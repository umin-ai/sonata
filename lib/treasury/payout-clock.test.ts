import assert from "node:assert/strict";
import test from "node:test";
import { mmss, nextPayout, payoutClock } from "./payout-clock.ts";

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 25, h, m, s);

test("counts down to the next quarter hour, and says when a run is under way", () => {
  assert.deepEqual(payoutClock(at(8, 7, 18)), { state: "waiting", msLeft: 462_000 });
  assert.equal(mmss(462_000), "07:42");
  assert.deepEqual(payoutClock(at(8, 30, 5)), { state: "running" });
  assert.equal(payoutClock(at(8, 34, 0)).state, "waiting");
});

test("the bot collects at 0.0001 of the stock or more, and always pays out what was collected", () => {
  const base = { lastClaimTs: at(8, 0) / 1000, now: at(8, 7) };
  assert.equal(nextPayout({ ...base, uncollected: 10_000n, unallocated: 0n }).kind, "pays");
  assert.equal(nextPayout({ ...base, uncollected: 9_999n, unallocated: 0n }).kind, "waits");
  assert.equal(nextPayout({ ...base, uncollected: 1n, unallocated: 5n }).kind, "pays");
  assert.equal(nextPayout({ ...base, uncollected: 0n, unallocated: 0n }).kind, "none");
});

test("late only when due fees outlast a full cycle, outside a run", () => {
  const fees = { uncollected: 50_000n, unallocated: 0n };
  assert.equal(nextPayout({ ...fees, lastClaimTs: at(8, 0) / 1000, now: at(8, 10) }).late, false);
  assert.equal(nextPayout({ ...fees, lastClaimTs: at(7, 30) / 1000, now: at(8, 10) }).late, true);
  assert.equal(nextPayout({ ...fees, lastClaimTs: at(7, 30) / 1000, now: at(8, 1) }).late, false);
  assert.equal(nextPayout({ uncollected: 5n, unallocated: 0n, lastClaimTs: 0, now: at(8, 10) }).late, false);
  // A new market that has never been collected is not overdue.
  assert.equal(nextPayout({ ...fees, lastClaimTs: 0, now: at(8, 10) }).late, false);
});
