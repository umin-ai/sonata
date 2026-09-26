import { after } from "next/server";
import { marketSnapshots } from "@/lib/server/market-snapshot";
import type { MarketAnswer, MarketsAnswer } from "@/lib/treasury/market-snapshot";

// The chain part of the server's market snapshot (lib/server/market-snapshot.ts):
// every listed market's identity and card numbers, checked on the server with
// the browser's own code. For display only. The market list asks for it when
// its copy is stale or missing, and the pools, rewards, portfolio and My
// tokens pages take their market list from it. With ?pool=<address> it serves
// that one market instead (the market page's fallback while its live stream is
// down).
//
// Its callers act on the list, so when an indexer read is due it waits for it
// (loopback, normally milliseconds) rather than serving the copy in memory. It
// waits for no extras (token images, prices, 24h stats: no caller uses them),
// but starts any that are due, so a request here also keeps the home and
// market pages' caches warm (deploy/lightsail/sonata-warm.timer).
export const dynamic = "force-dynamic";

const POOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request) {
  const noStore = { "Cache-Control": "no-store" };
  // ?pool=: one market's chain part, for a market page whose live stream is down (it polls this).
  const pool = new URL(request.url).searchParams.get("pool");
  if (pool !== null) {
    if (!POOL.test(pool)) return Response.json({ error: "Bad request." }, { status: 400, headers: noStore });
    const page = await marketSnapshots().marketPage(pool, { schedule: after, budgetMs: 0 });
    if (!page) return Response.json({ error: "Market not listed." }, { status: 404, headers: noStore });
    const { v, ageMs, readAt, slot, entry } = page;
    const body: MarketAnswer = { v, ageMs, readAt, slot, entry };
    return Response.json(body, { headers: noStore });
  }
  const snapshot = await marketSnapshots().home({ schedule: after, budgetMs: 0, awaitRead: true });
  if (!snapshot) return Response.json({ error: "Market snapshot unavailable." }, { status: 503, headers: noStore });
  const { v, ageMs, readAt, slot, entries, skipped } = snapshot;
  const body: MarketsAnswer = { v, ageMs, readAt, slot, entries, skipped };
  return Response.json(body, { headers: noStore });
}
