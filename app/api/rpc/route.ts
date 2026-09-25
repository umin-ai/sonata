import { READS } from "@/lib/treasury/rpc-fetch";
import { clientKey, createRateLimit } from "@/lib/server/rate-limit";

// Sonata's relay to a dedicated Solana Devnet RPC (QUICKNODE_DEVNET_URL), the
// app's fallback when the public endpoint is busy (lib/treasury/rpc-fetch.ts).
// The provider URL carries its access key, so it stays on the server. Only
// single JSON-RPC calls the app makes are forwarded. Limits keep the whole site
// under the provider's 15 requests per second and its monthly credits (10,000
// calls a day at up to ~30 credits each fits 10M a month).
export const dynamic = "force-dynamic";
const UPSTREAM = process.env.QUICKNODE_DEVNET_URL;
const MAX_BODY = 64_000;
const TIMEOUT_MS = 15_000;
const ALLOWED = new Set([...READS, "sendTransaction"]);
const MAX_RESPONSE = 16_000_000;
// Fixed windows can admit up to twice a limit across a boundary: 2 × 7 < 15 per second.
const perSecond = createRateLimit({ perKey: 3, total: 7, windowMs: 1_000 });
const perMinute = createRateLimit({ perKey: 120, total: 400, windowMs: 60_000 });
const perDay = createRateLimit({ perKey: 1_500, total: 10_000, windowMs: 86_400_000 });
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
const rpcError = (status: number, code: number, message: string, extra?: Record<string, string>) =>
  json(status, { jsonrpc: "2.0", id: null, error: { code, message } }, extra);

export async function POST(request: Request) {
  if (!UPSTREAM) return rpcError(503, -32000, "Fallback RPC is not configured.");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return rpcError(403, -32000, "Cross-origin requests are not accepted.");
  const key = clientKey(request);
  if (!perSecond(key) || !perMinute(key)) return rpcError(429, 429, "Too many requests.", { "retry-after": "2" });
  if (!perDay(key)) return rpcError(429, 429, "Daily fallback budget used.", { "retry-after": "60" });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return rpcError(413, -32600, "Request too large.");
  let call: { jsonrpc?: unknown; method?: unknown };
  try {
    call = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, "Invalid JSON.");
  }
  if (!call || typeof call !== "object" || Array.isArray(call) || call.jsonrpc !== "2.0")
    return rpcError(400, -32600, "Send one JSON-RPC 2.0 request.");
  if (typeof call.method !== "string" || !ALLOWED.has(call.method))
    return rpcError(403, -32601, "Method not available.");
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const retryAfter = upstream.headers.get("retry-after");
    // Anything but a success or a rate limit is reported as this relay being unavailable,
    // so the app fails over instead of treating the provider's error as an answer.
    if (!upstream.ok && upstream.status !== 429) return rpcError(502, -32000, "Fallback RPC unavailable.");
    let seen = 0;
    const cap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_RESPONSE) controller.error(new Error("Response too large."));
        else controller.enqueue(chunk);
      },
    });
    return new Response(upstream.body ? upstream.body.pipeThrough(cap) : null, {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      },
    });
  } catch {
    return rpcError(502, -32000, "Fallback RPC unavailable.");
  }
}
