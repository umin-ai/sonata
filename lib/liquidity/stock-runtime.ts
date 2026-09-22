import "../stockroom/polyfills.mjs";
import { Buffer } from "buffer";
import { PublicKey, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  unpackAccount,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  ExtensionType,
} from "@solana/spl-token";
import type { PoolState } from "@meteora-ag/cp-amm-sdk";
import { browserAnchor } from "../treasury/anchor.mjs";
import {
  connection,
  checkNetwork,
  finalizeTransaction,

  type PreparedTreasury,
} from "../treasury/runtime";
import { parseUnits } from "../treasury/units";
import markets from "./stock-markets.json";
import { minimum, maximum, portion } from "./math";

const pk = (s: string) => new PublicKey(s);
const { BN } = browserAnchor as typeof import("@coral-xyz/anchor");
const bn = (n: bigint | string) => new BN(n.toString());
async function client() {
  const sdk = await import("@meteora-ag/cp-amm-sdk");
  return { sdk, amm: new sdk.CpAmm(connection) };
}
export type StockPool={id:string;pool:string;programId:string;tokenAMint:string;tokenBMint:string;symbolA:string;symbolB:string};
export function stockLiquidity(id:string) {
const found = (markets as StockPool[]).find(m=>m.id===id);
if(!found) throw Error('This stock pool is not deployed yet.');
const manifest:StockPool=found;
async function readTradingWallet(wallet:string){
 const owner=pk(wallet),a=getAssociatedTokenAddressSync(pk(manifest!.tokenAMint),owner,false,TOKEN_PROGRAM_ID),b=getAssociatedTokenAddressSync(pk(manifest!.tokenBMint),owner,false,TOKEN_2022_PROGRAM_ID);
 const rows=await connection.getMultipleAccountsInfo([a,b]);
 const read=(i:number,address:PublicKey,mint:string,program:PublicKey)=>{if(!rows[i])return '0';const x=unpackAccount(address,rows[i],program);if(!x.owner.equals(owner)||!x.mint.equals(pk(mint))||x.isFrozen)throw Error('Unexpected token account');return x.amount.toString()};
 return {base:read(0,a,manifest!.tokenAMint,TOKEN_PROGRAM_ID),quote:read(1,b,manifest!.tokenBMint,TOKEN_2022_PROGRAM_ID)};
}
const pool = pk(manifest.pool);
function quoteFields(s: PoolState) {
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
async function readLiquidity(wallet?: string) {
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

async function prepareDeposit(
  wallet: string,
  amount: string,
): Promise<PreparedTreasury> {
  const raw = parseUnits(amount, 6),
    { s, amm } = await verifiedPool(),
    owner = pk(wallet),
    nft = Keypair.generate();
  const q = amm.getDepositQuote({
    ...quoteFields(s),
    inAmount: bn(raw),
    isTokenA: true,
  });
  if (!q.liquidityDelta.gtn(0)) throw Error("Deposit is too small.");
  const redemption = amm.getWithdrawQuote({
    ...quoteFields(s),
    liquidityDelta: q.liquidityDelta,
  });
  if (redemption.outAmountA.ltn(2) || redemption.outAmountB.ltn(2))
    throw Error(
      "Deposit is too small to create a redeemable two-token position. Increase the amount.",
    );
  const maxA = maximum(raw),
    maxB = maximum(BigInt(q.outputAmount.toString()));
  const balance = await readTradingWallet(wallet);
  if (BigInt(balance.base) < maxA || BigInt(balance.quote) < maxB)
    throw Error(
      "Keep enough MockUSDC and mock stocks for both sides, including the 0.5% quote buffer.",
    );
  const tx = await amm.createPositionAndAddLiquidity({
    owner,
    ...txFields(s),
    positionNft: nft.publicKey,
    liquidityDelta: q.liquidityDelta,
    maxAmountTokenA: bn(maxA),
    maxAmountTokenB: bn(maxB),
    tokenAAmountThreshold: bn(maxA),
    tokenBAmountThreshold: bn(maxB),
  });
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
  );
  const prepared = await finalizeTransaction(
    tx,
    "lp-deposit",
    wallet,
    raw.toString(),
    pool.toBase58(),
    undefined,
    [nft],
  );
  return {
    ...prepared,
    expiresAt: Date.now() + 30000,
    title: `Supply ${manifest.symbolA} + ${manifest.symbolB}`,
    liquidity: {
      symbolA:manifest.symbolA,symbolB:manifest.symbolB,decimalsA:6,decimalsB:8,
      kind: "deposit",
      a: raw.toString(),
      b: q.outputAmount.toString(),
      limitA: maxA.toString(),
      limitB: maxB.toString(),
      pool: pool.toBase58(),
      description:
        "Create a position NFT in your wallet. Supply both tokens to Meteora DAMM v2. Fees compound in pool reserves; the creator cannot redeem your position.",
    },
  };
}
async function prepareWithdrawal(
  wallet: string,
  positionAddress: string,
  bps: number,
): Promise<PreparedTreasury> {
  const { s, amm } = await verifiedPool(),
    owner = pk(wallet),
    positions = await amm.getUserPositionByPool(pool, owner),
    position = positions.find((p) => p.position.toBase58() === positionAddress);
  if (!position) throw Error("This wallet does not own the selected position.");
  const nftInfo = await connection.getAccountInfo(position.positionNftAccount);
  const nft = unpackAccount(
    position.positionNftAccount,
    nftInfo,
    TOKEN_2022_PROGRAM_ID,
  );
  if (
    !nft.owner.equals(owner) ||
    nft.amount !== 1n ||
    !nft.mint.equals(position.positionState.nftMint)
  )
    throw Error("Position NFT ownership verification failed.");
  const liquidityDelta = bn(
    portion(BigInt(position.positionState.unlockedLiquidity.toString()), bps),
  );
  const q = amm.getWithdrawQuote({ ...quoteFields(s), liquidityDelta }),
    minA = q.outAmountA.isZero()
      ? 0n
      : minimum(BigInt(q.outAmountA.toString())),
    minB = q.outAmountB.isZero()
      ? 0n
      : minimum(BigInt(q.outAmountB.toString()));
  const tx = await amm.removeLiquidity({
    owner,
    ...txFields(s),
    position: position.position,
    positionNftAccount: position.positionNftAccount,
    liquidityDelta,
    tokenAAmountThreshold: bn(minA),
    tokenBAmountThreshold: bn(minB),
    vestings: [],
    currentPoint: new BN(0),
  });
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
  );
  const prepared = await finalizeTransaction(
    tx,
    "lp-withdraw",
    wallet,
    liquidityDelta.toString(),
    wallet,
  );
  return {
    ...prepared,
    expiresAt: Date.now() + 30000,
    title:
      bps === 10000 ? "Exit liquidity position" : "Withdraw half of position",
    liquidity: {
      symbolA:manifest.symbolA,symbolB:manifest.symbolB,decimalsA:6,decimalsB:8,
      kind: "withdraw",
      a: q.outAmountA.toString(),
      b: q.outAmountB.toString(),
      limitA: minA.toString(),
      limitB: minB.toString(),
      pool: pool.toBase58(),
      description:
        "Redeem only your unlocked LP units. Both assets return to your wallet. This includes your share of compounded fees; there is no second fee claim. The empty NFT remains after a full exit.",
    },
  };
}

return {readLiquidity,prepareDeposit,prepareWithdrawal,manifest};
}
export type StockLiquiditySnapshot=Awaited<ReturnType<ReturnType<typeof stockLiquidity>["readLiquidity"]>>;
