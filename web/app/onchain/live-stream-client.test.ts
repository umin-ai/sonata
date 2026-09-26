// A page's live stream connection (live-stream-client.ts) against a fake
// EventSource and clock: reconnects, the watchdog, when it falls back to
// polling and when it stops, hidden tabs, and what it keeps.
import test from "node:test";
import assert from "node:assert/strict";
import { createLiveStream, FALLBACK_AFTER_MS, HIDDEN_CLOSE_MS, WATCHDOG_MS, type LiveStreamEnv } from "./live-stream-client.ts";
import type { MarketEvent, Snapshot } from "../../lib/live-events.ts";

type Listener = (e: MessageEvent) => void;
class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, Listener[]>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data: unknown, id = "") {
    this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data), lastEventId: id } as MessageEvent);
  }
  /** A network drop the browser retries itself (CONNECTING), or a failure it gives up on (CLOSED). */
  error(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}

function harness({ since = { epoch: "e1", seq: 5 }, scope = "list" as const, pool }: { since?: { epoch: string; seq: number } | null; scope?: "list" | "market"; pool?: string } = {}) {
  FakeSource.all = [];
  let t = 0;
  let timers: { at: number; fn: () => void }[] = [];
  let hidden = false;
  let onVis: (() => void) | null = null;
  const env: LiveStreamEnv = {
    EventSource: FakeSource as unknown as LiveStreamEnv["EventSource"],
    now: () => t,
    setTimeout: (fn, ms) => {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timers = timers.filter((x) => x !== timer);
    },
    random: () => 0.5,
    hidden: () => hidden,
    onVisibility: (fn) => ((onVis = fn), () => (onVis = null)),
  };
  const stream = createLiveStream({ scope, pool, since }, env);
  const statuses: string[] = [];
  stream.subscribe(() => statuses.at(-1) !== stream.status && statuses.push(stream.status));
  return {
    stream,
    statuses,
    source: () => FakeSource.all.at(-1)!,
    sources: () => FakeSource.all,
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at;
        timers = timers.filter((x) => x !== due);
        due.fn();
      }
      t = end;
    },
    setHidden(value: boolean) {
      hidden = value;
      onVis?.();
    },
  };
}
const hello = { v: 1, epoch: "e1", seq: 5, scope: "list", ready: true, resumed: true, serverTime: 0, pingMs: 15_000 };

test("no stream position, no stream: the page stays as it was", () => {
  const h = harness({ since: null });
  h.stream.start();
  assert.equal(h.sources().length, 0);
  assert.equal(h.stream.status, "off");
});

test("opens from the snapshot's position, goes live on hello, and reconnects from the last position after the browser gives up", () => {
  const h = harness();
  assert.equal(h.stream.status, "connecting");
  h.stream.start();
  assert.equal(h.source().url, "/api/index/stream?scope=list&since=e1-5");
  h.source().emit("hello", hello);
  assert.equal(h.stream.status, "live");
  h.source().emit("ping", { seq: 9 }, "e1-9");
  // The indexer restarts: Caddy answers 502 and EventSource stops for good.
  h.source().error(true);
  assert.equal(h.stream.status, "connecting");
  assert.equal(h.sources().length, 1);
  h.advance(1_000);
  assert.equal(h.sources().length, 2, "a new one after 1 s (0.7-1.3 s with jitter)");
  assert.equal(h.source().url, "/api/index/stream?scope=list&since=e1-9");
  h.source().error(true);
  h.advance(2_000);
  assert.equal(h.sources().length, 3, "then 2 s");
  h.source().emit("hello", { ...hello, epoch: "e2", resumed: false });
  assert.equal(h.stream.status, "live");
  // A network drop the browser retries itself is left to it.
  h.source().error(false);
  h.advance(10_000);
  assert.equal(h.sources().length, 3);
  assert.deepEqual(h.statuses, ["live", "connecting", "live", "connecting"]);
});

test("a restart's few seconds do not send the page to poll; a minute without a working stream does, and the first stream that works ends it", () => {
  const h = harness();
  h.stream.start();
  h.source().emit("hello", hello);
  h.source().error(true);
  h.advance(FALLBACK_AFTER_MS - 1);
  assert.equal(h.stream.status, "connecting", "still trying, not polling");
  const status = (): string => h.stream.status;
  for (let i = 0; i < 20 && status() !== "fallback"; i++) {
    h.source().error(true);
    h.advance(1_000);
  }
  assert.equal(h.stream.status, "fallback");
  const before = h.sources().length;
  h.advance(60_000);
  assert.ok(h.sources().length > before, "reconnects go on while polling");
  h.source().emit("hello", hello);
  assert.equal(h.stream.status, "live");
});

