import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { BACKFILL_TRANSACTIONS, airdropSummary, api, bountyRound, cursorsOf, dammPoolOf, holdsMarket, migratedState, syncer } from "./index.mjs";
import { HEAD_LAG_SECONDS, indexProgress } from "./modules/indexer-schema.mjs";
import { dammPoolAccount, dammSwapTx, dbcAccounts, key } from "./modules/testkit.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const T = 1_790_000_000; // unix seconds

// The indexer's pools and trades tables in memory, answering the sync loop's
// queries as PostgreSQL would (timestamps as unix seconds).
function memDb() {
  const pools = new Map(), trades = new Map(), queries = [];
  const blank = (pool, treasury) => ({
    pool, treasury, last_signature: null, damm_pool: null, damm_last_signature: null,
    synced_through: null, synced_at: null, damm_synced_through: null, damm_synced_at: null,
  });
  const sorted = () => [...pools.values()].sort((a, b) => (a.pool < b.pool ? -1 : 1));
  const later = (a, b) => (b === null || b === undefined ? a : a === null ? b : Math.max(a, b));
  async function query(sql, args = []) {
    queries.push({ sql, args });
    const s = sql.replace(/\s+/g, " ").trim();
    let m;
    if (s.startsWith("insert into pools")) {
      if (!pools.has(args[0])) pools.set(args[0], blank(args[0], args[1]));
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("select pool from pools where damm_pool is null")) return { rows: sorted().filter((p) => !p.damm_pool).map((p) => ({ pool: p.pool })) };
    if (s.startsWith("update pools set damm_pool = $2")) {
      const p = pools.get(args[0]);
      if (p && !p.damm_pool) p.damm_pool = args[1];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("select pool, last_signature, damm_pool, damm_last_signature, synced_at, damm_synced_at from pools")) return { rows: sorted().map((p) => ({ ...p })) };
    if (s.startsWith("insert into trades")) {
      const k = `${args[0]}/${args[1]}`;
      if (trades.has(k)) return { rows: [], rowCount: 0 };
      const [signature, ix_index, pool, venue, slot, block_time, side, trader, base_amount, quote_amount, fee, price] = args;
      trades.set(k, { signature, ix_index, pool, venue, slot, block_time, side, trader, base_amount, quote_amount, fee, price });
      return { rows: [], rowCount: 1 };
    }
    if ((m = /^update pools set (\w+) = \$2, updated_at = now\(\) where pool = \$1$/.exec(s))) {
      pools.get(args[0])[m[1]] = args[1];
      return { rows: [], rowCount: 1 };
    }
    if ((m = /^update pools set (\w+) = greatest\(\1, to_timestamp\(\$2\)\), (\w+) = greatest\(\2, to_timestamp\(\$3\)\) where pool = \$1$/.exec(s))) {
      const p = pools.get(args[0]);
      p[m[1]] = later(p[m[1]], args[1]);
      p[m[2]] = later(p[m[2]], args[2]);
      return { rows: [], rowCount: 1 };
    }
    throw Error(`unexpected query: ${s}`);
  }
  return { query, pools, trades, queries, rows: () => [...trades.values()] };
}

// Devnet in memory for the sync loop: accounts, the Sonata treasuries, and per
// address its signatures (newest first) with their transactions.
function memChain() {
  const accounts = new Map(), history = new Map(), txs = new Map(), treasuries = [];
  const unserved = new Set(), failing = new Set(), calls = [];
  const conn = {
    getProgramAccounts: async () => (calls.push("getProgramAccounts"), treasuries),
    getMultipleAccountsInfo: async (keys) => (calls.push("getMultipleAccountsInfo"), keys.map((k) => accounts.get(k.toBase58()) ?? null)),
    getSignaturesForAddress: async (address, { until, before, limit = 1000 } = {}) => {
      calls.push(`getSignaturesForAddress ${address.toBase58()}`);
      if (failing.has(address.toBase58())) throw Error("400 Bad Request");
      let list = history.get(address.toBase58()) ?? [];
      if (before) list = list.slice(list.findIndex((s) => s.signature === before) + 1);
      const stop = until ? list.findIndex((s) => s.signature === until) : -1;
      return (stop >= 0 ? list.slice(0, stop) : list).slice(0, limit);
    },
    getTransaction: async (signature) => (calls.push(`getTransaction ${signature}`), unserved.has(signature) ? null : txs.get(signature) ?? null),
  };
  return {
    conn, accounts, treasuries, unserved, failing, calls,
    put: (k, info) => accounts.set(k.toBase58(), info),
    // A transaction landing on `addresses` (newest first per address).
    land(signature, addresses, tx, { err = null } = {}) {
      for (const a of addresses) history.set(a.toBase58(), [{ signature, err, blockTime: tx?.blockTime ?? null }, ...(history.get(a.toBase58()) ?? [])]);
      if (tx) txs.set(signature, tx);
    },
  };
}

