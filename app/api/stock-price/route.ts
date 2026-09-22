import {
  PYTH_FEEDS,
  XSTOCK_MINTS,
  MAX_DIVERGENCE,
  assessMarket,
  divergence,
  effectiveMultiplier,
  toMillis,
  type StockPrice,
} from "@/lib/pricing/stock-price";

// Price for dollar-denominated launch targets.
//   1. The Solana market: the real xStock (e.g. SPYx) priced by Jupiter, which
//      aggregates Solana DEX liquidity, checked against an executable quote.
//   2. Pyth Pro, when a server-side key with equity access is configured. It is
//      used only if it agrees with the Solana market to within 1%.
// Keys stay server-side; neither source needs to reach the browser.
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE_USD = 1_000;
const cache = new Map<string, { until: number; data: unknown }>();
const requests = new Map<string, Promise<unknown>>();

type JupiterPrices = Record<string, {
  usdPrice: number;
  liquidity?: number;
  decimals: number;
  scaledUiConfig?: { multiplier?: number; newMultiplier?: number; newMultiplierEffectiveAt?: string };
}>;
type JupiterQuote = { outAmount: string; priceImpactPct?: string; routePlan?: { swapInfo?: { label?: string } }[] };

type Result = StockPrice & {
  crossCheck?: { source: "jupiter"; price: number; divergence: number };
  pythStatus?: string;
};

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
  const market = await jupiterPrice(symbol).catch((e: Error) => e);
  const key = process.env.PYTH_PRO_API_KEY;
  if (!key) {
    if (market instanceof Error) throw market;
    return { ...market, pythStatus: "No Pyth key configured" };
  }
  const pyth = await pythPrice(symbol, key).catch((e: Error) => e);
  if (pyth instanceof Error) {
    if (market instanceof Error) throw Error(`${pyth.message}; ${market.message}`);
    return { ...market, pythStatus: pyth.message };
  }
  if (market instanceof Error) return { ...pyth, pythStatus: "ok" };
  const gap = divergence(pyth.price, market.price);
  if (gap > MAX_DIVERGENCE)
    throw Error(`Pyth and the Solana market disagree by ${(gap * 100).toFixed(2)}%, so neither is used.`);
  return { ...pyth, pythStatus: "ok", crossCheck: { source: "jupiter", price: market.price, divergence: gap } };
}

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  if (!Object.hasOwn(XSTOCK_MINTS, symbol))
    return Response.json({ error: "No price source configured for this asset." }, { status: 404 });
  try {
    const hit = cache.get(symbol);
    if (hit && hit.until > Date.now()) return Response.json({ configured: true, ...(hit.data as object) });
    let pending = requests.get(symbol);
    if (!pending) {
      pending = resolve(symbol)
        .then((data) => {
          cache.set(symbol, { until: Date.now() + 10_000, data });
          return data;
        })
        .finally(() => requests.delete(symbol));
      requests.set(symbol, pending);
    }
    return Response.json({ configured: true, ...((await pending) as object) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      { configured: true, error: e instanceof Error ? e.message : "Price unavailable." },
      { status: 502 },
    );
  }
}
