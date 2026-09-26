// The creator's share of a graduated Sonata market's locked DAMM v2 liquidity.
//
// At migration DBC splits the pool's liquidity by the config's percentages and
// creates up to two DAMM v2 positions: the larger share goes in the first
// position, the other in a second one (on a tie the creator's comes first).
// It permanently locks each position's locked share, then hands the creator's
// position NFT to the virtual pool's creator and the partner's to the config's
// fee claimer (the Sonata Vault). A permanent lock stops withdrawal, not fee
// claims: DAMM v2 claim_position_fee only checks that the signer holds the NFT.
//
// Top-level imports stay node-loadable (no JSON, no extensionless relative
// imports) so protocol/scripts/verify-creator-position.mjs can run
// this exact code against Devnet. The app runtime is imported lazily.
import "../polyfills.mjs";
import {
  ComputeBudgetProgram,
  PublicKey,
  type Connection,
  type Transaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import type { PoolState, PositionState } from "@meteora-ag/cp-amm-sdk";
import type { Market, PreparedTreasury } from "../treasury/runtime";

const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
// DBC MigrationProgress: 3 = CreatedPool, the DAMM v2 pool and positions exist.
const CREATED_POOL = 3;
const pk = (s: string) => new PublicKey(s);

// Only the fields these reads need, so a proof script can pass a plain object.
export type MarketRef = Pick<
  Market,
  "pool" | "config" | "baseMint" | "quoteMint" | "vault" | "symbol"
> &
  Partial<Pick<Market, "baseDecimals" | "quoteDecimals">>;

/** part / whole in basis points, rounded down. */
export function shareBps(part: bigint, whole: bigint): number {
  if (part <= 0n || whole <= 0n) return 0;
  return Number((part * 10_000n) / whole);
}

/**
 * Basis points of every trading fee in the pool that a position earns. DAMM v2
 * keeps protocolFeePercent of each fee for the protocol; compoundingFeeBps of
 * the rest stays in the reserves; the remainder is claimable pro rata to
 * liquidity. Rounded down.
 */
export function feeShareBps(
  positionLiquidity: bigint,
  poolLiquidity: bigint,
  protocolFeePercent: number,
  compoundingFeeBps: number,
): number {
  if (
    !Number.isInteger(protocolFeePercent) ||
    protocolFeePercent < 0 ||
    protocolFeePercent > 100 ||
    !Number.isInteger(compoundingFeeBps) ||
    compoundingFeeBps < 0 ||
    compoundingFeeBps > 10_000
  )
    throw Error("Unexpected DAMM v2 fee split.");
  if (positionLiquidity <= 0n || poolLiquidity <= 0n) return 0;
  // position/pool * (100-p)/100 * (10000-c)/10000 * 10000
  return Number(
    (positionLiquidity *
      BigInt(100 - protocolFeePercent) *
      BigInt(10_000 - compoundingFeeBps)) /
      (poolLiquidity * 100n),
  );
}

/** "40.0%" from basis points. */
export const formatBps = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/** How much of the migrated liquidity the creator was configured to receive. */
export function creatorShareLabel(percent: number) {
  return percent === 50 ? "half" : percent === 100 ? "all" : `${percent}%`;
}

type Liquidity = { permanent: bigint; unlocked: bigint; vested: bigint };
const total = (p: Liquidity) => p.permanent + p.unlocked + p.vested;

/**
 * DBC's creator position is the permanently locked one. If the creator also
 * added ordinary liquidity to the same pool, prefer the most locked position,
 * then the largest.
 */
export function pickCreatorPosition<T extends Liquidity>(candidates: T[]) {
  const held = candidates.filter((c) => total(c) > 0n);
  held.sort((a, b) =>
    a.permanent !== b.permanent
      ? a.permanent > b.permanent
        ? -1
        : 1
      : total(a) === total(b)
        ? 0
        : total(a) > total(b)
          ? -1
          : 1,
  );
  return held[0] ?? null;
}

const networkChecks = new WeakMap<Connection, number>();
async function verifyDevnet(connection: Connection) {
  const at = networkChecks.get(connection);
  if (at && Date.now() - at < 60_000) return;
  if ((await connection.getGenesisHash()) !== GENESIS)
    throw Error("Devnet verification failed.");
  networkChecks.set(connection, Date.now());
}

type VirtualPoolState = {
  config: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  isMigrated: number;
  migrationProgress: number;
};
type DbcConfig = {
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  migrationFeeOption: number;
  creatorPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
  creatorLiquidityVestingInfo: { vestingPercentage: number };
};

export type CreatorPositionRead = {
  slot: number;
  readAt: number;
  dbcPool: string;
  dammPool: string;
  /** The DBC pool creator: DBC hands the creator position NFT to this wallet. */
  owner: string;
  /** Creator's configured share of migrated liquidity, all kinds, in percent. */
  creatorPercent: number;
  /** The permanently locked part of that share, in percent. */
  creatorLockedPercent: number;
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;
  tokenBVault: string;
  tokenAProgram: string;
  tokenBProgram: string;
  poolLiquidity: string;
  /** Null when the creator's wallet no longer holds the position NFT. */
  position: null | {
    address: string;
    nftMint: string;
    nftAccount: string;
    liquidity: string;
    permanentLockedLiquidity: string;
    unlockedLiquidity: string;
    vestedLiquidity: string;
    /** Permanently locked share of this position's liquidity. */
    lockedBps: number;
    /** This position's share of the pool's liquidity. */
    poolShareBps: number;
    /** Share of every trading fee in the pool this position earns. */
    feeShareBps: number;
    unclaimedA: string;
    unclaimedB: string;
    claimedA: string;
    claimedB: string;
  };
};

async function sdks() {
  const [cp, dbc] = await Promise.all([
    import("@meteora-ag/cp-amm-sdk"),
    import("@meteora-ag/dynamic-bonding-curve-sdk"),
  ]);
  return { cp, dbc };
}

// getMultipleAccounts takes at most 100 keys per call.
async function accountsInChunks(connection: Connection, keys: PublicKey[]) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100)
    out.push(
      await connection.getMultipleAccountsInfoAndContext(
        keys.slice(i, i + 100),
        "confirmed",
      ),
    );
  return out;
}