// A Sonata market on `chain`: its treasury, DBC pool and config; its DAMM v2
// pool's account once graduated (unless `dammReadable` is false).
function market(chain, { pool = key(), migrated = false, dammReadable = true } = {}) {
  const m = { pool, config: key(), baseMint: key(), quoteMint: key() };
  const dbc = dbcAccounts(m);
  const damm = dammPoolAccount(m, { migrationFeeOption: dbc.config.migrationFeeOption });
  const graduate = ({ readable = true } = {}) => {
    chain.put(m.pool, dbcAccounts(m, { migrated: true }).poolInfo);
    if (readable) chain.put(damm.address, damm.info);
  };
  chain.put(m.pool, dbc.poolInfo);
  chain.put(m.config, dbc.configInfo);
  chain.treasuries.push({ pubkey: key(), account: { data: m.pool.toBuffer() } });
  if (migrated) graduate({ readable: dammReadable });
  return { ...m, damm: damm.address, dammInfo: damm.info, graduate };
}

// A successful transaction with no swap events (fees, liquidity, migration...).
const quietTx = (blockTime) => ({ blockTime, slot: 1, meta: { err: null, innerInstructions: [] }, transaction: { message: { accountKeys: [key().toBase58()], instructions: [] } } });

// The sync loop on `clock` (unix seconds). With `slow`, every sleep moves the clock on, as a real loop's time passes.
function loop(chain, db, clock, { slow = false, ...over } = {}) {
  const state = { pools: 0, trades: 0, lastError: null };
  const sleep = slow ? async (ms) => void (clock.now += ms / 1000) : async () => {};
  const s = syncer({ db, conn: chain.conn, rpc: (fn) => fn(), sleep, state, now: () => clock.now * 1000, txRetries: 1, txRetryMs: 0, ...over });
  return { ...s, state };
}
// Markets on `chain`, in the order the loop reads them (by pool address).
const markets = (chain, n, opts) => Array.from({ length: n }, () => key()).sort((a, b) => (a.toBase58() < b.toBase58() ? -1 : 1)).map((pool) => market(chain, { pool, ...opts }));

test("after graduation the DAMM v2 pool's swaps are indexed under the market's DBC pool, from their own cursor", async () => {
  const chain = memChain(), db = memDb(), clock = { now: T };
  const m = market(chain, { migrated: true });
  const [buyer, seller, relayer] = [key(), key(), key()];
  chain.land("m1", [m.pool, m.damm], quietTx(T - 500)); // the migration touches both
  chain.land("d1", [m.damm], dammSwapTx({ direction: 1, pool: m.damm, payer: buyer, feePayer: relayer, blockTime: T - 100, slot: 7 }));
  chain.land("x", [m.damm], null, { err: { InstructionError: [0, "x"] } }); // failed: skipped, never fetched
  chain.land("d2", [m.damm], dammSwapTx({ direction: 0, pool: m.damm, payer: seller, blockTime: T - 50, result: { output_amount: 9_000n } }));
  // A swap in another DAMM v2 pool, in a transaction that also touches this one: not this market's.
  chain.land("o1", [m.damm], dammSwapTx({ direction: 1, pool: key(), blockTime: T - 40 }));
  const run = loop(chain, db, clock);
  await run.syncAll();
  assert.equal(run.state.lastError, null);
  const row = db.pools.get(m.pool.toBase58());
  assert.equal(row.damm_pool, m.damm.toBase58());
  assert.equal(row.last_signature, "m1");
  assert.equal(row.damm_last_signature, "o1");
  const trades = db.rows().sort((a, b) => a.block_time - b.block_time);
  assert.deepEqual(trades.map((t) => [t.pool, t.venue, t.side, t.trader, t.base_amount, t.quote_amount, t.fee, t.block_time]), [
    [m.pool.toBase58(), "damm", "buy", buyer.toBase58(), "49000000", "1000000", "12500", T - 100],
    [m.pool.toBase58(), "damm", "sell", seller.toBase58(), "1000000", "9000", "12500", T - 50],
  ]);
  assert.equal(trades[0].slot, 7);
  assert.ok(!chain.calls.includes("getTransaction x"));
  // Both addresses completed: the market is indexed up to this loop's start, less the lag.
  assert.equal(indexProgress(row), T - HEAD_LAG_SECONDS);
  assert.equal(row.damm_synced_through, T - 40);
  // Next loop: only the new signature is read, from the DAMM v2 cursor.
  clock.now = T + 30;
  chain.calls.length = 0;
  chain.land("d3", [m.damm], dammSwapTx({ direction: 1, pool: m.damm, payer: buyer, blockTime: T + 10 }));
  await run.syncAll();
  assert.deepEqual(chain.calls.filter((c) => c.startsWith("getTransaction")), ["getTransaction d3"]);
  assert.equal(db.trades.size, 3);
  assert.equal(db.pools.get(m.pool.toBase58()).damm_last_signature, "d3");
  assert.equal(indexProgress(db.pools.get(m.pool.toBase58())), T + 30 - HEAD_LAG_SECONDS);
});

