// Live push's 1 s poll (live.mjs) over a fake RPC holding four real Devnet
// markets, with the real reader, store and decoder: new registrations, curve
// changes, trade wake-ups, re-reads before errors, stats and graduation.
import test from "node:test";
import assert from "node:assert/strict";
import { dailyBudget, FALLBACK_POLL_EVERY_MS, livePush, PROFILE_CONCURRENCY, SYNC_CONCURRENCY, SYNC_STARTS_PER_SECOND, TRIGGER_GAP_MS } from "./live.mjs";
import { marketStore } from "./market-store.mjs";
import { appDecode, bought, bySymbol, fakeRpc, fixture, golden, manualClock, PROGRAM, readerOver, tokenAmount } from "./livekit.mjs";

const decode = await appDecode();

async function setup({ treasuries, db = null, ...opts } = {}) {
  const chain = fakeRpc();
  if (treasuries) chain.treasuries = treasuries;
  const clock = manualClock();
  const store = marketStore({ decode, programId: PROGRAM, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, epoch: "e1", log: () => {} });
  const frames = [];
  store.onFrame((f) => frames.push(f));
  const logs = [];
  let push = null;
  const reader = readerOver(chain, { onRead: (r) => push.onRead(r) });
  push = livePush({
    store,
    reader,
    conn: chain.conn,
    programId: PROGRAM,
    now: clock.now,
    sleep: async () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    every: clock.every,
    stopEvery: clock.stopEvery,
    log: (...a) => logs.push(a.join(" ")),
    ...opts,
  });
  if (db) push.attach(db);
  await reader.tick();
  clock.advance(1_000);
  return { chain, clock, store, frames, logs, push, reader };
}
function fakeDb() {
  const calls = [];
  const db = {
    calls,
    syncPool: async (pool, venues) => void calls.push(["sync", pool, venues ? [...venues].sort().join(",") : "all"]),
    insertPool: async (pool, treasury) => void calls.push(["insert", pool, treasury]),
    recordGraduation: async (pool) => void calls.push(["graduation", pool]),
    statsFor: async (pool) => (calls.push(["stats", pool]), { pool, trades_24h: 1, trades_total: 1 }),
    allStats: async () => (calls.push(["allStats"]), []),
  };
  return db;
}
const settle = () => new Promise((r) => setImmediate(r));

test("a market registered after the first poll is pushed after the next one: a new Sonata transaction triggers a full read at its slot", async () => {
  const [first, ...rest] = fixture.programAccounts.map((p) => p.pubkey);
  const db = fakeDb();
  const { chain, frames, push, store } = await setup({ treasuries: rest, db });
  assert.equal(store.entries().length, 3);
  chain.land(PROGRAM, "old", chain.slot);
  await push.pollOnce();
  assert.equal(frames.length, 3, "the first poll only notes the newest transaction");
  // The registration lands: its treasury is listed from its slot on.
  chain.slot += 5;
  chain.treasuries = [first, ...rest];
  chain.land(PROGRAM, "register", chain.slot);
  chain.calls.length = 0;
  await push.pollOnce();
  await settle();
  const added = frames.filter((f) => f.data.kind === "added").at(-1);
  assert.equal(added.data.entry.market.treasury, first);
  // The read asked for no older state than the registration's slot.
  const listing = chain.calls.find((c) => c.method === "getProgramAccounts");
  assert.equal(listing.config.minContextSlot, chain.slot);
  // Its pools row is written and its trades read at once.
  const pool = added.data.pool;
  assert.deepEqual(db.calls.filter((c) => c[0] === "insert" && c[1] === pool), [["insert", pool, first]]);
  assert.ok(db.calls.some((c) => c[0] === "sync" && c[1] === pool));
  // Nothing new: no read.
  chain.calls.length = 0;
  await push.pollOnce();
  assert.equal(chain.calls.filter((c) => c.method === "getProgramAccounts").length, 0);
});

test("a node answering with an older signature list does not trigger reads", async () => {
  const { chain, push } = await setup();
  chain.land(PROGRAM, "a", chain.slot);
  await push.pollOnce();
  chain.signatures.set(PROGRAM, [{ signature: "older", slot: chain.slot - 10, err: null }]);
  chain.calls.length = 0;
  await push.pollOnce();
  assert.equal(chain.calls.filter((c) => c.method === "getProgramAccounts").length, 0);
});

