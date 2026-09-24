// Graduated Sonata pools. When a Sonata market completes its bonding curve,
// Meteora DBC migrates it to a DAMM v2 pool (token A = the community token,
// token B = its stock) and permanently locks the migrated liquidity. Anyone can
// add their own liquidity to that pool and earn its trading fees; LP Farm tokens
// also pay these liquidity providers, pro rata by unlocked liquidity.
//
// A pool is only listed or used after it is checked against its market: DBC
// reports the market graduated, the address is the one DBC derives from the
// config's migration fee option, the account is owned by the DAMM v2 program,
// it holds the market's base mint as A and quote mint as B under the expected
// token programs, and both mints are plain (no freeze authority, no transfer
// fee or hook), so the SDK's quotes are exact. Every transaction re-reads and
// re-checks the pool first.
//
// Top-level imports stay node-loadable so the checks can be unit tested; the
// app runtime and the Meteora SDKs load lazily.
import "../stockroom/polyfills.mjs";
import { Buffer } from "buffer";
import { ComputeBudgetProgram, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionTypes,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import type { PoolState, PositionState } from "@meteora-ag/cp-amm-sdk";
import type { Market, PreparedTreasury } from "../treasury/runtime";
import { formatUnits, parseUnits } from "../treasury/units.ts";
import { maximum, minimum, portion } from "./math.ts";

export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const SPL_TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();
// DBC MigrationProgress: 3 = CreatedPool, the DAMM v2 pool and positions exist.
const CREATED_POOL = 3;
// DAMM v2 fees are numerators over 1e9.
const FEE_DENOMINATOR = 1_000_000_000n;
// The mock stocks carry metadata only; anything else could change amounts.
const QUOTE_EXTENSIONS = [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata];

const pk = (s: string) => new PublicKey(s);

// ---------------------------------------------------------------------------
// Pure checks and math (unit tested)

export type PoolMarket = Pick<
  Market,
  "pool" | "config" | "baseMint" | "quoteMint" | "vault" | "baseDecimals" | "quoteDecimals"
>;
export type MintFacts = {
  owner: string;
  decimals: number;
  freezeAuthority: boolean;
  extensions: number[];
};
export type BaseFee = {
  baseFeeMode: number;
  cliffFeeNumerator: bigint;
  numberOfPeriod: number;
  reductionFactor: bigint;
};
/** Everything a pool check needs, decoded from chain into plain values. */
export type PoolFacts = {
  dbcPool: {
    owner: string;
    config: string;
    baseMint: string;
    isMigrated: number;
    migrationProgress: number;
  } | null;
  dbcConfig: { owner: string; quoteMint: string; feeClaimer: string } | null;
  /** The DAMM v2 pool DBC creates for this market, or null for an unknown fee option. */
  derived: string | null;
  /** The account that was read as the pool. */
  address: string;
  damm:
    | ({
        owner: string;
        tokenAMint: string;
        tokenBMint: string;
        tokenAProgram: string;
        tokenBProgram: string;
        poolStatus: number;
        collectFeeMode: number;
        liquidity: bigint;
      } & BaseFee)
    | null;
  baseMint: MintFacts | null;
  quoteMint: MintFacts | null;
};

/**
 * The pool's base fee in basis points when it is a fixed fee (a fee time
 * scheduler with no periods or no reduction), else null.
 */
export function baseFeeBps(fee: BaseFee): number | null {
  // 0 = FeeTimeSchedulerLinear, 1 = FeeTimeSchedulerExponential.
  if (fee.baseFeeMode !== 0 && fee.baseFeeMode !== 1) return null;
  if (fee.numberOfPeriod !== 0 && fee.reductionFactor !== 0n) return null;
  if (fee.cliffFeeNumerator <= 0n || fee.cliffFeeNumerator >= FEE_DENOMINATOR) return null;
  return Number(fee.cliffFeeNumerator) / 100_000;
}

function mintProblem(
  mint: MintFacts | null,
  program: string,
  decimals: number,
  allowed: number[],
): string | null {
  if (!mint || mint.owner !== program) return "unexpected token program";
  if (mint.decimals !== decimals) return "unexpected decimals";
  if (mint.freezeAuthority) return "it can be frozen";
  if (mint.extensions.some((e) => !allowed.includes(e))) return "unsupported token extension";
  return null;
}

/** Why this is not the market's graduated DAMM v2 pool, or null when it is. */
export function poolProblem(market: PoolMarket, f: PoolFacts): string | null {
  const d = f.dbcPool,
    c = f.dbcConfig,
    p = f.damm;
  if (!d || !c || d.owner !== DBC_PROGRAM || c.owner !== DBC_PROGRAM)
    return "Market accounts are not owned by Meteora DBC.";
  if (
    d.config !== market.config ||
    d.baseMint !== market.baseMint ||
    c.quoteMint !== market.quoteMint ||
    c.feeClaimer !== market.vault
  )
    return "Pool configuration does not match this market.";
  if (d.isMigrated === 0 || d.migrationProgress !== CREATED_POOL)
    return "This market has not graduated yet.";
  if (!f.derived) return "Unsupported migration fee option.";
  if (f.address !== f.derived) return "This is not the pool DBC created for this market.";
  if (!p || p.owner !== DAMM_V2_PROGRAM) return "Graduated pool not found.";
  if (p.tokenAMint !== market.baseMint || p.tokenBMint !== market.quoteMint)
    return "Pool does not hold this market's tokens.";
  if (p.tokenAProgram !== SPL_TOKEN || p.tokenBProgram !== TOKEN_2022)
    return "Pool uses unexpected token programs.";
  if (p.poolStatus !== 0) return "Pool is disabled.";
  // 0 = both tokens, 1 = quote only. Compounding pools have no claimable fees.
  if (p.collectFeeMode !== 0 && p.collectFeeMode !== 1) return "Pool fee mode is not supported.";
  if (p.liquidity <= 0n) return "Pool has no liquidity.";
  if (baseFeeBps(p) === null) return "Pool fee changes over time, which is not supported.";
  const base = mintProblem(f.baseMint, SPL_TOKEN, market.baseDecimals, []);
  if (base) return `Token mint not supported: ${base}.`;
  const quote = mintProblem(f.quoteMint, TOKEN_2022, market.quoteDecimals, QUOTE_EXTENSIONS);
  if (quote) return `Stock mint not supported: ${quote}.`;
  return null;
}

/** Why a wallet cannot act on this position, or null when it holds it. */
export function positionProblem(
  wallet: string,
  poolAddress: string,
  position: { address: string; derived: string; pool: string; nftMint: string } | null,
  nft: { owner: string; amount: bigint; mint: string } | null,
): string | null {
  if (!position) return "Position not found.";
  if (position.pool !== poolAddress || position.derived !== position.address)
    return "This position is not in this pool.";
  if (!nft || nft.owner !== wallet || nft.amount !== 1n || nft.mint !== position.nftMint)
    return "This wallet does not hold the position NFT.";
  return null;
}

/** Pool value in raw quote units: B plus A at the pool price (sqrtPrice is Q64). */
export function poolValue(tokenA: bigint, tokenB: bigint, sqrtPrice: bigint) {
  return tokenB + ((tokenA * sqrtPrice * sqrtPrice) >> 128n);
}

/** Share of the pool, e.g. "12.5%", "0.0042%", "<0.0001%". Rounded down. */
export function sharePercent(part: bigint, whole: bigint) {
  if (part <= 0n || whole <= 0n) return "0%";
  const units = (part * 100_000_000n) / whole; // millionths of a percent
  if (units < 100n) return "<0.0001%";
  const whole100 = units / 1_000_000n,
    fraction = (units % 1_000_000n).toString().padStart(6, "0");
  const digits = whole100 >= 10n ? 1 : whole100 >= 1n ? 2 : 4;
  const shown = fraction.slice(0, digits).replace(/0+$/, "");
  return `${whole100}${shown ? `.${shown}` : ""}%`;
}

/** Short display amount, rounded down: "350,487,425.26", "3.9003", "0.000012". */
export function displayAmount(raw: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals),
    whole = raw / scale;
  const digits = whole >= 1000n ? 2 : whole >= 1n ? 4 : Math.min(decimals, 8);
  const fraction = (raw % scale).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** The largest amount whose 0.5% slippage limit (math.ts maximum) fits in `balance`. */
export function underBuffer(balance: bigint, bps = 50) {
  if (balance <= 0n) return 0n;
  return (balance * 10_000n) / BigInt(10_000 + bps);
}

/** Deposit debit limits, and which side the wallet cannot cover (null when both fit). */
export function depositLimits(a: bigint, b: bigint, balanceA: bigint, balanceB: bigint) {
  const maxA = maximum(a),
    maxB = maximum(b);
  return {
    maxA,
    maxB,
    short: balanceA < maxA ? ("base" as const) : balanceB < maxB ? ("quote" as const) : null,
  };
}

// ---------------------------------------------------------------------------
// Chain reads (lazy runtime and SDKs)

type Libs = Awaited<ReturnType<typeof loadLibs>>;
async function loadLibs() {
  const [runtime, cp, dbc, anchor, quotes] = await Promise.all([
    import("../treasury/runtime"),
    import("@meteora-ag/cp-amm-sdk"),
    import("@meteora-ag/dynamic-bonding-curve-sdk"),
    import("../treasury/anchor.mjs"),
    import("../treasury/quote-assets"),
  ]);
  if (
    cp.CP_AMM_PROGRAM_ID.toBase58() !== DAMM_V2_PROGRAM ||
    !dbc.DAMM_V2_PROGRAM_ID.equals(cp.CP_AMM_PROGRAM_ID) ||
    dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58() !== DBC_PROGRAM
  )
    throw Error("Unexpected Meteora program.");
  const { BN } = anchor.browserAnchor as typeof import("@coral-xyz/anchor");
  return {
    runtime,
    cp,
    dbc,
    BN,
    quoteSymbolOf: quotes.quoteSymbolOf,
    amm: new cp.CpAmm(runtime.connection),
    dbcCoder: new dbc.DynamicBondingCurveClient(runtime.connection, "confirmed").pool.program.coder
      .accounts,
  };
}
let libsPromise: Promise<Libs> | null = null;
function libs() {
  libsPromise ??= loadLibs().catch((e) => {
    libsPromise = null;
    throw e;
  });
  return libsPromise;
}

type Info = AccountInfo<Buffer> | null;

export type GraduatedPool = {
  market: Market;
  /** The DAMM v2 pool. */
  address: string;
  quoteSymbol: string;
  slot: number;
  /** Decoded pool, for quotes. */
  state: PoolState;
  feeBps: number;
  /** Meteora's dynamic fee is on: fast moves pay more. */
  dynamicFee: boolean;
  /** Percent of each trading fee that goes to liquidity providers. */
  lpFeePercent: number;
  /** 0: fees in both tokens; 1: fees in the stock only. */
  collectFeeMode: number;
  tokenA: bigint;
  tokenB: bigint;
  liquidity: bigint;
  /** Pool value in raw quote units. */
  value: bigint;
  /** Launch extras for the market's feature icons, read from its DBC config. */
  badges: { mode: Market["mode"]; airdrop: boolean; volatilityFee: boolean };
};
export type PoolList = {
  pools: GraduatedPool[];
  /** Graduated markets whose pool failed a check, so it is not offered. */
  skipped: { market: Market; reason: string }[];
};

function mintFacts(address: string, info: Info): MintFacts | null {
  if (!info) return null;
  try {
    const mint = unpackMint(pk(address), info, info.owner);
    return {
      owner: info.owner.toBase58(),
      decimals: mint.decimals,
      freezeAuthority: !!mint.freezeAuthority,
      extensions: mint.tlvData.length ? getExtensionTypes(mint.tlvData) : [],
    };
  } catch {
    return { owner: info.owner.toBase58(), decimals: -1, freezeAuthority: true, extensions: [] };
  }
}

type DbcRead = {
  pool: PoolFacts["dbcPool"];
  config: PoolFacts["dbcConfig"];
  derived: string | null;
  airdrop: boolean;
  volatilityFee: boolean;
};
function readDbc(L: Libs, market: Market, poolInfo: Info, configInfo: Info): DbcRead {
  const none = { pool: null, config: null, derived: null, airdrop: false, volatilityFee: false };
  if (!poolInfo || !configInfo) return none;
  try {
    const decoded = L.dbcCoder.decode("virtualPool", poolInfo.data);
    const vp = decoded.poolState ?? decoded;
    const config = L.dbcCoder.decode("poolConfig", configInfo.data);
    const dammConfig = L.dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
    return {
      pool: {
        owner: poolInfo.owner.toBase58(),
        config: vp.config.toBase58(),
        baseMint: vp.baseMint.toBase58(),
        isMigrated: vp.isMigrated,
        migrationProgress: vp.migrationProgress,
      },
      config: {
        owner: configInfo.owner.toBase58(),
        quoteMint: config.quoteMint.toBase58(),
        feeClaimer: config.feeClaimer.toBase58(),
      },
      derived: dammConfig
        ? L.dbc.deriveDammV2PoolAddress(dammConfig, pk(market.baseMint), pk(market.quoteMint)).toBase58()
        : null,
      // As readTreasury reads them: a Graduation Airdrop sends the held-back
      // supply to Sonata's payout bot; the volatility fee is Meteora's dynamic fee.
      airdrop: config.leftoverReceiver.equals(pk(L.runtime.REWARDS_WALLET)),
      volatilityFee: config.poolFees.dynamicFee.initialized !== 0,
    };
  } catch {
    return none;
  }
}

function decodeDamm(L: Libs, info: Info) {
  if (!info) return null;
  try {
    const state = L.amm._program.coder.accounts.decode<PoolState>("pool", info.data);
    const data = Buffer.from(state.poolFees.baseFee.baseFeeInfo.data);
    const baseFeeMode = L.cp.getBaseFeeModeFromPodAlignedData(data);
    const scheduler = baseFeeMode <= 1 ? L.cp.decodePodAlignedFeeTimeScheduler(data) : null;
    return {
      state,
      facts: {
        owner: info.owner.toBase58(),
        tokenAMint: state.tokenAMint.toBase58(),
        tokenBMint: state.tokenBMint.toBase58(),
        tokenAProgram: L.cp.getTokenProgram(state.tokenAFlag).toBase58(),
        tokenBProgram: L.cp.getTokenProgram(state.tokenBFlag).toBase58(),
        poolStatus: state.poolStatus,
        collectFeeMode: state.collectFeeMode,
        liquidity: BigInt(state.liquidity.toString()),
        baseFeeMode,
        cliffFeeNumerator: BigInt(scheduler?.cliffFeeNumerator.toString() ?? "0"),
        numberOfPeriod: scheduler?.numberOfPeriod ?? 0,
        reductionFactor: BigInt(scheduler?.reductionFactor.toString() ?? "0"),
      },
    };
  } catch {
    return null;
  }
}

/** Checks one market's pool; returns it, or the reason it is not offered. */
function checkPool(
  L: Libs,
  market: Market,
  dbc: DbcRead,
  address: string,
  dammInfo: Info,
  baseInfo: Info,
  quoteInfo: Info,
  slot: number,
): GraduatedPool | string {
  const damm = decodeDamm(L, dammInfo);
  const problem = poolProblem(market, {
    dbcPool: dbc.pool,
    dbcConfig: dbc.config,
    derived: dbc.derived,
    address,
    damm: damm?.facts ?? null,
    baseMint: mintFacts(market.baseMint, baseInfo),
    quoteMint: mintFacts(market.quoteMint, quoteInfo),
  });
  if (problem || !damm) return problem ?? "Graduated pool not found.";
  const s = damm.state,
    fees = s.poolFees;
  const tokenA = BigInt(s.tokenAAmount.toString()),
    tokenB = BigInt(s.tokenBAmount.toString());
  return {
    market,
    address,
    quoteSymbol: L.quoteSymbolOf(market.quoteMint),
    slot,
    state: s,
    feeBps: baseFeeBps(damm.facts)!,
    dynamicFee: fees.dynamicFee.initialized !== 0,
    lpFeePercent: ((100 - fees.protocolFeePercent) * (10_000 - fees.compoundingFeeBps)) / 10_000,
    collectFeeMode: s.collectFeeMode,
    tokenA,
    tokenB,
    liquidity: damm.facts.liquidity,
    value: poolValue(tokenA, tokenB, BigInt(s.sqrtPrice.toString())),
    badges: { mode: market.mode, airdrop: dbc.airdrop, volatilityFee: dbc.volatilityFee },
  };
}

// getMultipleAccounts takes at most 100 keys per call.
async function readAccounts(L: Libs, keys: string[]) {
  const infos: Info[] = [];
  let slot = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < keys.length; i += 100) {
    const { context, value } = await L.runtime.connection.getMultipleAccountsInfoAndContext(
      keys.slice(i, i + 100).map(pk),
      "confirmed",
    );
    infos.push(...value);
    slot = Math.min(slot, context.slot);
  }
  return { infos, slot };
}

