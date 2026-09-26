import "../polyfills.mjs";
import { Buffer } from "buffer";
import { type BN, type Idl } from "@coral-xyz/anchor";
import { browserAnchor } from "./anchor.mjs";
const { Program, BorshAccountsCoder, BN: BigNumber } =
  browserAnchor as typeof import("@coral-xyz/anchor");
import {
  Connection,
  PublicKey,
  type AccountInfo,
  Transaction,
  ComputeBudgetProgram,
  VersionedTransaction,
  Keypair,
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
import treasuryIdl from "./stockroom_treasury.json";
import dbcIdl from "./dbc.json";
import initialMarket from "./market.json";
import { buildCurveParams, type CurveOptions } from "./dbc-preview";
import { standardConfigProblem, type StandardConfigFields } from "./standard";
import { quoteAssetList, quoteAssetBySymbol, quoteSymbolOf } from "./quote-assets";
import { buyOut, graduationProgress, milestoneCaps } from "./graduation";
import { isProfileUrl, type FeeModel } from "../token-profile";
// Of the net fees the treasury claims (80% of the trading fee; Meteora takes 20%, and
// pays a fifth of that to Sonata as referrer on swaps this site builds):
// "standard": 50% to the creator's payout wallet, 50% to Sonata. New launches.
// "standardFloor": 25% creator, 25% Stock Floor, 50% Sonata. New launches with a floor.
// "refrain": 100% to the payout wallet.
// "duet": 50% to the payout wallet, 50% creator-withdrawable reserve.
// "floor": 50% to the payout wallet, 50% Stock Floor that only holders redeem.
export type TreasuryMode = "standard" | "standardFloor" | "refrain" | "duet" | "floor";
const MODES: TreasuryMode[] = ["standard", "standardFloor", "refrain", "duet", "floor"];
// Reward tokens are Standard-mode markets whose payout owner is Sonata's payout
// bot: it receives the creator's share and pays it to holders pro rata.
export const REWARDS_WALLET = "Fb83XLPdUM11FrUUBNaB1JXJ2feJacNkcPGUzP8dtGz";
export const isRewardMarket = (m: { payoutOwner: string; mode?: TreasuryMode }) =>
  m.payoutOwner === REWARDS_WALLET && m.mode === "standard";
/** Modes whose retained balance is a holder-redeemable Stock Floor. */
export const hasFloor = (mode?: TreasuryMode) => mode === "floor" || mode === "standardFloor";
export type Market = typeof initialMarket & {
  symbol: string;
  name: string;
  mode?: TreasuryMode;
  // Trading fee in bps, known for launches made in this session.
  fee?: number;
  // Token profile metadata JSON (image, description, links), when published.
  uri?: string;
  // Where the creator's share goes, as written in the metadata (launches made here).
  feeModel?: FeeModel;
};
const modeOf = (m: Record<string, unknown>): TreasuryMode | null =>
  MODES.find((mode) => mode in m) ?? null;
export const market: Market = {
  ...initialMarket,
  symbol: "ROOM",
  name: "Stockroom Treasury Demo",
};
import dbc from "./dbc-addresses.json";
import { parseUnits } from "./units.ts";

import { createRpcFetch } from "./rpc-fetch";
// Devnet RPCs in order of preference: Solana's public endpoint, then (in the
// browser) Sonata's relay to a dedicated provider, app/api/rpc, which keeps that
// provider's key on the server. rpc-fetch moves a request to the next endpoint
// when one is busy or down. Subscriptions (websockets) stay on the public endpoint.
const DEVNET_RPCS = [
  "https://api.devnet.solana.com",
  ...(typeof window !== "undefined" ? [new URL("/api/rpc", window.location.origin).toString()] : []),
];
export const connection = new Connection(DEVNET_RPCS[0], {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: createRpcFetch((input, init) => globalThis.fetch(input, init), { endpoints: DEVNET_RPCS }),
});
const pk = (s: string) => new PublicKey(s),
  program = new Program(treasuryIdl as Idl, { connection }),
  coder = new BorshAccountsCoder(dbcIdl as Idl);
// The treasury program bound to another connection (tests, scripts), made once per connection.
const programs = new WeakMap<Connection, typeof program>();
function programFor(conn: Connection) {
  if (conn === connection) return program;
  let p = programs.get(conn);
  if (!p) programs.set(conn, (p = new Program(treasuryIdl as Idl, { connection: conn })));
  return p;
}
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
// The last Devnet check per connection, and the one in flight.
const networkChecks = new WeakMap<Connection, { checkedAt: number; pending: Promise<void> | null }>();
export async function checkNetwork(conn: Connection = connection, maxAgeMs = 60_000) {
  let state = networkChecks.get(conn);
  if (!state) networkChecks.set(conn, (state = { checkedAt: 0, pending: null }));
  if (Date.now() - state.checkedAt <= maxAgeMs) return;
  const s = state;
  s.pending ??= (async () => {
    if ((await conn.getGenesisHash()) !== GENESIS) throw Error("Devnet verification failed.");
    s.checkedAt = Date.now();
  })().finally(() => {
    s.pending = null;
  });
  await s.pending;
}

type Treasury = {
  pool: PublicKey;
  config: PublicKey;
  quoteMint: PublicKey;
  baseMint: PublicKey;
  creator: PublicKey;
  payoutOwner: PublicKey;
  mode: Record<string, unknown>;
  totalClaimed: BN;
  totalDistributed: BN;
  totalRetained: BN;
  totalWithdrawn: BN;
  lastClaimTs: BN;
};
type Pool = {
  poolState?: Pool;
  config: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  partnerQuoteFee: BN;
  quoteReserve: BN;
  sqrtPrice: BN;
  isMigrated: number;
};
type CurveConfig = {
  leftoverReceiver: PublicKey;
  poolFees: { baseFee: { cliffFeeNumerator: BN }; dynamicFee: { initialized: number } };
  migrationQuoteThreshold: BN;
  migrationFeeOption: number;
  creatorPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
  creatorLiquidityVestingInfo: { vestingPercentage: number };
  migrationSqrtPrice: BN;
  sqrtStartPrice: BN;
  curve: { sqrtPrice: BN; liquidity: BN }[];
};
type Info = AccountInfo<Buffer> | null;
/** The accounts readTreasury reads, in its order, in one call and so at one slot. */
export const TREASURY_ACCOUNTS = [
  "treasury",
  "pool",
  "config",
  "treasuryQuote",
  "payoutQuote",
  "quoteMint",
  "programId",
  "baseMint",
] as const;
/** A graduated market's pool fees as readTreasury reports them: read, unreadable, or none (not graduated). */
export type PoolFeesRead = Awaited<ReturnType<typeof readPoolFees>> | { error: string } | null;
/**
 * readTreasury's checks and numbers from accounts already read: `infos` are
 * TREASURY_ACCOUNTS in that order, read at `slot`. The graduated pool's fees
 * are not included (poolFees null; withPoolFees adds them). Throws when any
 * check fails, exactly as readTreasury does. Makes no RPC call.
 */
export function treasuryFromAccounts(market: Market, infos: readonly Info[], slot: number) {
  validateMarketIdentity(market);
  const [ta, pa, ca, tqa, pqa, qm, pr, bm] = infos;
  if (
    !ta?.owner.equals(program.programId) ||
    !pa?.owner.equals(pk(dbc.program)) ||
    !ca?.owner.equals(pk(dbc.program)) ||
    !pr?.executable
  )
    throw Error("Onchain program or account ownership changed.");
  const treasury = program.coder.accounts.decode<Treasury>("treasury", ta.data);
  const decoded = coder.decode<Pool>("virtualPool", pa.data),
    pool = decoded.poolState ?? decoded;
  const config = coder.decode<
    { quoteMint: PublicKey; feeClaimer: PublicKey } & CurveConfig
  >("poolConfig", ca.data);
  const nonStandard = standardConfigProblem(config as unknown as StandardConfigFields, market.vault);
  if (nonStandard) throw Error(`This market is not a standard Sonata launch: ${nonStandard}.`);
  for (const key of [
    "pool",
    "config",
    "quoteMint",
    "baseMint",
    "creator",
    "payoutOwner",
  ] as const)
    if (treasury[key].toBase58() !== market[key])
      throw Error(
        `Treasury ${key} changed. Refresh integration before signing.`,
      );
  const mode = modeOf(treasury.mode);
  if (!mode || (market.mode && market.mode !== mode))
    throw Error("Treasury mode changed. Refresh integration before signing.");
  if (
    !config.feeClaimer.equals(pk(market.vault)) ||
    !config.quoteMint.equals(pk(market.quoteMint)) ||
    !pool.config.equals(pk(market.config)) ||
    !pool.baseMint.equals(pk(market.baseMint)) ||
    !pool.baseVault.equals(pk(market.baseVault)) ||
    !pool.quoteVault.equals(pk(market.quoteVault))
  )
    throw Error("Pool configuration does not match this market.");
  const mint = unpackMint(pk(market.quoteMint), qm, TOKEN_2022_PROGRAM_ID);
  if (mint.decimals !== 8 || mint.freezeAuthority)
    throw Error("Unexpected mock stock mint.");
  // Community token supply: the Stock Floor is shared across all of it.
  const baseSupply = unpackMint(pk(market.baseMint), bm, TOKEN_PROGRAM_ID).supply;
  const custody = unpackAccount(
      pk(market.treasuryQuote),
      tqa,
      TOKEN_2022_PROGRAM_ID,
    ),
    payout = unpackAccount(pk(market.payoutQuote), pqa, TOKEN_2022_PROGRAM_ID);
  if (
    !custody.owner.equals(pk(market.treasury)) ||
    !payout.owner.equals(pk(market.payoutOwner)) ||
    ![custody, payout].every(
      (a) => a.mint.equals(pk(market.quoteMint)) && !a.isFrozen,
    )
  )
    throw Error("Token custody verification failed.");
  const claimed = BigInt(treasury.totalClaimed.toString()),
    paid = BigInt(treasury.totalDistributed.toString()),
    retained = BigInt(treasury.totalRetained.toString()),
    withdrawn = BigInt(treasury.totalWithdrawn.toString());
  const unallocated = claimed - paid - retained,
    available = retained - withdrawn;
  if (
    unallocated < 0n ||
    available < 0n ||
    custody.amount < unallocated + available
  )
    throw Error("Treasury accounting does not reconcile.");
  const graduation = readGraduation(pool, config, market, baseSupply);
  return {
    slot,
    fetchedAt: Date.now(),
    claimed: claimed.toString(),
    paid: paid.toString(),
    retained: retained.toString(),
    withdrawn: withdrawn.toString(),
    unallocated: unallocated.toString(),
    available: available.toString(),
    custody: custody.amount.toString(),
    recipientBalance: payout.amount.toString(),
    // Unix seconds of the last fee collection, 0 if never; the payout bot collects every 15 minutes.
    lastClaimTs: Number(treasury.lastClaimTs.toString()),
    uncollected: pool.partnerQuoteFee.toString(),
    migrated: pool.isMigrated !== 0,
    mode,
    // In floor modes the available retained balance is the floor (Sonata's share
    // in standardFloor is counted as retained and withdrawn at once).
    floor: hasFloor(mode) ? available.toString() : "0",
    baseSupply: baseSupply.toString(),
    ...graduation,
    poolFees: null as PoolFeesRead,
  };
}
/** A verified read of the market without its graduated pool's fees (see treasuryFromAccounts). */
export type TreasuryState = ReturnType<typeof treasuryFromAccounts>;
/**
 * The market's treasury, pool and custody, read in one call at one slot and
 * checked against the market (the binding check every transaction relies
 * on), without a graduated pool's fees. The market page shows this as soon as
 * it passes and adds the fees with withPoolFees.
 */
export async function readTreasuryVerified(market: Market = exportsMarket, conn: Connection = connection) {
  validateMarketIdentity(market);
  await checkNetwork(conn);
  const result = await conn.getMultipleAccountsInfoAndContext(
    TREASURY_ACCOUNTS.map((n) => pk(market[n])),
    "confirmed",
  );
  return treasuryFromAccounts(market, result.value, result.context.slot);
}
/**
 * A verified read with the graduated pool's fees added, as readTreasury
 * returns it: after graduation the curve earns nothing more; Sonata's locked
 * half of the pool earns the fees instead, and "uncollected" is what it holds now.
 */
export async function withPoolFees(market: Market, state: TreasuryState, conn: Connection = connection) {
  const poolFees: PoolFeesRead =
    state.migrated && state.dammPool
      ? await readPoolFees(market, state.dammPool, conn).catch((e) => ({
          error: e instanceof Error ? e.message : "Pool fees unavailable",
        }))
      : null;
  return {
    ...state,
    ...(poolFees && "quote" in poolFees ? { uncollected: poolFees.quote } : {}),
    poolFees,
  };
}
export async function readTreasury(market: Market = exportsMarket, conn: Connection = connection) {
  return withPoolFees(market, await readTreasuryVerified(market, conn), conn);
}
// The Sonata Vault's locked position in each graduated DAMM v2 pool. Its
// address never changes, so the Vault's position NFTs are listed once per
// session; each read then fetches only the pool and the position.
const vaultPositions = new Map<string, Promise<{ position: PublicKey; positionNftAccount: PublicKey } | null>>();
/**
 * What claim_graduated needs for a graduated market, and the fees Sonata's
 * locked position has earned but not yet moved into the treasury (quote and
 * base atoms; the pool collects its fees in the stock, so base stays 0).
 */
async function readPoolFees(market: Market, dammPool: string, conn: Connection = connection) {
  const cp = await import("@meteora-ag/cp-amm-sdk");
  const amm = new cp.CpAmm(conn);
  let found = vaultPositions.get(dammPool);
  if (!found) {
    found = amm.getPositionsByUser(pk(market.vault)).then((list) => {
      const inPool = list.filter((p) => p.positionState.pool.toBase58() === dammPool);
      inPool.sort((a, b) => b.positionState.permanentLockedLiquidity.cmp(a.positionState.permanentLockedLiquidity));
      return inPool[0] ? { position: inPool[0].position, positionNftAccount: inPool[0].positionNftAccount } : null;
    });
    vaultPositions.set(dammPool, found);
  }
  const at = await found.catch(() => null);
  if (!at) {
    vaultPositions.delete(dammPool);
    throw Error("Sonata's locked position in the pool was not found");
  }
  const [state, position] = await Promise.all([
    amm.fetchPoolState(pk(dammPool)),
    amm.fetchPositionState(at.position),
  ]);
  if (state.tokenAMint.toBase58() !== market.baseMint || state.tokenBMint.toBase58() !== market.quoteMint)
    throw Error("The graduated pool does not hold this market's tokens");
  if (!position.pool.equals(pk(dammPool))) throw Error("Sonata's position is not in this pool");
  const fees = cp.getUnClaimLpFee(state, position);
  return {
    dammPool,
    position: at.position.toBase58(),
    positionNftAccount: at.positionNftAccount.toBase58(),
    tokenAVault: state.tokenAVault.toBase58(),
    tokenBVault: state.tokenBVault.toBase58(),
    quote: fees.feeTokenB.toString(),
    base: fees.feeTokenA.toString(),
  };
}
const DAMM_POOL_AUTHORITY = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";
const DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
// DBC's DAMM v2 migration configs by migration fee option (the SDK's
// DAMM_V2_MIGRATION_FEE_ADDRESS): FixedBps25, 30, 100, 200, 400, 600, Customizable.
const DAMM_V2_MIGRATION_CONFIGS = [
  "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd",
  "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k",
  "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
  "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq",
  "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD",
  "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u",
  "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
];
/**
 * The DAMM v2 pool DBC creates when a market graduates, as the SDK's
 * deriveDammV2PoolAddress derives it (seeds "pool", the migration config,
 * then the two mints, larger first), without loading the SDK. Null for a
 * migration fee option DBC does not map to a DAMM v2 config.
 */
export function dammV2PoolAddress(migrationFeeOption: number, baseMint: string, quoteMint: string) {
  const config = DAMM_V2_MIGRATION_CONFIGS[migrationFeeOption];
  if (!config) return null;
  const a = pk(baseMint).toBuffer(),
    b = pk(quoteMint).toBuffer();
  const [first, second] = Buffer.compare(a, b) === 1 ? [a, b] : [b, a];
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), pk(config).toBuffer(), first, second],
    pk(DAMM_V2_PROGRAM_ID),
  )[0].toBase58();
}
const FEE_DENOMINATOR = 1_000_000_000n;
function withFee(remaining: bigint, config: CurveConfig) {
  if (remaining <= 0n) return 0n;
  let fee = BigInt(config.poolFees.baseFee.cliffFeeNumerator.toString());
  if (config.poolFees.dynamicFee.initialized !== 0) fee = (fee * 12n) / 10n;
  if (fee >= FEE_DENOMINATOR) return remaining;
  return (remaining * FEE_DENOMINATOR + (FEE_DENOMINATOR - fee - 1n)) / (FEE_DENOMINATOR - fee) + 1n;
}
// Graduation state from the pool and config already fetched above: no extra RPC.
function readGraduation(
  pool: Pool,
  config: CurveConfig,
  market: Market,
  baseSupply: bigint,
) {
  const migrated = pool.isMigrated !== 0;
  const quoteReserve = BigInt(pool.quoteReserve.toString()),
    threshold = BigInt(config.migrationQuoteThreshold.toString());
  const progress = graduationProgress(quoteReserve, threshold, migrated);
  const big = (v: BN) => BigInt(v.toString());
  // Market cap in the quote stock, now and at each milestone.
  const caps = milestoneCaps(
    big(pool.sqrtPrice),
    big(config.sqrtStartPrice),
    config.curve.map((c) => ({ sqrtPrice: big(c.sqrtPrice), liquidity: big(c.liquidity) })),
    threshold,
    big(config.migrationSqrtPrice),
    baseSupply,
  );
  // DBC creates the DAMM v2 pool under the config matching the migration fee option.
  const dammPool = migrated
    ? dammV2PoolAddress(config.migrationFeeOption, market.baseMint, market.quoteMint)
    : null;
  return {
    quoteReserve: quoteReserve.toString(),
    migrationQuoteThreshold: threshold.toString(),
    graduationBps: progress.bps,
    graduationStage: progress.stage,
    heat: progress.heat,
    marketCap: caps.current,
    milestoneCaps: caps.milestones,
    remainingToGraduate: progress.remaining.toString(),
    // What a buy must send to finish the curve: the fee comes out of the input,
    // so the remainder plus the fee (the most a volatility fee adds, 20%, on
    // top). A partial-fill buy returns whatever is not needed.
    remainingWithFee: withFee(progress.remaining, config).toString(),
    dammPool,
    // Launch extras, read from the config itself: a Graduation Airdrop sends the
    // held-back supply to Sonata's payout bot; the volatility fee is Meteora's dynamic fee.
    airdrop: config.leftoverReceiver.equals(pk(REWARDS_WALLET)),
    volatilityFee: config.poolFees.dynamicFee.initialized !== 0,
    // The creator's share of the graduated pool's liquidity, in percent (older configs gave none),
    // as lib/liquidity/creator-position.ts counts it.
    creatorPoolPercent:
      config.creatorPermanentLockedLiquidityPercentage +
      config.creatorLiquidityPercentage +
      config.creatorLiquidityVestingInfo.vestingPercentage,
    // The curve's trading fee in basis points (DBC fees are numerators over 1e9).
    tradingFeeBps: Number(config.poolFees.baseFee.cliffFeeNumerator.toString()) / 100_000,
  };
}
export type TreasurySnapshot = Awaited<ReturnType<typeof readTreasury>>;
/** Backing and launch extras from readMarketFacts. Fields are absent when not read or a check failed. */
export type MarketFacts = {
  /** A Backed token's backing (retained less withdrawn), in quote units. */
  floor?: string;
  baseSupply?: string;
  airdrop?: boolean;
  volatilityFee?: boolean;
};
/**
 * Backing and launch extras for many markets in batched reads (100 accounts
 * per call) instead of one readTreasury per market: each Backed token's
 * backing and supply from its treasury account and base mint and, with
 * `configs`, each market's Graduation Airdrop and volatility fee from its DBC
 * config. For display only: anything that moves funds re-reads the market with
 * readTreasury. A market whose accounts fail a check gets no entry.
 */
