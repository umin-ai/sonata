// The live stream (stream.mjs) over the live market store with the app's
// decoder: framing, resume, scopes, pings, backpressure and limits.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { marketStore } from "./market-store.mjs";
import { parseSince, streamServer } from "./stream.mjs";
import { appDecode, bought, bySymbol, fakeRpc, fixture, manualClock, PROGRAM, readerOver } from "./livekit.mjs";

const decode = await appDecode();

function fakeRes({ accept = () => true } = {}) {
  const res = new EventEmitter();
  Object.assign(res, { chunks: [], status: null, headers: null, ended: false, destroyed: false, writableLength: 0, accept });
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.flushHeaders = () => {};
  res.write = (text) => {
    res.chunks.push(text);
    const ok = res.accept(text);
    if (!ok) res.writableLength += text.length;
    return ok;
  };
  res.end = (text) => {
    if (text) res.chunks.push(text);
    res.ended = true;
    res.emit("close");
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit("close");
  };
  /** The SSE frames written so far: { id, event, data, retry }. */
  res.frames = () =>
    res.chunks
      .join("")
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const f = {};
        for (const line of block.split("\n")) {
          const at = line.indexOf(": ");
          const [k, v] = [line.slice(0, at), line.slice(at + 2)];
          if (k === "data") f.data = JSON.parse(v);
          else f[k] = v;
        }
        return f;
      });
  res.events = () => res.frames().filter((f) => f.event).map((f) => f.event);
  return res;
}
const fakeReq = (headers = {}) => ({ headers, socket: { setNoDelay() {}, setKeepAlive() {}, setTimeout() {} } });

async function setup({ read: first = true, limits = {}, ...opts } = {}) {
  const chain = fakeRpc();
  const clock = manualClock();
  const store = marketStore({ decode, programId: PROGRAM, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, epoch: "e1", log: () => {} });
  const stream = streamServer({
    store,
    now: clock.now,
    random: () => 0.5,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    every: clock.every,
    stopEvery: clock.stopEvery,
    log: () => {},
    limits,
    ...opts,
  });
  const reader = readerOver(chain);
  const read = async () => store.decode(store.mergeRead(await reader.read(chain.conn)));
  if (first) {
    await read();
    clock.advance(1_000);
  }
  const connect = (query = "scope=list", { ip = "1.2.3.4", headers = {}, res = fakeRes() } = {}) => {
    stream.handle(fakeReq(headers), res, new URL(`http://x/api/index/stream?${query}`), ip);
    return res;
  };
  const poolChange = (symbol, slot) => {
    const m = bySymbol(symbol);
    chain.edit(m.pool, bought());
    const a = chain.accounts.get(m.pool);
    store.decode(store.patch([[m.pool, { owner: a.owner, lamports: a.lamports, executable: false, data: a.data[0], slot }]]));
  };
  return { chain, clock, store, stream, read, connect, poolChange };
}

test("a fresh connection: SSE headers, its own retry delay, hello, then a snapshot carrying its position", async () => {
  const { connect, store } = await setup();
  const res = connect();
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-cache, no-transform");
  const [retry, hello, snapshot] = res.frames();
  assert.equal(retry.retry, "5000", "between 2 and 8 s (random 0.5 here)");
  assert.equal(hello.event, "hello");
  assert.deepEqual({ ...hello.data, serverTime: 0 }, { v: 1, epoch: "e1", seq: store.seq, scope: "list", ready: true, resumed: false, serverTime: 0, pingMs: 15_000 });
  assert.equal(hello.id, undefined, "hello does not move the position");
  assert.equal(snapshot.event, "snapshot");
  assert.equal(snapshot.id, `e1-${store.seq}`);
  assert.equal(snapshot.data.entries.length, 4);
  assert.equal(snapshot.data.scope, "list");
  assert.equal(parseSince("e1-12", "e1"), 12);
  assert.equal(parseSince("e2-12", "e1"), null);
  assert.equal(parseSince("junk", "e1"), null);
});

