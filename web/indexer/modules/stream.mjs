// The live stream: GET /api/index/stream, Server-Sent Events from the live
// market store (modules/market-store.mjs) to open pages. Display data only:
// pages still verify a market on the chain before anything can be sent.
//
//   /api/index/stream?scope=list[&since=<epoch>-<seq>]
//   /api/index/stream?scope=market&pool=<address>[&since=…]
//
// A page connects with the position its server-rendered snapshot was taken at
// (`since`; EventSource's Last-Event-ID header wins on its own reconnects).
// It gets `hello`, then either what it missed (compacted from the store's ring
// buffer) or a full `snapshot`, then live frames: `market` (added / updated),
// `removed`, `stats`, `profile`, and on a market page `trade`. Every frame
// that moves the position carries `id: <epoch>-<seq>`, snapshots and pings
// included, so a quiet page resumes instead of starting over.
//
// Limits: at most 64 open streams and 120 new ones a minute per client address
// (the first X-Forwarded-For entry, which Caddy sets), 2,000 in all. A refused
// stream is answered 200 with `event: busy` and closed (EventSource cannot
// read a status code), and the page falls back to polling. Each connection
// gets its own reconnect delay (2–8 s) so reconnects after a restart spread
// out, full snapshots are paced, and streams end after 45–60 minutes to
// reconnect with Last-Event-ID. A client that reads slowly gets the latest
// state of what it missed once it catches up (never a backlog of stale
// updates), and is disconnected if it stays behind for 30 s or its buffer
// passes 1 MB.
export const STREAM_VERSION = 1;
export const PING_MS = 15_000;
export const STREAM_LIMITS = { perIp: 64, perIpPerMinute: 120, total: 2_000 };
export const CONGESTED_MS = 30_000;
export const MAX_BUFFERED_BYTES = 1 << 20;
export const MAX_QUEUED_TRADES = 100;
export const LIFETIME_MS = [45 * 60_000, 60 * 60_000];
export const RETRY_MS = [2_000, 8_000];
/** Busy refusals ask the browser to wait this long before its own retry. */
export const BUSY_RETRY_MS = [20_000, 40_000];
export const SNAPSHOTS_PER_SECOND = 50;
export const SNAPSHOT_BURST = 100;
/** Snapshots wait while all clients' unsent bytes together pass this. */
export const MAX_PENDING_BYTES = 16 << 20;

const isPool = (v) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);

/** The sequence number in a stream position (`<epoch>-<seq>`) of this epoch; null for another epoch or anything else. */
export function parseSince(value, epoch) {
  const m = /^([0-9a-z]{1,16})-(\d{1,15})$/.exec(String(value ?? "").trim());
  return m && m[1] === epoch ? Number(m[2]) : null;
}

