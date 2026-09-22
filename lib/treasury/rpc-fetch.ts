/** Shared pacing and in-flight deduplication. Never caches account values or retries writes. */
const READS = new Set([
  "getAccountInfo",
  "getTokenLargestAccounts",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getBalance",
  "getTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getGenesisHash",
  "getSlot",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTransaction",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "getEpochInfo",
  "getVersion",
  "simulateTransaction",
  "isBlockhashValid",
]);
export const RPC_BUSY =
  "Solana Devnet is busy. Please wait a few seconds, then refresh. Some balances are unavailable.";
export function createRpcFetch(
  base: typeof fetch,
  options: { intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): typeof fetch {
  const interval = options.intervalMs ?? 350;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let tail: Promise<unknown> = Promise.resolve(),
    nextStart = 0;
  const inFlight = new Map<string, Promise<Response>>();
  return (async (input, init) => {
    let request: { method?: string; params?: unknown; id?: unknown };
    try {
      request = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      return base(input, init);
    }
    const read = !!request.method && READS.has(request.method);
    const key =
      read && !init?.signal
        ? JSON.stringify([String(input), request.method, request.params])
        : undefined;
    let work = key ? inFlight.get(key) : undefined;
    if (!work) {
      work = tail
        .catch(() => undefined)
        .then(async () => {
          for (let attempt = 0; ; attempt++) {
            const wait = Math.max(0, nextStart - Date.now());
            if (wait) await sleep(wait);
            nextStart = Date.now() + interval;
            const response = await base(input, init);
            let data: { error?: { code?: number } } | undefined;
            if (response.ok) {
              try {
                data = await response.clone().json();
              } catch {}
            }
            const limited =
              response.status === 429 || data?.error?.code === 429;
            if (!limited) return response;
            if (!read || attempt >= 1) throw new Error(RPC_BUSY);
            const header = response.headers.get("retry-after");
            const seconds = header ? Number(header) : NaN;
            const delay = Number.isFinite(seconds)
              ? Math.min(10000, Math.max(2000, seconds * 1000))
              : 4000;
            await sleep(delay);
          }
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