export async function readMarketFacts(list: Market[], { configs = false } = {}) {
  await checkNetwork();
  const backed = list.filter((m) => hasFloor(m.mode));
  const keys = [
    ...backed.flatMap((m) => [m.treasury, m.baseMint]),
    ...(configs ? list.map((m) => m.config) : []),
  ];
  const infos: Awaited<ReturnType<typeof connection.getMultipleAccountsInfo>> = [];
  for (let i = 0; i < keys.length; i += 100)
    infos.push(
      ...(await connection.getMultipleAccountsInfo(
        keys.slice(i, i + 100).map(pk),
        "confirmed",
      )),
    );
  const facts = new Map<string, MarketFacts>();
  const entry = (pool: string) => {
    if (!facts.has(pool)) facts.set(pool, {});
    return facts.get(pool)!;
  };
  backed.forEach((m, i) => {
    const [ta, mi] = [infos[2 * i], infos[2 * i + 1]];
    try {
      if (!ta?.owner.equals(program.programId) || !mi) return;
      const t = program.coder.accounts.decode<Treasury>("treasury", ta.data);
      if (
        t.pool.toBase58() !== m.pool ||
        t.baseMint.toBase58() !== m.baseMint ||
        !hasFloor(modeOf(t.mode) ?? undefined)
      )
        return;
      const floor =
        BigInt(t.totalRetained.toString()) - BigInt(t.totalWithdrawn.toString());
      if (floor < 0n) return;
      const supply = unpackMint(pk(m.baseMint), mi, TOKEN_PROGRAM_ID).supply;
      Object.assign(entry(m.pool), {
        floor: floor.toString(),
        baseSupply: supply.toString(),
      });
    } catch {
      /* Left out: shown as unknown. */
    }
  });
  if (configs)
    list.forEach((m, j) => {
      const ca = infos[2 * backed.length + j];
      try {
        if (!ca?.owner.equals(pk(dbc.program))) return;
        const config = coder.decode<CurveConfig & { quoteMint: PublicKey }>(
          "poolConfig",
          ca.data,
        );
        if (!config.quoteMint.equals(pk(m.quoteMint))) return;
        // As readGraduation reads them.
        Object.assign(entry(m.pool), {
          airdrop: config.leftoverReceiver.equals(pk(REWARDS_WALLET)),
          volatilityFee: config.poolFees.dynamicFee.initialized !== 0,
        });
      } catch {
        /* Left out: no launch extras shown. */
      }
    });
  return facts;
}
export type TreasuryAction =
  | "collect"
  | "allocate"
  | "withdraw"
  | "redeem"
  | "sync";