/** One SSE frame's text. */
export const sseText = (event, data, id) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function streamServer({
  store,
  now = Date.now,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  every = setInterval,
  stopEvery = clearInterval,
  log = (...a) => console.error(...a),
  limits = {},
  pingMs = PING_MS,
}) {
  const lim = {
    ...STREAM_LIMITS,
    congestedMs: CONGESTED_MS,
    maxBuffered: MAX_BUFFERED_BYTES,
    maxTrades: MAX_QUEUED_TRADES,
    lifetimeMs: LIFETIME_MS,
    retryMs: RETRY_MS,
    busyRetryMs: BUSY_RETRY_MS,
    snapshotsPerSecond: SNAPSHOTS_PER_SECOND,
    snapshotBurst: SNAPSHOT_BURST,
    maxPendingBytes: MAX_PENDING_BYTES,
    ...limits,
  };
  const clients = new Set();
  const open = new Map(),
    recent = new Map();
  const counts = { busy: 0, destroyed: 0, snapshots: 0, replays: 0, bytes: 0, opened: 0 };
  const between = ([a, b]) => Math.round(a + random() * (b - a));
  const position = (seq = store.seq) => `${store.epoch}-${seq}`;
  const pingText = (withId) => sseText("ping", { seq: store.seq, t: now() }, withId ? position() : null);
  // The store serializes each frame once; every client gets that text.
  const frameText = (f) => `id: ${position(f.seq)}\nevent: ${f.event}\ndata: ${f.json ?? JSON.stringify({ seq: f.seq, t: f.t, ...f.data })}\n\n`;
  const matches = (c, f) => (c.scope === "market" ? f.scope !== "list" && f.pool === c.pool : f.scope !== "market");

  function cleanup(c) {
    if (c.closed) return;
    c.closed = true;
    clients.delete(c);
    clearTimer(c.lifetime);
    const n = (open.get(c.ip) ?? 1) - 1;
    if (n > 0) open.set(c.ip, n);
    else open.delete(c.ip);
  }
  function destroy(c, why) {
    counts.destroyed++;
    log(`live stream: disconnected a ${c.scope} client (${why})`);
    cleanup(c);
    c.res.destroy();
  }

  // Writes to a client; a full buffer marks it congested until 'drain'.
  function send(c, text) {
    if (c.closed) return false;
    const ok = c.res.write(text);
    counts.bytes += text.length;
    if (c.res.writableLength > lim.maxBuffered) {
      destroy(c, "too far behind");
      return false;
    }
    if (!ok && !c.congested) {
      c.congested = true;
      c.congestedAt = now();
      c.res.once("drain", () => drain(c));
    }
    return ok;
  }

  // What a congested client missed, as it is now, then a ping carrying the current position.
  function drain(c) {
    if (c.closed) return;
    c.congested = false;
    const parts = [];
    for (const pool of c.dirty) {
      const { event, data } = store.current(pool);
      parts.push(sseText(event, { seq: store.seq, t: now(), ...data }));
    }
    c.dirty.clear();
    for (const f of c.trades) parts.push(frameText(f));
    c.trades = [];
    const rows = c.dirtyStats ? store.statsRows() : null;
    if (rows) parts.push(sseText("stats", { seq: store.seq, t: now(), full: true, pools: c.scope === "market" ? rows.filter((r) => r.pool === c.pool) : rows }));
    c.dirtyStats = false;
    parts.push(pingText(true));
    send(c, parts.join(""));
  }

  function remember(c, f) {
    if (f.event === "trade") {
      c.trades.push(f);
      if (c.trades.length > lim.maxTrades) destroy(c, "too many trades behind");
    } else if (f.event === "stats") c.dirtyStats = true;
    else c.dirty.add(f.pool);
  }

  store.onFrame((f) => {
    let text = null;
    for (const c of clients) {
      if (c.waiting || c.closed || !matches(c, f)) continue;
      if (c.congested) remember(c, f);
      else send(c, (text ??= frameText(f)));
    }
  });

  // ---- Snapshots, paced ------------------------------------------------------
  const queue = [];
  let tokens = lim.snapshotBurst,
    refilledAt = now(),
    pumpTimer = null,
    listCache = null;
  function snapshotText(c) {
    if (c.scope === "list" && listCache?.seq === store.seq && listCache.epoch === store.epoch) return listCache.text;
    const text = sseText("snapshot", { scope: c.scope, ...store.snapshot(c.scope, c.pool) }, position());
    if (c.scope === "list") listCache = { seq: store.seq, epoch: store.epoch, text };
    return text;
  }
  function pump() {
    const t = now();
    tokens = Math.min(lim.snapshotBurst, tokens + ((t - refilledAt) / 1000) * lim.snapshotsPerSecond);
    refilledAt = t;
    let pending = 0;
    if (queue.length) for (const c of clients) pending += c.res.writableLength ?? 0;
    while (queue.length && tokens >= 1 && pending <= lim.maxPendingBytes) {
      const c = queue.shift();
      if (c.closed) continue;
      tokens--;
      counts.snapshots++;
      c.waiting = false;
      const text = snapshotText(c);
      pending += text.length;
      send(c, text);
    }
    if (queue.length && !pumpTimer)
      pumpTimer = setTimer(() => {
        pumpTimer = null;
        pump();
      }, 50);
  }
  store.onReady(() => {
    for (const c of clients) if (c.waiting && !c.queued) {
      c.queued = true;
      queue.push(c);
    }
    pump();
  });

  const pinger = every(() => {
    const withId = pingText(true),
      without = pingText(false);
    for (const c of [...clients]) {
      if (c.congested) {
        if (now() - c.congestedAt > lim.congestedMs) destroy(c, "stalled");
        continue;
      }
      // A client still waiting for its snapshot must not move its position.
      send(c, c.waiting ? without : withId);
    }
  }, pingMs);

  // Why a new stream from `ip` is refused, or null.
  function refusal(ip) {
    if (clients.size >= lim.total) return "busy";
    if ((open.get(ip) ?? 0) >= lim.perIp) return "too many streams";
    const t = now(),
      r = recent.get(ip);
    if (!r || t - r.start >= 60_000) recent.set(ip, { start: t, n: 1 });
    else if (++r.n > lim.perIpPerMinute) return "too many new streams";
    if (recent.size > 10_000) for (const [k, v] of recent) if (t - v.start >= 60_000) recent.delete(k);
    return null;
  }

  return {
    /** Serves one stream request (`ip`: the client's address). */
    handle(req, res, url, ip) {
      const q = url.searchParams;
      const scope = q.get("scope") ?? "list",
        pool = q.get("pool");
      if ((scope !== "list" && scope !== "market") || (scope === "market" && !isPool(pool))) {
        res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        return res.end(JSON.stringify({ error: "Bad request." }));
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      res.flushHeaders?.();
      req.socket?.setNoDelay?.(true);
      req.socket?.setKeepAlive?.(true, 30_000);
      req.socket?.setTimeout?.(0);
      const why = refusal(ip);
      if (why) {
        counts.busy++;
        const retryMs = between(lim.busyRetryMs);
        return res.end(`retry: ${retryMs}\n\n${sseText("busy", { retryMs, reason: why })}`);
      }
      const c = {
        res,
        ip,
        scope,
        pool: scope === "market" ? pool : null,
        waiting: true,
        queued: false,
        congested: false,
        congestedAt: 0,
        dirty: new Set(),
        dirtyStats: false,
        trades: [],
        closed: false,
        lifetime: null,
      };
      clients.add(c);
      counts.opened++;
      open.set(ip, (open.get(ip) ?? 0) + 1);
      res.on("close", () => cleanup(c));
      c.lifetime = setTimer(() => {
        cleanup(c);
        res.end();
      }, between(lim.lifetimeMs));
      const since = parseSince(req.headers["last-event-id"] ?? q.get("since"), store.epoch);
      const missed = store.ready && since !== null ? store.replay(since, scope, c.pool) : null;
      const hello = sseText("hello", {
        v: STREAM_VERSION,
        epoch: store.epoch,
        seq: store.seq,
        scope,
        ...(c.pool ? { pool: c.pool } : {}),
        ready: store.ready,
        resumed: !!missed,
        serverTime: now(),
        pingMs,
      });
      if (missed) {
        counts.replays++;
        c.waiting = false;
        const t = now();
        send(c, `retry: ${between(lim.retryMs)}\n\n${hello}${missed.map(({ event, data }) => sseText(event, { seq: store.seq, t, ...data })).join("")}${pingText(true)}`);
        return;
      }
      send(c, `retry: ${between(lim.retryMs)}\n\n${hello}`);
      if (store.ready) {
        c.queued = true;
        queue.push(c);
        pump();
      }
    },
    health: () => {
      let list = 0,
        congested = 0;
      for (const c of clients) {
        if (c.scope === "list") list++;
        if (c.congested) congested++;
      }
      return { clients: clients.size, list, market: clients.size - list, congested, queued: queue.length, ...counts };
    },
    close() {
      stopEvery(pinger);
      clearTimer(pumpTimer);
      for (const c of [...clients]) {
        cleanup(c);
        c.res.end();
      }
    },
  };
}
