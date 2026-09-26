// End-to-end timing of live push without touching the chain: a fake Devnet
// RPC over the app's capture of four markets (lib/treasury/fixtures), the
// indexer's own live push (reader, store, 1 s poll, stream) pointed at it, and
// SSE clients on the stream. It then launches markets (a new treasury and its
// accounts, plus a new transaction on the treasury program) and trades
// (a pool's reserve and price change), and reports how long each took to
// reach the clients.
//
//   node --experimental-strip-types --no-warnings --import ./scripts/test-register.mjs \
//     scripts/replay-live.mjs [--clients 20] [--launches 10] [--trades 30] [--rpc-ms 100] [--serve 8795]
//
// --rpc-ms is each RPC call's simulated latency (public Devnet answered
// getProgramAccounts in 52–125 ms and getSignaturesForAddress in about 110 ms
// in testing). With --serve PORT it keeps running afterwards and serves
// /api/index/accounts and /api/index/stream there (everything else under
// /api/index is forwarded to the hosted indexer), plus POST
// /control/trade[?symbol=FPT|pool=…] and /control/launch[?pool=…], for trying
// a local app against it
// (wrangler dev ... --var INDEXER_URL:http://127.0.0.1:PORT/api/index).
import http from "node:http";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { marketAccountsReader } from "../indexer/modules/market-accounts.mjs";
import { marketStore } from "../indexer/modules/market-store.mjs";
import { livePush } from "../indexer/modules/live.mjs";
import { streamServer } from "../indexer/modules/stream.mjs";
import { PRIORITY, rpcLimiter, rpcMethod } from "../indexer/modules/rpc-limiter.mjs";
import { snapshotFromAccounts } from "../lib/treasury/snapshot-decode.ts";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const CLIENTS = arg("clients", 20),
  LAUNCHES = arg("launches", 10),
  TRADES = arg("trades", 30),
  RPC_MS = arg("rpc-ms", 100),
  SERVE = arg("serve", 0);
const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const fixture = json("../lib/treasury/fixtures/devnet-markets.json");
const idl = json("../lib/treasury/stockroom_treasury.json");
const PROGRAM = fixture.treasuryProgram;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The fake chain ------------------------------------------------------------
const started = Date.now();
// Devnet moves about 2.5 slots a second; far ahead of real Devnet, so a browser's own read never looks newer.
const slotNow = () => 900_000_000 + Math.floor((Date.now() - started) / 400);
const accounts = new Map(Object.entries(fixture.accounts));
for (const m of fixture.golden.markets) {
  const damm = fixture.golden.treasuries[m.pool].dammPool;
  if (damm) accounts.set(damm, { owner: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", lamports: 1, executable: false, data: [Buffer.alloc(16).toString("base64"), "base64"] });
}
const treasuries = fixture.programAccounts.map((p) => p.pubkey);
const signatures = [];
const edit = (key, fn) => {
  const a = accounts.get(key);
  const d = Buffer.from(a.data[0], "base64");
  fn(d);
  accounts.set(key, { ...a, data: [d.toString("base64"), "base64"] });
};
const land = () => {
  const signature = Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58().slice(0, 20);
  signatures.unshift({ signature, slot: slotNow(), err: null, memo: null, blockTime: Math.floor(Date.now() / 1000), confirmationStatus: "confirmed" });
  signatures.length = Math.min(signatures.length, 50);
};

/** A trade on a curve market: more quote in the curve and a higher price, as after a buy. */
function trade(pool) {
  edit(pool, (d) => {
    d.writeBigUInt64LE(d.readBigUInt64LE(240) + 1_000_000n, 240);
    const price = (d.readBigUInt64LE(288) << 64n) | d.readBigUInt64LE(280);
    const next = price + price / 200n;
    d.writeBigUInt64LE(next & ((1n << 64n) - 1n), 280);
    d.writeBigUInt64LE(next >> 64n, 288);
  });
}

/**
 * A launch: a copy of a fixture market under a new pool (its treasury the
 * pool's PDA, its custody account owned by that treasury, activation now), as
 * the three launch transactions leave it; then a transaction on the treasury
 * program, as its registration is.
 */
function launch(poolKey = null, template = fixture.golden.markets.find((m) => m.symbol === "BACKED")) {
  const pool = poolKey ? new PublicKey(poolKey) : Keypair.generate().publicKey;
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), pool.toBuffer()], new PublicKey(PROGRAM));
  const custody = getAssociatedTokenAddressSync(new PublicKey(template.quoteMint), treasury, true, TOKEN_2022_PROGRAM_ID);
  const copy = (from, to, fn) => {
    const a = accounts.get(from);
    const d = Buffer.from(a.data[0], "base64");
    fn(d);
    accounts.set(to.toBase58(), { ...a, data: [d.toString("base64"), "base64"] });
  };
  copy(template.pool, pool, (d) => d.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 296));
  copy(template.treasury, treasury, (d) => pool.toBuffer().copy(d, 8));
  copy(template.treasuryQuote, custody, (d) => treasury.toBuffer().copy(d, 32));
  treasuries.push(treasury.toBase58());
  land();
  return pool.toBase58();
}

