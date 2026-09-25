/**
 * Shared pacing, in-flight deduplication and endpoint failover for the app's
 * Solana RPC traffic. Never caches account values.
 *
 * Requests go to the first endpoint in `endpoints` that is not resting. An
 * endpoint that answers "rate limited", a server error, or times out or fails
 * to connect rests for a cooldown (15 s doubling to 60 s, or its Retry-After if
 * longer) and the same request moves on to the next endpoint, so one busy
 * provider does not surface as an error. A read that every endpoint refused
 * waits once (Retry-After, else 4 s) and tries them all again; after that, and
 * for writes at once, the caller gets RPC_BUSY.
 */
export const READS = new Set([
  "getAccountInfo",
  "getTokenLargestAccounts",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getBalance",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getGenesisHash",
  "getSlot",
  "getBlockTime",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "getRecentPrioritizationFees",
  "getEpochInfo",
  "getEpochSchedule",
  "getVersion",
  "getHealth",
  "simulateTransaction",
  "isBlockhashValid",
]);
export const RPC_BUSY =
  "Solana Devnet is busy. Please wait a few seconds, then refresh. Some balances are unavailable.";

const BASE_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 60_000;
const READ_TIMEOUT_MS = 12_000;
const WRITE_TIMEOUT_MS = 20_000;
// An endpoint coming back from a rest gets a short trial when another endpoint
// can take the request, so a still-hanging one does not hold up the queue.
const PROBE_TIMEOUT_MS = 3_000;

type Health = { restUntil: number; strikes: number };

export function createRpcFetch(
  base: typeof fetch,
  options: {
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Endpoints in order of preference; without them each request goes to the URL it was given. */
    endpoints?: string[];
    now?: () => number;
    /** Per-attempt timeout; 0 turns it off (tests). */
    timeoutMs?: number;
  } = {},
): typeof fetch {
  const interval = options.intervalMs ?? 350;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const health = new Map<string, Health>();
  const state = (url: string) => {
    let h = health.get(url);
    if (!h) health.set(url, (h = { restUntil: 0, strikes: 0 }));
    return h;
  };
  const rest = (url: string, retryAfterMs?: number) => {
    const h = state(url);
    h.strikes++;
    const backoff = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (h.strikes - 1));
    h.restUntil = now() + Math.max(backoff, Math.min(MAX_COOLDOWN_MS, retryAfterMs ?? 0));
  };
  const recover = (url: string) => {
    const h = state(url);
    h.strikes = 0;
    h.restUntil = 0;
  };

  let tail: Promise<unknown> = Promise.resolve(),
    nextStart = 0;
  const inFlight = new Map<string, Promise<Response>>();

  // One try at one endpoint: the response if it is usable, or, after resting the
  // endpoint, how long it asked us to wait (Retry-After) if it said.
  async function attempt(
    url: string,
    init: RequestInit | undefined,
    read: boolean,
    last: boolean,
  ): Promise<{ response: Response } | { retryAfterMs?: number }> {
    const wait = Math.max(0, nextStart - now());
    if (wait) await sleep(wait);
    nextStart = now() + interval;
    const ms =
      options.timeoutMs ??
      (state(url).strikes && !last ? PROBE_TIMEOUT_MS : read ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
    const controller = !init?.signal && ms > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
    let response: Response, text: string;
    try {
      response = await base(url, controller ? { ...init, signal: controller.signal } : init);
      // The body is read under the same timeout: a reply that stalls midway is a failure too.
      text = await response.text();
    } catch (e) {
      // The caller's own abort is theirs to handle, not a provider failure.
      if (init?.signal?.aborted) throw e;
      rest(url);
      return {};
    } finally {
      if (timer) clearTimeout(timer);
    }
    let code: number | undefined;
    if (response.ok) {
      try {
        code = (JSON.parse(text) as { error?: { code?: number } })?.error?.code;
      } catch {}
    }
    const limited = response.status === 429 || code === 429;
    if (limited || response.status >= 500) {
      const header = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
      rest(url, retryAfterMs);
      return { retryAfterMs };
    }
    recover(url);
    return {
      response: new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }),
    };
  }

  return (async (input, init) => {
    let request: { method?: string; params?: unknown; id?: unknown };
    try {
      request = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      return base(input, init);
    }
    const read = !!request.method && READS.has(request.method);
    const endpoints = options.endpoints?.length ? options.endpoints : [String(input)];
    const key =
      read && !init?.signal
        ? JSON.stringify([endpoints[0], request.method, request.params])
        : undefined;
    let work = key ? inFlight.get(key) : undefined;
    if (!work) {
      work = tail
        .catch(() => undefined)
        .then(async () => {
          // First pass: every endpoint that is not resting, in order. If they are all
          // resting, the one back soonest still gets this request.
          const soonestFirst = () =>
            [...endpoints].sort((a, b) => state(a).restUntil - state(b).restUntil);
          let ready = endpoints.filter((u) => state(u).restUntil <= now());
          if (!ready.length) ready = soonestFirst().slice(0, 1);
          let retryAfterMs: number | undefined;
          for (const [i, url] of ready.entries()) {
            const r = await attempt(url, init, read, i === ready.length - 1);
            if ("response" in r) return r.response;
            retryAfterMs = r.retryAfterMs ?? retryAfterMs;
          }
          // Writes stop here: a signed transaction resent elsewhere has the same
          // signature and cannot land twice, but the caller decides whether to retry.
          if (!read) throw new Error(RPC_BUSY);
          // Reads wait once (Retry-After, else 4 s), then give every endpoint one more try.
          await sleep(Math.min(10_000, Math.max(2_000, retryAfterMs ?? 4_000)));
          const again = soonestFirst();
          for (const [i, url] of again.entries()) {
            const r = await attempt(url, init, read, i === again.length - 1);
            if ("response" in r) return r.response;
          }
          throw new Error(RPC_BUSY);
        });
      tail = work.catch(() => undefined);
      if (key) {
        inFlight.set(key, work);
        const current = work;
        void work
          .finally(() => {
            if (inFlight.get(key) === current) inFlight.delete(key);
          })
          .catch(() => undefined);
      }
    }
    const result = (await work).clone();
    if (!key) return result;
    // Different callers have different JSON-RPC IDs despite identical read parameters.
    let data: unknown;
    try {
      data = await result.clone().json();
    } catch {
      return result;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return result;
    return new Response(JSON.stringify({ ...data, id: request.id }), {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }) as typeof fetch;
}
