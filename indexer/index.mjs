// Sonata trade indexer: reads every swap on Sonata's markets from Solana Devnet
// into PostgreSQL (Meteora DBC swaps on the curve, and Meteora DAMM v2 swaps in
// the pool a market graduates to, filed under the market's DBC pool), and
// serves read-only market data over HTTP (charts, recent trades, 24h stats,
// payouts). The chain stays the source of truth; the app re-reads anything
// involving money from chain before offering a signature.
//
// Env: DATABASE_URL (required), SOLANA_RPC_URL (default: public Devnet),
//      INDEXER_PORT (default 8790), INDEXER_POLL_MS (default 20000).
import http from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { DAMM_PROGRAM, DBC_PROGRAM, decodeDammTrades, decodeTrades, SUPPLY_TOKENS } from "./parse.mjs";
import { splitRecipients } from "./modules/split.mjs";
import { parseKey } from "./modules/common.mjs";
import { amm, dbcClient, graduatedPool } from "./modules/meteora.mjs";
import { migrateIndexerSchema } from "./modules/indexer-schema.mjs";
import { LP_SNAPSHOT_KEEP_SECONDS } from "./modules/lp-farm.mjs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PORT = Number(process.env.INDEXER_PORT || 8790);
const POLL_MS = Number(process.env.INDEXER_POLL_MS || 20_000);
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
// Printed once every table and column is in place (migrate() and
// migrateIndexerSchema()); deploy/lightsail/setup.sh waits for it.
export const MIGRATED_LINE = "indexer migrated";
const treasuryIdl = JSON.parse(
  readFileSync(new URL("../lib/treasury/stockroom_treasury.json", import.meta.url), "utf8"),
);
const TREASURY_PROGRAM = new PublicKey(treasuryIdl.address);
const TREASURY_DISCRIMINATOR = Buffer.from(
  treasuryIdl.accounts.find((a) => a.name === "Treasury").discriminator,
);

// Neither connects until used, so importing this file (tests) opens nothing.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
// Our own backoff handles the public RPC's rate limits.
const conn = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true });
const SPACING_MS = Number(process.env.INDEXER_SPACING_MS || 350);
const state = { startedAt: new Date().toISOString(), lastSync: null, lastError: null, pools: 0, trades: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function migrate() {
  await db.query(`
    create table if not exists pools (
      pool text primary key,
      treasury text not null,
      last_signature text,
      updated_at timestamptz not null default now()
    );
    create table if not exists trades (
      signature text not null,
      ix_index int not null,
      pool text not null,
      slot bigint not null,
      block_time timestamptz not null,
      side text not null check (side in ('buy', 'sell')),
      trader text not null,
      base_amount numeric not null,
      quote_amount numeric not null,
      fee numeric not null,
      price double precision not null,
      primary key (signature, ix_index)
    );
    create index if not exists trades_pool_time on trades (pool, block_time desc);
    -- Reward token payouts, written by the crank (indexer/rewards.mjs): one row
    -- per confirmed payout transaction, and payouts signed but not yet settled.
    create table if not exists reward_payouts (
      pool text not null,
      signature text not null,
      amount numeric not null,
      recipients int not null,
      paid_at timestamptz not null,
      primary key (signature)
    );
    create index if not exists reward_payouts_pool_time on reward_payouts (pool, paid_at desc);
    create table if not exists reward_pending (
      signature text primary key,
      pool text not null,
      amount numeric not null,
      recipients int not null,
      last_valid_block_height bigint not null,
      sent_at timestamptz not null default now()
    );
    -- Fee modules (indexer/modules/): which module wrote a row (null = holders,
    -- rows from before modules existed) and what it did (burned base atoms,
    -- bounty round and winners, split recipients), carried from pending to paid.
    alter table reward_payouts add column if not exists module text;
    alter table reward_payouts add column if not exists detail jsonb;
    alter table reward_pending add column if not exists module text;
    alter table reward_pending add column if not exists detail jsonb;
    create index if not exists reward_payouts_pool_module on reward_payouts (pool, module, paid_at desc);
    -- Each Reward token's fee module, read once from its metadata JSON by the
    -- crank. config holds a split's recipients; status is lpFarm's current
    -- recipients ('holders' or 'lps').
    create table if not exists market_fee_models (
      pool text primary key,
      fee_model text not null,
      uri text,
      read_at timestamptz not null default now(),
      config jsonb,
      note text,
      status text,
      status_at timestamptz
    );
    -- Graduation airdrop (indexer/modules/airdrop.mjs), for markets whose DBC
    -- config names the crank key as leftover receiver: one state row per pool
    -- (written the first pass the crank sees such a config) and one payout row
    -- per holder of the snapshot. A row is pending with its signature before
    -- it is sent, so a crash resumes without paying twice.
    create table if not exists airdrop_state (
      pool text primary key,
      withdrawn numeric,
      withdraw_signature text,
      withdraw_last_valid_block_height bigint,
      snapshot_at timestamptz,
      done boolean not null default false,
      sent_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists airdrop_payouts (
      pool text not null,
      recipient text not null,
      owner text not null,
      amount numeric not null check (amount > 0),
      status text not null default 'unpaid' check (status in ('unpaid', 'pending', 'sent', 'skipped')),
      signature text,
      last_valid_block_height bigint,
      sent_at timestamptz,
      note text,
      primary key (pool, recipient)
    );
    create index if not exists airdrop_payouts_signature on airdrop_payouts (signature);
    -- claim_graduated's accounts per graduated market (indexer/modules/graduated.mjs):
    -- the Vault's permanently locked position in the graduated DAMM v2 pool.
    -- Finding it lists every position NFT the Vault holds, so it is cached.
    create table if not exists graduated_positions (
      pool text primary key,
      damm_pool text not null,
      position text not null,
      position_nft_account text not null,
      token_a_vault text not null,
      token_b_vault text not null,
      found_at timestamptz not null default now()
    );
  `);
  await (await import("./modules/ledger-schema.mjs")).migrateLedgerTables(db);
  await (await import("./modules/crank-schema.mjs")).migrateCrank(db);
}

// RPC errors that pass: rate limits, timeouts, dropped connections, and the
// gateway errors (502, 503, 504) a busy or lagging node answers with.
export const TRANSIENT_RPC_ERROR = /429|Too Many|fetch failed|timeout|timed out|ECONNRESET|socket hang up|\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Time-?out/i;

/** An rpc(fn) that retries transient errors with backoff (`sleep` waits ms), at most `attempts` times. */
export function retrying(sleep, { attempts = 8 } = {}) {
  return async function rpc(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= attempts || !TRANSIENT_RPC_ERROR.test(String(e))) throw e;
        await sleep(Math.min(30_000, 1500 * 2 ** attempt));
      }
    }
  };
}
const rpc = retrying(sleep);

