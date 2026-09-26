// How pages apply live stream events (live-events.ts) and merge refreshed
// lists (market-snapshot.ts mergeList): in place, never backwards, newest first.
import test from "node:test";
import assert from "node:assert/strict";
import fixtureJson from "./treasury/fixtures/devnet-markets.json" with { type: "json" };
import { identityOf, type Market, type TreasurySnapshot } from "./treasury/runtime.ts";
import { mergeList, newestFirst, type CardData, type SnapshotEntry } from "./treasury/market-snapshot.ts";
import {
  applyMarketEvent,
  applyTrade,
  applyTradeToCandles,
  candlesWithPushed,
  cover,
  covers,
  entryAfter,
  keepPushed,
  removeMarket,
  tradesWithPushed,
  type MarketEvent,
} from "./live-events.ts";
import type { Candle, Trade } from "./market-data.ts";

const golden = (fixtureJson as unknown as { golden: { markets: Market[]; treasuries: Record<string, TreasurySnapshot> } }).golden;
const card = (m: Market): CardData => ({ ...golden.treasuries[m.pool], poolFees: null });
const LAUNCH: Record<string, number> = { BACKED: 400, RWDCHK: 300, FPT: 200, ROOM: 100 };
const entry = (symbol: string, version = 10): SnapshotEntry => {
  const m = golden.markets.find((x) => x.symbol === symbol)!;
  return { market: identityOf(m), data: { ...card(m), slot: version }, launchedAt: LAUNCH[symbol], version };
};
const pools = (list: SnapshotEntry[]) => list.map((e) => e.market.symbol);
const list = () => ["BACKED", "RWDCHK", "FPT", "ROOM"].map((s) => entry(s));

test("a new market lands newest first (at the top when it just launched); a duplicate `added` is ignored; the oldest drops past the cap", () => {
  const shown = ["RWDCHK", "FPT", "ROOM"].map((s) => entry(s));
  const backed = entry("BACKED");
  const added: MarketEvent = { pool: backed.market.pool, kind: "added", version: 10, entry: backed };
  const next = applyMarketEvent(shown, added);
  assert.deepEqual(pools(next), ["BACKED", "RWDCHK", "FPT", "ROOM"]);
  assert.equal(next[1], shown[0], "other cards keep their objects");
  assert.equal(applyMarketEvent(next, added), next, "already there at that version");
  assert.deepEqual(pools(applyMarketEvent(shown, added, 3)), ["BACKED", "RWDCHK", "FPT"]);
  // A market whose launch time is unknown goes last.
  const unknown = { ...entry("FPT"), launchedAt: undefined };
  assert.deepEqual(pools(applyMarketEvent(["RWDCHK", "ROOM"].map((s) => entry(s)), { pool: unknown.market.pool, kind: "added", version: 10, entry: unknown })), ["RWDCHK", "ROOM", "FPT"]);
});

test("an update changes one card's numbers in place, only when at least as new; card-only updates merge into the numbers shown", () => {
  const shown = list();
  const fpt = shown[2];
  const card = { marketCap: 123.5, graduationBps: 4_200, heat: "heating" as const, slot: 12 };
  const next = applyMarketEvent(shown, { pool: fpt.market.pool, kind: "updated", version: 12, card });
  assert.equal(next[2].data?.marketCap, 123.5);
  assert.equal(next[2].data?.custody, fpt.data?.custody, "fields a card update does not carry stay");
  assert.equal(next[2].version, 12);
  assert.equal(next[0], shown[0]);
  assert.deepEqual(pools(next), pools(shown), "nothing moves");
  // Older than what is shown: ignored. For a market not in the list: ignored (it needs its identity).
  assert.equal(applyMarketEvent(next, { pool: fpt.market.pool, kind: "updated", version: 11, card: { marketCap: 1 } }), next);
  assert.equal(applyMarketEvent(next, { pool: "11111111111111111111111111111111", kind: "updated", version: 99, card }), next);
  // Numbers turn into an error, and back: full numbers come with the recovery.
  const failed = applyMarketEvent(next, { pool: fpt.market.pool, kind: "updated", version: 13, card: null, error: "Treasury accounting does not reconcile." });
  assert.equal(failed[2].data, null);
  assert.match(failed[2].error ?? "", /reconcile/);
  assert.equal(entryAfter(failed[2], { pool: fpt.market.pool, kind: "updated", version: 14, card }), failed[2], "no numbers to merge a card into");
  const back = entryAfter(failed[2], { pool: fpt.market.pool, kind: "updated", version: 14, data: fpt.data });
  assert.equal(back?.data?.custody, fpt.data?.custody);
  assert.equal(back?.error, undefined);
  assert.deepEqual(pools(removeMarket(next, fpt.market.pool)), ["BACKED", "RWDCHK", "ROOM"]);
});

test("mergeList: slot-guarded per market, never removes one, places new ones newest first, keeps the list when nothing changed", () => {
  const shown = list();
  assert.equal(mergeList(shown, list()), shown, "same versions: nothing changes");
  // A refresh that lags for one market and misses another.
  const lagging = [{ ...entry("BACKED", 5), data: { ...entry("BACKED").data!, marketCap: 1 } }, entry("FPT", 20)];
  const merged = mergeList(shown, lagging);
  assert.deepEqual(pools(merged), pools(shown), "none removed, none moved");
  assert.equal(merged[0], shown[0], "the older BACKED is not taken");
  assert.equal(merged[2].version, 20, "the newer FPT is");
  // A market only in the refresh: placed by launch time.
  const without = shown.filter((e) => e.market.symbol !== "RWDCHK");
  assert.deepEqual(pools(mergeList(without, [entry("RWDCHK")])), ["BACKED", "RWDCHK", "FPT", "ROOM"]);
  assert.deepEqual(pools(mergeList(without, [entry("RWDCHK")], 3)), ["BACKED", "RWDCHK", "FPT"]);
  // Entries from before versions existed are dated by their numbers' slot.
  const old = { ...entry("ROOM"), version: undefined, data: { ...entry("ROOM").data!, slot: 50 } };
  assert.equal(mergeList(shown, [old])[3], old);
  assert.deepEqual([...list()].sort(newestFirst).map((e) => e.market.symbol), ["BACKED", "RWDCHK", "FPT", "ROOM"]);
});