/**
 * Every graduated Sonata market's DAMM v2 pool, checked against its market.
 * Two batched reads: each market's DBC pool and config (graduation, and the
 * config that names the pool), then the pools and their mints.
 */
export async function listGraduatedPools(markets: Market[]): Promise<PoolList> {
  const L = await libs();
  await L.runtime.checkNetwork();
  const skipped: PoolList["skipped"] = [];
  const known = markets.filter((m) => {
    try {
      L.runtime.validateMarketIdentity(m);
      return true;
    } catch {
      return false;
    }
  });
  if (!known.length) return { pools: [], skipped };
  const first = await readAccounts(L, known.flatMap((m) => [m.pool, m.config]));
  const graduated = known.flatMap((market, i) => {
    const dbc = readDbc(L, market, first.infos[2 * i], first.infos[2 * i + 1]);
    // Not graduated (still on its curve) is not a problem, just not listed.
    if (dbc.pool && dbc.pool.isMigrated === 0) return [];
    if (!dbc.derived) {
      skipped.push({ market, reason: poolProblem(market, emptyFacts(dbc)) ?? "Pool not found." });
      return [];
    }
    return [{ market, dbc, address: dbc.derived }];
  });
  if (!graduated.length) return { pools: [], skipped };
  const mints = [...new Set(graduated.flatMap((g) => [g.market.baseMint, g.market.quoteMint]))];
  const second = await readAccounts(L, [...graduated.map((g) => g.address), ...mints]);
  const mintInfo = (mint: string) => second.infos[graduated.length + mints.indexOf(mint)];
  const pools: GraduatedPool[] = [];
  graduated.forEach(({ market, dbc, address }, i) => {
    const result = checkPool(
      L,
      market,
      dbc,
      address,
      second.infos[i],
      mintInfo(market.baseMint),
      mintInfo(market.quoteMint),
      second.slot,
    );
    if (typeof result === "string") skipped.push({ market, reason: result });
    else pools.push(result);
  });
  return { pools, skipped };
}
const emptyFacts = (dbc: DbcRead): PoolFacts => ({
  dbcPool: dbc.pool,
  dbcConfig: dbc.config,
  derived: dbc.derived,
  address: "",
  damm: null,
  baseMint: null,
  quoteMint: null,
});

