// Market data from Sonata's trade indexer (indexer/index.mjs), served at
// /api/index/*. Display only: nothing here feeds a transaction.
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: bigint; trades: number };
/** One swap; `ixIndex` tells apart two swaps in one transaction, `slot` orders it against live pushes. */
export type Trade = {
  signature: string;
  ixIndex: number;
  slot: number;
  time: number;
  side: "buy" | "sell";
  trader: string;
  base: bigint;
  quote: bigint;
  fee: bigint;
  price: number;
};
/** The trades a candles answer covers: its newest slot, and the trades (signature:ixIndex) in that slot. */
export type Covered = { slot: number; trades: string[] };
export type PoolStats = { pool: string; lastPrice: number | null; price24hAgo: number | null; volume24h: bigint; trades24h: number; tradesTotal: number };
export const INTERVALS = ["5m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`/api/index/${path}`, { signal });
  if (!r.ok) throw Error("Market data unavailable.");
  return (await r.json()) as T;
}

type Raw = Record<string, string | number | null>;

export async function fetchCandles(pool: string, interval: Interval, signal?: AbortSignal) {
  const d = await get<{ supply: number; candles: Raw[]; through?: { slot?: unknown; trades?: unknown } }>(`candles?pool=${pool}&interval=${interval}`, signal);
  const through: Covered = {
    slot: Number(d.through?.slot) || 0,
    trades: Array.isArray(d.through?.trades) ? d.through.trades.map(String) : [],
  };
  return {
    supply: d.supply,
    candles: d.candles.map((c): Candle => ({
      time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low),
      close: Number(c.close), volume: BigInt(String(c.volume)), trades: Number(c.trades),
    })),
    through,
  };
}

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
/**
 * One /trades row (or a live push's trade, which has the same fields), or
 * null when it is malformed.
 */
export function parseTrade(t: unknown): Trade | null {
  if (!t || typeof t !== "object") return null;
  const r = t as Raw;
  try {
    const trade: Trade = {
      signature: String(r.signature),
      ixIndex: Number(r.ix_index ?? 0),
      slot: Number(r.slot ?? 0),
      time: Number(r.time),
      side: r.side === "sell" ? "sell" : "buy",
      trader: String(r.trader),
      base: BigInt(String(r.base_amount)),
      quote: BigInt(String(r.quote_amount)),
      fee: BigInt(String(r.fee)),
      price: Number(r.price),
    };
    if (!SIGNATURE.test(trade.signature) || !Number.isFinite(trade.time) || !Number.isFinite(trade.price)) return null;
    if (!Number.isSafeInteger(trade.ixIndex) || !Number.isFinite(trade.slot)) return null;
    return trade;
  } catch {
    return null;
  }
}

export async function fetchTrades(pool: string, limit = 20, signal?: AbortSignal) {
  const d = await get<{ supply: number; trades: Raw[] }>(`trades?pool=${pool}&limit=${limit}`, signal);
  return {
    supply: d.supply,
    trades: d.trades.map(parseTrade).filter((t): t is Trade => t !== null),
  };
}

export async function fetchStats(signal?: AbortSignal) {
  return parseStats(await get<{ supply: number; pools: Raw[] }>("stats", signal));
}

const POOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ATOMS = /^\d{1,40}$/;
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : typeof v === "string" && /^\d{1,15}$/.test(v)
      ? Number(v)
      : null;
// A price: null when there is none; undefined when it is not a number.
const price = (v: unknown): number | null | undefined => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * One /stats row, or null when it is malformed (a renamed or null column, or
 * an indexer and app of different versions during a deploy): such a row is
 * left out rather than failing the whole answer.
 */
export function statsRow(p: unknown): PoolStats | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Raw;
  if (typeof r.pool !== "string" || !POOL.test(r.pool)) return null;
  const volume =
    typeof r.volume_24h === "number" && Number.isSafeInteger(r.volume_24h) ? String(r.volume_24h) : r.volume_24h;
  const trades24h = count(r.trades_24h),
    tradesTotal = count(r.trades_total),
    lastPrice = price(r.last_price),
    price24hAgo = price(r.price_24h_ago);
  if (typeof volume !== "string" || !ATOMS.test(volume) || trades24h === null || tradesTotal === null) return null;
  if (lastPrice === undefined || price24hAgo === undefined) return null;
  return { pool: r.pool, lastPrice, price24hAgo, volume24h: BigInt(volume), trades24h, tradesTotal };
}

/** The indexer's /stats answer as a map by pool; malformed rows are left out. Throws when it is not a stats answer. */
export function parseStats(d: { supply: number; pools: Raw[] }) {
  if (!d || typeof d !== "object" || !Array.isArray(d.pools)) throw Error("Unexpected stats answer.");
  const pools = new Map<string, PoolStats>();
  for (const p of d.pools) {
    const row = statsRow(p);
    if (row) pools.set(row.pool, row);
  }
  return { supply: typeof d.supply === "number" && Number.isFinite(d.supply) ? d.supply : 0, pools };
}

/**
 * The /stats answer with only its well-formed rows, in its own JSON shape: what
 * the server's market snapshot carries to the page, so the page can parse it
 * without a malformed row ever reaching a render.
 */
export function cleanStats(d: unknown): { supply: number; pools: Raw[] } {
  const { supply, pools } = parseStats(d as { supply: number; pools: Raw[] });
  return {
    supply,
    pools: [...pools.values()].map((s) => ({
      pool: s.pool,
      last_price: s.lastPrice,
      price_24h_ago: s.price24hAgo,
      volume_24h: s.volume24h.toString(),
      trades_24h: s.trades24h,
      trades_total: s.tradesTotal,
    })),
  };
}

// Price change over 24h as a fraction, or null without a reference price.
export function change24h(s: PoolStats) {
  return s.lastPrice && s.price24hAgo ? s.lastPrice / s.price24hAgo - 1 : null;
}

export function timeAgo(seconds: number, now = Date.now() / 1000) {
  const d = Math.max(0, Math.round(now - seconds));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
