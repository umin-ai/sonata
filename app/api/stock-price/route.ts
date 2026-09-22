import { PYTH_FEEDS, toMillis, type StockPrice } from "@/lib/pricing/stock-price";

// Latest Pyth Pro price for a stock quote token. The API key is server-only:
// Pyth's docs require it never reach the browser. Without a key the route
// reports `configured: false` so the launch flow can fall back cleanly.
const ENDPOINT = "https://pyth-lazer.dourolabs.app/v1/latest_price";
const cache = new Map<string, { until: number; data: StockPrice }>();
const requests = new Map<string, Promise<StockPrice>>();

type PythFeed = {
  priceFeedId: number;
  price?: string;
  confidence?: string;
  exponent?: number | string;
  feedUpdateTimestamp?: string | number;
  marketSession?: string;
};

async function fetchPrice(symbol: string, key: string): Promise<StockPrice> {
  const feed = PYTH_FEEDS[symbol];
  let lastError = "Pyth price service unavailable.";
  // Equities have a minimum channel of fixed_rate@50ms; any slower channel is allowed.
  for (const channel of ["fixed_rate@200ms", "fixed_rate@1000ms"]) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        priceFeedIds: [feed.id],
        properties: ["price", "confidence", "exponent", "feedUpdateTimestamp", "marketSession"],
        // Mirrors the documented request; the signed Solana payload is ignored here.
        formats: ["solana"],
        jsonBinaryEncoding: "hex",
        channel,
        parsed: true,
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) {
      // Pyth answers 403 "Not entitled" when a valid key's plan excludes a feed; free keys exclude equities.
      const text = await response.text();
      throw Error(
        /not entitled/i.test(text)
          ? "This Pyth API key's plan does not include US stock prices."
          : "Pyth rejected the API key.",
      );
    }
    if (!response.ok) {
      lastError = `Pyth returned ${response.status}: ${(await response.text()).slice(0, 160)}`;
      continue;
    }
    const body = (await response.json()) as { parsed?: { timestampUs?: string; priceFeeds?: PythFeed[] } };
    const row = body.parsed?.priceFeeds?.find((f) => Number(f.priceFeedId) === feed.id);
    if (!row?.price || row.exponent === undefined) throw Error("Pyth returned no price for this feed.");
    const scale = 10 ** Number(row.exponent);
    const stamp = Number(row.feedUpdateTimestamp ?? body.parsed?.timestampUs);
    if (!Number.isFinite(stamp)) throw Error("Pyth returned no timestamp.");
    return {
      symbol,
      feed: feed.symbol,
      price: Number(row.price) * scale,
      confidence: Number(row.confidence ?? 0) * scale,
      publishTimeMs: toMillis(stamp),
      marketSession: row.marketSession ?? "unknown",
      fetchedAt: new Date().toISOString(),
    };
  }
  throw Error(lastError);
}

export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  if (!Object.hasOwn(PYTH_FEEDS, symbol))
    return Response.json({ error: "No Pyth feed configured for this asset." }, { status: 404 });
  const key = process.env.PYTH_PRO_API_KEY;
  if (!key) return Response.json({ configured: false }, { headers: { "Cache-Control": "no-store" } });
  try {
    const cached = cache.get(symbol);
    if (cached && cached.until > Date.now()) return Response.json({ configured: true, ...cached.data });
    let pending = requests.get(symbol);
    if (!pending) {
      pending = fetchPrice(symbol, key)
        .then((data) => {
          cache.set(symbol, { until: Date.now() + 5_000, data });
          return data;
        })
        .finally(() => requests.delete(symbol));
      requests.set(symbol, pending);
    }
    return Response.json({ configured: true, ...(await pending) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      { configured: true, error: e instanceof Error ? e.message : "Pyth price unavailable." },
      { status: 502 },
    );
  }
}
