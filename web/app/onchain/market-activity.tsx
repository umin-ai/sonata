"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Area, Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { TokenName } from "@/app/token-identity";
import { explorer } from "@/lib/treasury/runtime";
import { formatUnits } from "@/lib/treasury/units";
import {
  INTERVALS,
  change24h,
  fetchCandles,
  fetchStats,
  fetchTrades,
  timeAgo,
  type Candle,
  type Interval,
  type PoolStats,
  type Trade,
} from "@/lib/market-data";

const QUOTE_DECIMALS = 8, BASE_DECIMALS = 6;
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const fmt = (n: number) =>
  n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toPrecision(3);

// Market cap over time, in the quote stock, from indexed DBC trades. Refreshes
// every 20 seconds, the indexer's poll interval. `supply` is the token's current
// supply in whole tokens, which Stock Floor burns reduce; without it the chart
// assumes the full minted supply.
export function PriceChart({ pool, quote, revision = 0, supply }: { pool: string; quote: string; revision?: number; supply?: number }) {
  const [interval, setIntervalValue] = useState<Interval>("1h");
  const [data, setData] = useState<{ candles: Candle[]; supply: number; at: number } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = () =>
      fetchCandles(pool, interval, controller.signal)
        .then((d) => {
          if (active) {
            setData({ ...d, at: Date.now() });
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    void load();
    const timer = setInterval(load, 20_000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [pool, interval, revision]);
  const points = (data?.candles ?? []).map((c) => ({
    time: c.time * 1000,
    cap: c.close * (supply ?? data?.supply ?? 0),
    volume: Number(c.volume) / 10 ** QUOTE_DECIMALS,
  }));
  const last = points.at(-1);
  // Carry the last price to now, so a market with one bucket still draws a line.
  if (last && data && data.at - last.time > 60_000) points.push({ time: data.at, cap: last.cap, volume: 0 });
  return (
    <div className="price-chart">
      <div className="price-chart-head">
        <div>
          <span>Market cap</span>
          <strong>
            {last ? fmt(last.cap) : "—"} <TokenName symbol={quote} />
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

// The latest trades on this market, newest first.
export function RecentTrades({ pool, symbol, quote, revision = 0 }: { pool: string; symbol: string; quote: string; revision?: number }) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = () =>
      fetchTrades(pool, 15, controller.signal)
        .then((d) => {
          if (active) {
            setTrades(d.trades);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    void load();
    const timer = setInterval(load, 20_000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [pool, revision]);
  if (error && !trades) return <p className="sr-note">Recent trades unavailable right now.</p>;
  if (!trades) return <p className="sr-note">Loading trades…</p>;
  if (!trades.length) return <p className="sr-note">No trades yet.</p>;
  return (
    <div className="recent-trades" role="table" aria-label="Recent trades">
      {trades.map((t) => (
        <a key={t.signature} className="recent-trade" role="row" href={explorer("tx", t.signature)} target="_blank" rel="noreferrer">
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

// 24h volume, trades and change for a market card. All cards share one
// request, refreshed at most every 20 seconds.
let statsCache: { at: number; promise: ReturnType<typeof fetchStats> } | null = null;
function sharedStats() {
  if (!statsCache || Date.now() - statsCache.at > 20_000) {
    const promise = fetchStats();
    statsCache = { at: Date.now(), promise };
    promise.catch(() => {
      statsCache = null;
    });
  }
  return statsCache.promise;
}

export function MarketStats({ pool, quote }: { pool: string; quote: string }) {
  const [stats, setStats] = useState<PoolStats | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void sharedStats()
      .then((d) => {
        if (active) setStats(d.pools.get(pool) ?? null);
      })
      .catch(() => {
        if (active) setStats(null);
      });
    return () => {
      active = false;
    };
  }, [pool]);
  if (!stats) return null;
  const change = change24h(stats);
  const volume = Number(formatUnits(stats.volume24h, QUOTE_DECIMALS));
  const volumeLabel = volume > 0 && volume < 0.0001
    ? "<0.0001"
    : volume.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return (
    <div className="market-card-stats">
      <span>
        24h vol <strong>{volumeLabel} {quote}</strong>
      </span>
      <span>
        {stats.trades24h} trade{stats.trades24h === 1 ? "" : "s"}
        {change !== null && change !== 0 && (
          <strong className={change > 0 ? "up" : "down"}>
            {" "}
            {change > 0 ? "+" : ""}
            {(change * 100).toFixed(1)}%
          </strong>
        )}
      </span>
    </div>
  );
}
