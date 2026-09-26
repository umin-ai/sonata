// Live push's 1 s poll (live.mjs) over a fake RPC holding four real Devnet
// markets, with the real reader, store and decoder: new registrations, curve
// changes, trade wake-ups, re-reads before errors, stats and graduation.
import test from "node:test";
import assert from "node:assert/strict";
import { livePush, SYNC_CONCURRENCY, SYNC_STARTS_PER_SECOND } from "./live.mjs";
import { marketStore } from "./market-store.mjs";
import { appDecode, bought, bySymbol, fakeRpc, fixture, golden, manualClock, PROGRAM, readerOver, tokenAmount } from "./livekit.mjs";

const decode = await appDecode();

async function setup({ treasuries, db = null } = {}) {
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
    syncPool: async (pool) => void calls.push(["sync", pool]),
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
  assert.deepEqual(db.calls.filter((c) => c[0] === "sync").map((c) => c[1]).sort(), [backed.pool, room.pool].sort());
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

test("trade syncs: one per market at a time (a wake during one runs it again after), at most four at once", async () => {
  const releases = [];
  const started = [];
  const db = { ...fakeDb(), syncPool: (pool) => (started.push(pool), new Promise((r) => releases.push(r))) };
  const { push, chain, clock } = await setup({ db });
  // Every listed market was woken as it was added: four, all running (two a second).
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

test("trade syncs start at most two a second, however many pools change at once", async () => {
  const started = [];
  const db = { ...fakeDb(), syncPool: async (pool) => void started.push(pool) };
  const { chain, clock, push } = await setup({ db });
  await push.pollOnce();
  await settle();
  clock.advance(10_000);
  started.length = 0;
  chain.slot++;
  for (const m of golden.markets) {
    const damm = golden.treasuries[m.pool].dammPool;
    chain.edit(damm ?? m.pool, damm ? (d) => (d[0] ^= 1) : bought());
  }
  await push.pollOnce();
  await settle();
  assert.equal(started.length, SYNC_STARTS_PER_SECOND, "two at once");
  clock.advance(500);
  await settle();
  assert.equal(started.length, 3);
  clock.advance(500);
  await settle();
  assert.equal(new Set(started).size, 4, "the rest follow, one every half second");
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