test("a pool that changes is decoded and pushed within the poll, and wakes its trade sync; a graduated market's DAMM v2 pool only wakes it", async () => {
  const db = fakeDb();
  const { chain, clock, frames, push, store } = await setup({ db });
  const room = bySymbol("ROOM"),
    backed = bySymbol("BACKED");
  const damm = golden.treasuries[room.pool].dammPool;
  await push.pollOnce();
  await settle();
  clock.advance(1_000);
  db.calls.length = 0;
  frames.length = 0;
  chain.slot++;
  chain.edit(backed.pool, bought());
  chain.edit(damm, (d) => (d[0] = 1));
  await push.pollOnce();
  assert.deepEqual(frames.map((f) => [f.scope, f.pool]), [["market", backed.pool], ["list", backed.pool]]);
  assert.equal(store.entryOf(backed.pool).version, chain.slot);
  await settle();
  clock.advance(1_000);
  await settle();
  // Each market's sync reads only the venue that changed.
  assert.deepEqual(
    db.calls.filter((c) => c[0] === "sync").sort((a, b) => (a[1] < b[1] ? -1 : 1)),
    [["sync", backed.pool, "dbc"], ["sync", room.pool, "damm"]].sort((a, b) => (a[1] < b[1] ? -1 : 1)),
  );
  // The poll read one call's worth of pools: three curve pools and ROOM's DAMM v2 pool.
  const read = chain.calls.filter((c) => c.method === "getMultipleAccounts").at(-1);
  assert.equal(read.keys.length, 4);
  assert.ok(read.keys.includes(damm) && !read.keys.includes(room.pool));
});

test("a failing poll is logged once and the next one goes on", async () => {
  const { chain, logs, push } = await setup();
  chain.fail = "fetch failed";
  await push.pollOnce();
  await push.pollOnce();
  assert.equal(logs.filter((l) => l.includes("live poll failed")).length, 1);
  assert.equal(push.health().pollErrors, 2);
  chain.fail = null;
  await push.pollOnce();
  assert.equal(push.health().lastError, null);
});

test("a market whose numbers turn into an error is re-read (at no older slot) before the error is pushed", async () => {
  const { chain, frames, push, store } = await setup();
  const backed = bySymbol("BACKED");
  frames.length = 0;
  // The pool changes at the same time as custody reads empty, as a half-landed view would.
  chain.edit(backed.treasuryQuote, tokenAmount(0n));
  const custody = chain.accounts.get(backed.treasuryQuote);
  chain.slot++;
  chain.calls.length = 0;
  push.onRead({ ...(await readerOver(chain).read()), readAt: 2_000 });
  await settle();
  const reread = chain.calls.filter((c) => c.method === "getMultipleAccounts").at(-1);
  assert.ok(reread.keys.includes(backed.treasuryQuote));
  assert.equal(reread.config.minContextSlot, chain.slot);
  // The re-read said the same: now it is pushed.
  assert.equal(store.entryOf(backed.pool).data, null);
  assert.match(frames.find((f) => f.scope === "market").data.error, /does not reconcile/);
  // Fixed on chain: the next read brings the numbers back.
  chain.accounts.set(backed.treasuryQuote, fixture.accounts[backed.treasuryQuote]);
  chain.slot++;
  push.onRead({ ...(await readerOver(chain).read()), readAt: 3_000 });
  assert.ok(store.entryOf(backed.pool).data);
  assert.ok(custody);
});

test("a trade the sync inserts is pushed to its market's pages, and its stats follow a moment later", async () => {
  const db = fakeDb();
  const { clock, frames, push } = await setup({ db });
  const backed = bySymbol("BACKED");
  frames.length = 0;
  push.onTrade({ pool: backed.pool, signature: "s", ix_index: 0, slot: 1, time: 1, side: "buy" });
  push.onTrade({ pool: backed.pool, signature: "s", ix_index: 1, slot: 1, time: 1, side: "buy" });
  assert.deepEqual(frames.map((f) => [f.event, f.scope]), [["trade", "market"], ["trade", "market"]]);
  clock.advance(250);
  await settle();
  assert.equal(db.calls.filter((c) => c[0] === "stats").length, 1, "one stats query for the burst");
  assert.deepEqual(frames.at(-1).event, "stats");
  // Every minute, everything's stats (the 24 h window moves with the clock).
  const before = db.calls.filter((c) => c[0] === "allStats").length;
  clock.advance(60_000);
  assert.equal(db.calls.filter((c) => c[0] === "allStats").length, before + 1);
});

