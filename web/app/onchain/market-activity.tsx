"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Area, Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { TokenName } from "@/app/token-identity";
import { explorer } from "@/lib/treasury/runtime";
import { formatUnits } from "@/lib/treasury/units";
import {
  INTERVALS,
  fetchCandles,
  fetchTrades,
  parseTrade,
  timeAgo,
  type Candle,
  type Covered,
  type Interval,
  type Trade,
} from "@/lib/market-data";
import {
  applyTrade,
  applyTradeToCandles,
  candlesWithPushed,
  cover,
  covers,
  INTERVAL_SECONDS,
  keepPushed,
  tradesWithPushed,
} from "@/lib/live-events";
import { useLiveEvent, useLiveResync, useLiveStream, useStreamStatus } from "./live-stream";

const QUOTE_DECIMALS = 8, BASE_DECIMALS = 6;
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const fmt = (n: number) =>
  n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toPrecision(3);

/**
 * Whether a component loads its data on a 20 s timer: on pages without a live
 * stream (as before), and while the stream is down. With it, the data is
 * loaded once (and again after a snapshot the stream could not resume from)
 * and pushed trades are added as they come.
 */
function usePolling() {
  const stream = useLiveStream();
  const status = useStreamStatus(stream);
  return { stream, polling: !stream || status === "off" || status === "fallback", resync: useLiveResync(stream) };
}

/**
 * This pool's trades pushed since the page opened (the last PUSHED_TRADES_KEPT),
 * each passed to `onTrade` as it comes: every load merges them into its
 * answer, so a trade pushed while a load was on its way (or before the first
 * one landed) is never dropped by it.
 */
function usePushedTrades(pool: string, onTrade: (trade: Trade) => void) {
  const stream = useLiveStream();
  const kept = useRef<{ pool: string; trades: Trade[] }>({ pool, trades: [] });
  useLiveEvent(stream, "trade", (ev) => {
    const trade = ev.pool === pool ? parseTrade(ev.trade) : null;
    if (!trade) return;
    kept.current = { pool, trades: keepPushed(kept.current.pool === pool ? kept.current.trades : [], trade) };
    onTrade(trade);
  });
  return kept;
}
const keptFor = (kept: { pool: string; trades: Trade[] }, pool: string) => (kept.pool === pool ? kept.trades : []);

