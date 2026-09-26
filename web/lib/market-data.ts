// Market data from Sonata's trade indexer (indexer/index.mjs), served at
// /api/index/*. Display only: nothing here feeds a transaction.
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: bigint; trades: number };
export type Trade = { signature: string; time: number; side: "buy" | "sell"; trader: string; base: bigint; quote: bigint; fee: bigint; price: number };
export type PoolStats = { pool: string; lastPrice: number | null; price24hAgo: number | null; volume24h: bigint; trades24h: number; tradesTotal: number };
export const INTERVALS = ["5m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`/api/index/${path}`, { signal });
  if (!r.ok) throw Error("Market data unavailable.");
  return (await r.json()) as T;
}

type Raw = Record<string, string | number | null>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function fetchCandles(pool: string, interval: Interval, signal?: AbortSignal) {
  const d = await get<{ supply: number; candles: Raw[] }>(`candles?pool=${pool}&interval=${interval}`, signal);
  return {
    supply: d.supply,
    candles: d.candles.map((c): Candle => ({
      time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low),
      close: Number(c.close), volume: BigInt(String(c.volume)), trades: Number(c.trades),
    })),
  };
}

export async function fetchTrades(pool: string, limit = 20, signal?: AbortSignal) {
  const d = await get<{ supply: number; trades: Raw[] }>(`trades?pool=${pool}&limit=${limit}`, signal);
  return {
    supply: d.supply,
    trades: d.trades.map((t): Trade => ({
      signature: String(t.signature), time: Number(t.time), side: t.side === "sell" ? "sell" : "buy",
      trader: String(t.trader), base: BigInt(String(t.base_amount)), quote: BigInt(String(t.quote_amount)),
      fee: BigInt(String(t.fee)), price: Number(t.price),
    })),
  };
}

export async function fetchStats(signal?: AbortSignal) {
  return parseStats(await get<{ supply: number; pools: Raw[] }>("stats", signal));
}

/** The indexer's /stats answer as a map by pool (the server's market snapshot carries it as it is). */
export function parseStats(d: { supply: number; pools: Raw[] }) {
  const pools = new Map<string, PoolStats>();
  for (const p of d.pools)
    pools.set(String(p.pool), {
      pool: String(p.pool), lastPrice: num(p.last_price), price24hAgo: num(p.price_24h_ago),
      volume24h: BigInt(String(p.volume_24h)), trades24h: Number(p.trades_24h), tradesTotal: Number(p.trades_total),
    });
  return { supply: d.supply, pools };
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