test("a listed transaction the RPC does not serve yet stops its cursor there; progress waits for a complete sync, other pools go on", async () => {
  const chain = memChain(), db = memDb(), clock = { now: T };
  // The app-buy fixture is a DBC buy on this pool.
  const m = market(chain, { pool: new PublicKey("9iuQLtqQETzEjGrPVycWFoANL22W9s3MoNfTt2dfxong") });
  const other = market(chain);
  chain.land("b1", [m.pool], quietTx(T - 100));
  chain.land("b2", [m.pool], fixture("app-buy.json"));
  chain.land("q1", [other.pool], quietTx(T - 90));
  chain.unserved.add("b2");
  const run = loop(chain, db, clock);
  await run.syncAll();
  const row = db.pools.get(m.pool.toBase58());
  assert.equal(row.last_signature, "b1", "the cursor stays before the transaction not served");
  assert.equal(db.trades.size, 0);
  assert.equal(row.synced_at, null);
  assert.equal(indexProgress(row), null, "no progress until a sync of the pool completes");
  assert.match(run.state.lastError, /dbc 9iuQ.*transaction b2 not served yet/);
  // The other pool was read and its progress stamped.
  assert.equal(db.pools.get(other.pool.toBase58()).last_signature, "q1");
  assert.equal(indexProgress(db.pools.get(other.pool.toBase58())), T - HEAD_LAG_SECONDS);
  // Served on the next loop: the trade is indexed, not lost.
  chain.unserved.delete("b2");
  clock.now = T + 20;
  await run.syncAll();
  assert.equal(run.state.lastError, null);
  assert.deepEqual(db.rows().map((t) => [t.signature, t.pool, t.venue, t.side, t.quote_amount]), [["b2", m.pool.toBase58(), "dbc", "buy", "2000000"]]);
  assert.equal(db.pools.get(m.pool.toBase58()).last_signature, "b2");
  assert.equal(indexProgress(db.pools.get(m.pool.toBase58())), T + 20 - HEAD_LAG_SECONDS);
});

test("a market that migrated before its DAMM v2 pool can be read keeps its earlier progress until that pool is synced", async () => {
  const chain = memChain(), db = memDb(), clock = { now: T };
  const m = market(chain);
  const run = loop(chain, db, clock);
  await run.syncAll();
  const row = () => db.pools.get(m.pool.toBase58());
  assert.equal(indexProgress(row()), T - HEAD_LAG_SECONDS);
  // Migrated, but the DAMM v2 pool is not readable yet: DAMM v2 trades may be missing.
  m.graduate({ readable: false });
  chain.land("d1", [m.damm], dammSwapTx({ direction: 1, pool: m.damm, blockTime: T + 50 }));
  clock.now = T + 100;
  await run.syncAll();
  assert.equal(row().damm_pool, null);
  assert.equal(indexProgress(row()), T - HEAD_LAG_SECONDS, "progress stays at the last loop that saw no migration");
  // Recorded, but its first sync fails: still no progress for the market.
  chain.put(m.damm, m.dammInfo);
  chain.failing.add(m.damm.toBase58());
  clock.now = T + 200;
  await run.syncAll();
  assert.equal(row().damm_pool, m.damm.toBase58());
  assert.equal(indexProgress(row()), null);
  assert.equal(db.trades.size, 0);
  chain.failing.clear();
  clock.now = T + 300;
  await run.syncAll();
  assert.equal(db.trades.size, 1);
  assert.equal(indexProgress(row()), T + 300 - HEAD_LAG_SECONDS);
  assert.deepEqual(cursorsOf(row()).map((c) => [c.venue, c.address, c.last, c.caughtUp]), [["dbc", m.pool.toBase58(), null, true], ["damm", m.damm.toBase58(), "d1", true]]);
});

