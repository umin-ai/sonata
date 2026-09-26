// One request budget for every call the indexer makes to its main Solana RPC
// (public Devnet unless SOLANA_RPC_URL says otherwise): the live poll, live
// push's reads and fast trade path, the market accounts reader, the sync loop
// and the LP readings all take a turn here before their request goes out.
//
// Public Devnet allows 100 requests per 10 s per IP and 40 per method, and the
// payout crank shares the server's IP (about 2 requests a second while it
// runs). Each part of the indexer used to keep only its own pace, and together
// they passed those limits with a little trading; the 429s that followed hit
// every part at once. So: at most `perSecond` requests a second in all and
// `perMethodPerSecond` per method (each with a burst of one second's worth),
// granted in priority order: the 1 s poll first (it is what keeps curves
// live), then live push's reads and trade path, then the 10 s accounts read,
// then the sync loop and everything else in the background.
//
// Defaults: 6 a second and 3 per method (at most 66 and 33 in any 10 s),
// which leaves the crank its share. INDEXER_RPC_PER_SECOND and
// INDEXER_RPC_PER_METHOD_PER_SECOND override them (a paid SOLANA_RPC_URL can
// take more).
export const RPC_PER_SECOND = 6;
export const RPC_PER_METHOD_PER_SECOND = 3;
/** Lower goes first. */
export const PRIORITY = { poll: 0, live: 1, reader: 2, background: 3 };

export function rpcLimiter({
  perSecond = RPC_PER_SECOND,
  perMethodPerSecond = RPC_PER_METHOD_PER_SECOND,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const bucket = (rate) => ({ rate, tokens: rate, at: now() });
  const refill = (b) => {
    const t = now();
    b.tokens = Math.min(b.rate, b.tokens + ((t - b.at) / 1000) * b.rate);
    b.at = t;
  };
  const wait = (b) => (b.tokens >= 1 ? 0 : Math.ceil(((1 - b.tokens) / b.rate) * 1000));
  const all = bucket(perSecond);
  const methods = new Map();
  const methodBucket = (m) => {
    let b = methods.get(m);
    if (!b) methods.set(m, (b = bucket(perMethodPerSecond)));
    refill(b);
    return b;
  };
  const queue = [];
  let timer = null,
    order = 0;
  const counts = { granted: 0, waited: 0, maxQueued: 0 };

  function pump() {
    timer = null;
    refill(all);
    queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
    // In priority order; a request whose method is used up waits without holding up other methods.
    for (let i = 0; i < queue.length && all.tokens >= 1; ) {
      const r = queue[i],
        b = methodBucket(r.method);
      if (b.tokens < 1) {
        i++;
        continue;
      }
      all.tokens--;
      b.tokens--;
      queue.splice(i, 1);
      counts.granted++;
      r.resolve();
    }
    if (queue.length && timer === null) {
      const next = Math.max(wait(all), Math.min(...queue.map((r) => wait(methodBucket(r.method)))));
      timer = setTimer(pump, Math.max(5, next));
    }
  }

  return {
    /** Resolves when a request for `method` at `priority` (PRIORITY) may go out. */
    acquire(method = "unknown", priority = PRIORITY.background) {
      return new Promise((resolve) => {
        const r = { method: String(method), priority, order: order++, resolve };
        queue.push(r);
        counts.maxQueued = Math.max(counts.maxQueued, queue.length);
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        pump();
        if (queue.includes(r)) counts.waited++;
      });
    },
    health: () => ({ perSecond, perMethodPerSecond, queued: queue.length, ...counts }),
  };
}

/** The JSON-RPC method of a request body (web3.js sends one call per request), for the limiter. */
export function rpcMethod(body) {
  try {
    const parsed = JSON.parse(typeof body === "string" ? body : "");
    return (Array.isArray(parsed) ? parsed[0]?.method : parsed?.method) ?? "unknown";
  } catch {
    return "unknown";
  }
}