test("a page that resumes within the buffer gets what it missed, compacted, and a ping with the new position; Last-Event-ID wins over since", async () => {
  const { connect, store, poolChange } = await setup();
  store.setStats([{ pool: bySymbol("FPT").pool, trades_24h: 1 }], { full: true });
  const since = store.seq;
  poolChange("BACKED", fixture.slot + 3);
  const res = connect("scope=list&since=e1-0", { headers: { "last-event-id": `e1-${since}` } });
  const frames = res.frames().slice(1);
  assert.equal(frames[0].data.resumed, true);
  assert.deepEqual(frames.slice(1).map((f) => f.event), ["market", "stats", "ping"]);
  assert.equal(frames[1].data.kind, "added");
  assert.equal(frames[1].data.pool, bySymbol("BACKED").pool);
  assert.equal(frames.at(-1).id, `e1-${store.seq}`);
  // Another epoch (the indexer restarted), or a position older than the buffer: a snapshot.
  for (const s of ["e0-5", "e1-junk"]) assert.deepEqual(connect(`scope=list&since=${s}`).events(), ["hello", "snapshot"]);
});

test("scopes: the list gets no trades; a market page gets only its market; a page for a market not listed yet gets it when it is", async () => {
  const [first, ...rest] = fixture.programAccounts.map((p) => p.pubkey);
  const { chain, connect, store, read, poolChange, clock } = await setup({ read: false });
  chain.treasuries = rest;
  await read();
  clock.advance(1_000);
  const backed = bySymbol("BACKED"),
    fpt = bySymbol("FPT");
  const newcomer = fixture.golden.markets.find((m) => m.treasury === first);
  const list = connect(),
    page = connect(`scope=market&pool=${backed.pool}`),
    waiting = connect(`scope=market&pool=${newcomer.pool}`);
  assert.equal(waiting.frames().at(-1).data.entry, null, "its snapshot: not listed yet");
  store.publishTrade({ pool: backed.pool, signature: "a", ix_index: 0 });
  store.publishTrade({ pool: fpt.pool, signature: "b", ix_index: 0 });
  poolChange("FPT", fixture.slot + 1);
  assert.deepEqual(list.events().slice(2), ["market"]);
  assert.equal(list.frames().at(-1).data.card.marketCap, store.entryOf(fpt.pool).data.marketCap);
  assert.deepEqual(page.events().slice(2), ["trade"]);
  assert.equal(page.frames().at(-1).data.trade.signature, "a");
  chain.treasuries = [first, ...rest];
  chain.slot++;
  await read();
  assert.deepEqual(waiting.events().slice(2), ["market"]);
  assert.equal(waiting.frames().at(-1).data.kind, "added");
  assert.equal(waiting.frames().at(-1).data.entry.market.pool, newcomer.pool);
  assert.equal(list.frames().at(-1).data.kind, "added");
});

test("before the first read a page waits with hello (ready: false) and id-less pings, then gets its snapshot", async () => {
  const { connect, clock, read } = await setup({ read: false });
  const res = connect();
  assert.deepEqual(res.events(), ["hello"]);
  assert.equal(res.frames()[1].data.ready, false);
  clock.advance(15_000);
  assert.deepEqual(res.events(), ["hello", "ping"]);
  assert.equal(res.frames().at(-1).id, undefined, "a waiting page's position does not move");
  await read();
  assert.deepEqual(res.events(), ["hello", "ping", "snapshot"]);
  clock.advance(15_000);
  assert.match(res.frames().at(-1).id, /^e1-\d+$/, "pings carry the position once it has its snapshot");
});

