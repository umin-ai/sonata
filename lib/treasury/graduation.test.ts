import test from "node:test";
import assert from "node:assert/strict";
import { graduationProgress, formatProgress, marketCapAt, milestoneCaps, sqrtPriceAtQuote } from "./graduation.ts";
import { buildCurveParams } from "./dbc-preview.ts";

test("progress is measured against each pool's own threshold", () => {
  // Legacy config threshold versus the per-launch 2 -> 18 config threshold.
  assert.equal(graduationProgress(80_283_000n, 347_877_538n, false).bps, 2307);
  assert.equal(graduationProgress(80_283_000n, 450_000_000n, false).bps, 1784);
});

test("progress never shows complete before the threshold is reached", () => {
  const nearly = graduationProgress(449_999_999n, 450_000_000n, false);
  assert.equal(nearly.stage, "curve");
  assert.equal(nearly.bps, 9999);
  assert.equal(formatProgress(nearly.bps), "99.9%");
  assert.equal(nearly.remaining, 1n);
});

test("stages: curve, complete but not migrated, graduated", () => {
  assert.equal(graduationProgress(0n, 450_000_000n, false).stage, "curve");
  const done = graduationProgress(450_000_000n, 450_000_000n, false);
  assert.deepEqual([done.stage, done.bps, done.remaining], ["complete", 10_000, 0n]);
  assert.equal(graduationProgress(450_000_000n, 450_000_000n, true).stage, "graduated");
});

test("a missing threshold is an error, not 0% or 100%", () => {
  assert.throws(() => graduationProgress(1n, 0n, false));
});

test("heat: heating up at a third, on fire at two thirds, exactly", () => {
  const heat = (q: bigint) => graduationProgress(q, 300n, false).heat;
  assert.deepEqual([heat(0n), heat(99n), heat(100n), heat(199n), heat(200n), heat(299n)], ["new", "new", "heating", "heating", "fire", "fire"]);
  assert.equal(graduationProgress(300n, 300n, false).heat, "complete");
  assert.equal(graduationProgress(300n, 300n, true).heat, "graduated");
});

test("milestone market caps follow the deployed curve from start to target", async () => {
  // A launch from a 2 to a 12 stock-token market cap, 1 billion tokens at 6 decimals.
  const p = await buildCurveParams(2, 12, 100);
  const big = (v: { toString(): string }) => BigInt(v.toString());
  const curve = p.curve.map((c) => ({ sqrtPrice: big(c.sqrtPrice), liquidity: big(c.liquidity) }));
  const start = big(p.sqrtStartPrice), threshold = big(p.migrationQuoteThreshold), supply = 10n ** 15n;
  // Devnet pool BZVxHs... was built from these inputs; its config's migration price is a 12 market cap.
  const migration = 3n * 2n ** 64n / 10n;
  const caps = milestoneCaps(start, start, curve, threshold, migration, supply);
  assert.ok(Math.abs(caps.current - 2) / 2 < 0.01, `start ${caps.current}`);
  assert.ok(caps.current < caps.milestones[0] && caps.milestones[0] < caps.milestones[1]);
  assert.ok(caps.milestones[1] < marketCapAt(sqrtPriceAtQuote(threshold, start, curve), supply));
  assert.equal(caps.milestones[2], marketCapAt(migration, supply));
  // Filling the threshold lands on the migration price, the end of the first segment,
  // as Meteora's formulas define it (not past it into the thin tail segment).
  const end = sqrtPriceAtQuote(threshold, start, curve), migrationPoint = curve[0].sqrtPrice;
  assert.ok(end <= migrationPoint && Number(migrationPoint - end) / Number(migrationPoint) < 1e-9, `${end} vs ${migrationPoint}`);
});
