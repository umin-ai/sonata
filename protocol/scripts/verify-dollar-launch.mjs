// SPDX-License-Identifier: GPL-3.0-or-later
// Deploys a launch whose targets were set in US dollars, exactly as the app
// does it: the price comes from the app's own /api/stock-price route (the
// Solana market via Jupiter, guarded by Pyth when a key covers the feed), the
// dollar targets are converted to quote units, and verify-configurable-launch
// deploys and registers that config and reads it back. The price snapshot is
// written into the evidence file alongside the on-chain checks.
//
// Needs the frontend dev server running (for the price route) and the funded
// Devnet deployer key. Usage:
//   node scripts/verify-dollar-launch.mjs mQQQ 25000 300 [out.json]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const [symbol = "mQQQ", targetArg = "25000", feeArg = "300", out = `artifacts/dollar-launch-${symbol.toLowerCase()}.json`] =
  process.argv.slice(2);
const OPEN_USD = 5_000;
const targetUsd = Number(targetArg);
const registry = JSON.parse(readFileSync("../cash-access/lib/treasury/quote-assets.json", "utf8")).assets;
const asset = registry.find((a) => a.symbol === symbol);
assert.ok(asset, `${symbol} has no Devnet mint in the registry.`);

const r = await fetch(`http://localhost:5173/api/stock-price?symbol=${symbol}`);
const price = await r.json();
assert.ok(r.ok && !price.error, `Price unavailable: ${price.error ?? r.status}`);
// Same conversion as lib/pricing/stock-price.ts usdToQuote.
const toQuote = (usd) => Math.round((usd / price.price) * 1e6) / 1e6;
const initial = toQuote(OPEN_USD), target = toQuote(targetUsd);
const pricing = {
  openUsd: OPEN_USD,
  targetUsd,
  priceUsd: price.price,
  priceSource: price.source,
  feed: price.feed,
  fetchedAt: price.fetchedAt,
  quoteCheck: price.quotePrice ? { quotePrice: price.quotePrice, liquidityUsd: price.liquidity, priceImpact: price.priceImpact, route: price.route } : undefined,
  pythGuard: price.guard ?? null,
  pythStatus: price.pythStatus,
  convertedInitial: initial,
  convertedTarget: target,
};
console.log(`${symbol}: $${OPEN_USD} -> $${targetUsd} at $${price.price.toFixed(4)} (${price.feed}) = ${initial} -> ${target} ${symbol}`);
console.log(`Pyth guard: ${price.guard ? `${price.guard.feed} $${price.guard.price.toFixed(2)}, ${(price.guard.divergence * 100).toFixed(3)}% apart` : price.pythStatus}`);

execFileSync("node", ["scripts/verify-configurable-launch.mjs", out], {
  stdio: "inherit",
  env: {
    ...process.env,
    SONATA_QUOTE_MINT: asset.mint,
    SONATA_QUOTE_SYMBOL: symbol,
    SONATA_INITIAL: String(initial),
    SONATA_TARGET: String(target),
    SONATA_FEE_BPS: feeArg,
    SONATA_TOKEN_NAME: process.env.SONATA_TOKEN_NAME ?? "Dollar Launch Proof",
    SONATA_TOKEN_SYMBOL: process.env.SONATA_TOKEN_SYMBOL ?? "USDL",
    SONATA_PRICING: JSON.stringify(pricing),
  },
});
