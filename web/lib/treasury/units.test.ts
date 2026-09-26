import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits, formatUnits } from "./units.ts";
test("stock amounts preserve all eight decimals and u64 precision", () => {
  assert.equal(parseUnits("0.00000001"), 1n);
  assert.equal(parseUnits("184467440737.09551615"), 18446744073709551615n);
  assert.equal(formatUnits(240000n), "0.0024");
  assert.equal(formatUnits(18446744073709551615n), "184467440737.09551615");
});
test("unsafe or ambiguous amounts fail before a transaction is built", () => {
  for (const value of [
    "0",
    "-1",
    "1e3",
    "NaN",
    "Infinity",
    " 1",
    "1.000000001",
    "184467440737.09551616",
    "1,000",
    ".5",
    "01",
  ])
    assert.throws(() => parseUnits(value), value);
});

test("community-token input uses six decimals, independently of the stock mint", () => {
  assert.equal(parseUnits("100000", 6), 100000000000n);
  assert.equal(parseUnits("0.000001", 6), 1n);
  assert.equal(formatUnits(2789696036788n, 6), "2789696.036788");
  assert.throws(() => parseUnits("0.0000001", 6));
});
