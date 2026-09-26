import test from "node:test";
import assert from "node:assert/strict";
import { buyOut, graduationProgress, formatProgress, marketCapAt, milestoneCaps, quoteForOut, sqrtPriceAtQuote } from "./graduation.ts";
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

test("dev buy: buyOut takes the fee first and never sells past the curve", async () => {
  const p = await buildCurveParams(2, 12, 125);
  const big = (v: { toString(): string }) => BigInt(v.toString());
  const curve = p.curve.map((c) => ({ sqrtPrice: big(c.sqrtPrice), liquidity: big(c.liquidity) }));
  const start = big(p.sqrtStartPrice);
  // 1.25% of 1 stock token (8 decimals), rounded up.
  const one = buyOut(100_000_000n, 125, start, curve);
  assert.equal(one.fee, 1_250_000n);
  assert.equal(one.unspent, 0n);
  assert.ok(one.out > 0n);
  // More in, more out.
  assert.ok(buyOut(200_000_000n, 125, start, curve).out > one.out);
  // An input bigger than the whole curve leaves some unspent.
  assert.ok(buyOut(10n ** 20n, 125, start, curve).unspent > 0n);
});

test("dev buy by share of supply: the smallest input that buys it", async () => {
  const p = await buildCurveParams(2, 12, 125);
  const big = (v: { toString(): string }) => BigInt(v.toString());
  const curve = p.curve.map((c) => ({ sqrtPrice: big(c.sqrtPrice), liquidity: big(c.liquidity) }));
  const start = big(p.sqrtStartPrice), supply = 10n ** 15n;
  for (const bps of [1n, 500n, 1250n, 5000n]) {
    const tokens = (supply * bps) / 10_000n;
    const quote = quoteForOut(tokens, 125, start, curve);
    assert.ok(quote !== null);
    assert.ok(buyOut(quote, 125, start, curve).out >= tokens);
    assert.ok(buyOut(quote - 1n, 125, start, curve).out < tokens);
  }
  assert.equal(quoteForOut(0n, 125, start, curve), 0n);
  // This curve sells about 71% of supply in all (the rest seeds the graduated pool),
  // so 75% is out of reach.
  assert.equal(quoteForOut((supply * 7500n) / 10_000n, 125, start, curve), null);
});

test("curve shapes: same start and cap; Rocket raises most, Whale wall least", async () => {
  const big = (v: { toString(): string }) => BigInt(v.toString());
  const soldAtGraduation = (p: Awaited<ReturnType<typeof buildCurveParams>>) => {
    const curve = p.curve.map((c) => ({ sqrtPrice: big(c.sqrtPrice), liquidity: big(c.liquidity) }));
    const gross = (big(p.migrationQuoteThreshold) * 1_000_000_000n) / (1_000_000_000n - 125n * 100_000n);
    return buyOut(gross, 125, big(p.sqrtStartPrice), curve).out;
  };
  const [classic, steady, rocket, whale] = await Promise.all(
    (["classic", "steady", "rocket", "whaleWall"] as const).map((shape) => buildCurveParams(2, 30, 125, { shape })),
  );
  for (const p of [steady, rocket, whale]) {
    assert.equal(p.curve.length, 16);
    const start = Number(big(classic.sqrtStartPrice));
    assert.ok(Math.abs(Number(big(p.sqrtStartPrice)) - start) / start < 1e-6);
    // The last segment ends at the same graduation price as Classic's curve.
    assert.ok(Math.abs(Number(big(p.curve[15].sqrtPrice) - big(classic.curve[0].sqrtPrice))) / Number(big(classic.curve[0].sqrtPrice)) < 1e-9);
  }
  const raise = (p: typeof classic) => big(p.migrationQuoteThreshold);
  assert.ok(raise(whale) < raise(classic) && raise(classic) < raise(steady) && raise(steady) < raise(rocket));
  assert.ok(soldAtGraduation(rocket) < soldAtGraduation(steady) && soldAtGraduation(steady) < soldAtGraduation(classic));
  assert.ok(soldAtGraduation(classic) < soldAtGraduation(whale));
});

test("graduation airdrop keeps 5% of supply off the curve; volatility turns on Meteora's dynamic fee", async () => {
  const big = (v: { toString(): string }) => BigInt(v.toString());
  const sold = (p: Awaited<ReturnType<typeof buildCurveParams>>) => {
    const curve = p.curve.map((c) => ({ sqrtPrice: big(c.sqrtPrice), liquidity: big(c.liquidity) }));
    const gross = (big(p.migrationQuoteThreshold) * 1_000_000_000n) / (1_000_000_000n - 125n * 100_000n);
    return buyOut(gross, 125, big(p.sqrtStartPrice), curve).out;
  };
  const plain = await buildCurveParams(2, 30, 125);
  const air = await buildCurveParams(2, 30, 125, { airdrop: true });
  // Supply stays 1 billion; 5% of it is neither sold on the curve nor put in the pool,
  // so the curve sells and raises about 5% less.
  assert.equal(big(air.tokenSupply!.preMigrationTokenSupply), 10n ** 15n);
  const ratio = Number(sold(air)) / Number(sold(plain));
  assert.ok(Math.abs(ratio - 0.95) < 0.001, `sold ratio ${ratio}`);
  assert.ok(big(air.migrationQuoteThreshold) < big(plain.migrationQuoteThreshold));
  const rocketAir = await buildCurveParams(2, 30, 125, { shape: "rocket", airdrop: true });
  const rocket = await buildCurveParams(2, 30, 125, { shape: "rocket" });
  assert.ok(Math.abs(Number(sold(rocketAir)) / Number(sold(rocket)) - 0.95) < 0.001);
  assert.equal(plain.poolFees.dynamicFee, null);
  const wild = await buildCurveParams(2, 30, 125, { volatility: true });
  assert.ok(wild.poolFees.dynamicFee !== null);
});
