// One page's connection to the indexer's live stream (/api/index/stream), as a
// small store without React, so its rules are tested (live-stream-client.test.ts):
//
// - It opens only for a page whose server snapshot carried a stream position
//   (`since`); without one it stays "off" and the page behaves as before.
// - EventSource reconnects by itself after a network drop (and resumes with
//   Last-Event-ID). When the browser gives up (the connection was refused, or
//   the indexer restarted), a new one is made from the last position, after
//   1, 2, 4 … 30 s with jitter. No event, not even a ping, for 40 s counts as
//   a dead connection.
// - The page falls back to polling (status "fallback") only after 60 s without
//   a working stream, or at once when the indexer refuses it (`busy`); a
//   restart's few seconds do not send every page to poll. Reconnects go on
//   meanwhile, at most a minute apart, and the first that works ends it.
// - It is live once the indexer has data to send: a `hello` from an indexer
//   that has not read the chain yet (just restarted) keeps it connecting, so
//   the page still falls back if that lasts a minute.
// - A stream from a newer protocol (hello.v) is closed for good: the page
//   polls until it is reloaded. An indexer with live push turned off answers
//   `off`: the page closes it for good and stays as pages were before live
//   push (status "off").
// - A tab hidden for a minute closes its stream, and resumes when shown.
//
// Pushed data is for display only: nothing here enables an action.
import type { ProfileBody, StreamPosition } from "@/lib/treasury/market-snapshot";
import { statsRow, type PoolStats } from "@/lib/market-data";
import {
  STREAM_VERSION,
  type MarketEvent,
  type ProfileEvent,
  type RemovedEvent,
  type Snapshot,
  type StatsEvent,
  type TradeEvent,
} from "@/lib/live-events";

export type StreamStatus = "off" | "connecting" | "live" | "fallback";
export const WATCHDOG_MS = 40_000;
export const FALLBACK_AFTER_MS = 60_000;
export const HIDDEN_CLOSE_MS = 60_000;
export const BACKOFF_MS = [1_000, 30_000] as const;
export const FALLBACK_RECONNECT_MS = 60_000;

type EventSourceLike = {
  readyState: number;
  close(): void;
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  onerror: ((e: Event) => void) | null;
};
export type LiveStreamEnv = {
  EventSource?: new (url: string) => EventSourceLike;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  random: () => number;
  /** Whether the page is hidden, and a way to hear when that changes. */
  hidden?: () => boolean;
  onVisibility?: (fn: () => void) => () => void;
};
export type LiveStreamOptions = {
  scope: "list" | "market";
  pool?: string;
  since: StreamPosition | null;
  url?: string;
  /** Log each event and how long after the indexer wrote it it arrived (?liveDebug=1). */
  debug?: boolean;
};
export type LiveHandlers = {
  market: (ev: MarketEvent) => void;
  removed: (ev: RemovedEvent) => void;
  snapshot: (ev: Snapshot) => void;
  trade: (ev: TradeEvent) => void;
};
const CLOSED = 2;

