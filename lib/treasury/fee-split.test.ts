import assert from "node:assert/strict";
import test from "node:test";
import { feeSplit, redeemed } from "./fee-split.ts";

const totals = { paid: 250n, retained: 750n, withdrawn: 600n };
const shares = (mode: Parameters<typeof feeSplit>[0], opts = {}) =>
  feeSplit(mode, { totals, ...opts }).map((s) => [s.label, s.percent, s.received]);

test("each mode's shares add up to 100%", () => {
  for (const mode of ["standard", "standardFloor", "floor", "refrain", "duet"] as const)
    assert.equal(feeSplit(mode).reduce((t, s) => t + s.percent, 0), 100, mode);
});

test("Standard: the creator gets paid, Sonata the retained total", () => {
  assert.deepEqual(shares("standard", { totals: { paid: 500n, retained: 500n, withdrawn: 500n } }), [
    ["Creator", 50, 500n],
    ["Sonata", 50, 500n],
  ]);
});

test("Standard + backing: the backing got what the creator got, Sonata the rest of retained", () => {
  // 1000 distributed: creator 250, backing 250, Sonata 500 (retained 750, withdrawn 500 + 100 redeemed).
  assert.deepEqual(shares("standardFloor"), [
    ["Creator", 25, 250n],
    ["Backing", 25, 250n],
    ["Sonata", 50, 500n],
  ]);
  assert.equal(redeemed("standardFloor", totals), 100n);
});

test("Backed and creator-reserve modes book the other half as retained", () => {
  assert.deepEqual(shares("floor"), [
    ["Creator", 50, 250n],
    ["Backing", 50, 750n],
  ]);
  assert.equal(redeemed("floor", totals), 600n);
  assert.deepEqual(shares("duet"), [
    ["Creator", 50, 250n],
    ["Creator reserve", 50, 750n],
  ]);
  assert.equal(redeemed("duet", totals), 0n);
  assert.deepEqual(shares("refrain"), [["Creator", 100, 250n]]);
});

test("Reward tokens name the bot's job instead of the creator", () => {
  assert.equal(feeSplit("standard", { reward: true })[0].label, "Holders");
  assert.equal(feeSplit("standard", { reward: true, feeModel: "buyback" })[0].label, "Buyback & burn");
  assert.equal(feeSplit("standard", { reward: true })[0].to, "bot");
  assert.equal(feeSplit("standard")[0].received, undefined);
});
