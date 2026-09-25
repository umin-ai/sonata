import assert from "node:assert/strict";
import test from "node:test";
import { nextRunText, sinceText } from "./payout-timing.ts";

test("time since the last collection", () => {
  const now = 1_790_000_000_000;
  assert.equal(sinceText(now / 1000 - 20, now), "just now");
  assert.equal(sinceText(now / 1000 - 180, now), "3 min ago");
  assert.equal(sinceText(now / 1000 - 7200, now), "2 h ago");
});

test("time to the next quarter-hour run", () => {
  assert.equal(nextRunText(new Date(2026, 8, 25, 8, 22, 10).getTime()), "in ~8 min");
  assert.equal(nextRunText(new Date(2026, 8, 25, 8, 29, 30).getTime()), "in ~1 min");
  assert.equal(nextRunText(new Date(2026, 8, 25, 8, 30, 0).getTime()), "in ~15 min");
});