test("each address is stamped with the time its own sync started, so pools read late in a slow loop are not stale", async () => {
  const chain = memChain(), db = memDb(), clock = { now: T };
  const [busy, second, third] = markets(chain, 3);
  // 30 transactions at 10 s each: the first pool alone takes 300 s of the loop.
  for (let i = 0; i < 30; i++) chain.land(`b${i}`, [busy.pool], quietTx(T - 1000 + i));
  chain.land("s1", [second.pool], quietTx(T - 500));
  chain.land("t1", [third.pool], quietTx(T - 400));
  const run = loop(chain, db, clock, { slow: true, spacingMs: 10_000 });
  await run.syncAll();
  assert.equal(run.state.lastError, null);
  const progress = (m) => indexProgress(db.pools.get(m.pool.toBase58()));
  assert.equal(progress(busy), T - HEAD_LAG_SECONDS);
  // The others from their own starts, 300.2 s and 310.4 s into the loop (10 s per transaction, 0.2 s between addresses), not the loop's.
  assert.equal(progress(second), T + 300 - HEAD_LAG_SECONDS);
  assert.equal(progress(third), T + 310 - HEAD_LAG_SECONDS);
  assert.ok(Math.abs(db.pools.get(third.pool.toBase58()).synced_at - (T + 310.4)) < 1e-3);
  // Next loop the same: each pool is as current as its own read.
  const start = clock.now;
  for (let i = 30; i < 60; i++) chain.land(`b${i}`, [busy.pool], quietTx(start - 60 + i));
  await run.syncAll();
  assert.equal(progress(busy), Math.floor(start - HEAD_LAG_SECONDS));
  assert.equal(progress(third), Math.floor(start + 300.4 - HEAD_LAG_SECONDS));
});

test("a DBC pool that migrates during the loop, after the graduation check, is not stamped past its migration", async () => {
  const chain = memChain(), db = memDb(), clock = { now: T };
  const [first, late] = markets(chain, 2);
  const run = loop(chain, db, clock, { slow: true, spacingMs: 10_000 });
  await run.syncAll();
  const row = () => db.pools.get(late.pool.toBase58());
  const earlier = indexProgress(row());
  assert.equal(earlier, Math.floor(T + 0.2 - HEAD_LAG_SECONDS));
  // Next loop: 20 transactions on the first pool (200 s). As its first one is read, the late pool
  // migrates and trades on DAMM v2 at T + 101, after findGraduated saw it on the curve.
  clock.now = T + 100;
  for (let i = 0; i < 20; i++) chain.land(`f${i}`, [first.pool], quietTx(T + 50 + i));
  const getTransaction = chain.conn.getTransaction;
  chain.conn.getTransaction = async (signature, opts) => {
    if (signature === "f0" && !chain.accounts.has(late.damm.toBase58())) {
      late.graduate();
      chain.land("d1", [late.damm], dammSwapTx({ direction: 1, pool: late.damm, blockTime: T + 101 }));
    }
    return getTransaction(signature, opts);
  };
  await run.syncAll();
  assert.equal(run.state.lastError, null);
  assert.equal(row().damm_pool, null, "recorded next loop");
  // Its own start was T + 300.2, but the DAMM v2 trade at T + 101 is not indexed yet: progress stays.
  assert.equal(indexProgress(row()), earlier);
  assert.ok(indexProgress(row()) <= T + 101);
  // Next loop records the DAMM v2 pool and reads its trade; progress resumes.
  clock.now = T + 400;
  await run.syncAll();
  assert.equal(row().damm_pool, late.damm.toBase58());
  assert.deepEqual(db.rows().map((t) => [t.signature, t.venue, t.block_time]), [["d1", "damm", T + 101]]);
  assert.equal(indexProgress(row()), Math.floor(T + 400.2 - HEAD_LAG_SECONDS));
});

