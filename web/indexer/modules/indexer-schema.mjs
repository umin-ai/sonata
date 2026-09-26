// The trade indexer's own schema additions (indexer/index.mjs runs
// migrateIndexerSchema at start, after migrate()) and the queries the crank's
// fee modules read them with (through its ledger, indexer/rewards.mjs).
//
//   trades.trader     the wallet that signed the swap (its `payer` account,
//                     indexer/parse.mjs), not the fee payer. Rows indexed
//                     before that change hold the fee payer; they are not
//                     rewritten (the two are the same for the app's trades).
//
//   trades.venue      'dbc' (the bonding curve) or 'damm' (the Meteora DAMM v2
//                     pool the market graduated to). Both are filed under the
//                     market's DBC pool, so charts, volume, the Top Buyer Bounty
//                     and Diamond Hands' tenure see one market across graduation.
//   pools.damm_pool   the graduated DAMM v2 pool, recorded once the indexer sees
//                     the DBC pool migrate; damm_last_signature is its own
//                     cursor. One DAMM v2 pool belongs to one market.
//   pools.synced_at, pools.synced_through (and damm_synced_*) the last sync of
//                     that address that completed without error: when that
//                     address's own sync started (before any of its reads),
//                     and the block_time of the newest signature it processed
//                     (for operators; progress does not rely on it, see below).
//
// Progress: every trade with block_time before indexProgress(row) is in the
// trades table. A sync that completed has read every signature confirmed
// before it started, so an address is complete up to that start less
// HEAD_LAG_SECONDS (confirmation, RPC node lag and block-time drift). That also
// holds for a quiet pool, whose newest block_time can be days old. Each
// address is stamped with its own start, so one read late in a long loop is as
// current as one read first. A market is as far as its slowest address, and
// has no progress until each has completed once: an address that never has (a
// DAMM v2 pool just found) backfills at most BACKFILL_TRANSACTIONS per loop
// (indexer/index.mjs) and is stamped only once it has caught up. Until its
// DAMM v2 pool is recorded, a market's DBC stamp also stands for its DAMM v2
// trades, so the indexer stamps it only when the pool's account, read after
// the sync's start, is still on the curve (no DAMM v2 trade can be older);
// once the pool has migrated, synced_at stays where it was until the DAMM v2
// pool is recorded. (The newest block_time is not a safe bound there: the DBC
// pool's own history can move past the migration within one loop.)

export const HEAD_LAG_SECONDS = 60;

/** Idempotent: safe on every start, on a database of any earlier version. */
export async function migrateIndexerSchema(db) {
  await db.query(`
    alter table trades add column if not exists venue text not null default 'dbc' check (venue in ('dbc', 'damm'));
    alter table pools add column if not exists synced_through timestamptz;
    alter table pools add column if not exists synced_at timestamptz;
    alter table pools add column if not exists damm_pool text;
    alter table pools add column if not exists damm_last_signature text;
    alter table pools add column if not exists damm_synced_through timestamptz;
    alter table pools add column if not exists damm_synced_at timestamptz;
    create unique index if not exists pools_damm_pool on pools (damm_pool);
  `);
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The unix second before which every trade of the market is indexed, from its
 * pools row (synced_at and damm_synced_at in unix seconds, and damm_pool), or
 * null if unknown.
 */
export function indexProgress(row, { lag = HEAD_LAG_SECONDS } = {}) {
  if (!row) return null;
  const dbc = num(row.synced_at);
  if (dbc === null) return null;
  if (row.damm_pool == null) return Math.floor(dbc - lag);
  const damm = num(row.damm_synced_at);
  return damm === null ? null : Math.floor(Math.min(dbc, damm) - lag);
}

/** indexProgress for a pool, read from the database (pg Pool or anything with pg's query()). */
export async function indexedThrough(db, pool) {
  const { rows: [row] } = await db.query(
    `select extract(epoch from synced_at)::float8 as synced_at, damm_pool, extract(epoch from damm_synced_at)::float8 as damm_synced_at
       from pools where pool = $1`,
    [pool],
  );
  return indexProgress(row);
}

// Rows buyerNets returns by default: far more than the three winners, so
// excluded addresses and non-wallets near the top cannot push a winner out.
export const BUYER_NETS_LIMIT = 200;

/**
 * Net base bought (`base`: base bought − base sold) and net quote spent
 * (`net`: quote spent on buys − quote received from sells) per trader on the
 * market in [start, end) unix seconds, both venues, for traders whose net
 * base is positive, most base first (ties by address). Amounts are bigint.
 */
export async function buyerNets(db, pool, start, end, limit = BUYER_NETS_LIMIT) {
  const { rows } = await db.query(
    `select trader,
            sum(case when side = 'buy' then quote_amount else -quote_amount end)::text as net,
            sum(case when side = 'buy' then base_amount else -base_amount end)::text as base
       from trades
      where pool = $1 and block_time >= to_timestamp($2) and block_time < to_timestamp($3)
      group by trader
     having sum(case when side = 'buy' then base_amount else -base_amount end) > 0
      order by sum(case when side = 'buy' then base_amount else -base_amount end) desc, trader
      limit $4`,
    [pool, start, end, limit],
  );
  return rows.map((r) => ({ trader: r.trader, net: BigInt(r.net), base: BigInt(r.base) }));
}

/**
 * Each of `traders`' signed net base (base bought − base sold, both venues)
 * on the market in [start, end) unix seconds: a Map trader → bigint, 0n for
 * a trader with no trades there. No filter on sign or quote, and no limit.
 */
export async function netBase(db, pool, traders, start, end) {
  const out = new Map(traders.map((t) => [t, 0n]));
  if (!traders.length) return out;
  const { rows } = await db.query(
    `select trader, sum(case when side = 'buy' then base_amount else -base_amount end)::text as base
       from trades
      where pool = $1 and trader = any($2::text[]) and block_time >= to_timestamp($3) and block_time < to_timestamp($4)
      group by trader`,
    [pool, traders, start, end],
  );
  for (const r of rows) out.set(r.trader, BigInt(r.base));
  return out;
}
