// What the indexer's live stream (/api/index/stream, indexer/modules/stream.mjs)
// sends, and how a page applies it to what it shows: pure functions, tested
// in lib/live-events.test.ts. Everything here is display data. Nothing that
// trades or moves funds reads it: the market page's own chain read
// (readTreasuryVerified) still gates every action.
import {
  MAX_LISTED_MARKETS,
  newestFirst,
  versionOf,
  type CardData,
  type ProfileBody,
  type SnapshotEntry,
} from "@/lib/treasury/market-snapshot";
import type { Candle, Covered, Interval, Trade } from "@/lib/market-data";

/** The stream protocol this build speaks (the indexer's `hello.v`). */
export const STREAM_VERSION = 1;

type Row = Record<string, string | number | null>;
/** A market's change. `added` carries the whole entry; an update carries full numbers (`data`, a market page) or only a card's (`card`, the market list); null numbers come with `error`. */
export type MarketEvent =
  | { pool: string; kind: "added"; version: number; entry: SnapshotEntry; stats?: Row | null; profile?: ProfileBody | null }
  | { pool: string; kind: "updated"; version: number; data?: CardData | null; card?: Partial<CardData> | null; error?: string };
export type RemovedEvent = { pool: string; reason?: string };
export type TradeEvent = { pool: string; trade: Row };
export type StatsEvent = { pool?: string; stats?: Row; full?: boolean; pools?: Row[] };
export type ProfileEvent = { pool: string; uri: string; profile: ProfileBody | null };
export type ListSnapshot = {
  scope: "list";
  seq: number;
  entries: SnapshotEntry[];
  skipped: number;
  /** Every market's 24h stats, or null while the indexer has not loaded them. */
  stats: Row[] | null;
  profiles: Record<string, ProfileBody | null>;
};
export type MarketSnapshot = {
  scope: "market";
  seq: number;
  pool: string;
  entry: SnapshotEntry | null;
  stats: Row | null;
  profile?: ProfileBody | null;
};
export type Snapshot = ListSnapshot | MarketSnapshot;

/**
 * A market's entry after an event: `added` replaces it (unless what is shown
 * is as new: a replay repeats it); an update changes its numbers in place,
 * only if at least as new.
 * A card-only update needs numbers to merge into: without them it is ignored
 * (the stream sends full numbers whenever a market regains them). Returns
 * `current` itself when nothing changes.
 */
export function entryAfter(current: SnapshotEntry | null, ev: MarketEvent): SnapshotEntry | null {
  if (ev.kind === "added") {
    if (current && versionOf(current) >= ev.version) return current;
    return { ...ev.entry, version: ev.version };
  }
  if (!current || ev.version < versionOf(current)) return current;
  if (ev.data !== undefined || ev.card === null) {
    const data = ev.data ?? null;
    return data ? { ...current, data, error: undefined, version: ev.version } : { ...current, data: null, error: ev.error ?? "Chain data unavailable", version: ev.version };
  }
  if (!ev.card || !current.data) return current;
  return { ...current, data: { ...current.data, ...ev.card }, error: undefined, version: ev.version };
}

/**
 * The market list after an event: a new market lands in newest-first order
 * (at the top when it just launched) and the oldest beyond `max` drops; an
 * update changes one card in place; other cards keep their objects, so they
 * do not re-render.
 */
export function applyMarketEvent(list: SnapshotEntry[], ev: MarketEvent, max = MAX_LISTED_MARKETS): SnapshotEntry[] {
  const i = list.findIndex((e) => e.market.pool === ev.pool);
  if (i < 0) {
    if (ev.kind !== "added") return list;
    const entry = entryAfter(null, ev)!;
    const out = [...list];
    const at = out.findIndex((x) => newestFirst(entry, x) < 0);
    out.splice(at < 0 ? out.length : at, 0, entry);
    if (out.length > max) out.length = max;
    return out;
  }
  const next = entryAfter(list[i], ev);
  if (next === list[i] || !next) return list;
  const out = [...list];
  out[i] = next;
  return out;
}

/** The list without a market the indexer no longer lists. */
export const removeMarket = (list: SnapshotEntry[], pool: string) =>
  list.some((e) => e.market.pool === pool) ? list.filter((e) => e.market.pool !== pool) : list;

