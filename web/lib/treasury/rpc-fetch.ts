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
 *
 * Some endpoints go quiet instead of refusing: public Devnet sometimes stops
 * answering account reads from a busy address without saying so. When there is
 * another endpoint to ask, a read that has had no answer after 2.5 s (4 s for
 * the heavy reads below) is sent to the next endpoint as well, and whichever
 * answers first is used; the other request is cancelled. An endpoint beaten that
 * way rests for 10 minutes instead of seconds. Writes are never sent twice. In a
 * browser the rests are kept in localStorage (endpoint URLs and times only), so
 * a new page load does not start with the endpoint that just went quiet.
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
// The rest for an endpoint that went quiet while another one answered.
const SLOW_REST_MS = 10 * 60_000;
// Reads that scan or return many accounts can take well over 10 s on the public
// endpoint, so they get more time than point lookups.
const HEAVY = new Set([
  "getProgramAccounts",
  "getMultipleAccounts",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenLargestAccounts",
  "getTokenAccountsByOwner",
]);
const READ_TIMEOUT_MS = 12_000;
const HEAVY_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 20_000;
// An endpoint coming back from a rest gets a shorter trial when another endpoint
// can take the request, so a still-hanging one does not hold up the queue. The
// final try always gets the full time.
const PROBE_TIMEOUT_MS = 4_000;
const HEAVY_PROBE_TIMEOUT_MS = 10_000;
// How long a read waits for an answer before it is also sent to another endpoint.
const HEDGE_MS = 2_500;
const HEAVY_HEDGE_MS = 4_000;
const STORAGE_KEY = "sonata.rpc.rest.v1";

type Health = { restUntil: number; strikes: number };
type Result = { response: Response } | { retryAfterMs?: number };
type Store = Pick<Storage, "getItem" | "setItem">;