/** A fresh read of one pool (and any extra accounts, in the same call), checked again. */
async function freshPool(L: Libs, pool: GraduatedPool, extra: string[] = []) {
  await L.runtime.checkNetwork();
  const m = pool.market;
  L.runtime.validateMarketIdentity(m);
  const { infos, slot } = await readAccounts(L, [
    m.pool,
    m.config,
    pool.address,
    m.baseMint,
    m.quoteMint,
    ...extra,
  ]);
  const dbc = readDbc(L, m, infos[0], infos[1]);
  const result = checkPool(L, m, dbc, pool.address, infos[2], infos[3], infos[4], slot);
  if (typeof result === "string") throw Error(`${m.symbol} pool check failed: ${result}`);
  return { pool: result, extra: infos.slice(5) };
}

export type PoolPosition = {
  pool: string;
  address: string;
  nftAccount: string;
  /** Liquidity the holder can withdraw. */
  unlocked: bigint;
  /** Permanently locked or vesting liquidity: earns fees, cannot be withdrawn now. */
  locked: bigint;
  /** What withdrawing all unlocked liquidity returns now. */
  a: bigint;
  b: bigint;
  /** Unclaimed trading fees. */
  feeA: bigint;
  feeB: bigint;
  share: string;
};

function withdrawQuote(L: Libs, s: PoolState, liquidityDelta: bigint) {
  return L.amm.getWithdrawQuote({
    liquidityDelta: new L.BN(liquidityDelta.toString()),
    minSqrtPrice: s.sqrtMinPrice,
    maxSqrtPrice: s.sqrtMaxPrice,
    sqrtPrice: s.sqrtPrice,
    collectFeeMode: s.collectFeeMode,
    tokenAAmount: s.tokenAAmount,
    tokenBAmount: s.tokenBAmount,
    liquidity: s.liquidity,
  });
}

