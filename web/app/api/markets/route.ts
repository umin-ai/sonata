import { after } from "next/server";
import { marketSnapshots } from "@/lib/server/market-snapshot";
import type { MarketsAnswer } from "@/lib/treasury/market-snapshot";

// The chain part of the server's market snapshot (lib/server/market-snapshot.ts):
// every listed market's identity and card numbers, checked on the server with
// the browser's own code. For display only. The market list asks for it when
// its copy is stale or missing, and the pools, rewards, portfolio and My
// tokens pages take their market list from it. Takes no parameters.
//
// Its callers act on the list, so when an indexer read is due it waits for it
// (loopback, normally milliseconds) rather than serving the copy in memory. It
// waits for no extras (token images, prices, 24h stats: no caller uses them),
// but starts any that are due, so a request here also keeps the home and
// market pages' caches warm (deploy/lightsail/sonata-warm.timer).
export const dynamic = "force-dynamic";

export async function GET() {
  const noStore = { "Cache-Control": "no-store" };
  const snapshot = await marketSnapshots().home({ schedule: after, budgetMs: 0, awaitRead: true });
  if (!snapshot) return Response.json({ error: "Market snapshot unavailable." }, { status: 503, headers: noStore });
  const { v, ageMs, readAt, slot, entries, skipped } = snapshot;
  const body: MarketsAnswer = { v, ageMs, readAt, slot, entries, skipped };
  return Response.json(body, { headers: noStore });
}
