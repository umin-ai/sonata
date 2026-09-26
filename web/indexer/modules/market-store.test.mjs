// The live market store (market-store.mjs) with the app's own decoder over
// four real Devnet markets: what it pushes, when, and what it never pushes.
import test from "node:test";
import assert from "node:assert/strict";
import { marketStore, MAX_REPLAY_TRADES } from "./market-store.mjs";
import { appDecode, bought, bySymbol, fakeRpc, fixture, golden, manualClock, PROGRAM, readerOver, tokenAmount } from "./livekit.mjs";

const decode = await appDecode();

async function setup({ treasuries, ...opts } = {}) {
  const chain = fakeRpc();
  if (treasuries) chain.treasuries = treasuries;
  const clock = manualClock();
  const store = marketStore({ decode, programId: PROGRAM, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, epoch: "e1", log: () => {}, ...opts });
  const frames = [];
  store.onFrame((f) => frames.push(f));
  const reader = readerOver(chain);
  const read = async (minContextSlot) => {
    const r = await reader.read(chain.conn, { minContextSlot });
    const todo = store.mergeRead(r);
    return store.decode(todo);
  };
  return { chain, clock, store, frames, read };
}
const pools = (entries) => entries.map((e) => e.market.pool);
const poolAccount = (chain, pool, slot) => {
  const a = chain.accounts.get(pool);
  return { owner: a.owner, lamports: a.lamports, executable: a.executable, data: a.data[0], slot };
};

test("the first read pushes each listed market once, newest first, with the entries the app's server decodes", async () => {
  const { store, frames, read } = await setup();
  await read();
  assert.equal(store.ready, true);
  assert.deepEqual(frames.map((f) => [f.event, f.data.kind, f.scope]), Array(4).fill(["market", "added", "all"]));
  assert.deepEqual(frames.map((f) => f.seq), [1, 2, 3, 4]);
  // Newest launch first: BACKED, RWDCHK, FPT, ROOM (fixture activation points).
  assert.deepEqual(pools(store.entries()), ["BACKED", "RWDCHK", "FPT", "ROOM"].map((s) => bySymbol(s).pool));
  for (const e of store.entries()) {
    assert.ok(e.data, e.error);
    assert.equal(e.version, fixture.slot);
    assert.ok(e.launchedAt > 1_789_000_000);
  }
  // The same read again changes nothing.
  await read();
  assert.equal(frames.length, 4);
  // /api/index/accounts: the raw view, the decoded entries and the stream position.
  const view = JSON.parse(store.view());
  assert.equal(view.epoch, "e1");
  assert.equal(view.seq, 4);
  assert.deepEqual(pools(view.entries), pools(store.entries()));
  assert.deepEqual(view.treasuries, fixture.programAccounts.map((p) => p.pubkey));
  assert.equal(Object.keys(view.accounts).length, Object.keys(fixture.accounts).length);
});

test("an older or equal view of an account never replaces a newer one; a newer pool pushes its market at once, and the list at most once a second", async () => {
  const { chain, clock, store, frames, read } = await setup();
  await read();
  // The list's throttle counts from each market's `added`.
  clock.advance(1_000);
  frames.length = 0;
  const backed = bySymbol("BACKED");
  const before = store.entryOf(backed.pool).data;
  chain.edit(backed.pool, bought());
  // Seen at an older slot (a lagging node): ignored.
  assert.deepEqual(store.patch([[backed.pool, poolAccount(chain, backed.pool, fixture.slot - 1)]]), []);
  const todo = store.patch([[backed.pool, poolAccount(chain, backed.pool, fixture.slot + 5)]]);
  assert.deepEqual(todo, [backed.treasury]);
  store.decode(todo);
  const after = store.entryOf(backed.pool).data;
  assert.ok(after.graduationBps > before.graduationBps && after.marketCap > before.marketCap);
  assert.equal(store.entryOf(backed.pool).version, fixture.slot + 5);
  assert.deepEqual(frames.map((f) => [f.scope, f.data.kind]), [["market", "updated"], ["list", "updated"]]);
  // The market page gets everything; the list only what a card shows.
  assert.equal(frames[0].data.data.custody, before.custody);
  assert.equal(frames[1].data.card.marketCap, after.marketCap);
  assert.equal(frames[1].data.card.custody, undefined);
  // A full read from a node behind the live view does not bring the old pool back.
  chain.slot = fixture.slot + 2;
  chain.edit(backed.pool, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(240) - 10_000_000n, 240));
  await read();
  assert.equal(store.entryOf(backed.pool).data.marketCap, after.marketCap);
  // Two more changes within the second: the list gets one update when the second is up, with the latest numbers.
  frames.length = 0;
  for (const [n, slot] of [[1n, fixture.slot + 10], [2n, fixture.slot + 11]]) {
    chain.edit(backed.pool, bought(n * 1_000_000n));
    store.decode(store.patch([[backed.pool, poolAccount(chain, backed.pool, slot)]]));
  }
  assert.deepEqual(frames.map((f) => f.scope), ["market", "market"]);
  clock.advance(1_000);
  assert.deepEqual(frames.map((f) => f.scope), ["market", "market", "list"]);
  assert.equal(frames[2].data.version, fixture.slot + 11);
  assert.equal(frames[2].data.card.marketCap, store.entryOf(backed.pool).data.marketCap);
});

