import test from "node:test";
import assert from "node:assert/strict";
import { minimum, maximum, portion } from "./math.ts";
test("limits remain conservative above Number precision and do not round a tiny maximum down", () => {
  const raw = 18446744073709551600n;
  assert(minimum(raw) * 10000n <= raw * 9950n);
  assert(maximum(raw) * 10000n >= raw * 10050n);
  assert.equal(maximum(1n), 2n);
  assert.equal(minimum(1n), 1n);
});
test("partial followed by full exit leaves no orphaned LP unit", () => {
  const units = 16499273779989412644853447379n;
  const first = portion(units, 5000),
    last = portion(units - first, 10000);
  assert.equal(first + last, units);
  assert.equal(last - first, 1n);
});
test("invalid bounds cannot over-redeem or remove zero liquidity", () => {
  for (const bps of [-1, 0, 10001, 1.5, NaN, Infinity])
    assert.throws(() => portion(100n, bps));
  assert.throws(() => portion(1n, 1));
  assert.throws(() => portion(0n, 10000));
  for (const value of [-1n, 0n]) {
    assert.throws(() => minimum(value));
    assert.throws(() => maximum(value));
  }
});
test("Meteora swap quote uses basis points, matching the advertised 0.5% minimum", async () => {
  const { getAmountWithSlippage, SwapMode } =
    await import("@meteora-ag/cp-amm-sdk");
  const { default: BN } = await import("bn.js");
  const raw = 10000000001n;
  assert.equal(
    getAmountWithSlippage(
      new BN(raw.toString()),
      50,
      SwapMode.ExactIn,
    ).toString(),
    minimum(raw).toString(),
  );
});
