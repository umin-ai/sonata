import { after } from "next/server";
import { marketSnapshots } from "@/lib/server/market-snapshot";

// The server's market snapshot (lib/server/market-snapshot.ts): every listed
// market's identity and card numbers, checked on the server with the
// browser's own code, plus token images, prices and 24h stats. For display
// only. The market list asks for it when its copy is stale or missing. Takes
// no parameters.
export const dynamic = "force-dynamic";

export async function GET() {
  const noStore = { "Cache-Control": "no-store" };
  const snapshot = await marketSnapshots().home({ schedule: after, budgetMs: 1_000 });
  if (!snapshot) return Response.json({ error: "Market snapshot unavailable." }, { status: 503, headers: noStore });
  return Response.json(snapshot, { headers: noStore });
}