/**
 * The creator's DAMM v2 position for a graduated Sonata market, with its
 * unclaimed fees and locked liquidity. The pool is derived exactly as DBC
 * derives it (the DAMM v2 config of the market's migration fee option); the
 * position is found among the creator's position NFTs.
 */
export async function findCreatorPosition(
  connection: Connection,
  market: MarketRef,
): Promise<CreatorPositionRead> {
  await verifyDevnet(connection);
  const { cp, dbc } = await sdks();
  if (!dbc.DAMM_V2_PROGRAM_ID.equals(cp.CP_AMM_PROGRAM_ID))
    throw Error("DBC migrates to an unexpected DAMM v2 program.");
  const dbcCoder = new dbc.DynamicBondingCurveClient(connection, "confirmed")
    .pool.program.coder.accounts;
  const amm = new cp.CpAmm(connection);

  const [poolInfo, configInfo] = await connection.getMultipleAccountsInfo(
    [pk(market.pool), pk(market.config)],
    "confirmed",
  );
  if (
    !poolInfo?.owner.equals(dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
    !configInfo?.owner.equals(dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID)
  )
    throw Error("Market accounts are not owned by Meteora DBC.");
  const decoded = dbcCoder.decode<{ poolState?: VirtualPoolState } & VirtualPoolState>(
    "virtualPool",
    poolInfo.data,
  );
  const vp = decoded.poolState ?? decoded;
  const config = dbcCoder.decode<DbcConfig>("poolConfig", configInfo.data);
  if (
    !vp.config.equals(pk(market.config)) ||
    !vp.baseMint.equals(pk(market.baseMint)) ||
    !config.quoteMint.equals(pk(market.quoteMint)) ||
    !config.feeClaimer.equals(pk(market.vault))
  )
    throw Error("Pool configuration does not match this market.");
  if (vp.isMigrated !== 1 || vp.migrationProgress !== CREATED_POOL)
    throw Error("This market has not graduated to DAMM v2 yet.");

  const dammConfig = dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) throw Error("Unsupported migration fee option.");
  const dammPool = dbc.deriveDammV2PoolAddress(
    dammConfig,
    pk(market.baseMint),
    pk(market.quoteMint),
  );
  const owner = vp.creator;

  // Position NFTs are Token-2022 tokens with supply 1.
  const held = await connection.getTokenAccountsByOwner(
    owner,
    { programId: TOKEN_2022_PROGRAM_ID },
    "confirmed",
  );
  const nfts = held.value
    .map(({ pubkey, account }) => ({
      nftAccount: pubkey,
      token: unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID),
    }))
    .filter(({ token }) => token.amount === 1n && token.owner.equals(owner));
  const positionKeys = nfts.map(({ token }) => cp.derivePositionAddress(token.mint));
  const results = await accountsInChunks(connection, [dammPool, ...positionKeys]);
  const slot = Math.min(...results.map((r) => r.context.slot));
  const [poolAccount, ...positionAccounts] = results.flatMap((r) => r.value);
  if (!poolAccount?.owner.equals(cp.CP_AMM_PROGRAM_ID))
    throw Error("Graduated DAMM v2 pool not found.");
  const pool = amm._program.coder.accounts.decode<PoolState>("pool", poolAccount.data);
  if (
    !pool.tokenAMint.equals(pk(market.baseMint)) ||
    !pool.tokenBMint.equals(pk(market.quoteMint))
  )
    throw Error("DAMM v2 pool does not hold this market's tokens.");

  const candidates = positionAccounts.flatMap((info, i) => {
    if (!info?.owner.equals(cp.CP_AMM_PROGRAM_ID)) return [];
    const state = amm._program.coder.accounts.decode<PositionState>(
      "position",
      info.data,
    );
    if (!state.pool.equals(dammPool) || !state.nftMint.equals(nfts[i].token.mint))
      return [];
    return [
      {
        address: positionKeys[i],
        nftAccount: nfts[i].nftAccount,
        state,
        permanent: BigInt(state.permanentLockedLiquidity.toString()),
        unlocked: BigInt(state.unlockedLiquidity.toString()),
        vested: BigInt(state.vestedLiquidity.toString()),
      },
    ];
  });
  const chosen = pickCreatorPosition(candidates);
  const poolLiquidity = BigInt(pool.liquidity.toString());
  let position: CreatorPositionRead["position"] = null;
  if (chosen) {
    const liquidity = total(chosen);
    const fees = cp.getUnClaimLpFee(pool, chosen.state);
    position = {
      address: chosen.address.toBase58(),
      nftMint: chosen.state.nftMint.toBase58(),
      nftAccount: chosen.nftAccount.toBase58(),
      liquidity: liquidity.toString(),
      permanentLockedLiquidity: chosen.permanent.toString(),
      unlockedLiquidity: chosen.unlocked.toString(),
      vestedLiquidity: chosen.vested.toString(),
      lockedBps: shareBps(chosen.permanent, liquidity),
      poolShareBps: shareBps(liquidity, poolLiquidity),
      feeShareBps: feeShareBps(
        liquidity,
        poolLiquidity,
        pool.poolFees.protocolFeePercent,
        pool.poolFees.compoundingFeeBps,
      ),
      unclaimedA: fees.feeTokenA.toString(),
      unclaimedB: fees.feeTokenB.toString(),
      claimedA: chosen.state.metrics.totalClaimedAFee.toString(),
      claimedB: chosen.state.metrics.totalClaimedBFee.toString(),
    };
  }
  return {
    slot,
    readAt: Date.now(),
    dbcPool: market.pool,
    dammPool: dammPool.toBase58(),
    owner: owner.toBase58(),
    creatorPercent:
      config.creatorPermanentLockedLiquidityPercentage +
      config.creatorLiquidityPercentage +
      config.creatorLiquidityVestingInfo.vestingPercentage,
    creatorLockedPercent: config.creatorPermanentLockedLiquidityPercentage,
    tokenAMint: pool.tokenAMint.toBase58(),
    tokenBMint: pool.tokenBMint.toBase58(),
    tokenAVault: pool.tokenAVault.toBase58(),
    tokenBVault: pool.tokenBVault.toBase58(),
    tokenAProgram: cp.getTokenProgram(pool.tokenAFlag).toBase58(),
    tokenBProgram: cp.getTokenProgram(pool.tokenBFlag).toBase58(),
    poolLiquidity: poolLiquidity.toString(),
    position,
  };
}