test("a market that graduates gets its DAMM v2 pool recorded, then its trades read", async () => {
  const db = fakeDb();
  const { chain, clock, push } = await setup({ db });
  const backed = bySymbol("BACKED");
  await push.pollOnce();
  await settle();
  clock.advance(1_000);
  db.calls.length = 0;
  chain.slot++;
  chain.edit(backed.pool, (d) => (d[305] = 1));
  await push.pollOnce();
  await settle();
  await settle();
  const i = db.calls.findIndex((c) => c[0] === "graduation");
  assert.ok(i >= 0);
  assert.ok(db.calls.slice(i).some((c) => c[0] === "sync" && c[1] === backed.pool));
});

// Every listed market's pool changes at once (graduated ones: their DAMM v2 pool, seen once before).
async function changeAll(chain, push) {
  await push.pollOnce();
  chain.slot++;
  for (const m of golden.markets) {
    const damm = golden.treasuries[m.pool].dammPool;
    chain.edit(damm ?? m.pool, damm ? (d) => (d[0] ^= 1) : bought());
  }
  await push.pollOnce();
}

test("trade syncs: one per market at a time (a wake during one runs it again after), at most four at once", async () => {
  const releases = [];
  const started = [];
  const db = { ...fakeDb(), syncPool: (pool) => (started.push(pool), new Promise((r) => releases.push(r))) };
  const { push, chain, clock } = await setup({ db });
  assert.equal(started.length, 0, "nothing woken for the markets the first read listed: the sync loop catches them up");
  await changeAll(chain, push);
  clock.advance(10_000);
  await settle();
  assert.equal(started.length, 4);
  assert.equal(push.health().syncing, SYNC_CONCURRENCY);
  const backed = bySymbol("BACKED");
  chain.slot++;
  chain.edit(backed.pool, bought());
  await push.pollOnce();
  assert.equal(started.length, 4, "BACKED's sync is running: woken again, it waits");
  releases.splice(0).forEach((r) => r());
  await settle();
  await settle();
  clock.advance(1_000);
  assert.deepEqual(started.slice(4), [backed.pool]);
});

test("trade syncs start at most one a second, however many pools change at once", async () => {
  const started = [];
  const db = { ...fakeDb(), syncPool: async (pool) => void started.push(pool) };
  const { chain, clock, push } = await setup({ db });
  await changeAll(chain, push);
  await settle();
  assert.equal(started.length, SYNC_STARTS_PER_SECOND);
  clock.advance(1_000);
  await settle();
  assert.equal(started.length, 2);
  clock.advance(2_000);
  await settle();
  assert.equal(new Set(started).size, 4, "the rest follow, one a second");
});

test("the very first transaction on a program with none before is news too", async () => {
  const [first, ...rest] = fixture.programAccounts.map((p) => p.pubkey);
  const { chain, frames, push } = await setup({ treasuries: rest });
  await push.pollOnce();
  chain.slot += 2;
  chain.treasuries = [first, ...rest];
  chain.land(PROGRAM, "register", chain.slot);
  await push.pollOnce();
  await settle();
  assert.equal(frames.filter((f) => f.data.kind === "added").at(-1).data.entry.market.treasury, first);
});

test("a new market's trades are read only once its pools row is written (a sync before would find no row)", async () => {
  const [first, ...rest] = fixture.programAccounts.map((p) => p.pubkey);
  let written;
  const db = fakeDb();
  db.insertPool = (pool, treasury) => new Promise((r) => (written = () => (db.calls.push(["insert", pool, treasury]), r())));
  const { chain, push } = await setup({ treasuries: rest, db });
  await push.pollOnce();
  chain.slot += 2;
  chain.treasuries = [first, ...rest];
  chain.land(PROGRAM, "register", chain.slot);
  await push.pollOnce();
  await settle();
  assert.equal(db.calls.filter((c) => c[0] === "sync").length, 0, "not before the row exists");
  written();
  await settle();
  assert.deepEqual(db.calls.map((c) => c[0]).filter((c) => c !== "allStats"), ["insert", "sync"]);
});

