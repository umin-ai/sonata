// Sonata trade indexer: reads every Meteora DBC swap on Sonata's markets from
// Solana Devnet into PostgreSQL, and serves read-only market data over HTTP
// (charts, recent trades, 24h stats). The chain stays the source of truth; the
// app re-reads anything involving money from chain before offering a signature.
//
// Env: DATABASE_URL (required), SOLANA_RPC_URL (default: public Devnet),
//      INDEXER_PORT (default 8790), INDEXER_POLL_MS (default 20000).
import http from "node:http";
import { readFileSync } from "node:fs";
import pg from "pg";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeTrades, SUPPLY_TOKENS } from "./parse.mjs";
import { splitRecipients } from "./modules/split.mjs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PORT = Number(process.env.INDEXER_PORT || 8790);
const POLL_MS = Number(process.env.INDEXER_POLL_MS || 20_000);
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const treasuryIdl = JSON.parse(
  readFileSync(new URL("../lib/treasury/stockroom_treasury.json", import.meta.url), "utf8"),
);
const TREASURY_PROGRAM = new PublicKey(treasuryIdl.address);
const TREASURY_DISCRIMINATOR = Buffer.from(
  treasuryIdl.accounts.find((a) => a.name === "Treasury").discriminator,
);

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
// Our own backoff handles the public RPC's rate limits.
const conn = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: true });
const SPACING_MS = Number(process.env.INDEXER_SPACING_MS || 350);
const state = { startedAt: new Date().toISOString(), lastSync: null, lastError: null, pools: 0, trades: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function migrate() {
  await db.query(`
    create table if not exists pools (
      pool text primary key,
      treasury text not null,
      last_signature text,
      updated_at timestamptz not null default now()
    );
    create table if not exists trades (
      signature text not null,
      ix_index int not null,
      pool text not null,
      slot bigint not null,
      block_time timestamptz not null,
      side text not null check (side in ('buy', 'sell')),
      trader text not null,
      base_amount numeric not null,
      quote_amount numeric not null,
      fee numeric not null,
      price double precision not null,
      primary key (signature, ix_index)
    );
    create index if not exists trades_pool_time on trades (pool, block_time desc);
    -- Reward token payouts, written by the crank (indexer/rewards.mjs): one row
    -- per confirmed payout transaction, and payouts signed but not yet settled.
    create table if not exists reward_payouts (
      pool text not null,
      signature text not null,
      amount numeric not null,
      recipients int not null,
      paid_at timestamptz not null,
      primary key (signature)
    );
    create index if not exists reward_payouts_pool_time on reward_payouts (pool, paid_at desc);
    create table if not exists reward_pending (
      signature text primary key,
      pool text not null,
      amount numeric not null,
      recipients int not null,
      last_valid_block_height bigint not null,
      sent_at timestamptz not null default now()
    );
    -- Fee modules (indexer/modules/): which module wrote a row (null = holders,
    -- rows from before modules existed) and what it did (burned base atoms,
    -- bounty round and winners, split recipients), carried from pending to paid.
    alter table reward_payouts add column if not exists module text;
    alter table reward_payouts add column if not exists detail jsonb;
    alter table reward_pending add column if not exists module text;
    alter table reward_pending add column if not exists detail jsonb;
    create index if not exists reward_payouts_pool_module on reward_payouts (pool, module, paid_at desc);
    -- Each Reward token's fee module, read once from its metadata JSON by the
    -- crank. config holds a split's recipients; status is lpFarm's current
    -- recipients ('holders' or 'lps').
    create table if not exists market_fee_models (
      pool text primary key,
      fee_model text not null,
      uri text,
      read_at timestamptz not null default now(),
      config jsonb,
      note text,
      status text,
      status_at timestamptz
    );
    -- Graduation airdrop (indexer/modules/airdrop.mjs), for markets whose DBC
    -- config names the crank key as leftover receiver: one state row per pool
    -- (written the first pass the crank sees such a config) and one payout row
    -- per holder of the snapshot. A row is pending with its signature before
    -- it is sent, so a crash resumes without paying twice.
    create table if not exists airdrop_state (
      pool text primary key,
      withdrawn numeric,
      withdraw_signature text,
      withdraw_last_valid_block_height bigint,
      snapshot_at timestamptz,
      done boolean not null default false,
      sent_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table if not exists airdrop_payouts (
      pool text not null,
      recipient text not null,
      owner text not null,
      amount numeric not null check (amount > 0),
      status text not null default 'unpaid' check (status in ('unpaid', 'pending', 'sent', 'skipped')),
      signature text,
      last_valid_block_height bigint,
      sent_at timestamptz,
      note text,
      primary key (pool, recipient)
    );
    create index if not exists airdrop_payouts_signature on airdrop_payouts (signature);
    -- claim_graduated's accounts per graduated market (indexer/modules/graduated.mjs):
    -- the Vault's permanently locked position in the graduated DAMM v2 pool.
    -- Finding it lists every position NFT the Vault holds, so it is cached.
    create table if not exists graduated_positions (
      pool text primary key,
      damm_pool text not null,
      position text not null,
      position_nft_account text not null,
      token_a_vault text not null,
      token_b_vault text not null,
      found_at timestamptz not null default now()
    );
  `);
  await (await import("./modules/ledger-schema.mjs")).migrateLedgerTables(db);
}

// Markets are the pools that have a Sonata treasury.
async function discoverPools() {
  const accounts = await conn.getProgramAccounts(TREASURY_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(TREASURY_DISCRIMINATOR) } }],
    dataSlice: { offset: 8, length: 32 },
  });
  for (const { pubkey, account } of accounts) {
    const pool = new PublicKey(account.data).toBase58();
    await db.query(
      "insert into pools (pool, treasury) values ($1, $2) on conflict (pool) do nothing",
      [pool, pubkey.toBase58()],
    );
  }
  return accounts.length;
}