const amount = (raw: bigint, decimals: number) => {
  const scale = 10n ** BigInt(decimals),
    fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${raw / scale}${fraction ? `.${fraction}` : ""}`;
};

/**
 * Unsigned legacy transaction that claims the creator position's trading fees
 * into the owner's own associated token accounts, created idempotently. The
 * owner is the fee payer and the only signer. Liquidity stays locked.
 */
export async function buildCreatorClaim(
  connection: Connection,
  wallet: string,
  market: MarketRef,
  quoteSymbol = "quote tokens",
): Promise<{
  transaction: Transaction;
  description: string;
  read: CreatorPositionRead;
  /** Unclaimed quote-token fees at build time; the claim takes at least this. */
  raw: string;
  recipient: string;
}> {
  const read = await findCreatorPosition(connection, market);
  if (read.owner !== wallet)
    throw Error("Only the wallet that created this market owns its graduated pool position.");
  const p = read.position;
  if (!p) throw Error("The creator position NFT is no longer in this wallet.");
  const a = BigInt(p.unclaimedA),
    b = BigInt(p.unclaimedB);
  if (a === 0n && b === 0n) throw Error("No trading fees to claim yet.");
  const { CpAmm } = await import("@meteora-ag/cp-amm-sdk");
  const owner = pk(wallet);
  // claimPositionFee2 prepends idempotent ATA creation for both tokens.
  const transaction = await new CpAmm(connection).claimPositionFee2({
    owner,
    receiver: owner,
    feePayer: owner,
    pool: pk(read.dammPool),
    position: pk(p.address),
    positionNftAccount: pk(p.nftAccount),
    tokenAMint: pk(read.tokenAMint),
    tokenBMint: pk(read.tokenBMint),
    tokenAVault: pk(read.tokenAVault),
    tokenBVault: pk(read.tokenBVault),
    tokenAProgram: pk(read.tokenAProgram),
    tokenBProgram: pk(read.tokenBProgram),
  });
  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
  );
  transaction.feePayer = owner;
  const parts = [
    ...(a > 0n ? [`${amount(a, market.baseDecimals ?? 6)} ${market.symbol}`] : []),
    ...(b > 0n ? [`${amount(b, market.quoteDecimals ?? 8)} ${quoteSymbol}`] : []),
  ];
  return {
    transaction,
    read,
    raw: b.toString(),
    recipient: wallet,
    description: `Claim ${parts.join(" and ")} of trading fees earned by your permanently locked DAMM v2 position. The liquidity stays locked; fees go to your own token accounts, created if missing.`,
  };
}

export const CREATOR_CLAIM_ACTION: PreparedTreasury["action"] = "creator-claim";

/** Review-ready claim for the app's execute() flow. */
export async function prepareCreatorClaim(
  wallet: string,
  market: Market,
): Promise<PreparedTreasury> {
  const [runtime, { quoteSymbolOf }] = await Promise.all([
    import("../treasury/runtime"),
    import("../treasury/quote-assets"),
  ]);
  await runtime.checkNetwork();
  runtime.validateMarketIdentity(market);
  const quote = quoteSymbolOf(market.quoteMint);
  const built = await buildCreatorClaim(runtime.connection, wallet, market, quote);
  const prepared = await runtime.finalizeTransaction(
    built.transaction,
    CREATOR_CLAIM_ACTION,
    wallet,
    built.raw,
    built.recipient,
  );
  return {
    ...prepared,
    market,
    title: `Claim ${market.symbol} pool fees`,
  };
}