const toRpc = (a) => a && { data: a.data, executable: a.executable, lamports: a.lamports, owner: a.owner, rentEpoch: 0, space: Buffer.from(a.data[0], "base64").length };
const rpcCalls = new Map();
const rpc = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { id, method, params = [] } = JSON.parse(body);
  rpcCalls.set(method, (rpcCalls.get(method) ?? 0) + 1);
  await sleep(Math.max(0, RPC_MS * (0.6 + 0.8 * Math.random())));
  const slot = slotNow();
  const config = params.find((p) => p && typeof p === "object" && !Array.isArray(p)) ?? {};
  const answer = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  if (config.minContextSlot && slot < config.minContextSlot)
    return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32016, message: "Minimum context slot has not been reached" } }));
  if (method === "getGenesisHash") return answer(fixture.genesis);
  if (method === "getProgramAccounts") {
    const slice = config.dataSlice;
    const value = treasuries.map((pubkey) => {
      const a = toRpc(accounts.get(pubkey));
      if (!slice) return { pubkey, account: a };
      const d = Buffer.from(a.data[0], "base64").subarray(slice.offset, slice.offset + slice.length);
      return { pubkey, account: { ...a, data: [d.toString("base64"), "base64"] } };
    });
    return answer(config.withContext ? { context: { slot }, value } : value);
  }
  if (method === "getMultipleAccounts") {
    const slice = config.dataSlice;
    const value = params[0].map((k) => {
      const a = toRpc(accounts.get(k) ?? null);
      if (!a || !slice) return a;
      const d = Buffer.from(a.data[0], "base64").subarray(slice.offset, slice.offset + slice.length);
      return { ...a, data: [d.toString("base64"), "base64"] };
    });
    return answer({ context: { slot }, value });
  }
  if (method === "getSignaturesForAddress") return answer(params[0] === PROGRAM ? signatures.slice(0, config.limit ?? 1000) : []);
  if (method === "getSlot") return answer(slot);
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `fake RPC: no ${method}` } }));
});
await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
const RPC_URL = `http://127.0.0.1:${rpc.address().port}`;

// ---- The indexer's live push, as indexer/index.mjs wires it ---------------------
// Every call through one request budget, each part at its priority.
const limiter = rpcLimiter();
const timed = (ms, priority = PRIORITY.background) =>
  new Connection(RPC_URL, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: async (i, init) => {
      await limiter.acquire(rpcMethod(init?.body), priority);
      return fetch(i, { ...init, signal: AbortSignal.timeout(ms) });
    },
  });
let push = null;
const reader = marketAccountsReader({
  conn: timed(4_000, PRIORITY.reader),
  programId: PROGRAM,
  discriminator: idl.accounts.find((a) => a.name === "Treasury").discriminator,
  quoteMints: new Set(json("../lib/treasury/quote-assets.json").assets.map((a) => a.mint)),
  log: () => {},
  onRead: (read) => push?.onRead(read),
});
const store = marketStore({ decode: snapshotFromAccounts, programId: PROGRAM, log: () => {} });
push = livePush({
  store,
  reader,
  conn: timed(2_500, PRIORITY.poll),
  readConn: timed(2_500, PRIORITY.live),
  programId: PROGRAM,
  log: (...a) => console.error("live:", ...a),
});
const stream = streamServer({ store, log: () => {} });
await reader.tick();
setInterval(reader.tick, 10_000).unref();
push.start();