// localStorage in a browser; nothing on a server, in scripts, or where storage is blocked.
function browserStorage(): Store | undefined {
  try {
    return typeof window !== "undefined" ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}

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
    /** How long a light or heavy read waits before it is also sent to another endpoint (tests). */
    hedgeMs?: { light: number; heavy: number };
    /** Starts the hedge timer and returns a function that stops it (tests). */
    hedgeTimer?: (ms: number, fire: () => void) => () => void;
    /** Where endpoint rests are kept between page loads; null keeps none. Defaults to localStorage in a browser. */
    storage?: Store | null;
  } = {},
): typeof fetch {
  const interval = options.intervalMs ?? 350;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const hedgeMs = options.hedgeMs ?? { light: HEDGE_MS, heavy: HEAVY_HEDGE_MS };
  const hedgeTimer =
    options.hedgeTimer ??
    ((ms: number, fire: () => void) => {
      const timer = setTimeout(fire, ms);
      return () => clearTimeout(timer);
    });
  const health = new Map<string, Health>();
  const state = (url: string) => {
    let h = health.get(url);
    if (!h) health.set(url, (h = { restUntil: 0, strikes: 0 }));
    return h;
  };
  // Rests are kept only for a configured list of endpoints to fail over between.
  const kept = options.endpoints && options.endpoints.length > 1 ? options.endpoints : [];
  const storage = kept.length ? (options.storage === undefined ? browserStorage() : options.storage) : null;
  const save = () => {
    if (!storage) return;
    const resting: Record<string, Health> = {};
    for (const url of kept) {
      const h = health.get(url);
      if (h && h.restUntil > now()) resting[url] = { restUntil: h.restUntil, strikes: h.strikes };
    }
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(resting));
    } catch {}
  };
  // Rests saved by an earlier page that are still running, none longer than SLOW_REST_MS from now.
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (saved && typeof saved === "object")
      for (const url of kept) {
        const { restUntil, strikes } = (saved[url] ?? {}) as Partial<Health>;
        if (typeof restUntil !== "number" || !(restUntil > now())) continue;
        if (typeof strikes !== "number" || !Number.isInteger(strikes) || strikes < 0) continue;
        health.set(url, { restUntil: Math.min(restUntil, now() + SLOW_REST_MS), strikes });
      }
  } catch {}
  const rest = (url: string, retryAfterMs?: number) => {
    const h = state(url);
    h.strikes++;
    const backoff = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (h.strikes - 1));
    // A quick failure does not cut short a longer rest that is still running.
    h.restUntil = Math.max(h.restUntil, now() + Math.max(backoff, Math.min(MAX_COOLDOWN_MS, retryAfterMs ?? 0)));
    save();
  };
  const restSlow = (url: string) => {
    const h = state(url);
    h.strikes++;
    h.restUntil = now() + SLOW_REST_MS;
    save();
  };
  const recover = (url: string) => {
    const h = state(url);
    if (!h.strikes && !h.restUntil) return;
    h.strikes = 0;
    h.restUntil = 0;
    save();
  };
  const soonestFirst = (endpoints: string[]) =>
    [...endpoints].sort((a, b) => state(a).restUntil - state(b).restUntil);

  let tail: Promise<unknown> = Promise.resolve(),
    nextStart = 0;
  const inFlight = new Map<string, Promise<Response>>();
  const pace = async () => {
    const wait = Math.max(0, nextStart - now());
    if (wait) await sleep(wait);
    nextStart = now() + interval;
  };

  // One try at one endpoint: the response if it is usable, or, after resting the
  // endpoint, how long it asked us to wait (Retry-After) if it said. A try ended
  // by `stop` (it lost a hedge) gives null and leaves the endpoint's state alone.
  async function attempt(
    url: string,
    init: RequestInit | undefined,
    method: string | undefined,
    last: boolean,
    stop?: AbortSignal,
  ): Promise<Result | null> {
    const heavy = !!method && HEAVY.has(method);
    const read = !!method && READS.has(method);
    const full = !read ? WRITE_TIMEOUT_MS : heavy ? HEAVY_TIMEOUT_MS : READ_TIMEOUT_MS;
    const probe = heavy ? HEAVY_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS;
    const ms = options.timeoutMs ?? (state(url).strikes && !last ? Math.min(probe, full) : full);
    const controller = !init?.signal && (ms > 0 || stop) ? new AbortController() : null;
    const timer = controller && ms > 0 ? setTimeout(() => controller.abort(), ms) : null;
    const halt = () => controller?.abort();
    stop?.addEventListener("abort", halt);
    let response: Response, text: string;
    try {
      response = await base(url, controller ? { ...init, signal: controller.signal } : init);
      // The body is read under the same timeout: a reply that stalls midway is a failure too.
      text = await response.text();
    } catch (e) {
      // The caller's own abort is theirs to handle, not a provider failure.
      if (init?.signal?.aborted) throw e;
      if (stop?.aborted) return null;
      rest(url);
      return {};
    } finally {
      if (timer) clearTimeout(timer);
      stop?.removeEventListener("abort", halt);
    }
    if (stop?.aborted) return null;
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

  // A try at `url` that `backup` joins if `url` has given no usable answer within
  // the hedge delay. The first usable answer wins and the other request is
  // cancelled; `url` beaten that way rests SLOW_REST_MS. If one of the two fails,
  // it rests as usual and the other is still awaited. `tried` says whether
  // `backup` was asked.
  function hedged(
    url: string,
    backup: string,
    init: RequestInit | undefined,
    method: string,
    last: boolean,
    backupLast: boolean,
  ): Promise<{ result: Result; tried: boolean }> {
    return new Promise((resolve, reject) => {
      const stops = [new AbortController(), new AbortController()];
      let stopTimer = () => {},
        open = 1,
        tried = false,
        waiting = true,
        done = false,
        retryAfterMs: number | undefined;
      const finish = (result: Result) => {
        done = true;
        stopTimer();
        resolve({ result, tried });
      };
      const run = (i: 0 | 1) =>
        void attempt(i ? backup : url, init, method, i ? backupLast : last, stops[i].signal).then(
          (r) => {
            if (done || !r) return;
            if (!i) waiting = false;
            if ("response" in r) {
              if (i && waiting) restSlow(url);
              stops[1 - i].abort();
              finish(r);
            } else {
              retryAfterMs = r.retryAfterMs ?? retryAfterMs;
              if (!--open) finish({ retryAfterMs });
            }
          },
          (e) => {
            done = true;
            stopTimer();
            for (const s of stops) s.abort();
            reject(e);
          },
        );
      run(0);
      stopTimer = hedgeTimer(HEAVY.has(method) ? hedgeMs.heavy : hedgeMs.light, () => {
        if (done || !waiting) return;
        tried = true;
        open++;
        // The backup goes out now; the pacing counts from it for what comes next.
        nextStart = now() + interval;
        run(1);
      });
    });
  }

  // Asks the endpoints of `order` in turn until one gives a usable answer, or
  // returns the latest Retry-After. With `hedge`, an endpoint still quiet after
  // the hedge delay is joined by the next one in `order` (after the last, by the
  // best of the others), which then counts as tried.
  async function pass(
    order: string[],
    endpoints: string[],
    init: RequestInit | undefined,
    method: string | undefined,
    hedge: boolean,
    final: boolean,
  ): Promise<Result> {
    let retryAfterMs: number | undefined;
    for (let i = 0; i < order.length; i++) {
      await pace();
      const url = order[i],
        last = final || i === order.length - 1;
      const backup = hedge ? (order[i + 1] ?? soonestFirst(endpoints).find((u) => u !== url)) : undefined;
      let r: Result;
      if (backup && method) {
        const h = await hedged(url, backup, init, method, last, final || i + 1 >= order.length - 1);
        r = h.result;
        if (h.tried && backup === order[i + 1]) i++;
      } else r = (await attempt(url, init, method, last)) ?? {};
      if ("response" in r) return r;
      retryAfterMs = r.retryAfterMs ?? retryAfterMs;
    }
    return { retryAfterMs };
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
          // Only reads are hedged, and only with another endpoint to ask. A caller's
          // own signal cannot cancel the losing request, so its reads are not hedged.
          const hedge = read && endpoints.length > 1 && !init?.signal;
          // First pass: every endpoint that is not resting, in order. If they are all
          // resting, the one back soonest still gets this request.
          let ready = endpoints.filter((u) => state(u).restUntil <= now());
          if (!ready.length) ready = soonestFirst(endpoints).slice(0, 1);
          const first = await pass(ready, endpoints, init, request.method, hedge, false);
          if ("response" in first) return first.response;
          // Writes stop here: a signed transaction resent elsewhere has the same
          // signature and cannot land twice, but the caller decides whether to retry.
          if (!read) throw new Error(RPC_BUSY);
          // Reads wait once (Retry-After, else 4 s), then give every endpoint one more try.
          await sleep(Math.min(10_000, Math.max(2_000, first.retryAfterMs ?? 4_000)));
          // The last round: every endpoint gets its full time.
          const again = await pass(soonestFirst(endpoints), endpoints, init, request.method, hedge, true);
          if ("response" in again) return again.response;
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