// ---- Graduation --------------------------------------------------------------

/** A DBC pool account's state if the pool has migrated off the curve, else null. */
export function migratedState(info) {
  if (!info || String(info.owner) !== DBC_PROGRAM) return null;
  try {
    const state = dbcClient.pool.program.coder.accounts.decode("virtualPool", Buffer.from(info.data)).poolState;
    return state.isMigrated !== 0 ? state : null;
  } catch {
    return null;
  }
}

/**
 * The DAMM v2 pool DBC migrated a pool to, from the pool's state and its
 * config account ({ address, baseMint, quoteMint }), derived as
 * lib/treasury/runtime.ts readGraduation does; null if the config is unreadable.
 */
export function dammPoolOf(state, configInfo) {
  if (!configInfo || String(configInfo.owner) !== DBC_PROGRAM) return null;
  try {
    const config = dbcClient.pool.program.coder.accounts.decode("poolConfig", Buffer.from(configInfo.data));
    const m = { baseMint: state.baseMint, quoteMint: config.quoteMint };
    return { address: graduatedPool(m, config), ...m };
  } catch {
    return null;
  }
}

/** Whether a DAMM v2 pool account exists and holds the market's tokens, base as token A and quote as B. */
export function holdsMarket(info, { baseMint, quoteMint }) {
  if (!info || String(info.owner) !== DAMM_PROGRAM) return false;
  try {
    const p = amm._program.coder.accounts.decode("pool", Buffer.from(info.data));
    return p.tokenAMint.equals(baseMint) && p.tokenBMint.equals(quoteMint);
  } catch {
    return false;
  }
}

/**
 * The addresses a market's trades are read from: its DBC pool, and its DAMM v2
 * pool once recorded. `caughtUp` is whether a sync of that address has ever
 * completed (its progress is stamped); until then it is backfilling.
 */
export function cursorsOf(row) {
  return [
    { pool: row.pool, venue: "dbc", address: row.pool, last: row.last_signature ?? null, caughtUp: row.synced_at != null },
    ...(row.damm_pool ? [{ pool: row.pool, venue: "damm", address: row.damm_pool, last: row.damm_last_signature ?? null, caughtUp: row.damm_synced_at != null }] : []),
  ];
}

// Transactions an address that has never caught up (a first-run backfill, such
// as a DAMM v2 pool just recorded, or a new market) reads per loop, so a long
// backfill does not hold up every pool after it. The backfill covers the
// history listed when it started, up to that listing's newest signature (its
// head); once the head is read the cap stops (see syncer).
export const BACKFILL_TRANSACTIONS = 100;
// getSignaturesForAddress's largest page.
const PAGE = 1000;

// Column names per venue (fixed strings, never input).
const COLUMNS = {
  dbc: { last: "last_signature", through: "synced_through", at: "synced_at" },
  damm: { last: "damm_last_signature", through: "damm_synced_through", at: "damm_synced_at" },
};

/**
 * The sync loop over `db` (pg) and `conn` (a web3.js Connection). `now` is the
 * clock progress is stamped with; `txRetries` and `txRetryMs` bound the wait
 * for a listed transaction that the RPC does not serve yet; `backfillCap` is
 * BACKFILL_TRANSACTIONS. `between`, if given, runs after each address (the LP
 * readings' tick, so a long loop does not hold them up).
 */