test("new Sonata transactions read only new registrations: failed ones trigger nothing, and reads are at least three seconds apart", async () => {
  const [first, second, ...rest] = fixture.programAccounts.map((p) => p.pubkey);
  const { chain, clock, frames, push } = await setup({ treasuries: rest });
  const reads = () => chain.calls.filter((c) => c.method === "getProgramAccounts");
  // Reads of treasury accounts (the poll reads pools only).
  const accountReads = () => chain.calls.filter((c) => c.method === "getMultipleAccounts" && c.keys.some((k) => [first, second, ...rest].includes(k)));
  await push.pollOnce();
  // A failed transaction: nothing.
  chain.signatures.set(PROGRAM, [{ signature: "failed", slot: chain.slot + 1, err: { InstructionError: [0, "Custom"] } }]);
  chain.calls.length = 0;
  await push.pollOnce();
  assert.equal(reads().length, 0);
  // A claim on a market already listed: one call (the account list), nothing more.
  chain.slot += 1;
  chain.land(PROGRAM, "claim", chain.slot);
  await push.pollOnce();
  await settle();
  assert.equal(reads().length, 1);
  assert.equal(reads()[0].config.dataSlice.length, 0, "keys only");
  assert.equal(accountReads().length, 0);
  // A registration a second later waits for the gap, then is read with its market's accounts.
  clock.advance(1_000);
  chain.slot += 1;
  chain.treasuries = [first, ...rest];
  chain.land(PROGRAM, "register", chain.slot);
  await push.pollOnce();
  await settle();
  assert.equal(reads().length, 1, "within three seconds of the last read");
  clock.advance(TRIGGER_GAP_MS - 1_000);
  await settle();
  await settle();
  assert.equal(reads().length, 2);
  assert.equal(frames.filter((f) => f.data.kind === "added").at(-1).data.entry.market.treasury, first);
  // Two landing close together share one read.
  clock.advance(TRIGGER_GAP_MS);
  chain.slot += 1;
  chain.treasuries = [first, second, ...rest];
  chain.land(PROGRAM, "again", chain.slot);
  await push.pollOnce();
  await settle();
  await settle();
  assert.equal(frames.filter((f) => f.data.kind === "added").at(-1).data.entry.market.treasury, second);
});

test("a full read triggered before the reader's first complete read is a full read", async () => {
  const chain = fakeRpc();
  const clock = manualClock();
  const store = marketStore({ decode, programId: PROGRAM, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, epoch: "e1", log: () => {} });
  let push = null;
  const reader = readerOver(chain, { onRead: (r) => push.onRead(r) });
  push = livePush({ store, reader, conn: chain.conn, programId: PROGRAM, now: clock.now, sleep: async () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {} });
  chain.land(PROGRAM, "a", chain.slot);
  await push.pollOnce();
  chain.land(PROGRAM, "b", chain.slot);
  await push.pollOnce();
  await settle();
  await settle();
  assert.equal(store.entries().length, 4);
});

test("24h stats: one full query at a time, and a row never replaced by one from a query that started earlier", async () => {
  let answerAll;
  const db = fakeDb();
  const { clock, push, store } = await setup({ db });
  const backed = bySymbol("BACKED");
  db.allStats = () => (db.calls.push(["allStats"]), new Promise((r) => (answerAll = r)));
  db.calls.length = 0;
  clock.advance(60_000);
  clock.advance(60_000);
  assert.equal(db.calls.filter((c) => c[0] === "allStats").length, 1, "the second minute's query waits for the first");
  // A trade's stats query starts after the full one and answers first.
  push.onTrade({ pool: backed.pool, signature: "s", ix_index: 0 });
  db.statsFor = async (pool) => ({ pool, trades_24h: 2, trades_total: 2 });
  clock.advance(250);
  await settle();
  answerAll([{ pool: backed.pool, trades_24h: 1, trades_total: 1 }]);
  await settle();
  await settle();
  assert.equal(store.statsRows().find((r) => r.pool === backed.pool).trades_24h, 2);
});