test("a first-run backfill reads at most 100 transactions per address per loop; later pools go on, and progress waits until it has caught up", async () => {
  assert.equal(BACKFILL_TRANSACTIONS, 100);
  const chain = memChain(), db = memDb(), clock = { now: T };
  const [graduated, later] = markets(chain, 2);
  graduated.graduate();
  chain.land("m1", [graduated.pool], quietTx(T - 5000));
  const swap = (i, blockTime) => chain.land(`d${i}`, [graduated.damm], dammSwapTx({ direction: 1, pool: graduated.damm, blockTime, slot: i }));
  for (let i = 0; i < 250; i++) swap(i, T - 4000 + i);
  chain.land("l1", [later.pool], quietTx(T - 50));
  const run = loop(chain, db, clock);
  const dammReads = () => chain.calls.filter((c) => /^getTransaction d\d+$/.test(c)).length;
  const row = (m) => db.pools.get(m.pool.toBase58());
  const next = async (at) => {
    clock.now = at;
    chain.calls.length = 0;
    await run.syncAll();
    assert.equal(run.state.lastError, null);
  };

  await next(T);
  // The 100 oldest, then the cursor waits there.
  assert.equal(dammReads(), 100);
  assert.equal(row(graduated).damm_last_signature, "d99");
  assert.equal(db.trades.size, 100);
  assert.equal(row(graduated).damm_synced_at, null);
  assert.equal(indexProgress(row(graduated)), null, "no progress while its backfill has not caught up");
  assert.equal(indexProgress(row(later)), T - HEAD_LAG_SECONDS, "the pool after it is read and stamped in the same loop");

  await next(T + 30);
  assert.equal(dammReads(), 100);
  assert.equal(row(graduated).damm_last_signature, "d199");
  assert.equal(indexProgress(row(graduated)), null);

  await next(T + 60);
  assert.equal(dammReads(), 50);
  assert.equal(db.trades.size, 250, "every swap indexed once");
  assert.equal(new Set(db.rows().map((t) => t.signature)).size, 250);
  assert.equal(indexProgress(row(graduated)), T + 60 - HEAD_LAG_SECONDS);

  // Caught up: a burst larger than the cap is read in one loop, as before.
  for (let i = 250; i < 400; i++) swap(i, T + 61);
  await next(T + 90);
  assert.equal(dammReads(), 150);
  assert.equal(db.trades.size, 400);
  assert.equal(indexProgress(row(graduated)), T + 90 - HEAD_LAG_SECONDS);
});

test("graduation is read from the DBC pool and config and checked against the DAMM v2 pool's tokens", () => {
  const chain = memChain();
  const m = market(chain, { migrated: true });
  const info = (k) => chain.accounts.get(k.toBase58());
  const state = migratedState(info(m.pool));
  assert.ok(state);
  assert.equal(migratedState(dbcAccounts(m).poolInfo), null, "still on the curve");
  assert.equal(migratedState({ ...info(m.pool), owner: key() }), null, "not a DBC account");
  assert.equal(migratedState(null), null);
  const damm = dammPoolOf(state, info(m.config));
  assert.equal(damm.address.toBase58(), m.damm.toBase58());
  assert.equal(dammPoolOf(state, { ...info(m.config), owner: key() }), null);
  assert.equal(holdsMarket(m.dammInfo, damm), true);
  assert.equal(holdsMarket(m.dammInfo, { baseMint: damm.quoteMint, quoteMint: damm.baseMint }), false);
  assert.equal(holdsMarket(null, damm), false);
  assert.equal(holdsMarket({ ...m.dammInfo, owner: key() }, damm), false);
});

// ---- API ---------------------------------------------------------------------

test("the last bounty round's winners carry their rank, gaps included, from every row of that round", () => {
  const [a, b, c] = [key(), key(), key()].map(String);
  const round = bountyRound([
    { roundEnd: 900, winners: [{ trader: c, rank: 1, amount: "5" }] },
    { roundEnd: 1800, winners: [{ trader: b, rank: 3, amount: "200" }] },
    { roundEnd: 1800, winners: [{ trader: a, rank: 2, amount: "300", net: "9" }] },
  ]);
  assert.deepEqual(round, { lastRoundAt: 1800, winners: [{ trader: a, amount: "300", rank: 2 }, { trader: b, amount: "200", rank: 3 }] });
  assert.deepEqual(bountyRound([]), { winners: [], lastRoundAt: null });
  assert.deepEqual(bountyRound([{ roundEnd: 5, winners: [{ trader: a, amount: 1 }] }]).winners, [{ trader: a, amount: "1", rank: null }]);
});

