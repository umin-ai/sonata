// Read-only proxy to the trade indexer for local development. On the hosted
// server, Caddy sends /api/index/* straight to the indexer, and INDEXER_URL
// points here at the local indexer, so this never loops.
export const dynamic = "force-dynamic";
const ALLOWED = new Set(["health", "trades", "candles", "stats", "rewards", "payouts", "stream"]);

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const endpoint = path.join("/");
  if (!ALLOWED.has(endpoint)) return Response.json({ error: "Not found." }, { status: 404 });
  const base = (process.env.INDEXER_URL || "https://sonata.umin.ai/api/index").replace(/\/+$/, "");
  const query = new URL(request.url).search;
  // The live stream is passed through as it arrives (the request's own I/O, which the Workers runtime allows).
  if (endpoint === "stream") {
    const lastId = request.headers.get("last-event-id");
    try {
      const r = await fetch(`${base}/stream${query}`, {
        headers: { accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) },
        signal: request.signal,
      });
      // An upstream that goes away (an indexer restart) ends the stream quietly; EventSource then reconnects.
      const upstream = r.body?.getReader();
      const body = upstream
        ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { value, done } = await upstream.read();
                if (done) controller.close();
                else controller.enqueue(value);
              } catch {
                controller.close();
              }
            },
            cancel() {
              void upstream.cancel().catch(() => {});
            },
          })
        : null;
      return new Response(body, {
        status: r.status,
        headers: { "Content-Type": r.headers.get("content-type") ?? "text/event-stream", "Cache-Control": "no-cache, no-transform" },
      });
    } catch {
      return Response.json({ error: "Market data unavailable." }, { status: 502 });
    }
  }
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