function toPosition(
  L: Libs,
  pool: GraduatedPool,
  address: string,
  nftAccount: string,
  p: PositionState,
): PoolPosition {
  const unlocked = BigInt(p.unlockedLiquidity.toString()),
    locked = BigInt(p.permanentLockedLiquidity.toString()) + BigInt(p.vestedLiquidity.toString());
  const q = unlocked > 0n ? withdrawQuote(L, pool.state, unlocked) : null;
  const fees = L.cp.getUnClaimLpFee(pool.state, p);
  return {
    pool: pool.address,
    address,
    nftAccount,
    unlocked,
    locked,
    a: BigInt(q?.outAmountA.toString() ?? "0"),
    b: BigInt(q?.outAmountB.toString() ?? "0"),
    feeA: BigInt(fees.feeTokenA.toString()),
    feeB: BigInt(fees.feeTokenB.toString()),
    share: sharePercent(unlocked + locked, pool.liquidity),
  };
}

/**
 * The wallet's positions in these pools, keyed by pool address: two reads for
 * all pools (the wallet's position NFTs, then their positions).
 */
export async function readPoolPositions(wallet: string, pools: GraduatedPool[]) {
  const L = await libs();
  await L.runtime.checkNetwork();
  const byAddress = new Map(pools.map((p) => [p.address, p]));
  const held = await L.amm.getPositionsByUser(pk(wallet));
  const out = new Map<string, PoolPosition[]>();
  for (const h of held) {
    const pool = byAddress.get(h.positionState.pool.toBase58());
    if (!pool) continue;
    const p = toPosition(L, pool, h.position.toBase58(), h.positionNftAccount.toBase58(), h.positionState);
    if (p.unlocked === 0n && p.locked === 0n && p.feeA === 0n && p.feeB === 0n) continue;
    out.set(pool.address, [...(out.get(pool.address) ?? []), p]);
  }
  return out;
}