test("a client that reads slowly gets the latest state of what it missed when it catches up; one too far behind is disconnected", async () => {
  const { connect, store, poolChange, clock } = await setup();
  let open = true;
  const res = connect("scope=list", { res: fakeRes({ accept: () => open }) });
  open = false;
  poolChange("BACKED", fixture.slot + 1);
  const written = res.chunks.length;
  clock.advance(1_000);
  poolChange("BACKED", fixture.slot + 2);
  clock.advance(1_000);
  assert.equal(res.chunks.length, written, "nothing written while its buffer is full");
  open = true;
  res.writableLength = 0;
  res.emit("drain");
  const tail = res.frames().slice(-2);
  assert.deepEqual(tail.map((f) => f.event), ["market", "ping"]);
  assert.equal(tail[0].data.entry.data.marketCap, store.entryOf(bySymbol("BACKED").pool).data.marketCap, "the latest numbers");
  assert.equal(tail[1].id, `e1-${store.seq}`);
  // Behind for more than 30 s: disconnected at the next ping.
  open = false;
  poolChange("BACKED", fixture.slot + 3);
  clock.advance(1_000);
  clock.advance(45_000);
  assert.equal(res.destroyed, true);
  // A market page more than 100 trades behind is disconnected; so is a buffer over 1 MB.
  const page = connect(`scope=market&pool=${bySymbol("FPT").pool}`, { res: fakeRes({ accept: () => false }) });
  for (let i = 0; i <= 100; i++) store.publishTrade({ pool: bySymbol("FPT").pool, signature: String(i), ix_index: 0 });
  assert.equal(page.destroyed, true);
  // A write that leaves more than 1 MB unsent (a snapshot to a client that stopped reading).
  const stuck = fakeRes({ accept: () => false });
  stuck.writableLength = 2 << 20;
  connect("scope=list", { res: stuck });
  assert.equal(stuck.destroyed, true);
});

test("limits: 64 streams per address, 120 new ones a minute, 2,000 in all; a refusal is a 200 with `busy`, then the end", async () => {
  const { connect, clock, stream } = await setup({ limits: { total: 70 } });
  const opened = Array.from({ length: 64 }, () => connect());
  const refused = connect();
  assert.equal(refused.status, 200);
  assert.deepEqual(refused.events(), ["busy"]);
  assert.equal(refused.ended, true);
  assert.equal(refused.frames()[1].data.reason, "too many streams");
  assert.ok(Number(refused.frames()[0].retry) >= 20_000);
  // Another address may still connect, up to the total.
  for (let i = 0; i < 6; i++) assert.deepEqual(connect("scope=list", { ip: "5.6.7.8" }).events(), ["hello", "snapshot"]);
  assert.equal(connect("scope=list", { ip: "9.9.9.9" }).frames()[1].data.reason, "busy");
  assert.equal(stream.health().clients, 70);
  // Closed streams free their place; but more than 120 new ones a minute from one address are refused.
  for (const r of opened) r.emit("close");
  let busy = 0;
  for (let i = 0; i < 60; i++) {
    const r = connect("scope=list", { ip: "1.2.3.4" });
    if (r.events()[0] === "busy") busy++;
    r.emit("close");
  }
  // 64 counted before (the refused one was not), so 56 more fit in this minute's 120.
  assert.equal(busy, 4);
  clock.advance(60_000);
  assert.deepEqual(connect().events(), ["hello", "snapshot"]);
  // Bad parameters are a plain 400.
  assert.equal(connect("scope=market&pool=nope").status, 400);
  assert.equal(connect("scope=all").status, 400);
});

test("snapshots after a restart are paced; streams end after 45–60 minutes", async () => {
  const { connect, clock } = await setup({ limits: { snapshotBurst: 5, snapshotsPerSecond: 10, perIp: 1_000 } });
  const all = Array.from({ length: 8 }, (_, i) => connect("scope=list", { ip: `10.0.0.${i}` }));
  assert.equal(all.filter((r) => r.events().includes("snapshot")).length, 5);
  clock.advance(300);
  assert.equal(all.filter((r) => r.events().includes("snapshot")).length, 8);
  clock.advance(52.5 * 60_000);
  assert.ok(all.every((r) => r.ended));
});

test("over real HTTP: flushed at once, no compression, framed as SSE", async () => {
  const { store } = await setup();
  const stream = streamServer({ store, log: () => {} });
  const server = http.createServer((req, res) => stream.handle(req, res, new URL(req.url, "http://x"), "127.0.0.1"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const started = performance.now();
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/index/stream?scope=list`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(r.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(r.headers.get("content-encoding"), null);
    const reader = r.body.getReader();
    let text = "";
    while (!text.includes("event: snapshot")) text += new TextDecoder().decode((await reader.read()).value);
    assert.ok(performance.now() - started < 1_000);
    assert.match(text, /^retry: \d+\n\nevent: hello\ndata: \{/);
    assert.match(text, /\nid: e1-\d+\nevent: snapshot\ndata: \{/);
    await reader.cancel();
  } finally {
    stream.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
