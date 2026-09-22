// Dollar-denominated launch targets, converted to the stock quote token with a
// live Pyth Pro price. The conversion decides the on-chain curve, so these rules
// say when a price is fit for that purpose and label it honestly when it is not
// a live regular-session print.

/** Pyth Pro (Lazer) feed ids, from the public symbols endpoint. */
export const PYTH_FEEDS: Record<string, { id: number; symbol: string }> = {
  mSPY: { id: 1398, symbol: "Equity.US.SPY/USD" },
  mNVDA: { id: 1314, symbol: "Equity.US.NVDA/USD" },
  mQQQ: { id: 1363, symbol: "Equity.US.QQQ/USD" },
  mTSLA: { id: 1435, symbol: "Equity.US.TSLA/USD" },
};

/** Opening market cap and graduation choices, in US dollars. */
export const OPEN_USD = 5_000;
export const GRADUATION_USD = [25_000, 50_000, 100_000] as const;

export type MarketSession =
  | "regular"
  | "preMarket"
  | "postMarket"
  | "overNight"
  | "closed";

export type StockPrice = {
  symbol: string;
  feed: string;
  price: number;
  confidence: number;
  publishTimeMs: number;
  marketSession: string;
  fetchedAt: string;
};

// Beyond these a price is not used to set a curve.
export const MAX_CONFIDENCE_RATIO = 0.01; // ±1%
const MAX_AGE_MS: Record<MarketSession, number> = {
  regular: 60_000,
  preMarket: 5 * 60_000,
  postMarket: 5 * 60_000,
  overNight: 5 * 60_000,
  // Covers a weekend plus a Monday holiday; anything older suggests a broken feed.
  closed: 96 * 3_600_000,
};
const SESSION_LABEL: Record<MarketSession, string> = {
  regular: "US regular session",
  preMarket: "US pre-market",
  postMarket: "US after-hours",
  overNight: "US overnight session",
  closed: "US market closed",
};

export function assessPrice(p: StockPrice, nowMs: number) {
  if (!(p.price > 0) || !Number.isFinite(p.price))
    return { usable: false as const, reason: "Pyth returned no usable price." };
  const ratio = p.confidence / p.price;
  if (!(ratio >= 0) || ratio > MAX_CONFIDENCE_RATIO)
    return {
      usable: false as const,
      reason: `Pyth price is too uncertain right now (±${(ratio * 100).toFixed(2)}%).`,
    };
  const session = p.marketSession as MarketSession;
  if (!(session in MAX_AGE_MS))
    return { usable: false as const, reason: `Unknown market session "${p.marketSession}".` };
  const ageMs = nowMs - p.publishTimeMs;
  if (ageMs > MAX_AGE_MS[session])
    return {
      usable: false as const,
      reason:
        session === "closed"
          ? "The last available price is too old to price a launch."
          : "The Pyth price feed has not updated recently.",
    };
  return {
    usable: true as const,
    session,
    label: SESSION_LABEL[session],
    live: session !== "closed",
    confidenceRatio: ratio,
  };
}

/** Dollars to quote-token units at a given price, to 6 decimal places. */
export function usdToQuote(usd: number, price: number) {
  if (!(usd > 0) || !(price > 0)) throw Error("Invalid dollar amount or price.");
  return Math.round((usd / price) * 1e6) / 1e6;
}

/** Converts a Pyth Pro timestamp to milliseconds (the API reports microseconds). */
export function toMillis(timestamp: number) {
  if (timestamp > 1e14) return Math.floor(timestamp / 1000); // microseconds
  if (timestamp > 1e11) return timestamp; // already milliseconds
  return timestamp * 1000; // seconds
}

export const formatUsd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);

/** Time alone for a price from the last 12 hours; otherwise include the day, so an old closing price cannot pass for a fresh one. */
export function formatPriceTime(ms: number, nowMs = Date.now()) {
  const d = new Date(ms);
  return nowMs - ms < 12 * 3_600_000
    ? d.toLocaleTimeString()
    : d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