/** The stock amount that matches `raw` community tokens at the pool price. */
export async function quoteDeposit(pool: GraduatedPool, raw: bigint) {
  const L = await libs();
  const s = pool.state;
  const q = L.amm.getDepositQuote({
    inAmount: new L.BN(raw.toString()),
    isTokenA: true,
    minSqrtPrice: s.sqrtMinPrice,
    maxSqrtPrice: s.sqrtMaxPrice,
    sqrtPrice: s.sqrtPrice,
    collectFeeMode: s.collectFeeMode,
    tokenAAmount: s.tokenAAmount,
    tokenBAmount: s.tokenBAmount,
    liquidity: s.liquidity,
  });
  return {
    b: BigInt(q.outputAmount.toString()),
    liquidityDelta: BigInt(q.liquidityDelta.toString()),
  };
}

/** The largest token amount whose deposit, with its 0.5% buffers, both balances cover. */
export async function maxDeposit(pool: GraduatedPool, balanceA: bigint, balanceB: bigint) {
  const L = await libs();
  const s = pool.state,
    b = underBuffer(balanceB);
  if (b <= 0n) return 0n;
  const q = L.amm.getDepositQuote({
    inAmount: new L.BN(b.toString()),
    isTokenA: false,
    minSqrtPrice: s.sqrtMinPrice,
    maxSqrtPrice: s.sqrtMaxPrice,
    sqrtPrice: s.sqrtPrice,
    collectFeeMode: s.collectFeeMode,
    tokenAAmount: s.tokenAAmount,
    tokenBAmount: s.tokenBAmount,
    liquidity: s.liquidity,
  });
  // A 0.1% margin absorbs rounding between the two quote directions.
  const aForB = (BigInt(q.outputAmount.toString()) * 9_990n) / 10_000n;
  const a = underBuffer(balanceA);
  return a < aForB ? a : aForB;
}