const tradeKey = (t: Pick<Trade, "signature" | "ixIndex">) => `${t.signature}:${t.ixIndex}`;
const newer = (a: Trade, b: Trade) => b.time - a.time || b.slot - a.slot || (a.signature < b.signature ? 1 : a.signature > b.signature ? -1 : b.ixIndex - a.ixIndex);

/** Recent trades after a pushed one: newest first, each swap once, at most `limit`. */
export function applyTrade(trades: Trade[], trade: Trade, limit = 15): Trade[] {
  if (trades.some((t) => tradeKey(t) === tradeKey(trade))) return trades;
  return [...trades, trade].sort(newer).slice(0, limit);
}

/** The trades pushed since a page opened that it keeps, to merge into what it loads later. */
export const PUSHED_TRADES_KEPT = 100;
/** `kept` with one more pushed trade (each swap once), the oldest beyond `max` dropped. */
export function keepPushed(kept: Trade[], trade: Trade, max = PUSHED_TRADES_KEPT): Trade[] {
  if (kept.some((t) => tradeKey(t) === tradeKey(trade))) return kept;
  const out = [...kept, trade];
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * A trades answer with the trades pushed while it was on its way (or before
 * it) added: a load never drops a trade the page was pushed, however the
 * answer and the push crossed.
 */
export const tradesWithPushed = (loaded: Trade[], pushed: readonly Trade[], limit = 15) =>
  pushed.reduce((list, t) => applyTrade(list, t, limit), loaded.slice(0, limit));

/**
 * A candles answer with the pushed trades it does not count yet (by its
 * `through`) added, so a trade pushed while the answer was on its way is
 * neither lost nor counted twice.
 */
export function candlesWithPushed<T extends { candles: Candle[]; through: Covered }>(loaded: T, pushed: readonly Trade[], intervalSeconds: number): T {
  let { candles, through } = loaded;
  for (const t of [...pushed].sort((a, b) => a.slot - b.slot || a.time - b.time)) {
    if (covers(through, t)) continue;
    candles = applyTradeToCandles(candles, t, intervalSeconds);
    through = cover(through, t);
  }
  return candles === loaded.candles ? loaded : { ...loaded, candles, through };
}

export const INTERVAL_SECONDS: Record<Interval, number> = { "5m": 300, "1h": 3_600, "4h": 14_400, "1d": 86_400 };

/** Whether candles covering `through` (their answer's newest slot and its trades) already count this trade. */
export const covers = (through: Covered, t: Pick<Trade, "slot" | "signature" | "ixIndex">) =>
  t.slot < through.slot || (t.slot === through.slot && through.trades.includes(tradeKey(t)));
/** `through` once this trade is counted too. */
export const cover = (through: Covered, t: Pick<Trade, "slot" | "signature" | "ixIndex">): Covered =>
  t.slot > through.slot ? { slot: t.slot, trades: [tradeKey(t)] } : t.slot === through.slot ? { slot: t.slot, trades: [...through.trades, tradeKey(t)] } : through;

/**
 * Candles (oldest first) with one more trade, bucketed as the indexer's
 * date_bin from the epoch does: the trade's bucket gets its high, low, volume
 * and count, and its close when it is the newest bucket (a trade pushed late
 * into an older bucket leaves that bucket's close); a bucket newer than any
 * opens at the trade's price.
 */
export function applyTradeToCandles(candles: Candle[], trade: Trade, intervalSeconds: number): Candle[] {
  const time = Math.floor(trade.time / intervalSeconds) * intervalSeconds;
  const i = candles.findIndex((c) => c.time === time);
  if (i >= 0) {
    const c = candles[i];
    const latest = i === candles.length - 1;
    const out = [...candles];
    out[i] = {
      ...c,
      high: Math.max(c.high, trade.price),
      low: Math.min(c.low, trade.price),
      close: latest ? trade.price : c.close,
      volume: c.volume + trade.quote,
      trades: c.trades + 1,
    };
    return out;
  }
  const bucket: Candle = { time, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.quote, trades: 1 };
  const at = candles.findIndex((c) => c.time > time);
  return at < 0 ? [...candles, bucket] : [...candles.slice(0, at), bucket, ...candles.slice(at)];
}