// Retries the public RPC's rate limits with backoff.
async function rpc(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 8 || !/429|Too Many|fetch failed|timeout/i.test(String(e))) throw e;
      await sleep(Math.min(30_000, 1500 * 2 ** attempt));
    }
  }
}

async function syncPool({ pool, last_signature }) {
  const address = new PublicKey(pool);
  const signatures = [];
  let before;
  for (;;) {
    const page = await rpc(() =>
      conn.getSignaturesForAddress(address, { until: last_signature ?? undefined, before, limit: 1000 }),
    );
    signatures.push(...page);
    if (page.length < 1000) break;
    before = page.at(-1).signature;
  }
  if (!signatures.length) return 0;
  let inserted = 0;
  // Oldest first, so last_signature only advances past processed transactions.
  const ordered = signatures.reverse().filter((s) => !s.err);
  // One transaction at a time: the public RPC limits getTransaction per caller.
  for (const { signature } of ordered) {
    const tx = await rpc(() =>
      conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
    );
    for (const t of decodeTrades(tx, signature)) {
      if (t.pool !== pool || !t.blockTime) continue;
      const r = await db.query(
        `insert into trades (signature, ix_index, pool, slot, block_time, side, trader, base_amount, quote_amount, fee, price)
         values ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8, $9, $10, $11) on conflict do nothing`,
        [t.signature, t.ixIndex, t.pool, t.slot, t.blockTime, t.side, t.trader, t.baseAmount, t.quoteAmount, t.fee, t.price],
      );
      inserted += r.rowCount;
    }
    await db.query("update pools set last_signature = $2, updated_at = now() where pool = $1", [pool, signature]);
    await sleep(SPACING_MS);
  }
  // Failed transactions at the head still move the cursor forward.
  await db.query("update pools set last_signature = $2, updated_at = now() where pool = $1", [pool, signatures[signatures.length - 1].signature]);
  return inserted;
}

async function syncAll() {
  state.pools = await rpc(() => discoverPools());
  const { rows } = await db.query("select pool, last_signature from pools");
  for (const row of rows) {
    state.trades += await syncPool(row);
    await sleep(200);
  }
  state.lastSync = new Date().toISOString();
  state.lastError = null;
}

