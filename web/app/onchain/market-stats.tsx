"use client";
import { useEffect, useState } from "react";
import { formatUnits } from "@/lib/treasury/units";
import { change24h, fetchStats, type PoolStats } from "@/lib/market-data";
import { useNumberLocale, useSnapshotStats } from "./snapshot-context";
import { useLivePoolStats } from "./live-stream";

// 24h volume, trades and change for a market card, in its own module so the
// market list does not load the chart library. On a page with a live stream
// they come pushed (a new market's with it); otherwise all cards share one
// request, refreshed at most every 20 seconds.
const QUOTE_DECIMALS = 8;
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
  // The server's snapshot carries the stats of the markets it listed, and the
  // live stream those of every market it has sent: nothing to fetch for those.
  // A market neither covers (no stream, listed after the page was rendered, or
  // no stats in the snapshot) loads them as before.
  const pushed = useLivePoolStats(pool);
  const seeded = useSnapshotStats(pool);
  const covered = pushed !== undefined || seeded !== undefined;
  const [fetched, setStats] = useState<PoolStats | null | undefined>(undefined);
  useEffect(() => {
    if (covered) return;
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
  }, [pool, covered]);
  // Formatted as the server did until hydration, so the first render matches its HTML.
  const locale = useNumberLocale();
  const stats = pushed !== undefined ? pushed : covered ? seeded : fetched;
  if (!stats) return null;
  const change = change24h(stats);
  const volume = Number(formatUnits(stats.volume24h, QUOTE_DECIMALS));
  const volumeLabel = volume > 0 && volume < 0.0001
    ? "<0.0001"
    : volume.toLocaleString(locale, { maximumFractionDigits: 4 });
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
