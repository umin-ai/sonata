import {
  PYTH_FEEDS,
  XSTOCK_MINTS,
  MAX_DIVERGENCE,
  assessMarket,
  divergence,
  effectiveMultiplier,
  stockFamily,
  toMillis,
  type StockPrice,
} from "@/lib/pricing/stock-price";

// Stock prices for dollar-denominated launch targets and dollar market caps,
// served by app/api/stock-price and used by the market snapshot.
//
// Price for dollar-denominated launch targets. The price always comes from the
// Solana market: the real xStock (e.g. SPYx) priced by Jupiter, which aggregates
// Solana DEX liquidity, checked against an executable quote. Pyth Pro, when a
// server-side key covers the feed, is a guard only: it never sets the price, but
// a gap of more than 1% blocks the launch, since one of the two is wrong or
// being manipulated. Keys stay server-side.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE_USD = 1_000;
// Each symbol's last answer for 10 seconds, and the request in flight.
const cache = new Map<string, { until: number; data: Result }>();
const requests = new Map<string, Promise<Result>>();

type JupiterPrices = Record<string, {
  usdPrice: number;
  liquidity?: number;
  decimals: number;
  scaledUiConfig?: { multiplier?: number; newMultiplier?: number; newMultiplierEffectiveAt?: string };
}>;
type JupiterQuote = { outAmount: string; priceImpactPct?: string; routePlan?: { swapInfo?: { label?: string } }[] };

export type Result = StockPrice & {
  guard?: { source: "pyth"; feed: string; price: number; divergence: number; session: string };
  pythStatus?: string;
  // Pre-IPO tokens: PreStocks' mark price, and the Solana market's premium (+) or discount (−) to it.
  mark?: { price: number; premium: number | null };
  marketStatus?: string;
};

// PreStocks' mark price per token, from its public API, cached for a minute.
let preStocks: { until: number; marks: Map<string, number> } | null = null;
async function preStocksMark(symbol: string): Promise<number> {
  if (!preStocks || preStocks.until < Date.now()) {
    const r = await fetch("https://prestocks.com/api/prestocks", {
      headers: { accept: "application/json", "user-agent": "SonataPrice/1.0 (+https://sonata.umin.ai)" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!r.ok) throw Error(`PreStocks returned ${r.status}.`);
    const list = (await r.json()) as { contract_address?: unknown; markPrice?: unknown }[];
    preStocks = {
      until: Date.now() + 60_000,
      marks: new Map(
        (Array.isArray(list) ? list : [])
          .filter((t) => typeof t.contract_address === "string" && Number(t.markPrice) > 0)
          .map((t) => [t.contract_address as string, Number(t.markPrice)]),
      ),
    };
  }
  const mark = preStocks.marks.get(XSTOCK_MINTS[symbol].mint);
  if (!mark) throw Error(`PreStocks lists no mark price for ${XSTOCK_MINTS[symbol].symbol}.`);
  return mark;
}

async function jupiterPrice(symbol: string): Promise<StockPrice & { liquidity: number; quotePrice: number; priceImpact: number; route: string }> {
  const x = XSTOCK_MINTS[symbol];
  const key = process.env.JUPITER_API_KEY;
  const base = key ? "https://api.jup.ag" : "https://lite-api.jup.ag";
  const headers: Record<string, string> = key ? { "x-api-key": key } : {};
  const get = async <T,>(path: string): Promise<T> => {
    const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!r.ok) throw Error(`Jupiter returned ${r.status}.`);
    return (await r.json()) as T;
  };
  const [prices, quote] = await Promise.all([
    get<JupiterPrices>(`/price/v3?ids=${x.mint}`),
    get<JupiterQuote>(`/swap/v1/quote?inputMint=${USDC}&outputMint=${x.mint}&amount=${QUOTE_USD * 1e6}&slippageBps=50`),
  ]);
  const p = prices?.[x.mint];
  if (!p || !(p.usdPrice > 0) || !(p.decimals > 0)) throw Error(`Jupiter has no price for ${x.symbol}.`);
  if (!(Number(quote?.outAmount) > 0)) throw Error(`Jupiter could not quote ${x.symbol}.`);
  // Quotes are in raw units; the price is per UI unit (per share).
  const uiOut = (Number(quote.outAmount) / 10 ** p.decimals) * effectiveMultiplier(p.scaledUiConfig, Date.now());
  const quotePrice = QUOTE_USD / uiOut;
  const priceImpact = Number(quote.priceImpactPct ?? 0);
  const market = { usdPrice: Number(p.usdPrice), liquidity: Number(p.liquidity ?? 0), quotePrice, priceImpact };
  const verdict = assessMarket(market);
  if (!verdict.usable) throw Error(verdict.reason);
  return {
    source: "jupiter",
    symbol,
    feed: `${x.symbol} on Solana`,
    price: market.usdPrice,
    // The gap to an executable quote serves as the uncertainty band.
    confidence: Math.abs(quotePrice - market.usdPrice),
    publishTimeMs: Date.now(),
    marketSession: "onchain",
    fetchedAt: new Date().toISOString(),
    liquidity: market.liquidity,
    quotePrice,
    priceImpact,
    route: (quote.routePlan ?? []).map((s) => s.swapInfo?.label).filter(Boolean).join(" → "),
  };
}

async function pythPrice(symbol: string, key: string): Promise<StockPrice> {
  const feed = PYTH_FEEDS[symbol];
  const response = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      priceFeedIds: [feed.id],
      properties: ["price", "confidence", "exponent", "feedUpdateTimestamp", "marketSession"],
      formats: ["solana"],
      jsonBinaryEncoding: "hex",
      // Equities have a minimum channel of fixed_rate@50ms; slower channels are allowed.
      channel: "fixed_rate@200ms",
      parsed: true,
    }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const text = await response.text();
  // Pyth answers 403 "Not entitled" when a valid key's plan excludes a feed; free keys exclude equities.
  if (response.status === 401 || response.status === 403)
    throw Error(/not entitled/i.test(text) ? "Pyth key's plan does not include US stock prices" : "Pyth rejected the API key");
  if (!response.ok) throw Error(`Pyth returned ${response.status}`);
  const body = JSON.parse(text) as { parsed?: { timestampUs?: string; priceFeeds?: Array<Record<string, string | number>> } };
  const row = body.parsed?.priceFeeds?.find((f) => Number(f.priceFeedId) === feed.id);
  if (!row?.price || row.exponent === undefined) throw Error("Pyth returned no price");
  const scale = 10 ** Number(row.exponent);
  return {
    source: "pyth",
    symbol,
    feed: feed.symbol,
    price: Number(row.price) * scale,
    confidence: Number(row.confidence ?? 0) * scale,
    publishTimeMs: toMillis(Number(row.feedUpdateTimestamp ?? body.parsed?.timestampUs)),
    marketSession: String(row.marketSession ?? "unknown"),
    fetchedAt: new Date().toISOString(),
  };
}

