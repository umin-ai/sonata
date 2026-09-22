import test from "node:test";
import assert from "node:assert/strict";
import { graduationProgress, formatProgress } from "./graduation.ts";

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
