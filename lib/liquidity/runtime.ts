import "../stockroom/polyfills.mjs";
import { Buffer } from "buffer";
import { PublicKey, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getExtensionTypes,
  ExtensionType,
} from "@solana/spl-token";
import type { PoolState } from "@meteora-ag/cp-amm-sdk";
import { browserAnchor } from "../treasury/anchor.mjs";
import {
  connection,
  checkNetwork,
  finalizeTransaction,
  readTradingWallet,
  type PreparedTreasury,
} from "../treasury/runtime";
import { parseUnits } from "../treasury/units";
import manifest from "./market.json";
import { maximum } from "./math";
export { manifest as liquidityMarket };
const pk = (s: string) => new PublicKey(s);
const { BN } = browserAnchor as typeof import("@coral-xyz/anchor");
const bn = (n: bigint | string) => new BN(n.toString());
async function client() {
  const sdk = await import("@meteora-ag/cp-amm-sdk");
  return { sdk, amm: new sdk.CpAmm(connection) };
}
const pool = pk(manifest.pool);
export function quoteFields(s: PoolState) {
  return {
    sqrtPrice: s.sqrtPrice,
    minSqrtPrice: s.sqrtMinPrice,
    maxSqrtPrice: s.sqrtMaxPrice,
    collectFeeMode: s.collectFeeMode,
    tokenAAmount: s.tokenAAmount,
    tokenBAmount: s.tokenBAmount,
    liquidity: s.liquidity,
  };
}
const txFields = (s: PoolState) => ({
  pool,
  tokenAMint: s.tokenAMint,
  tokenBMint: s.tokenBMint,
  tokenAVault: s.tokenAVault,
  tokenBVault: s.tokenBVault,
  tokenAProgram: TOKEN_PROGRAM_ID,
  tokenBProgram: TOKEN_2022_PROGRAM_ID,
});
async function verifiedPool() {
  await checkNetwork();
  const { sdk, amm } = await client();
  if (!sdk.CP_AMM_PROGRAM_ID.equals(pk(manifest.programId)))
    throw Error("Unexpected liquidity program.");
  const addresses = [
    pool,
    pk(manifest.programId),
    pk(manifest.tokenAMint),
    pk(manifest.tokenBMint),
  ];
  const { context, value: accounts } =
    await connection.getMultipleAccountsInfoAndContext(addresses, "confirmed");
  if (
    !accounts[0]?.owner.equals(sdk.CP_AMM_PROGRAM_ID) ||
    !accounts[1]?.executable
  )
    throw Error("Liquidity pool ownership verification failed.");
  const s = amm._program.coder.accounts.decode<PoolState>(
    "pool",
    accounts[0].data,
  );
  if (
    !s.tokenAMint.equals(addresses[2]) ||
    !s.tokenBMint.equals(addresses[3]) ||
    s.collectFeeMode !== sdk.CollectFeeMode.Compounding ||
    s.poolFees.compoundingFeeBps !== 10000 ||
    s.poolStatus !== 0 ||
    !s.liquidity.gtn(0)
  )
    throw Error("Pool no longer matches the unlocked compounding strategy.");
  const fees = sdk.decodePodAlignedFeeTimeScheduler(
    Buffer.from(s.poolFees.baseFee.baseFeeInfo.data),
  );
  if (
    fees.baseFeeMode !== sdk.BaseFeeMode.FeeTimeSchedulerLinear ||
    !fees.cliffFeeNumerator.eqn(10000000) ||
    fees.numberOfPeriod !== 0 ||
    s.poolFees.dynamicFee.initialized !== 0
  )
    throw Error(
      "Pool fee configuration changed; refresh the integration before signing.",
    );
  if (
    !sdk.getTokenProgram(s.tokenAFlag).equals(TOKEN_PROGRAM_ID) ||
    !sdk.getTokenProgram(s.tokenBFlag).equals(TOKEN_2022_PROGRAM_ID)
  )
    throw Error("Unsupported token program.");
  for (const [index, program, decimals] of [
    [2, TOKEN_PROGRAM_ID, 6],
    [3, TOKEN_2022_PROGRAM_ID, 8],
  ] as const) {
    const mint = unpackMint(addresses[index], accounts[index], program);
    if (mint.decimals !== decimals || mint.freezeAuthority)
      throw Error("Unsupported mint configuration.");
    // These allowlisted mocks carry metadata only: reject fees/hooks/non-transferability.
    const extensions = getExtensionTypes(mint.tlvData);
    if (
      extensions.some(
        (e) =>
          ![
            ExtensionType.MetadataPointer,
            ExtensionType.TokenMetadata,
          ].includes(e),
      )
    )
      throw Error("Unsupported token extension.");
  }
  return { s, sdk, amm, slot: context.slot };
}
export async function readLiquidity(wallet?: string) {
  const { s, amm, slot } = await verifiedPool();
  const held = wallet ? await amm.getUserPositionByPool(pool, pk(wallet)) : [];
  const positions = held
    .map((p) => {
      const unlocked = p.positionState.unlockedLiquidity;
      const q = unlocked.gtn(0)
        ? amm.getWithdrawQuote({ ...quoteFields(s), liquidityDelta: unlocked })
        : null;
      return {
        address: p.position.toBase58(),
        nft: p.positionState.nftMint.toBase58(),
        liquidity: unlocked.toString(),
        a: q?.outAmountA.toString() ?? "0",
        b: q?.outAmountB.toString() ?? "0",
        sharePercent: (
          Number(
            (BigInt(unlocked.toString()) * 1000000n) /
              BigInt(s.liquidity.toString()),
          ) / 10000
        ).toFixed(4),
      };
    })
    .filter((p) => p.liquidity !== "0");
  const balance = wallet ? await readTradingWallet(wallet) : null;
  return {
    pool: manifest.pool,
    slot,
    readAt: Date.now(),
    a: s.tokenAAmount.toString(),
    b: s.tokenBAmount.toString(),
    lpFeesB: s.metrics.totalLpBFee.toString(),
    protocolFeesB: s.metrics.totalProtocolBFee.toString(),
    positions,
    balance,
  };
}
export type LiquiditySnapshot = Awaited<ReturnType<typeof readLiquidity>>;
// One atomic transaction: authorized reserve withdrawal + creator-owned LP position.
export async function prepareReserveDeployment(
  wallet: string,
  source: import("../treasury/runtime").Market,
  amount: string,
): Promise<PreparedTreasury> {
  const { reserveWithdrawal } = await import("../treasury/runtime");
  const raw = parseUnits(amount, 8),
    { s, amm } = await verifiedPool(),
    owner = pk(wallet),
    nft = Keypair.generate();
  if (source.quoteMint !== manifest.tokenBMint)
    throw Error("Reserve asset does not match this strategy.");
  const spend = (raw * 9950n) / 10000n;
  if (spend < 2n) throw Error("Reserve amount is too small.");
  const q = amm.getDepositQuote({
    ...quoteFields(s),
    inAmount: bn(spend),
    isTokenA: false,
  });
  const maxA = maximum(BigInt(q.outputAmount.toString()));
  const balance = await readTradingWallet(wallet);
  if (BigInt(balance.base) < maxA)
    throw Error(
      "Add the matching ROOM to your wallet before deploying this reserve.",
    );
  const withdrawal = await reserveWithdrawal(wallet, source, raw);
  const tx = await amm.createPositionAndAddLiquidity({
    owner,
    ...txFields(s),
    positionNft: nft.publicKey,
    liquidityDelta: q.liquidityDelta,
    maxAmountTokenA: bn(maxA),
    maxAmountTokenB: bn(raw),
    tokenAAmountThreshold: bn(maxA),
    tokenBAmountThreshold: bn(raw),
  });
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 650000 }),
    ...withdrawal,
  );
  const prepared = await finalizeTransaction(
    tx,
    "reserve-deploy",
    wallet,
    raw.toString(),
    pool.toBase58(),
    undefined,
    [nft],
  );
  return {
    ...prepared,
    expiresAt: Date.now() + 30000,
    title: `Deploy ${source.symbol} creator reserve`,
    liquidity: {
      kind: "deposit",
      a: q.outputAmount.toString(),
      b: spend.toString(),
      limitA: maxA.toString(),
      limitB: raw.toString(),
      pool: pool.toBase58(),
      description: `Withdraw ${amount} mSPY from the ${source.symbol} creator reserve and supply it with wallet ROOM to this pool in one transaction. The resulting NFT belongs to the creator, not community members. Any unused mSPY buffer remains in the creator wallet. Failure rolls back both steps.`,
    },
  };
}
