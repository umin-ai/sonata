// Local stand-in for the indexer's /api/index/accounts, for developing the
// server-rendered market list without a local indexer and database. It runs
// the indexer's own reader (indexer/modules/market-accounts.mjs) every 10
// seconds and forwards every other /api/index/* path to INDEXER_URL (default:
// the hosted indexer), so charts and stats keep working. Read-only.
//
//   SOLANA_RPC_URL=<devnet rpc> node scripts/dev-market-accounts.mjs [port]
//
// then point the app at it (e.g. in .env.local): INDEXER_URL=http://127.0.0.1:8793/api/index
// Public Devnet is the default RPC; from some addresses it leaves account reads
// unanswered, so pass a provider URL or the site's relay if reads time out.
//
// With LIVE_PUSH=1 it also runs the indexer's live push (the 1 s poll, the live
// store and /api/index/stream; no database, so no trade rows or stats of its
// own), and /api/index/health shows its timings. Node needs type stripping:
//
//   LIVE_PUSH=1 node --experimental-strip-types --no-warnings scripts/dev-market-accounts.mjs [port]
import http from "node:http";
import { readFileSync } from "node:fs";
import { Connection } from "@solana/web3.js";
import { MARKET_ACCOUNTS_INTERVAL_MS, marketAccountsReader } from "../indexer/modules/market-accounts.mjs";
import { startLivePush } from "../indexer/index.mjs";

const PORT = Number(process.argv[2] || process.env.PORT || 8793);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const UPSTREAM = (process.env.INDEXER_URL || "https://sonata.umin.ai/api/index").replace(/\/+$/, "");
const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const idl = json("../lib/treasury/stockroom_treasury.json");

const timed = (ms) =>
  new Connection(RPC, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) }),
  });
let live = null;
const accounts = marketAccountsReader({
  conn: timed(8_000),
  onRead: (read) => live?.push.onRead(read),
  programId: idl.address,
  discriminator: idl.accounts.find((a) => a.name === "Treasury").discriminator,
  quoteMints: new Set(json("../lib/treasury/quote-assets.json").assets.map((a) => a.mint)),
  log: (...a) => console.log(new Date().toISOString(), ...a),
});
if (process.env.LIVE_PUSH === "1") {
  live = await startLivePush({ reader: accounts, conn: timed(2_500) });
  live.push.start();
}
void accounts.tick();
setInterval(accounts.tick, MARKET_ACCOUNTS_INTERVAL_MS);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (req.method !== "GET") return send(405, JSON.stringify({ error: "Read-only." }));
    if (url.pathname === "/api/index/accounts") {
      const current = live ? live.store.view() : accounts.currentJson();
      return current ? send(200, current) : send(503, JSON.stringify({ error: "Not read yet." }));
    }
    if (live && url.pathname === "/api/index/stream") return live.stream.handle(req, res, url, "127.0.0.1");
    if (live && url.pathname === "/api/index/health") return send(200, JSON.stringify({ ok: true, live: { ...live.push.health(), stream: live.stream.health() } }));
    if (!url.pathname.startsWith("/api/index/")) return send(404, JSON.stringify({ error: "Not found." }));
    try {
      const r = await fetch(UPSTREAM + url.pathname.slice("/api/index".length) + url.search, {
        signal: AbortSignal.timeout(10_000),
      });
      send(r.status, await r.text(), r.headers.get("content-type") ?? "application/json");
    } catch {
      send(502, JSON.stringify({ error: "Market data unavailable." }));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`market accounts on http://127.0.0.1:${PORT}/api/index/accounts (RPC ${new URL(RPC).host})`));
