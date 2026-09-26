import assert from "node:assert/strict";
import test from "node:test";
import { earningsTotals, tokenEarnings, type EarningsInput } from "./creator-earnings.ts";

const me = "Me111";
const base: EarningsInput = {
  mode: "standard",
  stock: "mSPY",
  creator: me,
  payoutOwner: me,
  reward: false,
  paid: 500n,
  uncollected: 60n,
  unallocated: 40n,
  available: 0n,
};

test("Standard: the creator's 50% is paid to them; half of what waits is theirs", () => {
  const e = tokenEarnings(base, me);
  assert.equal(e.sharePercent, 50);
  assert.equal(e.paidToYou, 500n);
  assert.equal(e.waiting, 100n);
  assert.equal(e.yourWaiting, 50n);
  assert.equal(e.reserve, 0n);
});

test("Reward tokens pay the bot, not the creator", () => {
  const e = tokenEarnings({ ...base, reward: true, payoutOwner: "Bot111" }, me);
  assert.equal(e.sharePercent, 0);
  assert.equal(e.paidToYou, 0n);
  assert.equal(e.yourWaiting, 0n);
  assert.equal(e.waiting, 100n);
});

test("A payout wallet that is not the creator sees its payouts, not the reserve or pool half", () => {
  const t: EarningsInput = { ...base, mode: "duet", creator: "Creator111", available: 70n, position: { unclaimed: 9n, claimed: 3n } };
  const e = tokenEarnings(t, me);
  assert.equal(e.sharePercent, 50);
  assert.equal(e.paidToYou, 500n);
  assert.equal(e.reserve, 0n);
  assert.equal(e.poolToClaim, 0n);
  const c = tokenEarnings(t, "Creator111");
  assert.equal(c.sharePercent, 50, "the creator's reserve half");
  assert.equal(c.paidToYou, 0n);
  assert.equal(c.reserve, 70n);
  assert.equal(c.poolToClaim, 9n);
  assert.equal(c.poolClaimed, 3n);
});

test("Creator and payout wallet in one: Reserve mode gives them all of it", () => {
  const e = tokenEarnings({ ...base, mode: "duet", available: 70n }, me);
  assert.equal(e.sharePercent, 100);
  assert.equal(e.yourWaiting, 100n);
  assert.equal(e.reserve, 70n);
});

test("Backed: a quarter to the creator", () => {
  assert.equal(tokenEarnings({ ...base, mode: "standardFloor" }, me).sharePercent, 25);
});

test("Totals are kept per stock and skip zeros", () => {
  const a = tokenEarnings({ ...base, position: { unclaimed: 5n, claimed: 7n } }, me);
  const b = tokenEarnings({ ...base, stock: "mQQQ", paid: 10n, uncollected: 0n, unallocated: 0n }, me);
  const t = earningsTotals([
    { stock: "mSPY", earnings: a },
    { stock: "mQQQ", earnings: b },
  ]);
  assert.equal(t.earned.get("mSPY"), 507n);
  assert.equal(t.earned.get("mQQQ"), 10n);
  assert.equal(t.yourWaiting.get("mSPY"), 50n);
  assert.equal(t.yourWaiting.has("mQQQ"), false);
  assert.equal(t.poolToClaim.get("mSPY"), 5n);
  assert.equal(t.reserve.size, 0);
});
