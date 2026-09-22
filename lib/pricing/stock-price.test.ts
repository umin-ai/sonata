import test from "node:test";
import assert from "node:assert/strict";
import { assessPrice, usdToQuote, toMillis, type StockPrice } from "./stock-price.ts";

const now = Date.UTC(2026, 8, 23, 15, 0, 0);
const base: StockPrice = {
  symbol: "mSPY", feed: "Equity.US.SPY/USD", price: 650, confidence: 0.2,
  publishTimeMs: now - 1_000, marketSession: "regular", fetchedAt: new Date(now).toISOString(),
};

test("a fresh regular-session price is usable and labelled live", () => {
  const a = assessPrice(base, now);
  assert.equal(a.usable, true);
  assert.equal(a.usable && a.live, true);
});

test("a regular-session price that stopped updating is refused", () => {
  assert.equal(assessPrice({ ...base, publishTimeMs: now - 120_000 }, now).usable, false);
});

test("a closed-market price is usable within the weekend window, labelled not live", () => {
  const friClose = assessPrice({ ...base, marketSession: "closed", publishTimeMs: now - 60 * 3_600_000 }, now);
  assert.equal(friClose.usable, true);
  assert.equal(friClose.usable && friClose.live, false);
  assert.equal(assessPrice({ ...base, marketSession: "closed", publishTimeMs: now - 100 * 3_600_000 }, now).usable, false);
});

test("a wide confidence interval is refused", () => {
  assert.equal(assessPrice({ ...base, confidence: 7 }, now).usable, false); // ±1.08%
  assert.equal(assessPrice({ ...base, confidence: 6 }, now).usable, true); // ±0.92%
});

test("unknown sessions and non-positive prices are refused", () => {
  assert.equal(assessPrice({ ...base, marketSession: "auction" }, now).usable, false);
  assert.equal(assessPrice({ ...base, price: 0 }, now).usable, false);
});

test("dollars convert to quote units at the given price", () => {
  assert.equal(usdToQuote(25_000, 650), 38.461538);
  assert.equal(usdToQuote(5_000, 650), 7.692308);
  assert.throws(() => usdToQuote(5_000, 0));
});

test("Pyth timestamps normalise to milliseconds", () => {
  assert.equal(toMillis(1_790_000_000_000_000), 1_790_000_000_000);
  assert.equal(toMillis(1_790_000_000_000), 1_790_000_000_000);
  assert.equal(toMillis(1_790_000_000), 1_790_000_000_000);
});

test("old prices show the day, recent ones only the time", async () => {
  const { formatPriceTime } = await import("./stock-price.ts");
  assert.doesNotMatch(formatPriceTime(now - 60_000, now), /Sep|Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  assert.match(formatPriceTime(now - 40 * 3_600_000, now), /Sep|Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
});