function apiDb({ fm = null, rounds = [], airdrop = null }) {
  return {
    async query(sql) {
      if (/as paid, count\(\*\) filter/.test(sql)) return { rows: [{ paid: "1000", payouts: 1, recipients_last: 2, last_paid_at: "1790000000" }] };
      if (/from market_fee_models/.test(sql)) return { rows: fm ? [fm] : [] };
      if (/from airdrop_state/.test(sql)) return { rows: airdrop ? [airdrop] : [] };
      if (/module = 'topBuyers'/.test(sql)) {
        const end = Math.max(...rounds.map((d) => d.roundEnd));
        return { rows: rounds.filter((d) => d.roundEnd === end).map((detail) => ({ detail })) };
      }
      if (/jsonb_array_elements/.test(sql)) return { rows: [] };
      throw Error(`unexpected query: ${sql}`);
    },
  };
}
const rewards = (db, pool = key().toBase58()) => api({ db, state: {} }).route(new URL(`http://x/api/index/rewards?pool=${pool}`));

test("GET /api/index/rewards: bounty winners with rank, the airdrop's status, and a split's error", async () => {
  const [a, b] = [key(), key()].map(String);
  const bounty = await rewards(apiDb({
    fm: { fee_model: "topBuyers" },
    rounds: [{ roundEnd: 1200, roundStart: 300, winners: [{ trader: b, rank: 3, amount: "200", net: "1" }, { trader: a, rank: 1, amount: "500", net: "2" }] }],
  }));
  assert.deepEqual(bounty.winners, [{ trader: a, amount: "500", rank: 1 }, { trader: b, amount: "200", rank: 3 }]);
  assert.equal(bounty.lastRoundAt, 1200);
  // Existing fields stay.
  assert.deepEqual([bounty.paid, bounty.payouts, bounty.recipientsLast, bounty.lastPaidAt, bounty.feeModel], ["1000", 1, 2, 1_790_000_000, "topBuyers"]);
  const waiting = await rewards(apiDb({ fm: { fee_model: "holders" }, airdrop: { withdrawn: null, done: false, sent_at: null, recipients: 0 } }));
  assert.deepEqual(waiting.airdrop, { status: "waiting", amount: null, recipients: 0, sentAt: null });
  const sent = await rewards(apiDb({ airdrop: { withdrawn: "50000000000000", done: true, sent_at: "1790000100", recipients: 12 } }));
  assert.deepEqual(sent.airdrop, { status: "sent", amount: "50000000000000", recipients: 12, sentAt: 1_790_000_100 });
  assert.deepEqual(airdropSummary({ done: false, withdrawn: "7", recipients: 3, sent_at: null }), { status: "waiting", amount: "7", recipients: 3, sentAt: null });
  const noAirdrop = await rewards(apiDb({ fm: { fee_model: "holders" } }));
  assert.equal("airdrop" in noAirdrop, false);
  const bad = await rewards(apiDb({ fm: { fee_model: "split", config: { split: [{ wallet: "11111111111111111111111111111111", weight: 1 }] } } }));
  assert.deepEqual(bad.recipients, []);
  assert.match(bad.splitError, /Sonata or program address/);
  const good = await rewards(apiDb({ fm: { fee_model: "split", config: { split: [{ wallet: a, weight: 2 }] } } }));
  assert.deepEqual(good.recipients, [{ wallet: a, weight: 2, paid: "0" }]);
  assert.equal("splitError" in good, false);
  assert.equal(await rewards(apiDb({}), "not a pool"), 400);
});