// ---------------------------------------------------------------------------
// Transactions, run by useLive().execute: review window, then wallet signature.

function reviewFields(pool: GraduatedPool) {
  return {
    symbolA: pool.market.symbol,
    symbolB: pool.quoteSymbol,
    decimalsA: pool.market.baseDecimals,
    decimalsB: pool.market.quoteDecimals,
    pool: pool.address,
  };
}
// Checked in poolProblem: A is an SPL Token mint, B a Token-2022 mint.
const mintFields = (s: PoolState) => ({
  tokenAMint: s.tokenAMint,
  tokenBMint: s.tokenBMint,
  tokenAProgram: TOKEN_PROGRAM_ID,
  tokenBProgram: TOKEN_2022_PROGRAM_ID,
});
const tokenAccounts = (s: PoolState) => ({
  ...mintFields(s),
  tokenAVault: s.tokenAVault,
  tokenBVault: s.tokenBVault,
});

/**
 * Add liquidity: `amount` community tokens and the matching stock at the pool
 * price, into a new position whose NFT goes to the wallet. Both debits are
 * capped 0.5% above the quote.
 */
export async function preparePoolDeposit(
  wallet: string,
  listed: GraduatedPool,
  amount: string,
): Promise<PreparedTreasury> {
  const L = await libs();
  const raw = parseUnits(amount, listed.market.baseDecimals);
  const { pool } = await freshPool(L, listed);
  const m = pool.market,
    s = pool.state,
    owner = pk(wallet);
  const q = await quoteDeposit(pool, raw);
  if (q.liquidityDelta <= 0n || q.b <= 0n) throw Error("Deposit is too small.");
  const redeem = withdrawQuote(L, s, q.liquidityDelta);
  if (redeem.outAmountA.ltn(2) || redeem.outAmountB.ltn(2))
    throw Error("Deposit is too small to withdraw both tokens later. Increase the amount.");
  const balance = await L.runtime.readTradingWallet(wallet, m);
  const limits = depositLimits(raw, q.b, BigInt(balance.base), BigInt(balance.quote));
  if (limits.short)
    throw Error(
      `You need ${formatUnits(limits.maxA, m.baseDecimals)} ${m.symbol} and ${formatUnits(limits.maxB, m.quoteDecimals)} ${pool.quoteSymbol}, including a 0.5% buffer for price moves.`,
    );
  const nft = Keypair.generate();
  const tx = await L.amm.createPositionAndAddLiquidity({
    owner,
    pool: pk(pool.address),
    positionNft: nft.publicKey,
    liquidityDelta: new L.BN(q.liquidityDelta.toString()),
    maxAmountTokenA: new L.BN(limits.maxA.toString()),
    maxAmountTokenB: new L.BN(limits.maxB.toString()),
    tokenAAmountThreshold: new L.BN(limits.maxA.toString()),
    tokenBAmountThreshold: new L.BN(limits.maxB.toString()),
    ...mintFields(s),
  });
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
  const prepared = await L.runtime.finalizeTransaction(
    tx,
    "lp-deposit",
    wallet,
    raw.toString(),
    pool.address,
    undefined,
    [nft],
  );
  return {
    ...prepared,
    market: m,
    expiresAt: Date.now() + 30_000,
    title: `Add ${m.symbol} / ${pool.quoteSymbol} liquidity`,
    liquidity: {
      ...reviewFields(pool),
      kind: "deposit",
      a: raw.toString(),
      b: q.b.toString(),
      limitA: limits.maxA.toString(),
      limitB: limits.maxB.toString(),
      description:
        "Adds both tokens to the Meteora DAMM v2 pool at its current price. A new position NFT goes to your wallet: it earns this pool's trading fees and you can withdraw it any time.",
    },
  };
}

