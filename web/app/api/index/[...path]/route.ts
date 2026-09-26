// Read-only proxy to the trade indexer for local development. On the hosted
// server, Caddy sends /api/index/* straight to the indexer, and INDEXER_URL
// points here at the local indexer, so this never loops.
export const dynamic = "force-dynamic";
const ALLOWED = new Set(["health", "trades", "candles", "stats", "rewards", "payouts"]);

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const endpoint = path.join("/");
  if (!ALLOWED.has(endpoint)) return Response.json({ error: "Not found." }, { status: 404 });
  const base = (process.env.INDEXER_URL || "https://sonata.umin.ai/api/index").replace(/\/+$/, "");
  const query = new URL(request.url).search;
  try {
    const r = await fetch(`${base}/${endpoint}${query}`, { headers: { accept: "application/json" } });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=5" },
    });
  } catch {
    return Response.json({ error: "Market data unavailable." }, { status: 502 });
  }
}