// The payout ledgers in memory (reward_allocations, reward_payouts,
// airdrop_payouts), answering GET /api/index/payouts's queries as PostgreSQL
// would: timestamps are unix seconds, amounts strings.
function ledgerDb({ allocations = [], payouts = [], airdrops = [] } = {}) {
  const queries = [];
  // group by pool and module: sum(amount), count(distinct signature) (or count(*)), max(time).
  const grouped = (rows, { distinct = true } = {}) => {
    const out = new Map();
    for (const r of rows) {
      const k = `${r.pool}/${r.module}`;
      const g = out.get(k) ?? { pool: r.pool, module: r.module, paid: 0n, sigs: new Set(), n: 0, last: null };
      g.paid += BigInt(r.amount);
      if (r.signature != null) g.sigs.add(r.signature);
      g.n++;
      if (r.at != null) g.last = Math.max(g.last ?? r.at, r.at);
      out.set(k, g);
    }
    return [...out.values()].map((g) => ({
      pool: g.pool, module: g.module, paid: g.paid.toString(), payouts: distinct ? g.sigs.size : g.n,
      last_paid_at: g.last === null ? null : String(g.last),
    }));
  };
  async function query(sql, args = []) {
    queries.push({ sql, args });
    const s = sql.replace(/\s+/g, " ").trim();
    const [wallet] = args;
    if (s.startsWith("select pool, module, sum(amount)::text as paid") && /from reward_allocations where status = 'paid'/.test(s))
      return {
        rows: grouped(
          allocations
            .filter((a) => a.status === "paid" && (a.paid_to === wallet || (a.paid_to == null && a.kind === "wallet" && a.recipient === wallet)))
            .map((a) => ({ ...a, at: a.paid_at })),
        ),
      };
    if (s.startsWith("with paid as (")) {
      const allocated = new Set(allocations.map((a) => a.signature).filter(Boolean));
      const rows = payouts
        .filter((p) => ["topBuyers", "split"].includes(p.module) && !allocated.has(p.signature))
        .flatMap((p) => {
          const list = p.module === "topBuyers" ? p.detail?.winners : p.detail?.recipients;
          return (Array.isArray(list) ? list : [])
            .filter((r) => (r.trader ?? r.wallet) === wallet && /^[0-9]+$/.test(String(r.amount)))
            .map((r) => ({ pool: p.pool, module: p.module, signature: p.signature, amount: r.amount, at: p.paid_at }));
        });
      return { rows: grouped(rows) };
    }
    if (s.startsWith("select pool, 'airdrop' as module"))
      return {
        rows: grouped(
          airdrops.filter((a) => a.owner === wallet && a.status === "sent").map((a) => ({ ...a, module: "airdrop", at: a.sent_at })),
          { distinct: false },
        ),
      };
    throw Error(`unexpected query: ${s}`);
  }
  return { query, queries };
}
const payoutsOf = (db, wallet) => api({ db, state: {} }).route(new URL(`http://x/api/index/payouts?wallet=${encodeURIComponent(wallet)}`));