test("no event, not even a ping, for 40 s: the connection is taken for dead and replaced", () => {
  const h = harness();
  h.stream.start();
  h.source().emit("hello", hello);
  h.advance(WATCHDOG_MS - 1);
  assert.equal(h.sources().length, 1);
  h.source().emit("ping", { seq: 5 });
  h.advance(WATCHDOG_MS - 1);
  assert.equal(h.sources().length, 1, "a ping keeps it");
  h.advance(1);
  assert.equal(h.sources().length, 2);
  assert.equal(h.sources()[0].closed, true);
});

test("a `busy` refusal sends the page to poll at once, and waits at least as long as asked before trying again", () => {
  const h = harness();
  h.stream.start();
  h.source().emit("busy", { retryMs: 30_000, reason: "too many streams" });
  assert.equal(h.stream.status, "fallback");
  h.advance(29_999);
  assert.equal(h.sources().length, 1);
  h.advance(1);
  assert.equal(h.sources().length, 2);
});

test("a stream from a newer protocol is closed for good: the page polls until reloaded", () => {
  const h = harness();
  h.stream.start();
  h.source().emit("hello", { ...hello, v: 2 });
  assert.equal(h.stream.status, "fallback");
  assert.equal(h.source().closed, true);
  h.advance(10 * 60_000);
  assert.equal(h.sources().length, 1);
});

test("a tab hidden for a minute closes its stream and resumes from its position when shown", () => {
  const h = harness();
  h.stream.start();
  h.source().emit("hello", hello);
  h.source().emit("ping", { seq: 7 }, "e1-7");
  h.setHidden(true);
  // Pings keep coming while it is hidden.
  h.advance(HIDDEN_CLOSE_MS / 2);
  h.source().emit("ping", { seq: 7 });
  h.advance(HIDDEN_CLOSE_MS / 2 - 1);
  h.source().emit("ping", { seq: 7 });
  assert.equal(h.source().closed, false);
  h.advance(1);
  assert.equal(h.source().closed, true);
  h.advance(10 * 60_000);
  assert.equal(h.sources().length, 1, "nothing while hidden");
  h.setHidden(false);
  assert.equal(h.sources().length, 2);
  assert.equal(h.source().url, "/api/index/stream?scope=list&since=e1-7");
});

test("it keeps the pushed stats and profiles, hands events to the page, and counts snapshots", () => {
  const h = harness();
  const events: string[] = [];
  h.stream.on("market", (ev: MarketEvent) => events.push(`market ${ev.kind}`));
  h.stream.on("snapshot", (s: Snapshot) => events.push(`snapshot ${s.scope}`));
  h.stream.start();
  const pool = "EFMUmeNJcz8Z49c74sTrmKcPq3qQsdchjzjGGJtMHUwQ";
  const row = { pool, last_price: 1, price_24h_ago: null, volume_24h: "5", trades_24h: 2, trades_total: 3 };
  assert.equal(h.stream.stats(pool), undefined, "nothing known yet: the card loads its own");
  h.source().emit("hello", hello);
  h.source().emit("snapshot", { scope: "list", seq: 6, entries: [], skipped: 0, stats: [row], profiles: { "https://a/p.json": { image: "https://a/i.png" } } }, "e1-6");
  assert.equal(h.stream.resync, 1);
  assert.equal(h.stream.stats(pool)?.trades24h, 2);
  assert.equal(h.stream.stats("11111111111111111111111111111111"), null, "covered, no row: nothing to fetch");
  const profiles = (): Record<string, unknown> => h.stream.profiles;
  assert.deepEqual(profiles(), { "https://a/p.json": { image: "https://a/i.png" } });
  // A new market's stats and pending profile come with it; its profile later.
  const other = "6NhcSQHyze4MjXiAEEdzzyukaiR4kMwJpxCLNARJS7A7";
  h.source().emit("market", { pool: other, kind: "added", version: 9, entry: { market: { pool: other, uri: "https://a/q.json" }, data: null }, stats: { ...row, pool: other, trades_24h: 1 } });
  assert.equal(h.stream.stats(other)?.trades24h, 1);
  assert.equal(profiles()["https://a/q.json"], null, "known to be coming: the card does not fetch it");
  h.source().emit("profile", { pool: other, uri: "https://a/q.json", profile: { image: "https://a/j.png" } });
  assert.deepEqual(profiles()["https://a/q.json"], { image: "https://a/j.png" });
  h.source().emit("stats", { pool, stats: { ...row, trades_24h: 4 } });
  assert.equal(h.stream.stats(pool)?.trades24h, 4);
  assert.deepEqual(events, ["snapshot list", "market added"]);
  h.stream.stop();
  assert.equal(h.source().closed, true);
});

test("a snapshot without stats (the indexer has not loaded them yet) leaves the page's own", () => {
  const h = harness();
  h.stream.start();
  h.source().emit("hello", hello);
  h.source().emit("snapshot", { scope: "list", seq: 6, entries: [], skipped: 0, stats: null, profiles: {} }, "e1-6");
  assert.equal(h.stream.stats("EFMUmeNJcz8Z49c74sTrmKcPq3qQsdchjzjGGJtMHUwQ"), undefined);
});
