import test from "node:test";
import assert from "node:assert/strict";
import {
  creatorShareLabel,
  feeShareBps,
  formatBps,
  pickCreatorPosition,
  shareBps,
} from "./creator-position.ts";

test("a 50/50 split earns half of the LP share of every fee", () => {
  // DAMM v2 migration config: 20% protocol fee, no compounding.
  const pool = 6_174_852_676_354_351_507_060_842_155_460n;
  assert.equal(feeShareBps(pool / 2n, pool, 20, 0), 4000);
  assert.equal(formatBps(feeShareBps(pool / 2n, pool, 20, 0)), "40.0%");
  // The whole pool with no protocol fee earns everything.
  assert.equal(feeShareBps(pool, pool, 0, 0), 10_000);
  // Compounding fees stay in reserves and are not claimable.
  assert.equal(feeShareBps(pool, pool, 20, 5000), 4000);
});

test("share falls when others add liquidity", () => {
  assert.equal(feeShareBps(50n, 150n, 20, 0), 2666);
  assert.equal(shareBps(50n, 150n), 3333);
});

test("empty inputs earn nothing and bad fee splits are rejected", () => {
  assert.equal(feeShareBps(0n, 100n, 20, 0), 0);
  assert.equal(feeShareBps(10n, 0n, 20, 0), 0);
  assert.equal(shareBps(1n, 0n), 0);
  assert.throws(() => feeShareBps(1n, 2n, 101, 0));
  assert.throws(() => feeShareBps(1n, 2n, 20, 10_001));
});

test("the permanently locked DBC position wins over ordinary LP positions", () => {
  const lp = { id: "lp", permanent: 0n, unlocked: 900n, vested: 0n };
  const dbc = { id: "dbc", permanent: 500n, unlocked: 1n, vested: 0n };
  const empty = { id: "empty", permanent: 0n, unlocked: 0n, vested: 0n };
  assert.equal(pickCreatorPosition([lp, empty, dbc])?.id, "dbc");
  assert.equal(pickCreatorPosition([lp, empty])?.id, "lp");
  assert.equal(pickCreatorPosition([empty]), null);
  assert.equal(pickCreatorPosition([]), null);
});

test("creator share wording", () => {
  assert.equal(creatorShareLabel(50), "half");
  assert.equal(creatorShareLabel(100), "all");
  assert.equal(creatorShareLabel(30), "30%");
});