const UPSTREAM = "https://sonata.umin.ai/api/index";
const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/control/launch") return res.end(JSON.stringify({ pool: launch(url.searchParams.get("pool")) }));
  if (req.method === "POST" && url.pathname === "/control/trade") {
    const pool = url.searchParams.get("pool") ?? fixture.golden.markets.find((m) => m.symbol === (url.searchParams.get("symbol") ?? "FPT")).pool;
    trade(pool);
    return res.end(JSON.stringify({ pool }));
  }
  if (url.pathname === "/api/index/stream") return stream.handle(req, res, url, "127.0.0.1");
  if (url.pathname === "/api/index/accounts") {
    const view = store.view();
    res.writeHead(view ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(view ?? JSON.stringify({ error: "Not read yet." }));
  }
  if (url.pathname === "/api/index/health") return res.end(JSON.stringify({ ok: true, live: { ...push.health(), stream: stream.health() } }));
  try {
    const r = await fetch(UPSTREAM + url.pathname.slice("/api/index".length) + url.search, { signal: AbortSignal.timeout(10_000) });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(await r.text());
  } catch {
    res.writeHead(502).end();
  }
});
await new Promise((r) => api.listen(SERVE || 0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${api.address().port}`;

// ---- SSE clients ---------------------------------------------------------------------
const arrivals = []; // { client, scope, event, pool, kind, at }
async function client(n, scope, pool) {
  const r = await fetch(`${BASE}/api/index/stream?scope=${scope}${pool ? `&pool=${pool}` : ""}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const at = performance.now();
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      const d = JSON.parse(data);
      arrivals.push({ client: n, scope, event, pool: d.pool, kind: d.kind, at });
    }
  }
}
const backed = fixture.golden.markets.find((m) => m.symbol === "BACKED").pool;
const curve = fixture.golden.markets.filter((m) => !fixture.golden.treasuries[m.pool].migrated).map((m) => m.pool);
for (let i = 0; i < CLIENTS; i++) void client(i, "list");
for (let i = 0; i < CLIENTS; i++) void client(CLIENTS + i, "market", backed);
await sleep(1_500);

// ---- Launches and trades, spaced so the list's 1 s throttle and the poll phase vary ----
const results = { launch: [], tradeMarket: [], tradeList: [] };
const firstAfter = (t0, match) => {
  const byClient = new Map();
  for (const a of arrivals) if (a.at >= t0 && match(a) && !byClient.has(a.client)) byClient.set(a.client, a.at - t0);
  return [...byClient.values()];
};
for (let i = 0; i < LAUNCHES; i++) {
  const t0 = performance.now();
  const pool = launch();
  await sleep(3_000 + Math.random() * 1_000);
  const got = firstAfter(t0, (a) => a.scope === "list" && a.event === "market" && a.kind === "added" && a.pool === pool);
  if (got.length < CLIENTS) console.error(`launch ${i}: ${got.length}/${CLIENTS} clients got it`);
  results.launch.push(...got);
}
for (let i = 0; i < TRADES; i++) {
  const pool = i % 2 ? backed : curve[i % curve.length];
  const t0 = performance.now();
  trade(pool);
  await sleep(2_200 + Math.random() * 800);
  if (pool === backed) results.tradeMarket.push(...firstAfter(t0, (a) => a.scope === "market" && a.event === "market" && a.pool === pool));
  results.tradeList.push(...firstAfter(t0, (a) => a.scope === "list" && a.event === "market" && a.kind === "updated" && a.pool === pool));
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : null;
};
const line = (label, xs) => console.log(`${label.padEnd(34)} n=${String(xs.length).padStart(4)}  p50=${pct(xs, 0.5)} ms  p95=${pct(xs, 0.95)} ms  max=${pct(xs, 1)} ms`);
console.log(`\nlive push replay: ${CLIENTS} list + ${CLIENTS} market clients, RPC latency ~${RPC_MS} ms, poll 1 s`);
line("launch -> `added` on the list", results.launch);
line("trade -> market page update", results.tradeMarket);
line("trade -> market list update", results.tradeList);
console.log("RPC calls:", Object.fromEntries(rpcCalls));
console.log("health:", JSON.stringify(push.health().pollMs), JSON.stringify(stream.health()));
console.log("request budget:", JSON.stringify(limiter.health()));
if (!SERVE) {
  await push.stop();
  stream.close();
  api.closeAllConnections();
  process.exit(0);
}
console.log(`serving on ${BASE}/api/index (POST ${BASE}/control/launch, ${BASE}/control/trade?symbol=FPT)`);
