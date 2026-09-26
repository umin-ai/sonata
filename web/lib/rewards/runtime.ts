import "../polyfills.mjs";
import { Buffer } from "buffer";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  unpackAccount,
} from "@solana/spl-token";
import type { Idl, BN } from "@coral-xyz/anchor";
import { browserAnchor } from "../treasury/anchor.mjs";
import {
  connection,
  checkNetwork,
  readTreasury,
  market,
  finalizeTransaction,
  type Market,
  type PreparedTreasury,
} from "../treasury/runtime";
import { parseUnits } from "../treasury/units";
import idl from "./stockroom_rewards.json";
const { Program, BN: BigNumber } =
  browserAnchor as typeof import("@coral-xyz/anchor");
export const rewardProgram = new Program(idl as Idl, { connection }),
  pk = (s: string) => new PublicKey(s),
  mint = pk(market.quoteMint);
const program = rewardProgram;
const ata = (owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
type Campaign = {
  creator: PublicKey;
  treasury: PublicKey;
  mint: PublicKey;
  nonce: BN;
  funded: BN;
  claimed: BN;
  claimedMask: number;
  bump: number;
  allocations: { recipient: PublicKey; amount: BN }[];
};
export { parseGrants } from "./allocations";
import type { Grant } from "./allocations";
export async function readCampaigns() {
  await checkNetwork();
  if (!(await connection.getAccountInfo(program.programId))?.executable)
    throw Error("Rewards program is not available on Devnet.");
  const all = await (
    program.account as unknown as {
      campaign: {
        all(): Promise<{ publicKey: PublicKey; account: Campaign }[]>;
      };
    }
  ).campaign.all();
  const filtered = all.filter(({ account: c }) => c.mint.equals(mint));
  if (!filtered.length) return [];
  const custodys = await connection.getMultipleAccountsInfo(
    filtered.map(({ publicKey }) => ata(publicKey)),
  );
  return filtered.map(({ publicKey, account: c }, i) => {
    const custody = unpackAccount(
      ata(publicKey),
      custodys[i],
      TOKEN_2022_PROGRAM_ID,
    );
    const remaining =
      BigInt(c.funded.toString()) - BigInt(c.claimed.toString());
    if (
      remaining < 0n ||
      custody.amount < remaining ||
      !custody.owner.equals(publicKey) ||
      !custody.mint.equals(mint)
    )
      throw Error("Reward escrow does not reconcile.");
    return {
      address: publicKey.toBase58(),
      creator: c.creator.toBase58(),
      treasury: c.treasury.toBase58(),
      funded: c.funded.toString(),
      claimed: c.claimed.toString(),
      remaining: remaining.toString(),
      allocations: c.allocations.map((a, index) => ({
        recipient: a.recipient.toBase58(),
        amount: a.amount.toString(),
        index,
        claimed: (c.claimedMask & (1 << index)) !== 0,
      })),
    };
  });
}
export type RewardCampaign = Awaited<ReturnType<typeof readCampaigns>>[number];
export async function prepareRewardFunding(
  wallet: string,
  source: Market,
  grants: Grant[],
  holderRound?: { slot: number; hash: number[] },
): Promise<PreparedTreasury> {
  const state = await readTreasury(source),
    owner = pk(wallet);
  if (wallet !== source.creator)
    throw Error("Only the creator can fund rewards from this reserve.");
  if (
    !grants.length ||
    grants.length > 8 ||
    new Set(grants.map((g) => g.recipient)).size !== grants.length
  )
    throw Error("Use 1–8 unique recipients.");
  const total = grants.reduce((sum, g) => sum + BigInt(g.amount), 0n);
  if (total <= 0n || total > BigInt(state.available))
    throw Error("Reward total exceeds the allocated creator reserve.");
  const random = crypto.getRandomValues(new Uint16Array(1))[0];
  const nonce = new BigNumber(
    ((BigInt(Date.now()) << 16n) + BigInt(random)).toString(),
  );
  const [campaign] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("rewards"),
      owner.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ata(owner),
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  tx.add(
    await program.methods
      .fund(
        nonce,
        grants.map((g) => ({
          recipient: pk(g.recipient),
          amount: new BigNumber(g.amount),
        })),
      )
      .accounts({
        creator: owner,
        treasury: pk(source.treasury),
        treasuryQuote: pk(source.treasuryQuote),
        creatorQuote: ata(owner),
        mint,
        campaign,
        escrow: ata(campaign),
        treasuryProgram: pk(source.programId),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );
  if (holderRound)
    tx.add(
      await program.methods
        .recordRound(new BigNumber(holderRound.slot), holderRound.hash)
        .accounts({
          instructions: pk("Sysvar1nstructions1111111111111111111111111"),
          creator: owner,
          treasury: pk(source.treasury),
          policy: PublicKey.findProgramAddressSync(
            [Buffer.from("holder-policy"), pk(source.treasury).toBuffer()],
            program.programId,
          )[0],
          campaign,
          round: PublicKey.findProgramAddressSync(
            [Buffer.from("holder-round"), campaign.toBuffer()],
            program.programId,
          )[0],
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    );
  return {
    ...(await finalizeTransaction(
      tx,
      "reward-fund",
      wallet,
      total.toString(),
      campaign.toBase58(),
    )),
    title: `Fund ${source.symbol} community rewards`,
    rewards: {
      description: holderRound
        ? `Fund a proportional holder round from new retained fees. Snapshot slot ${holderRound.slot}. The creator attests to the complete offchain snapshot; recipient amounts become immutable onchain. Anyone can then deliver each payout to its fixed wallet.`
        : `Move exactly these allocations out of the ${source.symbol} creator reserve into Sonata escrow. Recipients and amounts cannot be edited; the creator has no withdrawal or cancellation instruction. This is a creator-selected list, not an automatic holder snapshot.`,
      allocations: grants,
    },
  };
}
export async function prepareRewardClaim(
  wallet: string,
  address: string,
  index: number,
): Promise<PreparedTreasury> {
  const campaigns = await readCampaigns(),
    campaign = campaigns.find((c) => c.address === address),
    grant = campaign?.allocations[index];
  if (!campaign || !grant || grant.recipient !== wallet || grant.claimed)
    throw Error("No unclaimed allocation for this wallet.");
  const owner = pk(wallet),
    tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ata(owner),
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  tx.add(
    await program.methods
      .claim(index)
      .accounts({
        campaign: pk(address),
        escrow: ata(pk(address)),
        mint,
        recipient: owner,
        destination: ata(owner),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction(),
  );
  return {
    ...(await finalizeTransaction(
      tx,
      "reward-claim",
      wallet,
      grant.amount,
      wallet,
    )),
    title: "Claim your funded reward",
    rewards: {
      description:
        "Transfer your fixed allocation from campaign escrow to your wallet. The program records this allocation as claimed and rejects a second claim.",
      allocations: [grant],
    },
  };
}