type PositionRef = Pick<PoolPosition, "address" | "nftAccount">;

async function ownedPosition(L: Libs, wallet: string, listed: GraduatedPool, ref: PositionRef) {
  const { pool, extra } = await freshPool(L, listed, [ref.address, ref.nftAccount]);
  const [positionInfo, nftInfo] = extra;
  let state: PositionState | null = null;
  if (positionInfo?.owner.toBase58() === DAMM_V2_PROGRAM)
    try {
      state = L.amm._program.coder.accounts.decode<PositionState>("position", positionInfo.data);
    } catch {
      state = null;
    }
  let nft = null;
  if (nftInfo)
    try {
      const account = unpackAccount(pk(ref.nftAccount), nftInfo, TOKEN_2022_PROGRAM_ID);
      nft = { owner: account.owner.toBase58(), amount: account.amount, mint: account.mint.toBase58() };
    } catch {
      nft = null;
    }
  const problem = positionProblem(
    wallet,
    pool.address,
    state && {
      address: ref.address,
      derived: L.cp.derivePositionAddress(state.nftMint).toBase58(),
      pool: state.pool.toBase58(),
      nftMint: state.nftMint.toBase58(),
    },
    nft,
  );
  if (problem || !state) throw Error(problem ?? "Position not found.");
  return { pool, state };
}

