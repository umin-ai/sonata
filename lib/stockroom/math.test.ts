import test from "node:test";
import assert from "node:assert/strict";
import {
  atoms,
  assetsForShares,
  sharesForAssets,
  accruedDebt,
} from "./math.ts";
test("decimal inputs preserve token atoms and reject ambiguous or excessive input", () => {
  assert.equal(atoms("0.00000001", 8), 1n);
  assert.equal(atoms("123.456789", 6), 123456789n);
  for (const s of [
    "0",
    "-1",
    "NaN",
    "Infinity",
    "1e3",
    "0x10",
    "01",
    "1.0000001",
    "100001",
  ])
    assert.throws(() => atoms(s, 6));
});
test("UI debt calculation rounds up and supplier redemption rounds down", () => {
  for (const amount of [1n, 11n, 100000000n])
    for (const assets of [0n, 10n, 125009999n]) {
      const totalShares = assets * 1000000n + 7n;
      assert.ok(
        assetsForShares(
          sharesForAssets(amount, assets, totalShares),
          assets,
          totalShares,
        ) <= amount,
      );
      assert.ok(
        assetsForShares(
          sharesForAssets(amount, assets, totalShares, true),
          assets,
          totalShares,
          true,
        ) >= amount,
      );
    }
});
test("interest follows the compiled Rust reference vectors", () => {
  const annual = accruedDebt(1000000000n, 500n, 31536000n, 0n) - 1000000000n;
  assert.ok(annual >= 51270000n && annual <= 51271000n);
  assert.equal(accruedDebt(0n, 500n, 100000n, 0n), 0n);
  assert.equal(accruedDebt(1000000000n, 500n, 0n, 0n), 1000000000n);
});