function browserEnv(): LiveStreamEnv {
  const w = typeof window === "undefined" ? undefined : window;
  return {
    EventSource: w && "EventSource" in w ? (w.EventSource as unknown as LiveStreamEnv["EventSource"]) : undefined,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    random: Math.random,
    hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    onVisibility: (fn) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}

export type LiveStream = ReturnType<typeof createLiveStream>;

export function createLiveStream(options: LiveStreamOptions, env: LiveStreamEnv = browserEnv()) {
  const initialStatus: StreamStatus = options.since ? "connecting" : "off";
  let status: StreamStatus = initialStatus;
  let lastId = options.since ? `${options.since.epoch}-${options.since.seq}` : "";
  let es: EventSourceLike | null = null;
  let running = false,
    dead = false,
    paused = false,
    attempt = 0,
    failingSince: number | null = null,
    lastEventAt = 0,
    resync = 0,
    // The indexer's clock minus ours, from hello (for ?liveDebug=1's timings).
    skew = 0;
  let reconnectTimer: unknown = null,
    watchdogTimer: unknown = null,
    hiddenTimer: unknown = null,
    fallbackTimer: unknown = null,
    offVisibility: (() => void) | null = null;
  let stats = new Map<string, PoolStats>(),
    statsFull = false;
  let profiles: Record<string, ProfileBody | null> = {};
  const listeners = new Set<() => void>();
  const handlers: { [K in keyof LiveHandlers]: Set<LiveHandlers[K]> } = {
    market: new Set(),
    removed: new Set(),
    snapshot: new Set(),
    trade: new Set(),
  };
  const notify = () => listeners.forEach((fn) => fn());
  const setStatus = (next: StreamStatus) => {
    if (status === next) return;
    status = next;
    notify();
  };
  const clear = (timer: unknown) => {
    if (timer !== null) env.clearTimeout(timer);
    return null;
  };

  const url = () => {
    const q = new URLSearchParams({ scope: options.scope });
    if (options.pool) q.set("pool", options.pool);
    if (lastId) q.set("since", lastId);
    return `${options.url ?? "/api/index/stream"}?${q}`;
  };

  function close() {
    watchdogTimer = clear(watchdogTimer);
    if (!es) return;
    es.onerror = null;
    es.close();
    es = null;
  }

  // A working stream: the page stops counting towards the fallback.
  function working() {
    failingSince = null;
    fallbackTimer = clear(fallbackTimer);
    setStatus("live");
  }

  // No working stream since `failingSince`: past a minute, the page polls.
  function fail() {
    failingSince ??= env.now();
    if (status === "live") setStatus("connecting");
    if (fallbackTimer === null && status !== "fallback")
      fallbackTimer = env.setTimeout(() => {
        fallbackTimer = null;
        if (failingSince !== null && running) setStatus("fallback");
      }, Math.max(0, failingSince + FALLBACK_AFTER_MS - env.now()));
  }

  function scheduleReconnect(atLeast = 0) {
    reconnectTimer = clear(reconnectTimer);
    if (!running || dead) return;
    const cap = status === "fallback" ? FALLBACK_RECONNECT_MS : BACKOFF_MS[1];
    const base = Math.min(cap, BACKOFF_MS[0] * 2 ** attempt);
    attempt++;
    const delay = Math.max(atLeast, base * (0.7 + 0.6 * env.random()));
    reconnectTimer = env.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function armWatchdog() {
    watchdogTimer = clear(watchdogTimer);
    watchdogTimer = env.setTimeout(() => {
      watchdogTimer = null;
      close();
      fail();
      connect();
    }, WATCHDOG_MS);
  }

  const parse = (e: MessageEvent) => {
    try {
      return JSON.parse(String(e.data));
    } catch {
      return null;
    }
  };
  const setRow = (row: unknown) => {
    const s = statsRow(row);
    if (s) stats.set(s.pool, s);
  };

  function onEvent(type: string, e: MessageEvent) {
    lastEventAt = env.now();
    armWatchdog();
    if (e.lastEventId) lastId = e.lastEventId;
    const data = parse(e);
    if (!data || typeof data !== "object") return;
    if (options.debug) {
      if (type === "hello" && typeof data.serverTime === "number") skew = data.serverTime - env.now();
      const lag = typeof data.t === "number" ? ` ${Math.round(env.now() + skew - data.t)} ms after the indexer wrote it` : "";
      console.debug(`[live] ${type}${data.pool ? ` ${data.pool}` : ""}${data.kind ? ` ${data.kind}` : ""}${lag}`);
    }
    switch (type) {
      case "hello":
        if (data.v !== STREAM_VERSION) {
          // A protocol this build does not know: poll until the page is reloaded.
          dead = true;
          close();
          setStatus("fallback");
          return;
        }
        // Connected: the next failure starts the backoff over.
        attempt = 0;
        // An indexer that has not read the chain yet sends nothing until it has: not live yet.
        if (data.ready !== true) fail();
        else working();
        return;
      case "off":
        // Live push is off at the indexer: closed for good, the page as before live push.
        dead = true;
        close();
        fallbackTimer = clear(fallbackTimer);
        setStatus("off");
        return;
      case "busy":
        close();
        fail();
        setStatus("fallback");
        scheduleReconnect(Number(data.retryMs) || 0);
        return;
      case "snapshot": {
        working();
        const snap = data as Snapshot;
        if (snap.scope === "list") {
          // Without stats (the indexer has not loaded them yet) the page keeps its server snapshot's.
          if (Array.isArray(snap.stats)) {
            stats = new Map();
            statsFull = true;
            snap.stats.forEach(setRow);
          }
          profiles = { ...profiles, ...snap.profiles };
        } else {
          if (snap.stats) setRow(snap.stats);
          if (snap.entry?.market.uri && snap.profile !== undefined) profiles = { ...profiles, [snap.entry.market.uri]: snap.profile };
        }
        resync++;
        notify();
        handlers.snapshot.forEach((fn) => fn(snap));
        return;
      }
      case "market": {
        const ev = data as MarketEvent;
        if (ev.kind === "added") {
          if (ev.stats) setRow(ev.stats);
          const uri = ev.entry?.market?.uri;
          if (uri && ev.profile !== undefined) profiles = { ...profiles, [uri]: ev.profile };
          else if (uri && !Object.hasOwn(profiles, uri)) profiles = { ...profiles, [uri]: null };
          notify();
        }
        handlers.market.forEach((fn) => fn(ev));
        return;
      }
      case "removed":
        handlers.removed.forEach((fn) => fn(data as RemovedEvent));
        return;
      case "trade":
        handlers.trade.forEach((fn) => fn(data as TradeEvent));
        return;
      case "stats": {
        const ev = data as StatsEvent;
        if (ev.full && Array.isArray(ev.pools)) {
          if (options.scope === "list") {
            stats = new Map();
            statsFull = true;
          }
          ev.pools.forEach(setRow);
        } else if (ev.stats) setRow(ev.stats);
        notify();
        return;
      }
      case "profile": {
        const ev = data as ProfileEvent;
        profiles = { ...profiles, [ev.uri]: ev.profile };
        notify();
        return;
      }
    }
  }

  function connect() {
    reconnectTimer = clear(reconnectTimer);
    close();
    if (!running || dead || paused) return;
    if (!env.EventSource) {
      setStatus("fallback");
      return;
    }
    const source = new env.EventSource(url());
    es = source;
    for (const type of ["hello", "snapshot", "market", "removed", "trade", "stats", "profile", "ping", "busy", "off"])
      source.addEventListener(type, (e) => {
        if (es === source) onEvent(type, e);
      });
    source.onerror = () => {
      if (es !== source) return;
      fail();
      // The browser gave up (a refused or failed response): make a new one later.
      if (source.readyState === CLOSED) {
        close();
        scheduleReconnect();
      }
    };
    armWatchdog();
  }

  function onVisibility() {
    if (!running) return;
    if (env.hidden?.()) {
      hiddenTimer ??= env.setTimeout(() => {
        hiddenTimer = null;
        paused = true;
        reconnectTimer = clear(reconnectTimer);
        close();
      }, HIDDEN_CLOSE_MS);
      return;
    }
    hiddenTimer = clear(hiddenTimer);
    if (paused) {
      paused = false;
      connect();
    } else if (es && env.now() - lastEventAt > WATCHDOG_MS) connect();
  }

  return {
    initialStatus,
    get status() {
      return status;
    },
    /** How many full snapshots arrived: trades and charts load again after one (the stream could not resume). */
    get resync() {
      return resync;
    },
    get profiles() {
      return profiles;
    },
    /** A pool's pushed 24h stats: its row; null when the stream's full stats have none for it; undefined before any. */
    stats(pool: string): PoolStats | null | undefined {
      return stats.get(pool) ?? (statsFull ? null : undefined);
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    on<K extends keyof LiveHandlers>(kind: K, fn: LiveHandlers[K]) {
      handlers[kind].add(fn);
      return () => void handlers[kind].delete(fn);
    },
    start() {
      if (running || !options.since) return;
      running = true;
      paused = false;
      offVisibility = env.onVisibility?.(onVisibility) ?? null;
      connect();
      // Opened in a background tab: closed after a minute unless shown.
      if (env.hidden?.()) onVisibility();
    },
    stop() {
      running = false;
      reconnectTimer = clear(reconnectTimer);
      hiddenTimer = clear(hiddenTimer);
      fallbackTimer = clear(fallbackTimer);
      close();
      offVisibility?.();
      offVisibility = null;
    },
  };
}
