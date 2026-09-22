import test from "node:test";
import assert from "node:assert/strict";
import { holderShares, rewardBudget } from "./holder-math.ts";
test("aggregates all accounts, excludes creator and allocates proportionally", () => {
  assert.deepEqual(
    holderShares(
      [
        { owner: "a", amount: "1" },
        { owner: "a", amount: "1" },
        { owner: "b", amount: "6" },
        { owner: "creator", amount: "900" },
      ],
      80n,
      new Set(["creator"]),
    ).map((r) => r.amount),
    ["20", "60"],
  );
});
test("dust is deterministic and no atom is lost", () => {
  const a = [
    { owner: "c", amount: "1" },
    { owner: "b", amount: "1" },
    { owner: "a", amount: "1" },
  ];
  assert.deepEqual(
    holderShares(a, 2n, new Set()),
    holderShares(a.reverse(), 2n, new Set()),
  );
  assert.deepEqual(
    holderShares(a, 2n, new Set()).map((r) => r.amount),
    ["1", "1", "0"],
  );
});
test("zero holders and zero budget cannot manufacture rewards", () => {
  assert.throws(() => holderShares([], 2n, new Set()));
  assert.throws(() =>
    holderShares([{ owner: "a", amount: "1" }], 0n, new Set()),
  );
});
test("new revenue only; retained leftovers do not get rewarded again", () => {
  assert.equal(rewardBudget(1000n, 800n, 700n, 5000), 100n);
  assert.equal(rewardBudget(1000n, 1000n, 600n, 5000), 0n);
  assert.throws(() => rewardBudget(1000n, 800n, 50n, 5000));
});
