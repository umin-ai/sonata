import test from "node:test";
import assert from "node:assert/strict";
import { change24h, timeAgo } from "./market-data.ts";

test("24h change needs both prices", () => {
  const base = { pool: "p", volume24h: 0n, trades24h: 0, tradesTotal: 1 };
  assert.equal(change24h({ ...base, lastPrice: 2, price24hAgo: 1 }), 1);
  assert.equal(change24h({ ...base, lastPrice: 2, price24hAgo: null }), null);
});

test("relative times", () => {
  assert.equal(timeAgo(100, 130), "30s ago");
  assert.equal(timeAgo(0, 7200), "2h ago");
  assert.equal(timeAgo(0, 3 * 86400), "3d ago");
});