test("a market registered later is added once; markets that fail the listing rule are never pushed", async () => {
  const [first, ...rest] = fixture.programAccounts.map((p) => p.pubkey);
  const { chain, frames, read, store } = await setup({ treasuries: rest });
  await read();
  assert.equal(frames.length, 3);
  chain.treasuries = [first, ...rest];
  chain.slot++;
  await read();
  assert.equal(frames.length, 4);
  assert.equal(frames[3].data.kind, "added");
  assert.equal(frames[3].data.entry.market.treasury, first);
  await read();
  assert.equal(frames.length, 4);
  // A treasury on an unregistered quote mint is never read, so never listed (market-accounts.test.mjs);
  // one whose config is not Sonata's standard, or not owned by DBC, is read but never pushed.
  const { setConfigByte } = await import("../../lib/treasury/fixtures/config-bytes.ts");
  const floor = bySymbol("FPT"),
    reward = bySymbol("RWDCHK");
  const { chain: c2, frames: f2, read: read2 } = await setup();
  c2.edit(floor.config, (d) => setConfigByte(d, "creatorTradingFeePercentage", 50).copy(d));
  const cfg = c2.accounts.get(reward.config);
  c2.accounts.set(reward.config, { ...cfg, owner: "11111111111111111111111111111111" });
  await read2();
  assert.deepEqual(f2.map((f) => f.data.entry.market.symbol).sort(), ["BACKED", "ROOM"]);
  assert.equal(store.entries().length, 4);
});

test("a half-updated view (custody read before the treasury) is re-read before any error is pushed", async () => {
  const { chain, clock, frames, read, store } = await setup();
  await read();
  clock.advance(1_000);
  frames.length = 0;
  const backed = bySymbol("BACKED");
  const custody = chain.accounts.get(backed.treasuryQuote);
  chain.edit(backed.treasuryQuote, tokenAmount(0n));
  const todo = store.patch([[backed.treasuryQuote, { owner: custody.owner, lamports: custody.lamports, executable: false, data: chain.accounts.get(backed.treasuryQuote).data[0], slot: fixture.slot + 1 }]]);
  const { events, suspects } = store.decode(todo);
  assert.deepEqual(events, []);
  assert.deepEqual(suspects, [backed.treasury]);
  assert.equal(frames.length, 0, "nothing pushed yet");
  assert.ok(store.entryOf(backed.pool).data, "the last good numbers stay");
  // Confirmed by a fresh read: now it is pushed.
  store.decode([backed.treasury], { confirm: new Set([backed.treasury]) });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].data.data, null);
  assert.match(frames[0].data.error, /does not reconcile/);
  assert.equal(frames[1].data.card, null);
});

test("a market listed for the first time without numbers waits for a re-read; one missing from six reads is removed", async () => {
  const backed = bySymbol("BACKED");
  const { chain, frames, read, store } = await setup();
  chain.edit(backed.treasuryQuote, tokenAmount(0n));
  const { suspects } = await read();
  assert.deepEqual(suspects, [backed.treasury]);
  assert.equal(frames.length, 3);
  store.decode([backed.treasury], { confirm: new Set([backed.treasury]) });
  assert.equal(frames.length, 4);
  assert.equal(frames[3].data.entry.data, null);
  chain.treasuries = chain.treasuries.filter((t) => t !== backed.treasury);
  for (let i = 0; i < 5; i++) await read();
  assert.ok(store.entryOf(backed.pool), "still listed after five reads without it");
  await read();
  assert.equal(store.entryOf(backed.pool), null);
  assert.deepEqual([frames.at(-1).event, frames.at(-1).data.pool], ["removed", backed.pool]);
});

