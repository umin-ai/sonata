import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildSteps, planMarket, txBytes, MAX_TX_BYTES } from "./crank.mjs";

const state = (over = {}) => ({
  partnerQuoteFee: 0n,
  unallocated: 0n,
  treasuryBaseReady: true,
  payoutAccount: "ok",
  migrated: false,
  ...over,
});

test("nothing to do when no fees accrued and nothing is unallocated", () => {
  const plan = planMarket(state());
  assert.deepEqual(plan, { claim: false, distribute: false, createPayout: false, reason: "nothing to claim or distribute" });
});

test("claims only when the partner fee reaches the threshold", () => {
  const below = planMarket(state({ partnerQuoteFee: 9_999n }), 10_000n);
  assert.equal(below.claim, false);
  assert.equal(below.distribute, false);
  assert.match(below.reason, /below 10000/);
  const at = planMarket(state({ partnerQuoteFee: 10_000n }), 10_000n);
  assert.equal(at.claim, true);
  // A threshold of 0 never claims an empty pool.
  assert.equal(planMarket(state(), 0n).claim, false);
});

test("distributes whatever is unallocated, even below the claim threshold", () => {
  const plan = planMarket(state({ partnerQuoteFee: 5n, unallocated: 1n }), 10_000n);
  assert.deepEqual(plan, { claim: false, distribute: true, createPayout: false, reason: null });
});

test("claim and distribute together once fees reach the threshold", () => {
  for (const unallocated of [0n, 250n]) {
    const plan = planMarket(state({ partnerQuoteFee: 240_000n, unallocated }));
    assert.deepEqual(plan, { claim: true, distribute: true, createPayout: false, reason: null });
  }
});

test("creates a missing payout account only when distributing", () => {
  assert.equal(planMarket(state({ unallocated: 10n, payoutAccount: "missing" })).createPayout, true);
  assert.equal(planMarket(state({ payoutAccount: "missing" })).createPayout, false);
});

test("a frozen payout account blocks distribute but not claim", () => {
  const plan = planMarket(state({ partnerQuoteFee: 20_000n, payoutAccount: "frozen" }));
  assert.equal(plan.claim, true);
  assert.equal(plan.distribute, false);
  assert.match(plan.reason, /frozen/);
});

test("a missing treasury base account blocks claim but not distribute", () => {
  const plan = planMarket(state({ partnerQuoteFee: 20_000n, unallocated: 7n, treasuryBaseReady: false }));
  assert.equal(plan.claim, false);
  assert.equal(plan.distribute, true);
  assert.match(plan.reason, /cannot claim/);
});

test("migrated pools are still tried", () => {
  assert.equal(planMarket(state({ partnerQuoteFee: 20_000n, migrated: true })).claim, true);
});

test("claim, payout account creation and distribute fit in one transaction", async () => {
  const m = JSON.parse(readFileSync(new URL("../lib/treasury/market.json", import.meta.url), "utf8"));
  const market = Object.fromEntries(
    ["treasury", "pool", "config", "quoteMint", "baseMint", "payoutOwner", "treasuryBase", "treasuryQuote", "payoutQuote", "baseVault", "quoteVault"]
      .map((k) => [k, new PublicKey(m[k])]),
  );
  const payer = Keypair.generate().publicKey;
  const steps = await buildSteps(market, { claim: true, distribute: true, createPayout: true }, payer);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].map((s) => s.label), ["compute budget", "claim", "create payout account", "distribute"]);
  const bytes = txBytes(steps[0].map((s) => s.ix), payer);
  assert.ok(bytes <= MAX_TX_BYTES, `${bytes} bytes`);
  // The instruction set never includes the fee payer as a writable fund destination.
  const [, claim, , distribute] = steps[0].map((s) => s.ix);
  assert.ok(!claim.keys.some((k) => k.pubkey.equals(payer)));
  assert.ok(!distribute.keys.some((k) => k.pubkey.equals(payer)));
  assert.ok(distribute.keys.some((k) => k.pubkey.equals(market.payoutQuote) && k.isWritable));
});