export function syncer({ db, conn, rpc, sleep, state, spacingMs = SPACING_MS, now = Date.now, txRetries = 3, txRetryMs = 2000, backfillCap = BACKFILL_TRANSACTIONS, between = null }) {
  // Markets are the pools that have a Sonata treasury.
  async function discoverPools() {
    const accounts = await conn.getProgramAccounts(TREASURY_PROGRAM, {
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(TREASURY_DISCRIMINATOR) } }],
      dataSlice: { offset: 8, length: 32 },
    });
    for (const { pubkey, account } of accounts) {
      const pool = new PublicKey(account.data).toBase58();
      await db.query(
        "insert into pools (pool, treasury) values ($1, $2) on conflict (pool) do nothing",
        [pool, pubkey.toBase58()],
      );
    }
    return accounts.length;
  }

  // Records each newly graduated market's DAMM v2 pool: after migration every
  // trade happens there (DBC refuses swaps). DBC creates the pool in the
  // migration transaction; migration is permanent, so a recorded pool is not
  // checked again. Returns the pools that have migrated but whose DAMM v2 pool
  // could not be recorded yet: their DBC progress must not advance.
  async function findGraduated() {
    const { rows } = await db.query("select pool from pools where damm_pool is null order by pool");
    // Pools come from treasury accounts; a row that is not an address has nothing to read.
    const all = rows.map((r) => parseKey(r.pool)).filter(Boolean);
    const waiting = new Set();
    for (let i = 0; i < all.length; i += 100) {
      const pools = all.slice(i, i + 100);
      const infos = await rpc(() => conn.getMultipleAccountsInfo(pools, "confirmed"));
      const migrated = pools.map((pool, j) => ({ pool, state: migratedState(infos[j]) })).filter((x) => x.state);
      if (!migrated.length) continue;
      const configs = await rpc(() => conn.getMultipleAccountsInfo(migrated.map((x) => x.state.config), "confirmed"));
      const found = migrated.map((x, j) => ({ ...x, damm: dammPoolOf(x.state, configs[j]) }));
      const known = found.filter((x) => x.damm);
      const dammInfos = known.length ? await rpc(() => conn.getMultipleAccountsInfo(known.map((x) => x.damm.address), "confirmed")) : [];
      for (const x of found) {
        const k = known.indexOf(x);
        if (k >= 0 && holdsMarket(dammInfos[k], x.damm))
          await db.query("update pools set damm_pool = $2, updated_at = now() where pool = $1 and damm_pool is null", [x.pool.toBase58(), x.damm.address.toBase58()]);
        else waiting.add(x.pool.toBase58());
      }
    }
    return waiting;
  }

  // A signature can be listed before the RPC serves its transaction. Waiting
  // for it (and failing this address's sync if it never comes) keeps the
  // cursor before it, so its trades are read next loop, never skipped.
  async function transaction(signature) {
    for (let attempt = 0; ; attempt++) {
      const tx = await rpc(() => conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
      if (tx) return tx;
      if (attempt >= txRetries) throw Error(`transaction ${signature} not served yet; read again next loop`);
      await sleep(txRetryMs);
    }
  }

  const saveCursor = ({ pool, venue }, signature) =>
    db.query(`update pools set ${COLUMNS[venue].last} = $2, updated_at = now() where pool = $1`, [pool, signature]);

  // Files one transaction's swaps on the cursor's address under the market's
  // DBC pool, then moves the cursor to it. Returns the rows inserted.
  async function readTransaction(cursor, signature) {
    const { pool, venue, address } = cursor;
    const decode = venue === "damm" ? decodeDammTrades : decodeTrades;
    const tx = await transaction(signature);
    let inserted = 0;
    for (const t of decode(tx, signature)) {
      if (t.pool !== address || !t.blockTime) continue;
      const r = await db.query(
        `insert into trades (signature, ix_index, pool, venue, slot, block_time, side, trader, base_amount, quote_amount, fee, price)
         values ($1, $2, $3, $4, $5, to_timestamp($6), $7, $8, $9, $10, $11, $12) on conflict do nothing`,
        [t.signature, t.ixIndex, pool, venue, t.slot, t.blockTime, t.side, t.trader, t.baseAmount, t.quoteAmount, t.fee, t.price],
      );
      inserted += r.rowCount;
    }
    await saveCursor(cursor, signature);
    // One transaction at a time: the public RPC limits getTransaction per caller.
    await sleep(spacingMs);
    return inserted;
  }

  const listPage = (address, { until, before }) =>
    rpc(() => conn.getSignaturesForAddress(new PublicKey(address), { until: until ?? undefined, before, limit: PAGE }));

  // A caught-up address: reads every signature newer than its cursor, oldest
  // first, so the cursor only advances past processed transactions. Returns
  // the rows inserted, the newest signature's block_time, and complete: true.
  async function readAll(cursor) {
    const signatures = [];
    let before;
    for (;;) {
      const page = await listPage(cursor.address, { until: cursor.last, before });
      signatures.push(...page);
      if (page.length < PAGE) break;
      before = page.at(-1).signature;
    }
    if (!signatures.length) return { inserted: 0, newest: null, complete: true };
    let inserted = 0;
    for (const { signature } of [...signatures].reverse().filter((s) => !s.err)) inserted += await readTransaction(cursor, signature);
    // Failed transactions at the head still move the cursor forward.
    await saveCursor(cursor, signatures[0].signature);
    const times = signatures.map((s) => s.blockTime).filter((t) => Number.isFinite(t));
    return { inserted, newest: times.length ? Math.max(...times) : null, complete: true };
  }

  // Backfills of addresses that have not caught up, in memory (after a
  // restart one is listed again from the saved cursor). A backfill covers the
  // signatures newer than the cursor when it started, listed once then:
  // `bounds` holds the first (newest) signature of each page of that listing,
  // newest first (bounds[0] is the head), and the signatures strictly between
  // two bounds, fewer than a page, are listed again with one call when their
  // turn comes. `pending` is the stretch being read, oldest first, ending with
  // its bound; `last` is the cursor as last saved (a backfill whose cursor was
  // moved otherwise is started again).
  const backfills = new Map();

  async function startBackfill({ address, last }, startedAt) {
    const bounds = [];
    let before, newest = null;
    for (;;) {
      const page = await listPage(address, { until: last, before });
      // Each bound remembers how many signatures follow it on its page: listing
      // that stretch again must return exactly that many.
      if (page.length) bounds.push({ ...page[0], between: page.length - 1 });
      for (const { blockTime } of page) if (Number.isFinite(blockTime)) newest = newest === null ? blockTime : Math.max(newest, blockTime);
      if (page.length < PAGE) break;
      before = page.at(-1).signature;
    }
    return { last: last ?? null, bounds, pending: [], newest, startedAt };
  }

  // Reads at most `backfillCap` of an address's backfill, oldest first, from
  // where the last loop stopped. Returns { inserted, complete: false } until
  // its head has been read, then { inserted, complete: true, newest, last
  // (the cursor), startedAt (when the backfill's listing started) }.
  async function backfill(cursor, startedAt) {
    let b = backfills.get(cursor.address);
    if (!b || b.last !== (cursor.last ?? null)) backfills.set(cursor.address, (b = await startBackfill(cursor, startedAt)));
    let inserted = 0, read = 0;
    for (;;) {
      if (!b.pending.length) {
        if (!b.bounds.length) break;
        const bound = b.bounds.at(-1);
        const page = await listPage(cursor.address, { until: b.last, before: bound.signature });
        // A stretch lists again as exactly the signatures that followed its bound
        // on the first listing. Any other count, a full page or the empty answer
        // an RPC node gives when it does not know `before` yet, means this listing
        // cannot be trusted: start the backfill again from the saved cursor rather
        // than skip a stretch.
        if (page.length !== bound.between) {
          backfills.delete(cursor.address);
          return { inserted, complete: false };
        }
        b.bounds.pop();
        b.pending = [...page.reverse(), bound];
      }
      const s = b.pending[0];
      if (!s.err) {
        if (read >= backfillCap) return { inserted, complete: false };
        inserted += await readTransaction(cursor, s.signature);
        read++;
        b.last = s.signature;
      }
      b.pending.shift();
      // A stretch read to its end leaves the cursor at its bound, failed or not.
      if (!b.pending.length && b.last !== s.signature) {
        await saveCursor(cursor, s.signature);
        b.last = s.signature;
      }
    }
    backfills.delete(cursor.address);
    return { inserted, complete: true, newest: b.newest, last: b.last, startedAt: b.startedAt };
  }

  // Reads one address's new signatures and files its swaps under the
  // market's DBC pool: readAll, or backfill while it has not caught up.
  function syncCursor(cursor, startedAt = now()) {
    return cursor.caughtUp === false ? backfill(cursor, startedAt) : readAll(cursor);
  }

  // Stamps an address's progress (modules/indexer-schema.mjs) once its sync completed.
  async function synced({ pool, venue }, newest, startedAt) {
    const col = COLUMNS[venue];
    await db.query(
      `update pools set ${col.through} = greatest(${col.through}, to_timestamp($2)), ${col.at} = greatest(${col.at}, to_timestamp($3)) where pool = $1`,
      [pool, newest, startedAt / 1000],
    );
  }

  // Whether a DBC pool is off the curve, read now.
  async function migratedNow(pool) {
    const [info] = await rpc(() => conn.getMultipleAccountsInfo([new PublicKey(pool)], "confirmed"));
    return migratedState(info) !== null;
  }

  // One loop over every market. An address whose sync fails (after the RPC
  // backoff) keeps its cursor and progress and is read again next loop; the
  // other addresses go on.
  async function syncAll() {
    state.pools = await rpc(() => discoverPools());
    const waiting = await findGraduated();
    const { rows } = await db.query("select pool, last_signature, damm_pool, damm_last_signature, synced_at, damm_synced_at from pools order by pool");
    const errors = [];
    const fail = (cursor, e) => errors.push(`${cursor.venue} ${cursor.address}: ${String(e?.message ?? e)}`);
    for (const row of rows) {
      for (const cursor of cursorsOf(row)) {
        try {
          // Each address's own start, taken before any read of it, so its
          // progress never claims more than was read, and an address synced
          // late in a long loop is not stamped with the loop's start.
          const startedAt = now();
          // Until its DAMM v2 pool is recorded, a market's DBC progress also
          // stands for its DAMM v2 trades (none can predate the migration), so
          // it is stamped only if the pool is still on the curve, read after
          // startedAt; a pool that migrated keeps its earlier progress. If that
          // read fails (after rpc's retries), the pool's trades are still read
          // and only its stamp waits for a later loop.
          let stamp = cursor.venue === "damm" || row.damm_pool != null;
          if (!stamp && !waiting.has(row.pool)) {
            try {
              stamp = !(await migratedNow(row.pool));
            } catch (e) {
              fail(cursor, `graduation check failed, trades read but progress not stamped: ${String(e?.message ?? e)}`);
            }
          }
          let r = await syncCursor(cursor, startedAt);
          state.trades += r.inserted;
          if (r.startedAt !== undefined) {
            // A backfill that has read its head covers everything confirmed
            // before its listing started. What is newer than the head is read
            // now, uncapped, as for a caught-up address.
            if (stamp) await synced(cursor, r.newest, r.startedAt);
            r = await readAll({ ...cursor, last: r.last });
            state.trades += r.inserted;
          }
          if (r.complete && stamp) await synced(cursor, r.newest, startedAt);
        } catch (e) {
          fail(cursor, e);
        }
        await sleep(200);
        if (between) await between();
      }
    }
    state.lastSync = new Date().toISOString();
    state.lastError = errors.length ? errors.join("; ").slice(0, 300) : null;
    if (errors.length) console.error("sync incomplete:", state.lastError);
  }

  return { discoverPools, findGraduated, syncCursor, syncAll };
}