// Market cap over time, in the quote stock, from indexed DBC trades, with
// pushed trades added as they come (else refreshed every 20 seconds). `supply`
// is the token's current supply in whole tokens, which Stock Floor burns
// reduce; without it the chart assumes the full minted supply. `liveCap` is
// the market cap now, from the curve itself (the page's live or pushed read;
// not after graduation, when the price moves in the DAMM v2 pool): the
// headline and the line's last point follow it, ahead of the trade rows.
export function PriceChart({ pool, quote, revision = 0, supply, liveCap }: { pool: string; quote: string; revision?: number; supply?: number; liveCap?: number }) {
  const [interval, setIntervalValue] = useState<Interval>("1h");
  const [data, setData] = useState<{ candles: Candle[]; supply: number; at: number; through: Covered } | null>(null);
  const [error, setError] = useState(false);
  const { polling, resync } = usePolling();
  // A pushed trade goes into its candle unless the candles loaded already count it.
  const pushed = usePushedTrades(pool, (trade) =>
    setData((d) =>
      d && !covers(d.through, trade)
        ? { ...d, candles: applyTradeToCandles(d.candles, trade, INTERVAL_SECONDS[interval]), through: cover(d.through, trade), at: Date.now() }
        : d,
    ),
  );
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = () =>
      fetchCandles(pool, interval, controller.signal)
        .then((d) => {
          if (active) {
            setData({ ...candlesWithPushed(d, keptFor(pushed.current, pool), INTERVAL_SECONDS[interval]), at: Date.now() });
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    void load();
    const timer = polling ? setInterval(load, 20_000) : undefined;
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [pool, interval, revision, polling, resync, pushed]);
  const points = (data?.candles ?? []).map((c) => ({
    time: c.time * 1000,
    cap: c.close * (supply ?? data?.supply ?? 0),
    volume: Number(c.volume) / 10 ** QUOTE_DECIMALS,
  }));
  const last = points.at(-1);
  const headline = liveCap ?? last?.cap;
  // The line ends at the market cap now (from the pool) when known, else carries
  // the last price to now, so a market with one bucket still draws a line.
  if (last && data && liveCap !== undefined) points.push({ time: Math.max(data.at, last.time + 1), cap: liveCap, volume: 0 });
  else if (last && data && data.at - last.time > 60_000) points.push({ time: data.at, cap: last.cap, volume: 0 });
  return (
    <div className="price-chart">
      <div className="price-chart-head">
        <div>
          <span>Market cap</span>
          <strong>
            {headline !== undefined ? fmt(headline) : "—"} <TokenName symbol={quote} />
          </strong>
        </div>
        <div className="price-chart-intervals" role="group" aria-label="Chart interval">
          {INTERVALS.map((i) => (
            <button key={i} type="button" aria-pressed={interval === i} onClick={() => setIntervalValue(i)}>
              {i}
            </button>
          ))}
        </div>
      </div>
      {error && !data ? (
        <p className="sr-note">Market data unavailable right now. Trading still works.</p>
      ) : points.length === 0 ? (
        <p className="sr-note">{data ? "No trades yet. The first buy starts the chart." : "Loading chart…"}</p>
      ) : (
        <ChartContainer
          className="h-56 w-full"
          config={{
            cap: { label: `Market cap (${quote})`, color: "var(--chart-1)" },
            volume: { label: `Volume (${quote})`, color: "var(--chart-2)" },
          }}
        >
          <ComposedChart data={points} margin={{ left: 4, right: 4, top: 8 }}>
            <CartesianGrid vertical={false} strokeOpacity={0.3} />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t) =>
                new Date(t).toLocaleString(undefined, interval === "1d" ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" })
              }
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis yAxisId="cap" dataKey="cap" tickFormatter={fmt} width={48} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
            <YAxis yAxisId="volume" dataKey="volume" orientation="right" hide />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, p) => new Date(Number(p?.[0]?.payload?.time)).toLocaleString()}
                  formatter={(v, name) => (
                    <span>
                      {name === "cap" ? "Market cap" : "Volume"} {fmt(Number(v))} {quote}
                    </span>
                  )}
                />
              }
            />
            <Bar yAxisId="volume" dataKey="volume" fill="var(--color-volume)" opacity={0.35} barSize={6} />
            <Area yAxisId="cap" dataKey="cap" type="stepAfter" stroke="var(--color-cap)" fill="var(--color-cap)" fillOpacity={0.12} strokeWidth={2} />
          </ComposedChart>
        </ChartContainer>
      )}
    </div>
  );
}

// The latest trades on this market, newest first, with pushed trades added as they come.
export function RecentTrades({ pool, symbol, quote, revision = 0 }: { pool: string; symbol: string; quote: string; revision?: number }) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState(false);
  const { polling, resync } = usePolling();
  const pushed = usePushedTrades(pool, (trade) => setTrades((list) => (list ? applyTrade(list, trade, 15) : list)));
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = () =>
      fetchTrades(pool, 15, controller.signal)
        .then((d) => {
          if (active) {
            setTrades(tradesWithPushed(d.trades, keptFor(pushed.current, pool), 15));
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    void load();
    const timer = polling ? setInterval(load, 20_000) : undefined;
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [pool, revision, polling, resync, pushed]);
  if (error && !trades) return <p className="sr-note">Recent trades unavailable right now.</p>;
  if (!trades) return <p className="sr-note">Loading trades…</p>;
  if (!trades.length) return <p className="sr-note">No trades yet.</p>;
  return (
    <div className="recent-trades" role="table" aria-label="Recent trades">
      {trades.map((t) => (
        <a key={`${t.signature}:${t.ixIndex}`} className="recent-trade" role="row" href={explorer("tx", t.signature)} target="_blank" rel="noreferrer">
          <span className={`recent-trade-side ${t.side}`}>{t.side === "buy" ? "Buy" : "Sell"}</span>
          <span>
            {formatUnits(t.quote, QUOTE_DECIMALS)} <TokenName symbol={quote} />
          </span>
          <span className="recent-trade-muted">
            {Number(formatUnits(t.base, BASE_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 0 })} {symbol}
          </span>
          <span className="recent-trade-muted">{short(t.trader)}</span>
          <span className="recent-trade-muted">
            {timeAgo(t.time)} <ArrowUpRight size={12} />
          </span>
        </a>
      ))}
    </div>
  );
}