/** Withdraw `bps` of a position's unlocked liquidity; both tokens go to the wallet. */
export async function preparePoolWithdrawal(
  wallet: string,
  listed: GraduatedPool,
  ref: PositionRef,
  bps: number,
): Promise<PreparedTreasury> {
  const L = await libs();
  const { pool, state } = await ownedPosition(L, wallet, listed, ref);
  const s = pool.state,
    owner = pk(wallet);
  const delta = portion(BigInt(state.unlockedLiquidity.toString()), bps);
  const q = withdrawQuote(L, s, delta);
  const outA = BigInt(q.outAmountA.toString()),
    outB = BigInt(q.outAmountB.toString());
  const minA = outA === 0n ? 0n : minimum(outA),
    minB = outB === 0n ? 0n : minimum(outB);
  const tx = await L.amm.removeLiquidity({
    owner,
    pool: pk(pool.address),
    position: pk(ref.address),
    positionNftAccount: pk(ref.nftAccount),
    liquidityDelta: new L.BN(delta.toString()),
    tokenAAmountThreshold: new L.BN(minA.toString()),
    tokenBAmountThreshold: new L.BN(minB.toString()),
    ...tokenAccounts(s),
    vestings: [],
    currentPoint: new L.BN(0),
  });
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  const prepared = await L.runtime.finalizeTransaction(tx, "lp-withdraw", wallet, delta.toString(), wallet);
  const percent = bps === 10_000 ? "all" : `${bps / 100}%`;
  return {
    ...prepared,
    market: pool.market,
    expiresAt: Date.now() + 30_000,
    title: `Withdraw ${percent} of your ${pool.market.symbol} / ${pool.quoteSymbol} position`,
    liquidity: {
      ...reviewFields(pool),
      kind: "withdraw",
      a: outA.toString(),
      b: outB.toString(),
      limitA: minA.toString(),
      limitB: minB.toString(),
      description: `Withdraws ${percent} of this position's unlocked liquidity. Both tokens go to your wallet and the position NFT stays with you. Unclaimed fees stay on the position; claim them separately.`,
    },
  };
}

/** Claim a position's trading fees into the wallet's own token accounts. */
export async function preparePoolClaim(
  wallet: string,
  listed: GraduatedPool,
  ref: PositionRef,
): Promise<PreparedTreasury> {
  const L = await libs();
  const { pool, state } = await ownedPosition(L, wallet, listed, ref);
  const fees = L.cp.getUnClaimLpFee(pool.state, state);
  const a = BigInt(fees.feeTokenA.toString()),
    b = BigInt(fees.feeTokenB.toString());
  if (a === 0n && b === 0n) throw Error("No fees to claim yet.");
  const owner = pk(wallet);
  // claimPositionFee2 creates the wallet's token accounts first if missing.
  const tx = await L.amm.claimPositionFee2({
    owner,
    receiver: owner,
    feePayer: owner,
    pool: pk(pool.address),
    position: pk(ref.address),
    positionNftAccount: pk(ref.nftAccount),
    ...tokenAccounts(pool.state),
  });
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  const prepared = await L.runtime.finalizeTransaction(tx, "lp-claim", wallet, b.toString(), wallet);
  return {
    ...prepared,
    market: pool.market,
    expiresAt: Date.now() + 30_000,
    title: `Claim ${pool.market.symbol} / ${pool.quoteSymbol} pool fees`,
    liquidity: {
      ...reviewFields(pool),
      kind: "claim",
      a: a.toString(),
      b: b.toString(),
      limitA: "0",
      limitB: "0",
      description:
        "Claims the trading fees this position has earned, into your wallet. You get at least this much, more if trades land first. Your liquidity stays in the pool.",
    },
  };
}