test("GET /api/index/payouts: a wallet's payouts per market and module, from every ledger that records recipients", async () => {
  const me = key().toBase58(), other = key().toBase58();
  const [p1, p2, p3] = [key(), key(), key()].map(String);
  const position = key().toBase58();
  const db = ledgerDb({
    allocations: [
      // Holders: two rounds paid in one transfer (one payout), then a third round.
      { pool: p1, round: 1, recipient: me, kind: "wallet", module: "holders", amount: "100", status: "paid", signature: "h1", paid_to: me, paid_at: T },
      { pool: p1, round: 2, recipient: me, kind: "wallet", module: "holders", amount: "50", status: "paid", signature: "h1", paid_to: me, paid_at: T },
      { pool: p1, round: 3, recipient: me, kind: "wallet", module: "holders", amount: "25", status: "paid", signature: "h2", paid_to: me, paid_at: T + 900 },
      // Not paid yet, or someone else's: not counted.
      { pool: p1, round: 4, recipient: me, kind: "wallet", module: "holders", amount: "999", status: "pending", signature: "h3", paid_to: me, paid_at: null },
      { pool: p1, round: 4, recipient: other, kind: "wallet", module: "holders", amount: "70", status: "paid", signature: "h4", paid_to: other, paid_at: T + 950 },
      // An LP position row paid to its NFT holder, and a wallet row written before paid_to was recorded.
      { pool: p2, round: 1, recipient: position, kind: "position", module: "lpFarm", amount: "40", status: "paid", signature: "l1", paid_to: me, paid_at: T + 100 },
      { pool: p2, round: 2, recipient: me, kind: "wallet", module: "lpFarm", amount: "2", status: "paid", signature: "l2", paid_to: null, paid_at: T + 200 },
      // An unresolved position row never counts as the wallet's, whatever its address.
      { pool: p2, round: 3, recipient: me, kind: "position", module: "lpFarm", amount: "5", status: "paid", signature: "l3", paid_to: null, paid_at: T + 300 },
      // Split paid by allocation rounds: its reward_payouts row (s2 below) lists the same payout.
      { pool: p3, round: 1, recipient: me, kind: "wallet", module: "split", amount: "300", status: "paid", signature: "s2", paid_to: me, paid_at: T + 400 },
    ],
    payouts: [
      // Top Buyer rounds: the wallet won twice; winners are only in the payout's detail.
      { pool: p1, module: "topBuyers", signature: "t1", paid_at: T + 500, detail: { roundEnd: 1, winners: [{ trader: me, rank: 1, amount: "500" }, { trader: other, rank: 2, amount: "300" }] } },
      { pool: p1, module: "topBuyers", signature: "t2", paid_at: T + 1400, detail: { roundEnd: 2, winners: [{ trader: me, rank: 3, amount: "20" }] } },
      { pool: p1, module: "topBuyers", signature: "t3", paid_at: T + 1500, detail: { roundEnd: 3, winners: [{ trader: other, rank: 1, amount: "9" }] } },
      // A split paid before allocation rounds existed, and one with allocation rows (counted from those).
      { pool: p3, module: "split", signature: "s1", paid_at: T + 350, detail: { recipients: [{ wallet: me, weight: 1, amount: "10" }, { wallet: other, weight: 1, amount: "10" }] } },
      { pool: p3, module: "split", signature: "s2", paid_at: T + 400, detail: { recipients: [{ wallet: me, weight: 1, amount: "300" }] } },
      // Older holders rows record only how many were paid, not who.
      { pool: p1, module: null, signature: "o1", paid_at: T - 100, recipients: 3, detail: null },
      { pool: p1, module: "holders", signature: "o2", paid_at: T - 50, recipients: 2, detail: null },
      // A detail that is not a list, or an amount that is not atoms, is skipped.
      { pool: p1, module: "topBuyers", signature: "t4", paid_at: T + 1600, detail: { winners: { trader: me, amount: "7" } } },
      { pool: p1, module: "topBuyers", signature: "t5", paid_at: T + 1700, detail: { winners: [{ trader: me, amount: "-7" }] } },
    ],
    airdrops: [
      { pool: p2, recipient: key().toBase58(), owner: me, amount: "5000000", status: "sent", signature: "a1", sent_at: T + 50 },
      { pool: p3, recipient: key().toBase58(), owner: me, amount: "8000000", status: "pending", signature: "a2", sent_at: null },
      { pool: p2, recipient: key().toBase58(), owner: other, amount: "1", status: "sent", signature: "a3", sent_at: T + 60 },
    ],
  });
  const out = await payoutsOf(db, me);
  assert.equal(out.wallet, me);
  assert.deepEqual(out.payouts, [
    { pool: p1, module: "topBuyers", asset: "quote", paid: "520", payouts: 2, lastPaidAt: T + 1400 },
    { pool: p1, module: "holders", asset: "quote", paid: "175", payouts: 2, lastPaidAt: T + 900 },
    { pool: p3, module: "split", asset: "quote", paid: "310", payouts: 2, lastPaidAt: T + 400 },
    { pool: p2, module: "lpFarm", asset: "quote", paid: "42", payouts: 2, lastPaidAt: T + 200 },
    { pool: p2, module: "airdrop", asset: "base", paid: "5000000", payouts: 1, lastPaidAt: T + 50 },
  ]);
  // The wallet is only ever a query parameter.
  assert.ok(db.queries.every((q) => q.args[0] === me && !q.sql.includes(me)));
  const nobody = await payoutsOf(ledgerDb(), key().toBase58());
  assert.deepEqual(nobody.payouts, []);
});

test("GET /api/index/payouts takes only a canonical base58 32-byte key", async () => {
  const db = ledgerDb();
  const valid = key().toBase58();
  for (const bad of [
    "",
    "not a key",
    `${valid} `,
    `${valid}1`,
    valid.replace(/.$/, "0"),
    bs58.encode(Buffer.alloc(31, 7)),
    bs58.encode(Buffer.alloc(33, 7)),
  ])
    assert.equal(await payoutsOf(db, bad), 400, JSON.stringify(bad));
  assert.equal(await api({ db, state: {} }).route(new URL("http://x/api/index/payouts")), 400);
  assert.equal(db.queries.length, 0, "nothing is read for a bad wallet");
  assert.deepEqual(await payoutsOf(db, "11111111111111111111111111111111"), { wallet: "11111111111111111111111111111111", payouts: [] });
});
