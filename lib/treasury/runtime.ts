import "../stockroom/polyfills.mjs";
import { Buffer } from "buffer";
import { type BN, type Idl } from "@coral-xyz/anchor";
import { browserAnchor } from "./anchor.mjs";
const { Program, BorshAccountsCoder, BN: BigNumber } =
  browserAnchor as typeof import("@coral-xyz/anchor");
import {
  Connection,
  PublicKey,
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
export const connection = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: createRpcFetch((input, init) => globalThis.fetch(input, init)),
});
const pk = (s: string) => new PublicKey(s),
  program = new Program(treasuryIdl as Idl, { connection }),
  coder = new BorshAccountsCoder(dbcIdl as Idl);
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
let checkedAt = 0;
let networkCheck: Promise<void> | null = null;
export async function checkNetwork() {
  if (Date.now() - checkedAt <= 60000) return;
  if (!networkCheck) networkCheck = (async () => {
    if ((await connection.getGenesisHash()) !== GENESIS) throw Error("Devnet verification failed.");
    checkedAt = Date.now();
  })().finally(() => { networkCheck = null; });
  await networkCheck;
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
export async function readTreasury(market: Market = exportsMarket) {
  validateMarketIdentity(market);
  await checkNetwork();
  const names = [
    "treasury",
    "pool",
    "config",
    "treasuryQuote",
    "payoutQuote",
    "quoteMint",
    "programId",
    "baseMint",
  ] as const;
  const result = await connection.getMultipleAccountsInfoAndContext(
    names.map((n) => pk(market[n])),
    "confirmed",
  );
  const [ta, pa, ca, tqa, pqa, qm, pr, bm] = result.value;
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
  const graduation = await readGraduation(pool, config, market, baseSupply);
  const poolFees =
    pool.isMigrated !== 0 && graduation.dammPool
      ? await readPoolFees(market, graduation.dammPool).catch((e) => ({
          error: e instanceof Error ? e.message : "Pool fees unavailable",
        }))
      : null;
  return {
    slot: result.context.slot,
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
    // After graduation the curve earns nothing more; Sonata's locked half of
    // the pool earns the fees instead, and "uncollected" is what it holds now.
    ...(poolFees && "quote" in poolFees ? { uncollected: poolFees.quote } : {}),
    poolFees,
  };
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
async function readPoolFees(market: Market, dammPool: string) {
  const cp = await import("@meteora-ag/cp-amm-sdk");
  const amm = new cp.CpAmm(connection);
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
const FEE_DENOMINATOR = 1_000_000_000n;
function withFee(remaining: bigint, config: CurveConfig) {
  if (remaining <= 0n) return 0n;
  let fee = BigInt(config.poolFees.baseFee.cliffFeeNumerator.toString());
  if (config.poolFees.dynamicFee.initialized !== 0) fee = (fee * 12n) / 10n;
  if (fee >= FEE_DENOMINATOR) return remaining;
  return (remaining * FEE_DENOMINATOR + (FEE_DENOMINATOR - fee - 1n)) / (FEE_DENOMINATOR - fee) + 1n;
}
// Graduation state from the pool and config already fetched above: no extra RPC.
async function readGraduation(
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
  let dammPool: string | null = null;
  if (migrated) {
    // DBC creates the DAMM v2 pool under the config matching the migration fee option.
    const { deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS } =
      await import("@meteora-ag/dynamic-bonding-curve-sdk");
    const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
    if (dammConfig)
      dammPool = deriveDammV2PoolAddress(
        dammConfig,
        pk(market.baseMint),
        pk(market.quoteMint),
      ).toBase58();
  }
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
export async function discoverMarkets(): Promise<Market[]> {
  await checkNetwork();
  const entries = await (
    program.account as unknown as {
      treasury: {
        all(): Promise<{ publicKey: PublicKey; account: Treasury }[]>;
      };
    }
  ).treasury.all();
  const quoteMints = new Set(quoteAssetList.map((a) => a.mint));
  const supported = entries.filter(
    ({ account: t }) =>
      quoteMints.has(t.quoteMint.toBase58()) && modeOf(t.mode) !== null,
  );
  if (!supported.length) return [];
  const [pools, configs] = await Promise.all([
    connection.getMultipleAccountsInfo(supported.map(({ account: t }) => t.pool)),
    connection.getMultipleAccountsInfo(supported.map(({ account: t }) => t.config)),
  ]);
  const { deriveMintMetadata, METAPLEX_PROGRAM_ID } =
    await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const metadata = await connection.getMultipleAccountsInfo(
    supported.map(({ account: t }) => deriveMintMetadata(t.baseMint)),
  );
  // A market whose Meteora config is not Sonata's standard launch (liquidity the
  // creator could pull, a mintable token, hidden fees) is never listed, even if
  // it was registered before the treasury program refused such configs.
  const standard = supported.map((_, i) => {
    const info = configs[i];
    if (!info?.owner.equals(pk(dbc.program))) return false;
    return standardConfigProblem(coder.decode<StandardConfigFields>("poolConfig", info.data), exportsMarket.vault) === null;
  });
  return supported.filter((_, i) => standard[i]).map(({ publicKey, account: t }) => {
    const i = supported.findIndex((e) => e.publicKey.equals(publicKey));
    const info = pools[i];
    if (!info?.owner.equals(pk(dbc.program)))
      throw Error("A registered pool could not be verified.");
    const decoded = coder.decode<Pool>("virtualPool", info.data),
      pool = decoded.poolState ?? decoded;
    let name = `Community ${t.baseMint.toBase58().slice(0, 6)}`,
      symbol = t.baseMint.toBase58().slice(0, 6),
      uri = "";
    const md = metadata[i];
    if (
      md?.owner.equals(METAPLEX_PROGRAM_ID) &&
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
    return m;
  });
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