export type TradeSide = "buy" | "sell";
export type PreparedTreasury = {
  action:
    | TreasuryAction
    | TradeSide
    | "launch"
    | "register"
    | "lp-deposit"
    | "lp-withdraw"
    | "lp-claim"
    | "lp-buy"
    | "lp-sell"
    | "reserve-deploy"
    | "reward-fund"
    | "reward-claim"
    | "reward-policy"
    | "reward-deliver"
    | "creator-claim"
    | "graduate";
  redeem?: { burn: string; payout: string; baseSymbol: string };
  /** A graduation: the curve fees collected first, in the stock's atoms. */
  graduation?: { fees: string };
  /** A collect-and-pay-out: stock atoms collected now, those already in the treasury, and where from. */
  payout?: { collect: string; waiting: string; source: "curve" | "pool" };
  rewards?: {
    description: string;
    allocations: { recipient: string; amount: string }[];
  };
  liquidity?: {
    symbolA?:string;symbolB?:string;decimalsA?:number;decimalsB?:number;
    // A claim has no slippage limits: limitA and limitB are "0".
    kind: "deposit" | "withdraw" | "claim";
    /** The pool adds its fees back into the pool (nothing to claim). */
    compounding?: boolean;
    a: string;
    b: string;
    limitA: string;
    limitB: string;
    pool: string;
    description: string;
  };
  market?: Market;
  title?: string;
  rentLamports?: number;
  // Further transactions signed in the same wallet approval and sent after
  // `transaction`, in order, each once the previous one confirms. They depend on
  // it (a launch's pool needs its config), so only `transaction` is simulated.
  bundle?: { transaction: string; action: PreparedTreasury["action"] }[];
  // A dev buy made in the same transaction that creates the pool.
  devBuy?: { quoteAmount: string; quote: string; tokens: string; percent: number };
  wallet: string;
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  expiresAt: number;
  raw: string;
  recipient: string;
  feeLamports: number;
  trade?: {
    inputSymbol: string;
    inputDecimals: number;
    outputSymbol: string;
    outputDecimals: number;
    expectedOut: string;
    minimumOut: string;
    slippageBps: number;
    tradingFee: string;
    protocolFee: string;
    rentLamports: number;
  };
};
// Sonata's platform wallet is the Vault's admin, read from chain once per session.
let adminCache: Promise<PublicKey> | null = null;
function vaultAdmin() {
  adminCache ??= (
    program.account as unknown as { vault: { fetch(a: PublicKey): Promise<{ admin: PublicKey }> } }
  ).vault
    .fetch(pk(exportsMarket.vault))
    .then((v) => v.admin)
    .catch((e) => {
      adminCache = null;
      throw e;
    });
  return adminCache;
}
// Meteora pays a swap's referrer 20% of its protocol fee (4% of the whole fee),
// in the stock, out of Meteora's own cut: the trader and the fee split are
// unchanged. Swaps built on this site name Sonata's platform wallet (the Vault
// admin) as referrer, through its token account for the stock, which also takes
// Sonata's share of distributions. Meteora requires that account to exist and
// hold that stock, or the whole swap fails, so anything else means no referrer.
const referrals = new Map<string, PublicKey>();
export async function sonataReferral(quoteMint: PublicKey): Promise<PublicKey | null> {
  const hit = referrals.get(quoteMint.toBase58());
  if (hit) return hit;
  try {
    const account = getAssociatedTokenAddressSync(quoteMint, await vaultAdmin(), false, TOKEN_2022_PROGRAM_ID);
    const info = await connection.getAccountInfo(account, "confirmed");
    if (!info?.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
    const token = unpackAccount(account, info, TOKEN_2022_PROGRAM_ID);
    if (!token.mint.equals(quoteMint) || token.isFrozen) return null;
    // Only a usable account is remembered, so one created later is picked up.
    referrals.set(quoteMint.toBase58(), account);
    return account;
  } catch {
    return null;
  }
}
export async function prepareTreasury(
  action: TreasuryAction,
  wallet: string,
  market: Market = exportsMarket,
  amount?: string,
): Promise<PreparedTreasury> {
  const owner = pk(wallet);
  if (!PublicKey.isOnCurve(owner.toBytes()))
    throw Error("Connect a signing wallet.");
  const state = await readTreasury(market);
  let raw = "0",
    recipient = market.treasury;
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
  );
  const claimIx = () =>
    program.methods
      .claim()
      .accounts({
        vault: pk(market.vault),
        treasury: pk(market.treasury),
        poolAuthority: pk(dbc.poolAuthority),
        config: pk(market.config),
        pool: pk(market.pool),
        treasuryBase: pk(market.treasuryBase),
        treasuryQuote: pk(market.treasuryQuote),
        baseVault: pk(market.baseVault),
        quoteVault: pk(market.quoteVault),
        baseMint: pk(market.baseMint),
        quoteMint: pk(market.quoteMint),
        tokenBaseProgram: TOKEN_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
        dbcEventAuthority: pk(dbc.eventAuthority),
        dbcProgram: pk(dbc.program),
      })
      .instruction();
  // Standard modes split each allocation with Sonata: the platform share goes to
  // the Vault admin's quote account, created here if it does not exist yet.
  const split = state.mode === "standard" || state.mode === "standardFloor";
  const distributeIx = async () => {
    if (!split)
      return program.methods
        .distribute()
        .accounts({
          treasury: pk(market.treasury),
          treasuryQuote: pk(market.treasuryQuote),
          payoutQuote: pk(market.payoutQuote),
          quoteMint: pk(market.quoteMint),
          tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction();
    const admin = await vaultAdmin();
    const platformQuote = getAssociatedTokenAddressSync(pk(market.quoteMint), admin, false, TOKEN_2022_PROGRAM_ID);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        platformQuote,
        admin,
        pk(market.quoteMint),
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    return program.methods
      .distributeSplit()
      .accountsPartial({
        vault: pk(market.vault),
        treasury: pk(market.treasury),
        treasuryQuote: pk(market.treasuryQuote),
        payoutQuote: pk(market.payoutQuote),
        platformQuote,
        quoteMint: pk(market.quoteMint),
        tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  };
  if (action === "collect") {
    if (state.migrated)
      throw Error("This pool migrated; the DAMM fee adapter is not connected.");
    if (BigInt(state.uncollected) <= 0n)
      throw Error("No new trading fees to collect.");
    raw = state.uncollected;
    tx.add(await claimIx());
  } else if (action === "allocate") {
    if (BigInt(state.unallocated) <= 0n)
      throw Error("Collect trading fees first.");
    raw = state.unallocated;
    recipient = market.payoutOwner;
    tx.add(await distributeIx());
  } else if (action === "sync") {
    // Collect and pay out in one signature: new fees from the curve (or, after
    // graduation, from Sonata's locked half of the pool) into the treasury, then
    // split by the market's mode. Both steps are permissionless; the caller
    // only pays the network fee.
    const pool = state.poolFees && "quote" in state.poolFees ? state.poolFees : null;
    if (state.migrated && !pool)
      throw Error(`Can't read the pool's fees: ${state.poolFees && "error" in state.poolFees ? state.poolFees.error : "pool not found"}.`);
    const uncollected = BigInt(state.uncollected),
      waiting = BigInt(state.unallocated);
    if (uncollected <= 0n && waiting <= 0n)
      throw Error("No new trading fees to collect yet.");
    raw = (uncollected + waiting).toString();
    recipient = market.treasury;
    if (uncollected > 0n && pool) {
      // claim_graduated pays any base-token fees into the treasury's base account.
      const treasuryBase = pk(market.treasuryBase);
      if (!(await connection.getAccountInfo(treasuryBase, "confirmed")))
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            owner,
            treasuryBase,
            pk(market.treasury),
            pk(market.baseMint),
            TOKEN_PROGRAM_ID,
          ),
        );
      tx.add(
        await program.methods
          .claimGraduated()
          .accountsPartial({
            vault: pk(market.vault),
            treasury: pk(market.treasury),
            dammPoolAuthority: pk(DAMM_POOL_AUTHORITY),
            dammPool: pk(pool.dammPool),
            position: pk(pool.position),
            treasuryBase,
            treasuryQuote: pk(market.treasuryQuote),
            tokenAVault: pk(pool.tokenAVault),
            tokenBVault: pk(pool.tokenBVault),
            baseMint: pk(market.baseMint),
            quoteMint: pk(market.quoteMint),
            positionNftAccount: pk(pool.positionNftAccount),
            tokenBaseProgram: TOKEN_PROGRAM_ID,
            tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
            dammEventAuthority: PublicKey.findProgramAddressSync(
              [Buffer.from("__event_authority")],
              pk(DAMM_V2_PROGRAM_ID),
            )[0],
          })
          .instruction(),
      );
    } else if (uncollected > 0n) tx.add(await claimIx());
    tx.add(await distributeIx());
    return {
      ...(await finalizeTransaction(tx, action, wallet, raw, recipient)),
      market,
      payout: {
        collect: uncollected.toString(),
        waiting: waiting.toString(),
        source: pool ? ("pool" as const) : ("curve" as const),
      },
    };
  }
  if (action === "redeem") {
    if (!hasFloor(state.mode))
      throw Error("This market is not a Backed token.");
    const burn = parseUnits(amount ?? "", 6);
    if (burn <= 0n) throw Error("Enter how many tokens to burn.");
    const holderBase = getAssociatedTokenAddressSync(pk(market.baseMint), owner);
    const info = await connection.getAccountInfo(holderBase, "confirmed");
    const held = info
      ? unpackAccount(holderBase, info, TOKEN_PROGRAM_ID).amount
      : 0n;
    if (burn > held) throw Error(`You hold fewer ${market.symbol} than that.`);
    // Same rounding as the program: floor * burn / supply, rounded down.
    const payout = (BigInt(state.floor) * burn) / BigInt(state.baseSupply);
    if (payout <= 0n)
      throw Error("Too few tokens to get any stock back yet.");
    raw = payout.toString();
    recipient = wallet;
    const holderQuote = getAssociatedTokenAddressSync(
      pk(market.quoteMint),
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const { BN } = browserAnchor as typeof import("@coral-xyz/anchor");
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        holderQuote,
        owner,
        pk(market.quoteMint),
        TOKEN_2022_PROGRAM_ID,
      ),
      await program.methods
        .redeem(new BN(burn.toString()))
        .accounts({
          treasury: pk(market.treasury),
          holder: owner,
          holderBase,
          holderQuote,
          treasuryQuote: pk(market.treasuryQuote),
          baseMint: pk(market.baseMint),
          quoteMint: pk(market.quoteMint),
          tokenBaseProgram: TOKEN_PROGRAM_ID,
          tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction(),
    );
    return {
      ...(await finalizeTransaction(tx, action, wallet, raw, recipient)),
      market,
      redeem: { burn: burn.toString(), payout: raw, baseSymbol: market.symbol },
    };
  }
  if (action === "withdraw") {
    if (hasFloor(state.mode))
      throw Error("The backing belongs to holders; the creator can never withdraw it.");
    if (state.mode === "standard" || state.mode === "refrain")
      throw Error("This market pays the creator directly; it has no reserve to withdraw.");
    if (wallet !== market.creator)
      throw Error("Only this market’s creator can withdraw its reserve.");
    const quantity = parseUnits(amount ?? "", 8);
    if (quantity > BigInt(state.available))
      throw Error("Amount exceeds the allocated creator reserve.");
    raw = quantity.toString();
    recipient = wallet;
    const ata = getAssociatedTokenAddressSync(
      pk(market.quoteMint),
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ata,
        owner,
        pk(market.quoteMint),
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    const { BN } = browserAnchor as typeof import("@coral-xyz/anchor");
    tx.add(
      await program.methods
        .withdrawRetained(new BN(raw))
        .accounts({
          treasury: pk(market.treasury),
          creator: owner,
          treasuryQuote: pk(market.treasuryQuote),
          creatorQuote: ata,
          quoteMint: pk(market.quoteMint),
          tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction(),
    );
  }
  return {
    ...(await finalizeTransaction(tx, action, wallet, raw, recipient)),
    market,
  };
}
export async function finalizeTransaction(
  tx: Transaction,
  action: PreparedTreasury["action"],
  wallet: string,
  raw: string,
  recipient: string,
  trade?: PreparedTreasury["trade"],
  signers: Keypair[] = [],
): Promise<PreparedTreasury> {
  const owner = pk(wallet);
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;
  const beforeBalance = await connection.getBalance(owner);
  const simulation = await connection.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    {
      sigVerify: false,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [wallet] },
    },
  );
  if (simulation.value.err)
    throw Error(
      `Transaction simulation failed: ${JSON.stringify(simulation.value.err)}. Check your Devnet SOL balance.`,
    );
  const fee = await connection.getFeeForMessage(tx.compileMessage());
  if (fee.value === null) throw Error("Unable to estimate network fee.");
  if (signers.length) tx.partialSign(...signers);
  return {
    action,
    wallet,
    transaction: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    ...latest,
    expiresAt: Date.now() + (trade ? 30000 : 60000),
    raw,
    recipient,
    feeLamports: fee.value,
    rentLamports: simulation.value.accounts?.[0]
      ? Math.max(
          0,
          beforeBalance - simulation.value.accounts[0].lamports - fee.value,
        )
      : undefined,
    trade,
  };
}
export async function treasuryReceipts(market: Market = exportsMarket) {
  await checkNetwork();
  const histories = await Promise.all(
    [market.treasury, market.pool].map((address) =>
      connection.getSignaturesForAddress(
        pk(address),
        { limit: 12 },
        "confirmed",
      ),
    ),
  );
  return [...new Map(histories.flat().map((r) => [r.signature, r])).values()]
    .sort((a, b) => b.slot - a.slot)
    .slice(0, 16);
}
export const explorer = (kind: "address" | "tx", value: string) =>
  `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
/** A DAMM v2 pool on Meteora's own Devnet site: swap, add liquidity, positions and pool stats. */
export const meteoraPool = (pool: string) => `https://devnet.meteora.ag/dammv2/${pool}`;

export async function readTradingWallet(
  wallet: string,
  market: Market = exportsMarket,
) {
  await checkNetwork();
  const owner = pk(wallet);
  const quote = getAssociatedTokenAddressSync(
    pk(market.quoteMint),
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const base = getAssociatedTokenAddressSync(
    pk(market.baseMint),
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const { value, context } = await connection.getMultipleAccountsInfoAndContext(
    [owner, quote, base],
    "confirmed",
  );
  const amount = (
    index: number,
    address: PublicKey,
    mint: string,
    tokenProgram: PublicKey,
  ) => {
    if (!value[index]) return "0";
    const account = unpackAccount(address, value[index], tokenProgram);
    if (
      !account.owner.equals(owner) ||
      !account.mint.equals(pk(mint)) ||
      account.isFrozen
    )
      throw Error("Unexpected wallet token account.");
    return account.amount.toString();
  };
  return {
    wallet,
    slot: context.slot,
    sol: String(value[0]?.lamports ?? 0),
    quote: amount(1, quote, market.quoteMint, TOKEN_2022_PROGRAM_ID),
    base: amount(2, base, market.baseMint, TOKEN_PROGRAM_ID),
    hasBase: !!value[2],
    hasQuote: !!value[1],
  };
}
/**
 * A wallet's SOL and its balances in many markets at once (the portfolio), in
 * one getMultipleAccounts per 100 accounts instead of one call per market.
 * Each market's entry has readTradingWallet's shape; the same checks apply.
 */
export async function readWalletBalances(
  wallet: string,
  markets: Pick<Market, "pool" | "quoteMint" | "baseMint">[],
  conn: Connection = connection,
) {
  await checkNetwork(conn);
  const owner = pk(wallet);
  const quoteOf = (mint: string) => getAssociatedTokenAddressSync(pk(mint), owner, false, TOKEN_2022_PROGRAM_ID);
  const baseOf = (mint: string) => getAssociatedTokenAddressSync(pk(mint), owner, false, TOKEN_PROGRAM_ID);
  const keys = [
    owner.toBase58(),
    ...new Set(markets.flatMap((m) => [quoteOf(m.quoteMint).toBase58(), baseOf(m.baseMint).toBase58()])),
  ];
  const read = await readAccounts(conn, keys.map((k) => [k]));
  const amount = (address: PublicKey, mint: string, tokenProgram: PublicKey) => {
    const info = read.info(address.toBase58());
    if (!info) return "0";
    const account = unpackAccount(address, info, tokenProgram);
    if (!account.owner.equals(owner) || !account.mint.equals(pk(mint)) || account.isFrozen)
      throw Error("Unexpected wallet token account.");
    return account.amount.toString();
  };
  const sol = String(read.info(owner.toBase58())?.lamports ?? 0);
  return new Map(
    markets.map((m) => {
      const quote = quoteOf(m.quoteMint),
        base = baseOf(m.baseMint);
      return [
        m.pool,
        {
          wallet,
          slot: read.minSlot,
          sol,
          quote: amount(quote, m.quoteMint, TOKEN_2022_PROGRAM_ID),
          base: amount(base, m.baseMint, TOKEN_PROGRAM_ID),
          hasBase: !!read.info(base.toBase58()),
          hasQuote: !!read.info(quote.toBase58()),
        },
      ] as const;
    }),
  );
}
// A curve trade's quote. Buys are partial fills: a buy larger than what the
// curve still needs takes only that (fee included) and completes the curve;
// the rest stays in the wallet. Without it, buying exactly the amount shown
// as left always fell a fee short, and the curve never finished.
async function curveQuote(side: TradeSide, raw: bigint, market: Market) {
  const { DynamicBondingCurveClient, getCurrentPoint, SwapMode } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const [virtualPool, config] = await Promise.all([
    client.state.getPool(pk(market.pool)),
    client.state.getPoolConfig(pk(market.config)),
  ]);
  if (!virtualPool || !config || !virtualPool.poolState.config.equals(pk(market.config)))
    throw Error("Pool quote is unavailable.");
  const { BN } = browserAnchor as typeof import("@coral-xyz/anchor");
  const mode = side === "buy" ? SwapMode.PartialFill : SwapMode.ExactIn;
  const quote = client.pool.swapQuote2({
    virtualPool,
    config,
    swapBaseForQuote: side === "sell",
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: await getCurrentPoint(connection, config.activationType),
    slippageBps: 50,
    swapMode: mode,
    amountIn: new BN(raw.toString()),
  } as Parameters<typeof client.pool.swapQuote2>[0]);
  const minimum = BigInt((quote.minimumAmountOut ?? quote.outputAmount).toString());
  if (minimum <= 0n) throw Error("Trade is too small to receive anything after fees.");
  return {
    client,
    mode,
    out: BigInt(quote.outputAmount.toString()),
    minimum,
    // The whole fee the trader pays, however Meteora splits its own cut with a referrer.
    fee:
      BigInt(quote.tradingFee.toString()) +
      BigInt(quote.protocolFee.toString()) +
      BigInt(quote.referralFee?.toString() ?? "0"),
    /** The input actually used, fee included: less than `raw` when a buy completes the curve. */
    used: BigInt(quote.includedFeeInputAmount.toString()),
    // DBC fees are numerators over 1e9.
    feeBps: Number(config.poolFees.baseFee.cliffFeeNumerator.toString()) / 100_000,
    dynamicFee: config.poolFees.dynamicFee.initialized !== 0,
  };
}

/** What a curve trade of `amount` returns now, after fees, for the swap box's estimate. */
export async function quoteTrade(side: TradeSide, amount: string, market: Market = exportsMarket) {
  const raw = parseUnits(amount, side === "buy" ? market.quoteDecimals : market.baseDecimals);
  if (raw <= 0n) throw Error("Enter an amount.");
  const { out, minimum, fee, used, feeBps, dynamicFee } = await curveQuote(side, raw, market);
  return { out, minimum, fee, used, feeBps, dynamicFee };
}

export async function prepareTrade(
  side: TradeSide,
  wallet: string,
  amount: string,
  market: Market = exportsMarket,
): Promise<PreparedTreasury> {
  const state = await readTreasury(market);
  if (state.migrated)
    throw Error("This market has graduated. Refresh to trade it in its Meteora pool.");
  const owner = pk(wallet);
  const raw = parseUnits(
    amount,
    side === "buy" ? market.quoteDecimals : market.baseDecimals,
  );
  const balances = await readTradingWallet(wallet, market);
  if (raw > BigInt(side === "buy" ? balances.quote : balances.base))
    throw Error("Insufficient test-token balance.");
  const quote = await curveQuote(side, raw, market);
  const { BN } = browserAnchor as typeof import("@coral-xyz/anchor");
  const tx = await quote.client.pool.swap2({
    owner,
    pool: pk(market.pool),
    swapBaseForQuote: side === "sell",
    // Sonata's collect mode is the stock (standard.ts), so buys and sells both pay it in the stock.
    referralTokenAccount: await sonataReferral(pk(market.quoteMint)),
    swapMode: quote.mode,
    amountIn: new BN(raw.toString()),
    minimumAmountOut: new BN(quote.minimum.toString()),
  } as Parameters<typeof quote.client.pool.swap2>[0]);
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
  );
  // Existing quote ATAs have mint-specific Token-2022 sizes; the SDK builds their creation instruction.
  const missingAccounts =
    Number(!balances.hasBase) + Number(!balances.hasQuote);
  const rentLamports = missingAccounts
    ? missingAccounts *
      (await connection.getMinimumBalanceForRentExemption(182))
    : 0;
  return finalizeTransaction(tx, side, wallet, quote.used.toString(), wallet, {
    inputSymbol: side === "buy" ? quoteSymbolOf(market.quoteMint) : market.symbol,
    inputDecimals: side === "buy" ? 8 : 6,
    outputSymbol: side === "buy" ? market.symbol : quoteSymbolOf(market.quoteMint),
    outputDecimals: side === "buy" ? 6 : 8,
    expectedOut: quote.out.toString(),
    minimumOut: quote.minimum.toString(),
    slippageBps: 50,
    tradingFee: quote.fee.toString(),
    protocolFee: "0",
    rentLamports,
  });
}

/**
 * Moves a market whose curve is full into its Meteora DAMM v2 pool, as Meteora
 * does on its own for mainnet launches. Anyone can do it. Uncollected curve
 * fees are collected first, in the same approval, while the pool can still pay
 * them; then the migration creates the pool and its two locked positions.
 */
export async function prepareGraduation(wallet: string, market: Market = exportsMarket): Promise<PreparedTreasury> {
  const owner = pk(wallet);
  const { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const [virtualPool, config] = await Promise.all([
    client.state.getPool(pk(market.pool)),
    client.state.getPoolConfig(pk(market.config)),
  ]);
  if (!virtualPool || !config || !virtualPool.poolState.config.equals(pk(market.config)))
    throw Error("Pool is unavailable.");
  const p = virtualPool.poolState;
  if (p.isMigrated !== 0) throw Error("This market has already graduated.");
  if (BigInt(p.quoteReserve.toString()) < BigInt(config.migrationQuoteThreshold.toString()))
    throw Error("The curve is not full yet.");
  // DBC MigrationProgress: 2 = LockedVesting, ready to create the DAMM v2 pool.
  if (p.migrationProgress !== 2) throw Error("The pool is not ready to graduate yet. Try again in a minute.");
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw Error("Unsupported migration fee option.");
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({
    payer: owner,
    pool: pk(market.pool),
    dammConfig,
  });
  const migrate = await finalizeTransaction(transaction, "graduate", wallet, "0", market.pool, undefined, [
    firstPositionNftKeypair,
    secondPositionNftKeypair,
  ]);
  const title = `Graduate ${market.symbol} to its Meteora pool`;
  const state = await readTreasury(market);
  if (BigInt(state.uncollected) <= 0n) return { ...migrate, market, title, graduation: { fees: "0" } };
  const collect = await prepareTreasury("collect", wallet, market);
  return {
    ...collect,
    action: "graduate",
    market,
    title,
    graduation: { fees: state.uncollected },
    bundle: [{ transaction: migrate.transaction, action: "graduate" }],
    feeLamports: collect.feeLamports + migrate.feeLamports,
    rentLamports: (collect.rentLamports ?? 0) + (migrate.rentLamports ?? 0),
  };
}

const exportsMarket = market;

// The Sonata program and its fee vault are fixed; the DBC config is not.
// Each launch creates its own config, so only the quote mint is constrained
// here, to a registered mock stock. That a config actually routes fees to the
// vault is verified onchain in readTreasury, which is the binding check.
export function validateMarketIdentity(value: Market) {
  for (const key of ["programId", "vault"] as const)
    if (value[key] !== exportsMarket[key])
      throw Error("Unsupported Sonata market configuration.");
  if (!quoteAssetList.some((a) => a.mint === value.quoteMint))
    throw Error("Unsupported quote asset for a Sonata market.");
  if (value.mode !== undefined && !MODES.includes(value.mode))
    throw Error("Unsupported treasury mode.");
  if (value.uri !== undefined && !isProfileUrl(value.uri))
    throw Error("Unsupported token profile location.");
  const [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), pk(value.pool).toBuffer()],
    program.programId,
  );
  if (treasury.toBase58() !== value.treasury)
    throw Error("Treasury address does not match the pool.");
}
const METAPLEX_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/** A mint's Metaplex metadata account, as the DBC SDK's deriveMintMetadata derives it. */
export function metadataAddress(mint: PublicKey | string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), pk(METAPLEX_PROGRAM).toBuffer(), new PublicKey(mint).toBuffer()],
    pk(METAPLEX_PROGRAM),
  )[0];
}
type TreasuryEntry = { publicKey: PublicKey; account: Treasury };
/** A registered pool that is not listed, and why (for logs and the market snapshot API). */
export type SkippedMarket = { pool: string; reason: string };
const QUOTE_MINTS = new Set(quoteAssetList.map((a) => a.mint));
// Only treasuries on a registered mock stock, in a mode the app knows, are considered.
const supportedTreasury = (t: Treasury) => QUOTE_MINTS.has(t.quoteMint.toBase58()) && modeOf(t.mode) !== null;
const errorText = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message || e.name || fallback : fallback;
/** Every supported treasury the program has registered (one getProgramAccounts). */
async function scanTreasuries(conn: Connection): Promise<TreasuryEntry[]> {
  const entries = await (
    programFor(conn).account as unknown as {
      treasury: { all(): Promise<TreasuryEntry[]> };
    }
  ).treasury.all();
  return entries.filter(({ account }) => supportedTreasury(account));
}
/**
 * Treasuries as scanTreasuries lists them, decoded from accounts read
 * elsewhere (the server's market snapshot): each must be owned by the
 * treasury program and decode as a treasury, or it is skipped.
 */
export function treasuryEntries(keys: string[], info: (key: string) => Info) {
  const entries: TreasuryEntry[] = [],
    skipped: SkippedMarket[] = [];
  for (const key of keys) {
    try {
      const ti = info(key);
      if (!ti?.owner.equals(program.programId)) throw Error("Treasury account is not owned by the Sonata program.");
      const account = program.coder.accounts.decode<Treasury>("treasury", ti.data);
      if (supportedTreasury(account)) entries.push({ publicKey: pk(key), account });
    } catch (e) {
      skipped.push({ pool: key, reason: errorText(e, "Treasury could not be read.") });
    }
  }
  return { entries, skipped };
}
/**
 * One market's accounts for its listing and card, read together: pool,
 * config, metadata, treasury, base mint, and the treasury's and payout
 * wallet's quote accounts (both derived from the treasury's own fields).
 */
function cardKeys({ publicKey, account: t }: TreasuryEntry) {
  return [
    t.pool,
    t.config,
    metadataAddress(t.baseMint),
    publicKey,
    t.baseMint,
    getAssociatedTokenAddressSync(t.quoteMint, publicKey, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(t.quoteMint, t.payoutOwner, true, TOKEN_2022_PROGRAM_ID),
  ].map((k) => k.toBase58());
}
/** Accounts every card needs once: the quote mints in use and the treasury program. */
const sharedCardKeys = (entries: TreasuryEntry[]) => [
  ...new Set(entries.map(({ account }) => account.quoteMint.toBase58())),
  exportsMarket.programId,
];
export const MAX_ACCOUNTS_PER_CALL = 100;
/**
 * Splits keys into getMultipleAccounts calls of at most 100: the shared keys
 * first, then each group whole, so one market's own accounts are read in one
 * call (at one slot). A key is read once: a group key an earlier call already
 * holds (a payout account two markets share, say) is not read again.
 */
export function accountBatches(groups: string[][], shared: string[] = []) {
  const batches: string[][] = [],
    seen = new Set<string>();
  let current: string[] = [];
  const add = (keys: string[]) => {
    for (const k of keys)
      if (!seen.has(k)) {
        seen.add(k);
        current.push(k);
      }
  };
  add(shared);
  for (const group of groups) {
    const fresh = [...new Set(group)].filter((k) => !seen.has(k));
    if (current.length && current.length + fresh.length > MAX_ACCOUNTS_PER_CALL) {
      batches.push(current);
      current = [];
    }
    add(fresh);
  }
  if (current.length) batches.push(current);
  return batches;
}
/** Reads the keys in accountBatches' calls, one after another. */
async function readAccounts(conn: Connection, groups: string[][], shared: string[] = []) {
  const infos = new Map<string, Info>(),
    slots = new Map<string, number>();
  let minSlot = Infinity;
  for (const batch of accountBatches(groups, shared)) {
    const { context, value } = await conn.getMultipleAccountsInfoAndContext(batch.map(pk), "confirmed");
    batch.forEach((k, i) => {
      infos.set(k, value[i]);
      slots.set(k, context.slot);
    });
    minSlot = Math.min(minSlot, context.slot);
  }
  const slot = Number.isFinite(minSlot) ? minSlot : 0;
  return {
    info: (k: string): Info => infos.get(k) ?? null,
    slotOf: (k: string) => slots.get(k) ?? slot,
    minSlot: slot,
  };
}
/**
 * The listing rule, used by every market list (the server snapshot, the
 * browser's own read and discoverMarkets): a market is listed only if its
 * Meteora config is Sonata's standard launch (liquidity the creator could
 * pull, a mintable token or hidden fees are never listed, even for a market
 * registered before the treasury program refused such configs), its pool is
 * a DBC pool, and its identity passes validateMarketIdentity (quote mint,
 * mode, treasury address, profile location). A registered market whose pool
 * cannot be verified is left out and reported in `skipped`; the others are
 * still listed. Reads nothing: `info` returns accounts already read.
 */
export function marketsFromAccounts(entries: TreasuryEntry[], info: (key: string) => Info) {
  const markets: Market[] = [],
    skipped: SkippedMarket[] = [];
  for (const { publicKey, account: t } of entries) {
    try {
      const configInfo = info(t.config.toBase58());
      if (!configInfo?.owner.equals(pk(dbc.program))) continue;
      if (
        standardConfigProblem(coder.decode<StandardConfigFields>("poolConfig", configInfo.data), exportsMarket.vault) !==
        null
      )
        continue;
      const poolInfo = info(t.pool.toBase58());
      if (!poolInfo?.owner.equals(pk(dbc.program))) throw Error("A registered pool could not be verified.");
      const decoded = coder.decode<Pool>("virtualPool", poolInfo.data),
        pool = decoded.poolState ?? decoded;
      let name = `Community ${t.baseMint.toBase58().slice(0, 6)}`,
        symbol = t.baseMint.toBase58().slice(0, 6),
        uri = "";
      const md = info(metadataAddress(t.baseMint).toBase58());
      if (
        md?.owner.equals(pk(METAPLEX_PROGRAM)) &&
        md.data.length > 69 &&
        new PublicKey(md.data.subarray(33, 65)).equals(t.baseMint)
      ) {
        let offset = 65;
        const read = () => {
          const length = md.data.readUInt32LE(offset);
          offset += 4;
          if (length > 200 || offset + length > md.data.length)
            throw Error("Invalid mint metadata.");
          const text = md.data
            .subarray(offset, offset + length)
            .toString("utf8")
            .replace(/\0/g, "");
          offset += length;
          return text;
        };
        try {
          name = read();
          symbol = read();
          uri = read();
        } catch {
          /* Address remains the asset identity. */
        }
      }
      const m: Market = {
        ...exportsMarket,
        name,
        symbol,
        config: t.config.toBase58(),
        quoteMint: t.quoteMint.toBase58(),
        pool: t.pool.toBase58(),
        treasury: publicKey.toBase58(),
        baseMint: t.baseMint.toBase58(),
        creator: t.creator.toBase58(),
        payoutOwner: t.payoutOwner.toBase58(),
        mode: modeOf(t.mode) ?? undefined,
        ...(isProfileUrl(uri) ? { uri } : {}),
        baseVault: pool.baseVault.toBase58(),
        quoteVault: pool.quoteVault.toBase58(),
        treasuryBase: getAssociatedTokenAddressSync(
          t.baseMint,
          publicKey,
          true,
        ).toBase58(),
        treasuryQuote: getAssociatedTokenAddressSync(
          t.quoteMint,
          publicKey,
          true,
          TOKEN_2022_PROGRAM_ID,
        ).toBase58(),
        payoutQuote: getAssociatedTokenAddressSync(
          t.quoteMint,
          t.payoutOwner,
          true,
          TOKEN_2022_PROGRAM_ID,
        ).toBase58(),
        traces:
          t.pool.toBase58() === exportsMarket.pool ? exportsMarket.traces : [],
      };
      validateMarketIdentity(m);
      markets.push(m);
    } catch (e) {
      skipped.push({ pool: t.pool.toBase58(), reason: errorText(e, "Market could not be verified.") });
    }
  }
  return { markets, skipped };
}
/** Every listed Sonata market: one getProgramAccounts and one getMultipleAccounts per 100 accounts. */
export async function discoverMarkets(conn: Connection = connection): Promise<Market[]> {
  await checkNetwork(conn);
  const entries = await scanTreasuries(conn);
  if (!entries.length) return [];
  const read = await readAccounts(
    conn,
    entries.map(({ account: t }) => [t.pool, t.config, metadataAddress(t.baseMint)].map((k) => k.toBase58())),
  );
  const { markets, skipped } = marketsFromAccounts(entries, read.info);
  // Nothing listed because nothing could be verified is an error, not an empty market.
  if (!markets.length && skipped.length) throw Error(skipped[0].reason);
  return markets;
}
/** A listed market and its card numbers (readTreasury's, without pool fees), or why they are unavailable. */
export type MarketCard = { market: Market; data: TreasuryState | null; error?: string };
/**
 * The listed markets with every card's numbers, from accounts already read:
 * the listing rule (marketsFromAccounts), then each market's checks and
 * numbers exactly as readTreasury computes them (treasuryFromAccounts). A
 * market whose checks fail is listed with `data: null` and the reason.
 */
export function cardsFromAccounts(
  entries: TreasuryEntry[],
  info: (key: string) => Info,
  slotOf: (key: string) => number,
) {
  const { markets, skipped } = marketsFromAccounts(entries, info);
  const cards = markets.map((market): MarketCard => {
    try {
      return {
        market,
        data: treasuryFromAccounts(
          market,
          TREASURY_ACCOUNTS.map((k) => info(market[k])),
          slotOf(market.pool),
        ),
      };
    } catch (e) {
      return { market, data: null, error: errorText(e, "Chain data unavailable") };
    }
  });
  return { cards, skipped };
}
/**
 * Every listed market with its card numbers in a few batched reads: one
 * getProgramAccounts, then each market's seven accounts plus the shared quote
 * mints and program in calls of up to 100 accounts (2 calls for 19 markets).
 * For display: anything that moves funds re-reads with readTreasury.
 */
export async function readMarketsAndCards(conn: Connection = connection) {
  await checkNetwork(conn);
  const entries = await scanTreasuries(conn);
  if (!entries.length) return { slot: 0, cards: [] as MarketCard[], skipped: [] as SkippedMarket[] };
  const read = await readAccounts(conn, entries.map(cardKeys), sharedCardKeys(entries));
  return { slot: read.minSlot, ...cardsFromAccounts(entries, read.info, read.slotOf) };
}
/** What identifies a market, as the server's market snapshot carries it; everything else is fixed or derived. */
export type MarketIdentity = Pick<
  Market,
  | "pool"
  | "treasury"
  | "config"
  | "baseMint"
  | "quoteMint"
  | "creator"
  | "payoutOwner"
  | "mode"
  | "baseVault"
  | "quoteVault"
  | "treasuryBase"
  | "treasuryQuote"
  | "payoutQuote"
  | "name"
  | "symbol"
  | "uri"
>;
const IDENTITY_KEYS = [
  "pool",
  "treasury",
  "config",
  "baseMint",
  "quoteMint",
  "creator",
  "payoutOwner",
  "baseVault",
  "quoteVault",
  "treasuryBase",
  "treasuryQuote",
  "payoutQuote",
] as const;
export function identityOf(m: MarketIdentity): MarketIdentity {
  return {
    pool: m.pool,
    treasury: m.treasury,
    config: m.config,
    baseMint: m.baseMint,
    quoteMint: m.quoteMint,
    creator: m.creator,
    payoutOwner: m.payoutOwner,
    mode: m.mode,
    baseVault: m.baseVault,
    quoteVault: m.quoteVault,
    treasuryBase: m.treasuryBase,
    treasuryQuote: m.treasuryQuote,
    payoutQuote: m.payoutQuote,
    name: m.name,
    symbol: m.symbol,
    ...(m.uri !== undefined ? { uri: m.uri } : {}),
  };
}
/**
 * A Market from identity fields received from elsewhere (the server's
 * snapshot). Only those fields are taken: program, vault, decimals, traces
 * and network are this build's own. The treasury address and its token
 * accounts are derived here and must match, and the identity must pass
 * validateMarketIdentity; otherwise this throws. Fields that cannot be derived
 * (config, mints, creator, payout owner, mode, vaults) are checked against
 * the chain by readTreasury before anything is signed.
 */
export function marketFromIdentity(id: MarketIdentity): Market {
  for (const key of IDENTITY_KEYS)
    if (typeof id[key] !== "string" || new PublicKey(id[key]).toBase58() !== id[key])
      throw Error(`Market ${key} is not an address.`);
  for (const key of ["name", "symbol"] as const)
    if (typeof id[key] !== "string" || id[key].length > 200) throw Error(`Market ${key} is invalid.`);
  if (id.uri !== undefined && typeof id.uri !== "string") throw Error("Market profile location is invalid.");
  const treasury = pk(id.treasury),
    quoteMint = pk(id.quoteMint);
  const m: Market = {
    ...exportsMarket,
    name: id.name,
    symbol: id.symbol,
    config: id.config,
    quoteMint: id.quoteMint,
    pool: id.pool,
    treasury: id.treasury,
    baseMint: id.baseMint,
    creator: id.creator,
    payoutOwner: id.payoutOwner,
    mode: id.mode,
    ...(id.uri !== undefined ? { uri: id.uri } : {}),
    baseVault: id.baseVault,
    quoteVault: id.quoteVault,
    treasuryBase: getAssociatedTokenAddressSync(pk(id.baseMint), treasury, true).toBase58(),
    treasuryQuote: getAssociatedTokenAddressSync(quoteMint, treasury, true, TOKEN_2022_PROGRAM_ID).toBase58(),
    payoutQuote: getAssociatedTokenAddressSync(quoteMint, pk(id.payoutOwner), true, TOKEN_2022_PROGRAM_ID).toBase58(),
    traces: id.pool === exportsMarket.pool ? exportsMarket.traces : [],
  };
  if (m.treasuryBase !== id.treasuryBase || m.treasuryQuote !== id.treasuryQuote || m.payoutQuote !== id.payoutQuote)
    throw Error("Market token accounts do not match its treasury.");
  if (m.mode === undefined) throw Error("Unsupported treasury mode.");
  validateMarketIdentity(m);
  return m;
}
export type LaunchCurve = {
  quote: string;
  initial: number;
  target: number;
  fee: number;
  floor?: boolean;
  // Optional first buy, in quote tokens.
  devBuy?: number;
  // Reward token: the creator's share is paid to holders by Sonata's payout bot.
  reward?: boolean;
  // Fee module: the creator's share runs this instead, also through the payout bot.
  module?: FeeModule;
} & CurveOptions;
export const FEE_MODULES = ["buyback", "topBuyers", "lpFarm", "split", "diamond"] as const;
export type FeeModule = (typeof FEE_MODULES)[number];
const MAX_TX_BYTES = 1232;
function txBytes(tx: Transaction, feePayer: PublicKey) {
  tx.feePayer = feePayer;
  tx.recentBlockhash = PublicKey.default.toBase58();
  const message = tx.compileMessage();
  return 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
}
// Rent for the accounts the pool and treasury transactions create, measured on
// Devnet (pool, mint, metadata, two vaults; treasury and its three token accounts),
// plus the buyer's token account for a dev buy. The config transaction's own rent
// comes from its simulation.
const POOL_AND_TREASURY_RENT = 25_480_000,
  DEV_BUY_ACCOUNT_RENT = 2_039_280;
export async function prepareLaunch(
  wallet: string,
  name: string,
  symbol: string,
  payout: string,
  curve: LaunchCurve,
  uri = "",
): Promise<PreparedTreasury> {
  await checkNetwork();
  if (uri && !isProfileUrl(uri))
    throw Error("Token profile must be published through Sonata first.");
  const asset = quoteAssetBySymbol(curve.quote);
  if (!asset)
    throw Error(
      `${curve.quote} has no Devnet mint yet, so it cannot back a launch.`,
    );
  // The vault is the fee claimer every Sonata config must name. Confirm it
  // is live before asking the creator to pay for a config account.
  const vaultInfo = await connection.getAccountInfo(pk(exportsMarket.vault));
  if (!vaultInfo?.owner.equals(program.programId))
    throw Error("Sonata fee authority is unavailable on this network.");
  if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{2,31}$/.test(name))
    throw Error(
      "Use a 3–32 character market name: letters, numbers, spaces, dots or hyphens.",
    );
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(symbol))
    throw Error("Use a 2–10 character uppercase ticker.");
  // Holder rewards and fee modules are paid by Sonata's payout bot, which reads the
  // module from the token's metadata, so a module launch must carry it.
  const botRun = !!curve.reward || !!curve.module;
  if (curve.module) {
    if (!uri) throw Error("A fee module is saved in the token's metadata, which did not upload. Try again.");
    const meta = (await fetch(`/api/token-meta?uri=${encodeURIComponent(uri)}`)
      .then((r) => r.json())
      .catch(() => null)) as { sonata?: { feeModel?: string; split?: { wallet: string }[] } } | null;
    if (meta?.sonata?.feeModel !== curve.module)
      throw Error("The token's metadata does not name this fee module. Try again.");
    // The metadata is permanent and the payout bot never pays a program, so a split
    // naming one would hold its share forever: refuse it before launch.
    if (curve.module === "split") {
      const wallets = (meta.sonata.split ?? []).map((r) => pk(r.wallet));
      if (!wallets.length) throw Error("The token's metadata has no split wallets. Try again.");
      const infos = await connection.getMultipleAccountsInfo(wallets);
      const bad = wallets.find((w, i) => !PublicKey.isOnCurve(w.toBytes()) || infos[i]?.executable);
      if (bad) throw Error(`Split: ${bad.toBase58()} is a program, not a wallet. Use normal wallets only.`);
    }
  }
  if (botRun) payout = REWARDS_WALLET;
  const owner = pk(wallet),
    recipient = pk(payout);
  if (!PublicKey.isOnCurve(recipient.toBytes()))
    throw Error("Choose a normal wallet as the fixed payout recipient.");
  const {
    DynamicBondingCurveClient,
    deriveDbcPoolAddress,
    deriveDbcTokenVaultAddress,
  } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const client = new DynamicBondingCurveClient(connection, "confirmed"),
    mint = Keypair.generate(),
    // Each launch owns its configuration, so the creator's curve and fee
    // choices are the deployed ones rather than a shared preset.
    config = Keypair.generate(),
    quoteMint = pk(asset.mint);
  const curveParams = await buildCurveParams(curve.initial, curve.target, curve.fee, {
    shape: curve.shape,
    volatility: curve.volatility,
    airdrop: curve.airdrop,
  });
  const pool = deriveDbcPoolAddress(quoteMint, mint.publicKey, config.publicKey);
  const [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), pool.toBuffer()],
    program.programId,
  );
  const m: Market = {
    ...exportsMarket,
    name,
    symbol,
    config: config.publicKey.toBase58(),
    quoteMint: asset.mint,
    quoteDecimals: asset.decimals,
    baseMint: mint.publicKey.toBase58(),
    pool: pool.toBase58(),
    treasury: treasury.toBase58(),
    creator: wallet,
    payoutOwner: payout,
    // Creator 50% / Sonata 50% of claimed fees, or creator 25% / floor 25% / Sonata 50%.
    mode: curve.floor && !botRun ? "standardFloor" : "standard",
    fee: curve.fee,
    feeModel: curve.module ?? (curve.reward ? "holders" : curve.floor ? "backed" : "standard"),
    ...(uri ? { uri } : {}),
    baseVault: deriveDbcTokenVaultAddress(pool, mint.publicKey).toBase58(),
    quoteVault: deriveDbcTokenVaultAddress(pool, quoteMint).toBase58(),
    treasuryBase: getAssociatedTokenAddressSync(
      mint.publicKey,
      treasury,
      true,
    ).toBase58(),
    treasuryQuote: getAssociatedTokenAddressSync(
      quoteMint,
      treasury,
      true,
      TOKEN_2022_PROGRAM_ID,
    ).toBase58(),
    payoutQuote: getAssociatedTokenAddressSync(
      quoteMint,
      recipient,
      false,
      TOKEN_2022_PROGRAM_ID,
    ).toBase58(),
    traces: [],
  };
  // Dev buy: the pool's very first trade, in the same transaction that creates the
  // pool, so nothing can trade before the creator.
  const devBuyAtoms =
    curve.devBuy && curve.devBuy > 0 ? BigInt(Math.round(curve.devBuy * 10 ** asset.decimals)) : 0n;
  let firstBuyParam:
    | { buyer: PublicKey; buyAmount: BN; minimumAmountOut: BN; referralTokenAccount: PublicKey | null }
    | undefined;
  let devBuy: PreparedTreasury["devBuy"];
  if (devBuyAtoms > 0n) {
    const balance = await connection
      .getTokenAccountBalance(getAssociatedTokenAddressSync(quoteMint, owner, false, TOKEN_2022_PROGRAM_ID))
      .catch(() => null);
    if (!balance || BigInt(balance.value.amount) < devBuyAtoms)
      throw Error(`Your wallet holds less than ${curve.devBuy} ${asset.symbol} for the first buy.`);
    const big = (v: { toString(): string }) => BigInt(v.toString());
    const quote = buyOut(
      devBuyAtoms,
      curve.fee,
      big(curveParams.sqrtStartPrice),
      curveParams.curve.map((c) => ({ sqrtPrice: big(c.sqrtPrice), liquidity: big(c.liquidity) })),
    );
    if (quote.unspent > 0n) throw Error("That first buy is larger than the whole curve. Buy less.");
    // A buy that fills the curve would graduate the token the moment it launches.
    if (devBuyAtoms - quote.fee >= big(curveParams.migrationQuoteThreshold))
      throw Error("That first buy would fill the curve and graduate the token at launch. Buy less.");
    const percent = Number((quote.out * 10_000n) / 10n ** 15n) / 100;
    if (percent > 75) throw Error("A first buy can take at most 75% of the supply. Buy less.");
    firstBuyParam = {
      buyer: owner,
      buyAmount: new BigNumber(devBuyAtoms.toString()),
      // Nothing trades before this buy, so the quote is exact; 0.5% covers rounding.
      minimumAmountOut: new BigNumber(((quote.out * 995n) / 1000n).toString()),
      referralTokenAccount: await sonataReferral(quoteMint),
    };
    devBuy = { quoteAmount: String(curve.devBuy), quote: asset.symbol, tokens: quote.out.toString(), percent };
  }
  // Three transactions in one approval: this launch's config; its pool with the
  // dev buy (atomic); then the treasury. Without an airdrop, leftoverReceiver matches
  // feeClaimer so any leftover supply also returns to the Sonata vault.
  const { createConfigTx, createPoolWithFirstBuyTx } = await client.partner.createConfigAndPoolWithFirstBuy({
    config: config.publicKey,
    feeClaimer: pk(exportsMarket.vault),
    // A Graduation Airdrop's held-back supply goes to Sonata's payout bot, which
    // withdraws it at graduation and airdrops it to holders.
    leftoverReceiver: pk(curve.airdrop ? REWARDS_WALLET : exportsMarket.vault),
    quoteMint,
    payer: owner,
    ...curveParams,
    preCreatePoolParam: {
      name,
      symbol,
      uri,
      poolCreator: owner,
      baseMint: mint.publicKey,
    },
    firstBuyParam,
  });
  const registrationTx = await registrationTransaction(owner, m);
  for (const tx of [createConfigTx, createPoolWithFirstBuyTx, registrationTx])
    if (txBytes(tx, owner) > MAX_TX_BYTES)
      throw Error("This launch is too large for one Solana transaction. Shorten the token name.");
  const prepared = await finalizeTransaction(
    createConfigTx,
    "launch",
    wallet,
    "0",
    m.pool,
    undefined,
    [config],
  );
  const later = (tx: Transaction, signers: Keypair[]) => {
    tx.feePayer = owner;
    tx.recentBlockhash = prepared.blockhash;
    if (signers.length) tx.partialSign(...signers);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  };
  return {
    ...prepared,
    bundle: [
      { transaction: later(createPoolWithFirstBuyTx, [mint]), action: "launch" },
      { transaction: later(registrationTx, []), action: "register" },
    ],
    feeLamports: prepared.feeLamports + 15_000,
    rentLamports:
      (prepared.rentLamports ?? 0) + POOL_AND_TREASURY_RENT + (devBuy ? DEV_BUY_ACCOUNT_RENT : 0),
    devBuy,
    market: m,
    title: `Launch ${symbol} / ${asset.symbol}`,
  };
}
// Registers the treasury for a launch's pool and creates its token accounts.
async function registrationTransaction(owner: PublicKey, m: Market) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(
    await program.methods
      .initTreasury({ [m.mode ?? "duet"]: {} }, pk(m.payoutOwner))
      .accounts({
        vault: pk(m.vault),
        treasury: pk(m.treasury),
        pool: pk(m.pool),
        config: pk(m.config),
        quoteMint: pk(m.quoteMint),
        baseMint: pk(m.baseMint),
        creator: owner,
        payer: owner,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );
  for (const [ata, authority, mint, token] of [
    [m.treasuryBase, m.treasury, m.baseMint, TOKEN_PROGRAM_ID],
    [m.treasuryQuote, m.treasury, m.quoteMint, TOKEN_2022_PROGRAM_ID],
    [m.payoutQuote, m.payoutOwner, m.quoteMint, TOKEN_2022_PROGRAM_ID],
  ] as const)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, pk(ata), pk(authority), pk(mint), token));
  return tx;
}
export async function prepareRegistration(
  wallet: string,
  m: Market,
): Promise<PreparedTreasury> {
  await checkNetwork();
  validateMarketIdentity(m);
  if (wallet !== m.creator)
    throw Error("Reconnect the wallet that created this pool.");
  const tx = await registrationTransaction(pk(wallet), m);
  return {
    ...(await finalizeTransaction(tx, "register", wallet, "0", m.treasury)),
    market: m,
    title: `Activate ${m.symbol} treasury`,
  };
}
// Composable reserve withdrawal. The destination is always the authenticated creator's ATA.
export async function reserveWithdrawal(
  wallet: string,
  m: Market,
  raw: bigint,
) {
  const state = await readTreasury(m);
  if (state.mode !== "duet")
    throw Error("Only markets with a creator reserve can deploy it.");
  if (wallet !== m.creator)
    throw Error("Only this market’s creator can deploy its reserve.");
  if (raw <= 0n || raw > BigInt(state.available))
    throw Error("Amount exceeds the allocated creator reserve.");
  const owner = pk(wallet),
    ata = getAssociatedTokenAddressSync(
      pk(m.quoteMint),
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  const { BN } = browserAnchor as typeof import("@coral-xyz/anchor");
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ata,
      owner,
      pk(m.quoteMint),
      TOKEN_2022_PROGRAM_ID,
    ),
    await program.methods
      .withdrawRetained(new BN(raw.toString()))
      .accounts({
        treasury: pk(m.treasury),
        creator: owner,
        treasuryQuote: pk(m.treasuryQuote),
        creatorQuote: ata,
        quoteMint: pk(m.quoteMint),
        tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction(),
  ];
}
