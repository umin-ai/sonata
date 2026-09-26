import { READS } from "@/lib/treasury/rpc-fetch";
import { clientKey, createRateLimit } from "@/lib/server/rate-limit";

// Sonata's relay to dedicated Solana Devnet RPC providers, the app's fallback
// when the public endpoint is busy (lib/treasury/rpc-fetch.ts). Provider URLs
// carry their access keys, so they stay on the server. The relay tries its
// providers in order and moves on when one is rate limited, erroring or slow,
// resting it for a while as the browser does. Only single JSON-RPC calls the
// app makes are forwarded. Limits keep the whole site under the smallest free
// plan: QuickNode's 15 requests per second and 10M credits a month (10,000
// calls a day at up to ~30 credits each fits).
export const dynamic = "force-dynamic";

type Provider = { name: string; url: string; maxAccounts: number };
const PROVIDERS: Provider[] = [
  // QuickNode's free plan answers getMultipleAccounts for at most 5 accounts per call.
  { name: "quicknode", url: process.env.QUICKNODE_DEVNET_URL ?? "", maxAccounts: 5 },
  { name: "getblock", url: process.env.GETBLOCK_DEVNET_URL ?? "", maxAccounts: 100 },
].filter((p) => p.url);

const MAX_BODY = 64_000;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE = 16_000_000;
const CHUNK_CONCURRENCY = 3;
const ALLOWED = new Set([...READS, "sendTransaction"]);
// Fixed windows can admit up to twice a limit across a boundary: 2 × 7 < 15 per second.
// A browser paces its own calls at about 3 per second; 4 leaves room for jitter.
const perSecond = createRateLimit({ perKey: 4, total: 7, windowMs: 1_000 });
const perMinute = createRateLimit({ perKey: 120, total: 400, windowMs: 60_000 });
const perDay = createRateLimit({ perKey: 1_500, total: 10_000, windowMs: 86_400_000 });

// A provider that failed rests 15 s, doubling to 60 s, before it is preferred again.
const rest = new Map<string, { until: number; strikes: number }>();
const resting = (p: Provider) => (rest.get(p.name)?.until ?? 0) > Date.now();
const fail = (p: Provider) => {
  const r = rest.get(p.name) ?? { until: 0, strikes: 0 };
  r.strikes++;
  r.until = Date.now() + Math.min(60_000, 15_000 * 2 ** (r.strikes - 1));
  rest.set(p.name, r);
};
const recover = (p: Provider) => rest.delete(p.name);

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
const rpcError = (status: number, code: number, message: string, extra?: Record<string, string>) =>
  json(status, { jsonrpc: "2.0", id: null, error: { code, message } }, extra);

export async function POST(request: Request) {
  if (!PROVIDERS.length) return rpcError(503, -32000, "Fallback RPC is not configured.");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return rpcError(403, -32000, "Cross-origin requests are not accepted.");
  const key = clientKey(request);
  if (!perSecond(key) || !perMinute(key)) return rpcError(429, 429, "Too many requests.", { "retry-after": "2" });
  if (!perDay(key)) return rpcError(429, 429, "Daily fallback budget used.", { "retry-after": "60" });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return rpcError(413, -32600, "Request too large.");
  let call: { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown };
  try {
    call = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, "Invalid JSON.");
  }
  if (!call || typeof call !== "object" || Array.isArray(call) || call.jsonrpc !== "2.0")
    return rpcError(400, -32600, "Send one JSON-RPC 2.0 request.");
  if (typeof call.method !== "string" || !ALLOWED.has(call.method))
    return rpcError(403, -32601, "Method not available.");

  const keys =
    call.method === "getMultipleAccounts" && Array.isArray(call.params) && Array.isArray(call.params[0])
      ? (call.params[0] as unknown[])
      : null;
  // Providers not resting first; for a multi-account read, those that take it in one call first.
  const order = [...PROVIDERS].sort(
    (a, b) =>
      Number(resting(a)) - Number(resting(b)) ||
      (keys ? Number(keys.length > a.maxAccounts) - Number(keys.length > b.maxAccounts) : 0),
  );
  for (const p of order) {
    const answer =
      keys && keys.length > p.maxAccounts
        ? await splitMultipleAccounts(p, call.id, keys, (call.params as unknown[])[1])
        : await forward(p, raw);
    if (answer) {
      recover(p);
      return answer;
    }
    fail(p);
  }
  return rpcError(502, -32000, "Fallback RPC unavailable.");
}

// One call to one provider: its answer, streamed with a size cap, or null if it
// was rate limited, erroring or slow, so the next provider is tried.
async function forward(p: Provider, raw: string) {
  try {
    const upstream = await fetch(p.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!upstream.ok) return null;
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
      headers: { "content-type": "application/json", "cache-control": "no-store", "x-rpc-provider": p.name },
    });
  } catch {
    return null;
  }
}

type Answer = { result?: { context?: { slot?: number }; value?: unknown[] }; error?: unknown };
// Asks one provider for the accounts in groups it accepts and returns one answer
// in the usual shape, in the original order, at the oldest slot seen; null if any group failed.
async function splitMultipleAccounts(p: Provider, id: unknown, keys: unknown[], config: unknown) {
  const groups: unknown[][] = [];
  for (let i = 0; i < keys.length; i += p.maxAccounts) groups.push(keys.slice(i, i + p.maxAccounts));
  const answers: Answer[] = new Array(groups.length);
  let next = 0,
    failed = false;
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, groups.length) }, async () => {
      while (!failed && next < groups.length) {
        const i = next++;
        try {
          const r = await fetch(p.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: i,
              method: "getMultipleAccounts",
              params: config === undefined ? [groups[i]] : [groups[i], config],
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          const data = (await r.json()) as Answer;
          if (!r.ok || data.error || !Array.isArray(data.result?.value)) failed = true;
          else answers[i] = data;
        } catch {
          failed = true;
        }
      }
    }),
  );
  if (failed) return null;
  const slot = Math.min(...answers.map((a) => a.result?.context?.slot ?? Infinity));
  return json(
    200,
    {
      jsonrpc: "2.0",
      id,
      result: { context: { slot: Number.isFinite(slot) ? slot : 0 }, value: answers.flatMap((a) => a.result!.value!) },
    },
    // Which provider answered (its name, never its URL), for checking the failover.
    { "x-rpc-provider": p.name },
  );
}