test("a poll hit by a rate limit or a timeout says to wait longer; the loop doubles its wait up to 8 s and goes back to 1 s once one works", async () => {
  const waits = [];
  let polls = 0;
  const { chain, push } = await setup({
    sleep: async (ms) => {
      waits.push(ms);
      if (++polls === 6) chain.fail = null;
      if (polls >= 8) await push.stop();
    },
  });
  chain.fail = "429 Too Many Requests";
  assert.equal(await push.pollOnce(), true);
  chain.fail = "boom";
  assert.equal(await push.pollOnce(), false);
  chain.fail = "The operation was aborted due to timeout";
  push.start();
  while (polls < 8) await settle();
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 1_000, 1_000]);
});

test("pools keep being read through the fallback RPC while the main one fails: after three failures, at most every five seconds, within its daily budget", async () => {
  const main = fakeRpc();
  const spare = fakeRpc();
  const budget = dailyBudget(2);
  const { chain, clock, push, frames } = await setup({ fallback: spare.conn, fallbackBudget: budget });
  const backed = bySymbol("BACKED");
  chain.fail = "429 Too Many Requests";
  for (let i = 0; i < 2; i++) await push.pollOnce();
  assert.equal(push.health().fallbackPolls, 0);
  spare.slot = chain.slot + 1;
  spare.edit(backed.pool, bought());
  frames.length = 0;
  await push.pollOnce();
  assert.equal(push.health().fallbackPolls, 1);
  assert.equal(frames.find((f) => f.scope === "market").pool, backed.pool, "the curve moved");
  await push.pollOnce();
  assert.equal(push.health().fallbackPolls, 1, "not within five seconds");
  clock.advance(FALLBACK_POLL_EVERY_MS);
  await push.pollOnce();
  clock.advance(FALLBACK_POLL_EVERY_MS);
  await push.pollOnce();
  assert.equal(push.health().fallbackPolls, 2, "the budget is used up");
  assert.ok(main);
});

test("token profiles are read at most four at once", async () => {
  let reading = 0,
    most = 0;
  const releases = [],
    set = [];
  const fetchProfile = () => {
    reading++;
    most = Math.max(most, reading);
    return new Promise((r) => releases.push(() => (reading--, r({ image: "https://x/i.png" }))));
  };
  // Seven listed markets, each with its own profile.
  const entries = Array.from({ length: 7 }, (_, i) => ({ market: { pool: `p${i}`, uri: `https://x/${i}.json` } }));
  const store = {
    ready: true,
    mergeRead: () => [],
    decode: () => ({ events: [], suspects: [] }),
    entries: () => entries,
    setProfile: (uri) => set.push(uri),
    hasProfile: () => false,
  };
  const push = livePush({ store, reader: {}, conn: fakeRpc().conn, programId: PROGRAM, fetchProfile, log: () => {} });
  push.onRead({});
  assert.equal(most, PROFILE_CONCURRENCY);
  while (releases.length) {
    releases.shift()();
    await settle();
  }
  assert.equal(most, PROFILE_CONCURRENCY);
  assert.equal(set.length, 7, "all read in the end");
});

test("attaching the database after the first read wakes nothing: the sync loop catches listed markets up", async () => {
  const { push } = await setup();
  const db = fakeDb();
  push.attach(db);
  await settle();
  assert.deepEqual(db.calls.filter((c) => c[0] !== "allStats"), []);
});

test("with a second RPC every other poll goes to it, only while its daily budget lasts", async () => {
  let target = null,
    altCalls = 0;
  // Serves the same chain as the main connection, counting its calls.
  const alt = new Proxy({}, { get: (_, k) => (...a) => (altCalls++, target[k](...a)) });
  const { chain, push } = await setup({ altConn: alt, altBudget: dailyBudget(2) });
  target = chain.conn;
  for (let i = 0; i < 6; i++) await push.pollOnce();
  // Polls 1 and 3 go to the second RPC; poll 5 would, but its budget of 2 is spent.
  assert.equal(push.health().altPolls, 2);
  assert.equal(altCalls, 4);
  assert.equal(push.health().pollErrors, 0);
});