test("replay: what a page missed, compacted; null once the buffer no longer covers it", async () => {
  const { chain, clock, store, read } = await setup({ ringFrames: 8 });
  await read();
  clock.advance(1_000);
  const backed = bySymbol("BACKED"),
    fpt = bySymbol("FPT");
  store.setStats([{ pool: backed.pool, trades_24h: 1 }]);
  const since = store.seq;
  for (let i = 1; i <= 2; i++) {
    chain.edit(backed.pool, bought());
    store.decode(store.patch([[backed.pool, poolAccount(chain, backed.pool, fixture.slot + i)]]));
  }
  store.publishTrade({ pool: backed.pool, signature: "s1", ix_index: 0 });
  store.publishTrade({ pool: fpt.pool, signature: "s2", ix_index: 0 });
  const list = store.replay(since, "list");
  assert.deepEqual(list.map((f) => f.event), ["market", "stats"]);
  assert.equal(list[0].data.kind, "added");
  assert.equal(list[0].data.entry.data.marketCap, store.entryOf(backed.pool).data.marketCap, "as it is now");
  assert.equal(list[1].data.full, true);
  const market = store.replay(since, "market", backed.pool);
  assert.deepEqual(market.map((f) => f.event), ["market", "trade", "stats"]);
  assert.equal(market[1].data.trade.signature, "s1");
  assert.deepEqual(store.replay(since, "market", fpt.pool).map((f) => f.event), ["trade", "stats"]);
  // Too old for the buffer, from the future, or too many trades: a snapshot instead.
  assert.equal(store.replay(0, "list"), null);
  assert.equal(store.replay(store.seq + 1, "list"), null);
  const at = store.seq;
  for (let i = 0; i <= MAX_REPLAY_TRADES; i++) store.publishTrade({ pool: fpt.pool, signature: `t${i}`, ix_index: 0 });
  assert.equal(store.replay(at, "market", fpt.pool), null);
  assert.ok(store.replay(store.seq, "list"));
});

test("the ring buffer keeps at most its size and five minutes; seq only grows", async () => {
  const { clock, store, read } = await setup({ ringFrames: 10 });
  await read();
  for (let i = 0; i < 20; i++) store.publishTrade({ pool: "p", signature: String(i), ix_index: 0 });
  assert.equal(store.health().frames, 10);
  assert.equal(store.replay(store.seq - 10, "list") !== null, true);
  assert.equal(store.replay(store.seq - 11, "list"), null);
  clock.advance(5 * 60_000 + 1);
  store.publishTrade({ pool: "p", signature: "late", ix_index: 0 });
  assert.equal(store.health().frames, 1);
  assert.equal(store.seq, 25);
});

test("the 1 s poll covers each curve market's pool and each graduated market's DAMM v2 pool, traded markets first", async () => {
  const { store, read } = await setup();
  await read();
  const room = bySymbol("ROOM");
  const keys = store.pollKeys(10);
  assert.deepEqual(keys.map((k) => k.venue), ["dbc", "dbc", "dbc", "damm"]);
  assert.equal(keys[3].key, golden.treasuries[room.pool].dammPool);
  store.setStats([{ pool: room.pool, trades_24h: 3 }]);
  assert.equal(store.pollKeys(10)[0].pool, room.pool);
  assert.equal(store.pollKeys(2).length, 2);
});

test("stats and profiles are pushed only when they change; snapshots carry them", async () => {
  const { store, frames, read } = await setup();
  await read();
  frames.length = 0;
  const room = golden.markets.find((m) => m.uri);
  store.setStats([{ pool: room.pool, trades_24h: 1 }]);
  store.setStats([{ pool: room.pool, trades_24h: 1 }]);
  assert.equal(frames.length, 1);
  store.setProfile(room.uri, { image: "https://x/i.png" });
  assert.deepEqual(frames.map((f) => f.event), ["stats", "profile"]);
  const snap = store.snapshot("list");
  assert.equal(snap.entries.length, 4);
  assert.deepEqual(snap.profiles, { [room.uri]: { image: "https://x/i.png" } });
  assert.equal(snap.stats.length, 1);
  const page = store.snapshot("market", room.pool);
  assert.equal(page.entry.market.pool, room.pool);
  assert.deepEqual(page.profile, { image: "https://x/i.png" });
  assert.equal(store.snapshot("market", "11111111111111111111111111111111").entry, null);
});