// ---- LP Farm readings between crank passes -----------------------------------

// The gap between two LP readings, drawn uniformly in [min, max] seconds: 1.5
// to 3 readings per 15 minutes, and at least one in any 10, so one lands
// between every two crank passes, at a time the crank's timer does not tell.
export const LP_READING_GAP_SECONDS = [300, 600];

/** A DAMM v2 position account's unlocked liquidity if it is a position in `dammPool`, else 0. */
export function unlockedIn(info, dammPool) {
  if (!info || String(info.owner) !== DAMM_PROGRAM) return 0n;
  try {
    const s = amm._program.coder.accounts.decode("position", Buffer.from(info.data));
    return s.pool.equals(dammPool) ? BigInt(s.unlockedLiquidity.toString()) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Readings of the graduated LP Farm markets' positions at random times
 * between crank passes, written as the crank writes its own (ledger kind
 * 'lp' in balance_snapshots and balance_snapshot_rows), so
 * modules/lp-farm.mjs counts them: a position earns the least it held at
 * every reading since the last round, and liquidity that is only in place
 * around the crank's passes is caught out at one of these. Markets are those
 * whose fee model (market_fee_models) is lpFarm and whose DAMM v2 pool the
 * indexer has recorded. Only the positions of the market's newest reading are
 * read, 100 per getMultipleAccountsInfo: any other position is missing from
 * that reading, so it earns nothing at the next round anyway, and a closed
 * one (no account) or one no longer in the pool is left out, as none held. A
 * reading is taken at a time with a fraction of a second, so it never takes a
 * crank reading's place (those are whole seconds, one per pool and second).
 * tick() takes the readings once due and draws the next time; failures are
 * logged, never thrown, and a market whose read fails gets no reading.
 */
export function lpReadings({ db, conn, rpc, now = Date.now, random = Math.random, gap = LP_READING_GAP_SECONDS, log = (...a) => console.error(...a) }) {
  let due = null;
  const draw = () => (due = now() + (gap[0] + random() * (gap[1] - gap[0])) * 1000);

  // One market's reading: { positions (read), held (with liquidity), at }, or null if it has no reading to follow.
  async function readMarket({ pool, damm_pool }) {
    const dammPool = parseKey(damm_pool);
    if (!dammPool) return null;
    const { rows } = await db.query(
      `select holder from balance_snapshot_rows
        where pool = $1 and kind = 'lp'
          and taken_at = (select max(taken_at) from balance_snapshots where pool = $1 and kind = 'lp')
        order by holder`,
      [pool],
    );
    const positions = rows.map((r) => parseKey(r.holder)).filter(Boolean);
    if (!positions.length) return null;
    const entries = [];
    for (let i = 0; i < positions.length; i += 100) {
      const batch = positions.slice(i, i + 100);
      const infos = await rpc(() => conn.getMultipleAccountsInfo(batch, "confirmed"));
      batch.forEach((p, j) => {
        const unlocked = unlockedIn(infos[j], dammPool);
        if (unlocked > 0n) entries.push([p.toBase58(), unlocked]);
      });
    }
    const ms = Math.floor(now());
    const at = (ms % 1000 === 0 ? ms + 1 : ms) / 1000;
    await db.query(
      `with taken as (
         insert into balance_snapshots (pool, kind, taken_at) values ($1, 'lp', to_timestamp($2::double precision)) on conflict do nothing returning taken_at)
       insert into balance_snapshot_rows (pool, kind, taken_at, holder, amount)
       select $1, 'lp', taken.taken_at, t.holder, t.amount from taken, unnest($3::text[], $4::numeric[]) as t(holder, amount)`,
      [pool, at, entries.map(([h]) => h), entries.map(([, a]) => a.toString())],
    );
    // As the crank prunes after its own readings (modules/lp-farm.mjs recordPositions).
    await db.query(
      `delete from balance_snapshots
        where pool = $1 and kind = 'lp'
          and taken_at < (select max(taken_at) from balance_snapshots where pool = $1 and kind = 'lp' and taken_at <= to_timestamp($2::double precision) - $3::int * interval '1 second')`,
      [pool, at, LP_SNAPSHOT_KEEP_SECONDS],
    );
    return { positions: positions.length, held: entries.length, at };
  }

  // Every graduated LP Farm market's reading, now.
  async function readAll() {
    const { rows } = await db.query(
      `select p.pool, p.damm_pool from pools p join market_fee_models f on f.pool = p.pool
        where f.fee_model = 'lpFarm' and p.damm_pool is not null
        order by p.pool`,
    );
    for (const row of rows) {
      try {
        await readMarket(row);
      } catch (e) {
        log("lp reading failed:", row.pool, String(e?.message ?? e).slice(0, 200));
      }
    }
  }

  // Takes the readings if they are due; returns whether it did.
  async function tick() {
    if (due === null) draw();
    if (now() < due) return false;
    draw();
    try {
      await readAll();
    } catch (e) {
      log("lp readings failed:", String(e?.message ?? e).slice(0, 200));
    }
    return true;
  }

  return { tick, readAll, readMarket };
}

// ---- Read-only API ----------------------------------------------------------

const INTERVALS = { "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "1h": "1 hour", "4h": "4 hours", "1d": "1 day" };
const isPool = (v) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const limitOf = (v, max, dflt) => Math.min(max, Math.max(1, Number.parseInt(v ?? "", 10) || dflt));
const hits = new Map();
function allowed(ip) {
  const now = Date.now(), e = hits.get(ip);
  if (!e || now - e.start > 60_000) return hits.set(ip, { start: now, n: 1 }), true;
  return ++e.n <= 120;
}

const seconds = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The last Top Buyer round from its payout rows' details: its end and each
 * winner paid in it with their rank (1-3; null for a row written without
 * one). A rank whose winner was skipped (their share rolled over) is absent,
 * so the panel labels rows by rank, not by position.
 */
export function bountyRound(details) {
  const ends = details.map((d) => Number(d?.roundEnd)).filter(Number.isFinite);
  if (!ends.length) return { winners: [], lastRoundAt: null };
  const end = Math.max(...ends);
  const rankOf = (r) => (Number.isInteger(Number(r)) && Number(r) >= 1 && Number(r) <= 3 ? Number(r) : null);
  const winners = details
    .filter((d) => Number(d?.roundEnd) === end)
    .flatMap((d) => (Array.isArray(d.winners) ? d.winners : []))
    .map((w) => ({ trader: String(w.trader), amount: String(w.amount), rank: rankOf(w.rank) }))
    .sort((a, b) => (a.rank ?? 4) - (b.rank ?? 4));
  return { winners, lastRoundAt: end };
}

/** The graduation airdrop as the API reports it, from its airdrop_state row (amount in base atoms, null until withdrawn). */
export const airdropSummary = (a) => ({
  status: a.done ? "sent" : "waiting",
  amount: a.withdrawn ?? null,
  recipients: a.recipients ?? 0,
  sentAt: seconds(a.sent_at),
});

/** The read-only API over `db`; `state` is the sync loop's, for /health. */
export function api({ db, state }) {
  // What the market's fee module has done, from confirmed rows only.
  async function moduleDetail(pool, fm) {
    if (fm?.fee_model === "buyback") {
      const { rows: [b] } = await db.query(
        `select coalesce(sum((detail->>'burned')::numeric), 0)::text as burned,
                floor(extract(epoch from max(paid_at) filter (where amount > 0)))::bigint::text as last_buy_at
           from reward_payouts where pool = $1 and module = 'buyback'`,
        [pool],
      );
      return { burned: b.burned, lastBuyAt: seconds(b.last_buy_at) };
    }
    if (fm?.fee_model === "topBuyers") {
      // Every row of the last round: its winners may span transactions.
      const { rows } = await db.query(
        `select detail from reward_payouts where pool = $1 and module = 'topBuyers'
            and (detail->>'roundEnd')::bigint = (select max((detail->>'roundEnd')::bigint) from reward_payouts where pool = $1 and module = 'topBuyers')
          order by paid_at, signature`,
        [pool],
      );
      return bountyRound(rows.map((r) => r.detail));
    }
    if (fm?.fee_model === "lpFarm") return { status: fm.status === "lps" ? "lps" : "holders" };
    if (fm?.fee_model === "diamond") {
      const { rows: [d] } = await db.query(
        `select detail->'multipliers' as multipliers from reward_payouts
          where pool = $1 and module = 'diamond' and detail ? 'multipliers' order by paid_at desc, signature desc limit 1`,
        [pool],
      );
      return { multipliers: d?.multipliers ?? null };
    }
    if (fm?.fee_model === "split") {
      const { rows } = await db.query(
        `select r->>'wallet' as wallet, sum((r->>'amount')::numeric)::text as paid
           from reward_payouts p, jsonb_array_elements(p.detail->'recipients') r
          where p.pool = $1 and p.module = 'split' group by 1`,
        [pool],
      );
      // { recipients: [], splitError } when the split fails validation (the bot pays nobody).
      return splitRecipients(fm.config, new Map(rows.map((x) => [x.wallet, x.paid])));
    }
    return {};
  }

  /**
   * A wallet's payout rows ({ pool, module, paid, payouts, last_paid_at }, from
   * several ledgers) as the API reports them: one per pool and module, amounts
   * in atoms as strings (the airdrop in base-token atoms, `asset: "base"`;
   * everything else in the quote stock), most recently paid first.
   */
  function mergePayouts(rows) {
    const out = new Map();
    for (const r of rows) {
      const k = `${r.pool}/${r.module}`;
      const at = seconds(r.last_paid_at);
      const seen = out.get(k);
      if (!seen) {
        out.set(k, {
          pool: r.pool,
          module: r.module,
          asset: r.module === "airdrop" ? "base" : "quote",
          paid: BigInt(r.paid ?? 0),
          payouts: Number(r.payouts ?? 0),
          lastPaidAt: at,
        });
        continue;
      }
      seen.paid += BigInt(r.paid ?? 0);
      seen.payouts += Number(r.payouts ?? 0);
      if (at !== null && (seen.lastPaidAt === null || at > seen.lastPaidAt)) seen.lastPaidAt = at;
    }
    return [...out.values()]
      .map((p) => ({ ...p, paid: p.paid.toString() }))
      .sort((a, b) => (b.lastPaidAt ?? -1) - (a.lastPaidAt ?? -1) || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : a.module < b.module ? -1 : 1));
  }

  // What the payout bot has paid one wallet, per market and module, from every
  // ledger that records recipients. Confirmed payouts only:
  //   reward_allocations  paid rows (holders, diamond, lpFarm, split). The
  //                       wallet paid is paid_to (for an LP position row, the
  //                       NFT holder at the time), else the row's own wallet.
  //   reward_payouts      rows whose detail lists who was paid (topBuyers
  //                       winners, split recipients) and whose transaction
  //                       has no allocation rows, so nothing counts twice.
  //   airdrop_payouts     sent rows; owner is the wallet. Paid in base atoms.
  // Not counted: older holders rows in reward_payouts record only how many
  // were paid, not who, and reward_pending rows are not settled yet.
  async function walletPayouts(wallet) {
    const { rows: allocated } = await db.query(
      `select pool, module, sum(amount)::text as paid, count(distinct signature)::int as payouts,
              floor(extract(epoch from max(paid_at)))::bigint::text as last_paid_at
         from reward_allocations
        where status = 'paid' and (paid_to = $1 or (paid_to is null and kind = 'wallet' and recipient = $1))
        group by pool, module`,
      [wallet],
    );
    const { rows: listed } = await db.query(
      `with paid as (
         select pool, module, signature, paid_at,
                case module when 'topBuyers' then detail->'winners' else detail->'recipients' end as list
           from reward_payouts
          where module in ('topBuyers', 'split')
            and not exists (select 1 from reward_allocations a where a.signature = reward_payouts.signature))
       select p.pool, p.module, sum((r->>'amount')::numeric)::text as paid, count(distinct p.signature)::int as payouts,
              floor(extract(epoch from max(p.paid_at)))::bigint::text as last_paid_at
         from paid p
        cross join lateral jsonb_array_elements(case when jsonb_typeof(p.list) = 'array' then p.list else '[]'::jsonb end) r
        where coalesce(r->>'trader', r->>'wallet') = $1 and r->>'amount' ~ '^[0-9]+$'
        group by p.pool, p.module`,
      [wallet],
    );
    const { rows: airdropped } = await db.query(
      `select pool, 'airdrop' as module, sum(amount)::text as paid, count(*)::int as payouts,
              floor(extract(epoch from max(sent_at)))::bigint::text as last_paid_at
         from airdrop_payouts where owner = $1 and status = 'sent'
        group by pool`,
      [wallet],
    );
    return mergePayouts([...allocated, ...listed, ...airdropped]);
  }

  async function route(url) {
    const q = url.searchParams;
    if (url.pathname === "/api/index/health") return { ok: true, ...state };
    if (url.pathname === "/api/index/trades") {
      if (!isPool(q.get("pool"))) return 400;
      const { rows } = await db.query(
        `select signature, extract(epoch from block_time)::bigint as time, side, trader,
                base_amount::text, quote_amount::text, fee::text, price, venue
           from trades where pool = $1 order by block_time desc, signature desc, ix_index desc limit $2`,
        [q.get("pool"), limitOf(q.get("limit"), 100, 30)],
      );
      return { pool: q.get("pool"), supply: SUPPLY_TOKENS, trades: rows };
    }
    if (url.pathname === "/api/index/candles") {
      const interval = INTERVALS[q.get("interval") ?? "15m"];
      if (!isPool(q.get("pool")) || !interval) return 400;
      const { rows } = await db.query(
        `select extract(epoch from date_bin($2::interval, block_time, timestamptz 'epoch'))::bigint as time,
                (array_agg(price order by block_time, signature, ix_index))[1] as open,
                max(price) as high, min(price) as low,
                (array_agg(price order by block_time desc, signature desc, ix_index desc))[1] as close,
                sum(quote_amount)::text as volume, count(*)::int as trades
           from trades where pool = $1 group by 1 order by 1 desc limit $3`,
        [q.get("pool"), interval, limitOf(q.get("limit"), 500, 200)],
      );
      return { pool: q.get("pool"), interval: q.get("interval") ?? "15m", supply: SUPPLY_TOKENS, candles: rows.reverse() };
    }
    if (url.pathname === "/api/index/stats") {
      const { rows } = await db.query(
        `select p.pool,
                (select price from trades t where t.pool = p.pool order by block_time desc, signature desc, ix_index desc limit 1) as last_price,
                (select price from trades t where t.pool = p.pool and block_time <= now() - interval '24 hours'
                   order by block_time desc, signature desc, ix_index desc limit 1) as price_24h_ago,
                coalesce((select sum(quote_amount) from trades t where t.pool = p.pool and block_time > now() - interval '24 hours'), 0)::text as volume_24h,
                (select count(*) from trades t where t.pool = p.pool and block_time > now() - interval '24 hours')::int as trades_24h,
                (select count(*) from trades t where t.pool = p.pool)::int as trades_total
           from pools p`,
      );
      return { supply: SUPPLY_TOKENS, pools: rows };
    }
    // Reward token payouts (confirmed transactions only), in quote atoms, and the
    // market's fee module with what it has done.
    if (url.pathname === "/api/index/rewards") {
      if (!isPool(q.get("pool"))) return 400;
      const pool = q.get("pool");
      // Burn-only buyback rows move no quote and are not counted as payouts.
      const { rows: [r] } = await db.query(
        `select coalesce(sum(amount), 0)::text as paid, count(*) filter (where amount > 0)::int as payouts,
                (select recipients from reward_payouts where pool = $1 and amount > 0 order by paid_at desc, signature desc limit 1) as recipients_last,
                floor(extract(epoch from max(paid_at) filter (where amount > 0)))::bigint::text as last_paid_at
           from reward_payouts where pool = $1`,
        [pool],
      );
      const { rows: [fm] } = await db.query("select fee_model, config, status from market_fee_models where pool = $1", [pool]);
      const out = {
        pool,
        paid: r.paid,
        payouts: r.payouts,
        recipientsLast: r.recipients_last ?? 0,
        lastPaidAt: seconds(r.last_paid_at),
        // null until the crank has read the token's metadata.
        feeModel: fm?.fee_model ?? null,
      };
      const { rows: [a] } = await db.query(
        `select withdrawn::text, done, floor(extract(epoch from sent_at))::bigint::text as sent_at,
                (select count(*) from airdrop_payouts where pool = $1 and status = 'sent')::int as recipients
           from airdrop_state where pool = $1`,
        [pool],
      );
      return {
        ...out,
        ...(await moduleDetail(pool, fm)),
        // Only for markets whose DBC config names the crank key as leftover receiver.
        ...(a ? { airdrop: airdropSummary(a) } : {}),
      };
    }
    // One wallet's payouts from the bot, per market and module (walletPayouts).
    // Rate limited per IP with the other routes, before route() is called.
    if (url.pathname === "/api/index/payouts") {
      const key = parseKey(q.get("wallet"));
      if (!key) return 400;
      const wallet = key.toBase58();
      return { wallet, payouts: await walletPayouts(wallet) };
    }
    return 404;
  }

  return { moduleDetail, walletPayouts, route };
}


// ---- Main -------------------------------------------------------------------

// Run as a service (node indexer/index.mjs); imported by tests, it only exports.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const { route } = api({ db, state });
  http
    .createServer(async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": status === 200 ? "public, max-age=5" : "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.method !== "GET") return send(405, { error: "Read-only." });
        const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",")[0].trim();
        if (!allowed(ip)) return send(429, { error: "Too many requests." });
        const out = await route(new URL(req.url, "http://localhost"));
        if (out === 400) return send(400, { error: "Bad request." });
        if (out === 404) return send(404, { error: "Not found." });
        send(200, out);
      } catch {
        send(500, { error: "Market data unavailable." });
      }
    })
    .listen(PORT, "127.0.0.1", () => console.log(`indexer API on 127.0.0.1:${PORT}`));

  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required.");
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw Error("Not Devnet.");
  await migrate();
  // The indexer's own columns: the DAMM v2 venue, its cursor, and progress.
  await migrateIndexerSchema(db);
  // deploy/lightsail/setup.sh waits for this line before it starts the crank's timer.
  console.log(MIGRATED_LINE);
  // LP Farm readings at random times between crank passes (lpReadings).
  const lp = lpReadings({ db, conn, rpc });
  const { syncAll } = syncer({ db, conn, rpc, sleep, state, between: lp.tick });
  for (;;) {
    try {
      await syncAll();
    } catch (e) {
      state.lastError = String(e?.message ?? e).slice(0, 300);
      console.error("sync failed:", state.lastError);
    }
    await lp.tick();
    await sleep(POLL_MS);
  }
}
