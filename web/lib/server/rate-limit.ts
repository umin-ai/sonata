// Fixed-window request limits kept in memory, per client key and in total.
// Enough for a single-process server; counts reset when the process restarts.
export function createRateLimit(opts: { perKey: number; total: number; windowMs: number }) {
  const hits = new Map<string, { count: number; start: number }>();
  let total = { count: 0, start: 0 };
  return function allow(key: string, now = Date.now()) {
    if (now - total.start >= opts.windowMs) total = { count: 0, start: now };
    const entry = hits.get(key);
    const current = entry && now - entry.start < opts.windowMs ? entry : { count: 0, start: now };
    if (current.count >= opts.perKey || total.count >= opts.total) return false;
    current.count++;
    total.count++;
    hits.set(key, current);
    if (hits.size > 10_000)
      for (const [k, v] of hits) if (now - v.start >= opts.windowMs) hits.delete(k);
    return true;
  };
}

// The reverse proxy (Caddy) replaces X-Forwarded-For with the real client
// address, so its first entry identifies the client.
export function clientKey(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    "local"
  );
}