const trade = (over: Partial<Trade> = {}): Trade => ({
  signature: "5".repeat(64),
  ixIndex: 0,
  slot: 100,
  time: 1_790_000_000,
  side: "buy",
  trader: "t",
  base: 10n,
  quote: 1_000n,
  fee: 1n,
  price: 2,
  ...over,
});

test("pushed trades: newest first, each swap once (two swaps in one transaction are two), at most the list's length", () => {
  const a = trade({ signature: "A".repeat(64), time: 10 }),
    b = trade({ signature: "B".repeat(64), time: 20 }),
    b2 = trade({ signature: "B".repeat(64), ixIndex: 1, time: 20 });
  let trades = applyTrade([], a);
  trades = applyTrade(trades, b);
  trades = applyTrade(trades, b2);
  assert.deepEqual(trades.map((t) => [t.signature[0], t.ixIndex]), [["B", 1], ["B", 0], ["A", 0]]);
  assert.equal(applyTrade(trades, b), trades, "a replayed trade is not added twice");
  assert.equal(applyTrade(trades, trade({ signature: "C".repeat(64), time: 5 }), 3).length, 3);
});

test("candles take a pushed trade in its interval's bucket, a new bucket, or an older one out of order; covered trades are not counted twice", () => {
  const c = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 100n, trades: 1 });
  const candles = [c(3_600, 1), c(7_200, 2)];
  const same = applyTradeToCandles(candles, trade({ time: 7_300, price: 3 }), 3_600);
  assert.deepEqual(same.at(-1), { time: 7_200, open: 2, high: 3, low: 2, close: 3, volume: 1_100n, trades: 2 });
  const later = applyTradeToCandles(candles, trade({ time: 11_000, price: 0.5 }), 3_600);
  assert.deepEqual(later.at(-1), { time: 10_800, open: 0.5, high: 0.5, low: 0.5, close: 0.5, volume: 1_000n, trades: 1 });
  const late = applyTradeToCandles(candles, trade({ time: 3_700, price: 9 }), 3_600);
  assert.deepEqual(late[0], { time: 3_600, open: 1, high: 9, low: 1, close: 1, volume: 1_100n, trades: 2 }, "an older bucket keeps its close");
  const gap = applyTradeToCandles([c(0, 1), c(7_200, 2)], trade({ time: 4_000 }), 3_600);
  assert.deepEqual(gap.map((x) => x.time), [0, 3_600, 7_200]);
  for (const [interval, seconds] of [["5m", 300], ["1d", 86_400]] as const)
    assert.equal(applyTradeToCandles([], trade({ time: 1_790_000_123 }), seconds)[0].time % seconds, 0, interval);
  // The candles answer covered slot 100's trade A: not counted again; B in the same slot, or a later slot, is.
  const through = { slot: 100, trades: [`${"A".repeat(64)}:0`] };
  assert.equal(covers(through, trade({ signature: "A".repeat(64) })), true);
  assert.equal(covers(through, trade({ signature: "B".repeat(64) })), false);
  assert.equal(covers(through, trade({ slot: 99 })), true);
  assert.equal(covers(through, trade({ slot: 101 })), false);
  const after = cover(through, trade({ signature: "B".repeat(64) }));
  assert.equal(covers(after, trade({ signature: "B".repeat(64) })), true, "a replay of a trade already added");
  assert.deepEqual(cover(after, trade({ slot: 101 })).slot, 101);
});

test("a load merges the trades pushed while it was on its way: none is lost, none counted twice", () => {
  const a = trade({ signature: "A".repeat(64), slot: 100, time: 10 }),
    b = trade({ signature: "B".repeat(64), slot: 101, time: 11 }),
    c = trade({ signature: "C".repeat(64), slot: 102, time: 12 });
  // Pushed trades are kept (each once, the oldest beyond the cap dropped).
  let kept = keepPushed([], b);
  kept = keepPushed(kept, c);
  assert.equal(keepPushed(kept, c), kept);
  assert.deepEqual(keepPushed(kept, a, 2).map((t) => t.signature[0]), ["C", "A"]);
  // The list: an answer read before B and C were inserted still shows them; one that has them does not repeat them.
  assert.deepEqual(tradesWithPushed([a], kept).map((t) => t.signature[0]), ["C", "B", "A"]);
  assert.deepEqual(tradesWithPushed([c, b, a], kept).map((t) => t.signature[0]), ["C", "B", "A"]);
  assert.equal(tradesWithPushed([c, b, a], kept, 2).length, 2);
  // Candles: an answer through slot 101 (B counted) gets only C.
  const candle = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 100n, trades: 1 });
  const loaded = { candles: [candle(0)], through: { slot: 101, trades: [`${"B".repeat(64)}:0`] }, supply: 1 };
  const merged = candlesWithPushed(loaded, kept, 3_600);
  assert.equal(merged.candles[0].trades, 2, "C only");
  assert.equal(merged.through.slot, 102);
  assert.equal(merged.supply, 1);
  // Everything counted: the answer as it is.
  assert.equal(candlesWithPushed(merged, kept, 3_600), merged);
});
