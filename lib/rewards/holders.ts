import {scanHolderAccounts} from "./holder-scan";
import { Buffer } from "buffer";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import type { BN } from "@coral-xyz/anchor";
import { browserAnchor } from "../treasury/anchor.mjs";
import {
  connection,
  checkNetwork,
  readTreasury,
  finalizeTransaction,
  type Market,
} from "../treasury/runtime";
import { rewardProgram, prepareRewardFunding, readCampaigns } from "./runtime";
import { holderShares, rewardBudget } from "./holder-math";
const { BN: BigNumber } = browserAnchor as typeof import("@coral-xyz/anchor");
const pk = (v: string) => new PublicKey(v);
export const policyAddress = (m: Market) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("holder-policy"), pk(m.treasury).toBuffer()],
    rewardProgram.programId,
  )[0];
type PolicyAccount = {
  creator: PublicKey;
  treasury: PublicKey;
  shareBps: number;
  intervalSeconds: BN;
  checkpoint: BN;
  lastRoundAt: BN;
  rounds: BN;
};
type RoundAccount = {
  campaign: PublicKey;
  policy: PublicKey;
  snapshotSlot: BN;
  snapshotHash: number[];
  createdAt: BN;
  number: BN;
};
const accounts = rewardProgram.account as unknown as {
  holderPolicy: {
    all(): Promise<{ publicKey: PublicKey; account: PolicyAccount }[]>;
  };
  holderRound: {
    all(): Promise<{ publicKey: PublicKey; account: RoundAccount }[]>;
  };
};
export async function readHolderRewards() {
  await checkNetwork();
  const policies = await accounts.holderPolicy.all();
  const rounds = await accounts.holderRound.all();
  const campaigns = await readCampaigns();
  return {
    policies: policies.map(({ publicKey, account: p }) => ({
      address: publicKey.toBase58(),
      creator: p.creator.toBase58(),
      treasury: p.treasury.toBase58(),
      shareBps: p.shareBps,
      intervalSeconds: p.intervalSeconds.toNumber(),
      checkpoint: p.checkpoint.toString(),
      lastRoundAt: p.lastRoundAt.toNumber(),
      rounds: p.rounds.toNumber(),
    })),
    rounds: rounds
      .map(({ publicKey, account: r }) => ({
        address: publicKey.toBase58(),
        campaign: campaigns.find((c) => c.address === r.campaign.toBase58()),
        policy: r.policy.toBase58(),
        slot: r.snapshotSlot.toNumber(),
        hash: Buffer.from(r.snapshotHash).toString("hex"),
        createdAt: r.createdAt.toNumber(),
        number: r.number.toNumber(),
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
    legacy: campaigns.filter(
      (c) => !rounds.some((r) => r.account.campaign.toBase58() === c.address),
    ),
  };
}
export type HolderRewards = Awaited<ReturnType<typeof readHolderRewards>>;
export type HolderPolicy = HolderRewards["policies"][number];
export async function preparePolicy(
  wallet: string,
  m: Market,
  share: number,
  interval: number,
  exists: boolean,
) {
  await readTreasury(m);
  if (wallet !== m.creator)
    throw Error("Connect this market’s creator wallet.");
  if (
    !Number.isInteger(share) ||
    share < 0 ||
    share > 10000 ||
    (!exists && share === 0) ||
    !Number.isInteger(interval) ||
    interval < 60
  )
    throw Error("Choose a valid reward share and interval.");
  const ix = exists
    ? await rewardProgram.methods
        .updatePolicy(share, new BigNumber(interval))
        .accounts({
          creator: pk(wallet),
          treasury: pk(m.treasury),
          policy: policyAddress(m),
        })
        .instruction()
    : await rewardProgram.methods
        .createPolicy(share, new BigNumber(interval))
        .accounts({
          creator: pk(wallet),
          treasury: pk(m.treasury),
          policy: policyAddress(m),
          systemProgram: SystemProgram.programId,
        })
        .instruction();
  return {
    ...(await finalizeTransaction(
      new Transaction().add(ix),
      "reward-policy",
      wallet,
      "0",
      policyAddress(m).toBase58(),
    )),
    title: exists ? "Update holder reward policy" : "Enable holder rewards",
    rewards: {
      description: `${share / 100}% of newly retained market fees will fund proportional holder rewards, no more often than every ${interval / 60} minutes. The creator and program-owned accounts are excluded. Changes start a new fee checkpoint; existing reserve and funded rounds are not reallocated. A creator-authorized operator must run distributions.`,
      allocations: [],
    },
  };
}
export async function snapshotHolders(m: Market, p: HolderPolicy) {
  const state = await readTreasury(m);
  const budget = rewardBudget(
    BigInt(state.retained),
    BigInt(p.checkpoint),
    BigInt(state.available),
    p.shareBps,
  );
  const scan = await scanHolderAccounts(connection,m.baseMint);
  const balances = scan.value
    .map(({ pubkey, account }) =>
      unpackAccount(pubkey, account, scan.program),
    )
    .filter(
      (a) =>
        a.mint.toBase58() === m.baseMint &&
        PublicKey.isOnCurve(a.owner.toBytes()) &&
        !a.isFrozen,
    )
    .map((a) => ({ owner: a.owner.toBase58(), amount: a.amount.toString() }));
  const shares = holderShares(balances, budget, new Set([m.creator]));
  const payouts = shares.filter((s) => BigInt(s.amount) > 0n);
  if (payouts.length > 8)
    throw Error(
      "This Devnet distributor supports eight payable wallets per round. No holders were omitted; distribution is blocked until batching is upgraded.",
    );
  const document = JSON.stringify({
    treasury: m.treasury,
    policy: p.address,
    checkpoint: p.checkpoint,
    slot: scan.context.slot,
    budget: budget.toString(),
    shares,
  });
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(document)),
    ),
  );
  return {
    slot: scan.context.slot,
    budget: budget.toString(),
    shares,
    payouts,
    hash,
    document,
  };
}
export type HolderSnapshot = Awaited<ReturnType<typeof snapshotHolders>>;
export async function prepareHolderRound(
  wallet: string,
  m: Market,
  snapshot: HolderSnapshot,
) {
  const current = (await readHolderRewards()).policies.find(
    (p) => p.treasury === m.treasury,
  );
  if (!current || !current.shareBps)
    throw Error("Holder rewards are not enabled.");
  const fresh = await snapshotHolders(m, current);
  // New slots are expected, but economics and every wallet share must still match the reviewed preview.
  if (
    fresh.budget !== snapshot.budget ||
    JSON.stringify(fresh.shares) !== JSON.stringify(snapshot.shares)
  )
    throw Error(
      "Holdings or fees changed. Refresh the preview before distributing.",
    );
  return prepareRewardFunding(wallet, m, fresh.payouts, {
    slot: fresh.slot,
    hash: fresh.hash,
  });
}
export async function prepareDelivery(
  wallet: string,
  campaignAddress: string,
  index: number,
) {
  const campaign = (await readCampaigns()).find(
      (c) => c.address === campaignAddress,
    ),
    a = campaign?.allocations[index];
  if (!campaign || !a || a.claimed)
    throw Error("This payout is already delivered or unavailable.");
  const mint = pk((await import("../treasury/runtime")).market.quoteMint),
    recipient = pk(a.recipient),
    payer = pk(wallet);
  const ata = (o: PublicKey) =>
    getAssociatedTokenAddressSync(mint, o, true, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      ata(recipient),
      recipient,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    await rewardProgram.methods
      .deliver(index)
      .accounts({
        payer,
        campaign: pk(campaignAddress),
        escrow: ata(pk(campaignAddress)),
        mint,
        recipient,
        destination: ata(recipient),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction(),
  );
  return {
    ...(await finalizeTransaction(
      tx,
      "reward-deliver",
      wallet,
      a.amount,
      a.recipient,
    )),
    title: "Deliver holder reward",
    rewards: {
      description:
        "Send this funded payout directly to its fixed recipient. You pay only Devnet network/rent costs; the holder does not sign. The program rejects duplicate or redirected delivery.",
      allocations: [a],
    },
  };
}