async function resolve(symbol: string): Promise<Result> {
  // Pre-IPO tokens trade well away from their mark (premiums and discounts of 20-30%
  // are common), so the curve uses what the token costs on Solana when that market
  // is deep enough, and PreStocks' mark price when it is not. Both are reported.
  if (stockFamily(symbol) === "PreStocks") {
    const [market, mark] = await Promise.all([
      jupiterPrice(symbol).catch((e: Error) => e),
      preStocksMark(symbol).catch((e: Error) => e),
    ]);
    const markPrice = typeof mark === "number" ? mark : null;
    if (!(market instanceof Error))
      return {
        ...market,
        ...(markPrice ? { mark: { price: markPrice, premium: market.price / markPrice - 1 } } : {}),
        pythStatus: "Pyth has no feed for pre-IPO tokens",
      };
    if (markPrice)
      return {
        source: "prestocks",
        symbol,
        feed: `${XSTOCK_MINTS[symbol].symbol} mark price (PreStocks)`,
        price: markPrice,
        confidence: 0,
        publishTimeMs: Date.now(),
        marketSession: "mark",
        fetchedAt: new Date().toISOString(),
        mark: { price: markPrice, premium: null },
        marketStatus: market.message,
        pythStatus: "Pyth has no feed for pre-IPO tokens",
      };
    throw market;
  }
  const market = await jupiterPrice(symbol);
  const key = process.env.PYTH_PRO_API_KEY;
  if (!key) return { ...market, pythStatus: "No Pyth key configured" };
  if (!PYTH_FEEDS[symbol]) return { ...market, pythStatus: "Pyth has no feed for this asset" };
  const pyth = await pythPrice(symbol, key).catch((e: Error) => e);
  if (pyth instanceof Error) return { ...market, pythStatus: pyth.message };
  const gap = divergence(market.price, pyth.price);
  if (gap > MAX_DIVERGENCE)
    throw Error(`The Solana market and Pyth disagree by ${(gap * 100).toFixed(2)}%, so the launch is blocked.`);
  return {
    ...market,
    pythStatus: "ok",
    guard: { source: "pyth", feed: pyth.feed, price: pyth.price, divergence: gap, session: pyth.marketSession },
  };
}

/** Whether a price source is configured for this symbol. */
export const isPricedSymbol = (symbol: string) => Object.hasOwn(XSTOCK_MINTS, symbol);

/** The answer from the last 10 seconds, if any. */
export function cachedStockPrice(symbol: string): Result | undefined {
  const hit = cache.get(symbol);
  return hit && hit.until > Date.now() ? hit.data : undefined;
}

/**
 * A fresh answer, kept for 10 seconds. Concurrent callers share one request
 * unless `share` is false: the market snapshot passes false, because in the
 * Workers runtime a request may not wait on I/O another request started.
 */
export function resolveStockPrice(symbol: string, { share = true } = {}): Promise<Result> {
  const run = () =>
    resolve(symbol).then((data) => {
      cache.set(symbol, { until: Date.now() + 10_000, data });
      return data;
    });
  if (!share) return run();
  let pending = requests.get(symbol);
  if (!pending) {
    pending = run().finally(() => requests.delete(symbol));
    requests.set(symbol, pending);
  }
  return pending;
}
