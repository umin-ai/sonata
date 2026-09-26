import { cachedStockPrice, isPricedSymbol, resolveStockPrice } from "@/lib/server/stock-price";

// Price for dollar-denominated launch targets (lib/server/stock-price.ts): the
// real xStock on Solana, priced by Jupiter and checked against an executable
// quote, with Pyth Pro as a guard when configured. Answers are kept 10 seconds.
export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol") ?? "";
  if (!isPricedSymbol(symbol))
    return Response.json({ error: "No price source configured for this asset." }, { status: 404 });
  try {
    const hit = cachedStockPrice(symbol);
    if (hit) return Response.json({ configured: true, ...hit });
    return Response.json({ configured: true, ...(await resolveStockPrice(symbol)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json(
      { configured: true, error: e instanceof Error ? e.message : "Price unavailable." },
      { status: 502 },
    );
  }
}