// ---- Read-only API ----------------------------------------------------------

const INTERVALS = { "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "1h": "1 hour", "4h": "4 hours", "1d": "1 day" };
const isPool = (v) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const limitOf = (v, max, dflt) => Math.min(max, Math.max(1, Number.parseInt(v ?? "", 10) || dflt));
const hits = new Map();
function allowed(ip) {
  const now = Date.now(), e = hits.get(ip);
  if (!e || now - e.start > 60_000) return hits.set(ip, { start: now, n: 1 }), true;
  return ++e.n <= 120;
}

const seconds = (v) => (v === null || v === undefined ? null : Number(v));

// What the market's fee module has done, from confirmed rows only.
async function moduleDetail(pool, fm) {
  if (fm?.fee_model === "buyback") {
    const { rows: [b] } = await db.query(
      `select coalesce(sum((detail->>'burned')::numeric), 0)::text as burned,
              floor(extract(epoch from max(paid_at) filter (where amount > 0)))::bigint::text as last_buy_at
         from reward_payouts where pool = $1 and module = 'buyback'`,
      [pool],
    );
    return { burned: b.burned, lastBuyAt: seconds(b.last_buy_at) };
  }
  if (fm?.fee_model === "topBuyers") {
    const { rows: [t] } = await db.query(
      `select detail from reward_payouts where pool = $1 and module = 'topBuyers'
        order by (detail->>'roundEnd')::bigint desc, paid_at desc limit 1`,
      [pool],
    );
    const winners = Array.isArray(t?.detail?.winners) ? t.detail.winners : [];
    return {
      winners: winners.map((w) => ({ trader: String(w.trader), amount: String(w.amount) })),
      lastRoundAt: seconds(t?.detail?.roundEnd),
    };
  }
  if (fm?.fee_model === "lpFarm") return { status: fm.status === "lps" ? "lps" : "holders" };
  if (fm?.fee_model === "diamond") {
    const { rows: [d] } = await db.query(
      `select detail->'multipliers' as multipliers from reward_payouts
        where pool = $1 and module = 'diamond' and detail ? 'multipliers' order by paid_at desc, signature desc limit 1`,
      [pool],
    );
    return { multipliers: d?.multipliers ?? null };
  }
  if (fm?.fee_model === "split") {
    const { rows } = await db.query(
      `select r->>'wallet' as wallet, sum((r->>'amount')::numeric)::text as paid
         from reward_payouts p, jsonb_array_elements(p.detail->'recipients') r
        where p.pool = $1 and p.module = 'split' group by 1`,
      [pool],
    );
    return splitRecipients(fm.config, new Map(rows.map((x) => [x.wallet, x.paid])));
  }
  return {};
}

async function route(url) {
  const q = url.searchParams;
  if (url.pathname === "/api/index/health") return { ok: true, ...state };
  if (url.pathname === "/api/index/trades") {
    if (!isPool(q.get("pool"))) return 400;
    const { rows } = await db.query(
      `select signature, extract(epoch from block_time)::bigint as time, side, trader,
              base_amount::text, quote_amount::text, fee::text, price
         from trades where pool = $1 order by block_time desc, signature desc, ix_index desc limit $2`,
      [q.get("pool"), limitOf(q.get("limit"), 100, 30)],
    );
    return { pool: q.get("pool"), supply: SUPPLY_TOKENS, trades: rows };
  }
  if (url.pathname === "/api/index/candles") {
    const interval = INTERVALS[q.get("interval") ?? "15m"];
    if (!isPool(q.get("pool")) || !interval) return 400;
    const { rows } = await db.query(
      `select extract(epoch from date_bin($2::interval, block_time, timestamptz 'epoch'))::bigint as time,
              (array_agg(price order by block_time, signature, ix_index))[1] as open,
              max(price) as high, min(price) as low,
              (array_agg(price order by block_time desc, signature desc, ix_index desc))[1] as close,
              sum(quote_amount)::text as volume, count(*)::int as trades
         from trades where pool = $1 group by 1 order by 1 desc limit $3`,
      [q.get("pool"), interval, limitOf(q.get("limit"), 500, 200)],
    );
    return { pool: q.get("pool"), interval: q.get("interval") ?? "15m", supply: SUPPLY_TOKENS, candles: rows.reverse() };
  }
  if (url.pathname === "/api/index/stats") {
    const { rows } = await db.query(
      `select p.pool,
              (select price from trades t where t.pool = p.pool order by block_time desc, signature desc, ix_index desc limit 1) as last_price,
              (select price from trades t where t.pool = p.pool and block_time <= now() - interval '24 hours'
                 order by block_time desc, signature desc, ix_index desc limit 1) as price_24h_ago,
              coalesce((select sum(quote_amount) from trades t where t.pool = p.pool and block_time > now() - interval '24 hours'), 0)::text as volume_24h,
              (select count(*) from trades t where t.pool = p.pool and block_time > now() - interval '24 hours')::int as trades_24h,
              (select count(*) from trades t where t.pool = p.pool)::int as trades_total
         from pools p`,
    );
    return { supply: SUPPLY_TOKENS, pools: rows };
  }
  // Reward token payouts (confirmed transactions only), in quote atoms, and the
  // market's fee module with what it has done.
  if (url.pathname === "/api/index/rewards") {
    if (!isPool(q.get("pool"))) return 400;
    const pool = q.get("pool");
    // Burn-only buyback rows move no quote and are not counted as payouts.
    const { rows: [r] } = await db.query(
      `select coalesce(sum(amount), 0)::text as paid, count(*) filter (where amount > 0)::int as payouts,
              (select recipients from reward_payouts where pool = $1 and amount > 0 order by paid_at desc, signature desc limit 1) as recipients_last,
              floor(extract(epoch from max(paid_at) filter (where amount > 0)))::bigint::text as last_paid_at
         from reward_payouts where pool = $1`,
      [pool],
    );
    const { rows: [fm] } = await db.query("select fee_model, config, status from market_fee_models where pool = $1", [pool]);
    const out = {
      pool,
      paid: r.paid,
      payouts: r.payouts,
      recipientsLast: r.recipients_last ?? 0,
      lastPaidAt: seconds(r.last_paid_at),
      // null until the crank has read the token's metadata.
      feeModel: fm?.fee_model ?? null,
    };
    const { rows: [a] } = await db.query(
      `select withdrawn::text, done, floor(extract(epoch from sent_at))::bigint::text as sent_at,
              (select count(*) from airdrop_payouts where pool = $1 and status = 'sent')::int as recipients
         from airdrop_state where pool = $1`,
      [pool],
    );
    return {
      ...out,
      ...(await moduleDetail(pool, fm)),
      // Only for markets whose DBC config names the crank key as leftover receiver.
      ...(a ? { airdrop: { status: a.done ? "sent" : "waiting", amount: a.withdrawn, recipients: a.recipients, sentAt: seconds(a.sent_at) } } : {}),
    };
  }
  return 404;
}

http
  .createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": status === 200 ? "public, max-age=5" : "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== "GET") return send(405, { error: "Read-only." });
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",")[0].trim();
      if (!allowed(ip)) return send(429, { error: "Too many requests." });
      const out = await route(new URL(req.url, "http://localhost"));
      if (out === 400) return send(400, { error: "Bad request." });
      if (out === 404) return send(404, { error: "Not found." });
      send(200, out);
    } catch {
      send(500, { error: "Market data unavailable." });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`indexer API on 127.0.0.1:${PORT}`));

// ---- Main loop --------------------------------------------------------------

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required.");
if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw Error("Not Devnet.");
await migrate();
for (;;) {
  try {
    await syncAll();
  } catch (e) {
    state.lastError = String(e?.message ?? e).slice(0, 300);
    console.error("sync failed:", state.lastError);
  }
  await sleep(POLL_MS);
}
