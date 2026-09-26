"use client";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { parseStats, type PoolStats } from "@/lib/market-data";
import type { ProfileBody, RawStats } from "@/lib/treasury/market-snapshot";

// What the server's market snapshot already knows beyond the cards: token
// profiles, USD prices, 24h stats and the visitor's number locale. The hooks
// below give components their first value from it, so the browser's first
// render matches the server's HTML and nothing is fetched again. A value the
// snapshot does not have is undefined, and the component loads it as before.
type Extras = {
  profiles: Record<string, ProfileBody | null>;
  prices: Record<string, number | null>;
  /** 24h stats by pool, for the pools in `statsPools` (a pool there without a row has none). */
  stats: Map<string, PoolStats> | null;
  statsPools: Set<string>;
  locale?: string;
};
const SnapshotContext = createContext<Extras | null>(null);

export function SnapshotProvider({
  profiles,
  prices,
  stats,
  statsPools,
  locale,
  children,
}: {
  profiles?: Record<string, ProfileBody | null>;
  prices?: Record<string, number | null>;
  stats?: RawStats | null;
  /** The pools `stats` covers: the markets listed when they were taken. Markets added later load their own. */
  statsPools?: readonly string[];
  locale?: string;
  children: ReactNode;
}) {
  const value = useMemo(() => {
    let parsed: Map<string, PoolStats> | null = null;
    try {
      parsed = stats ? parseStats(stats).pools : null;
    } catch {
      // Unreadable stats: the cards load their own, as without a snapshot.
    }
    return {
      profiles: profiles ?? {},
      prices: prices ?? {},
      stats: parsed,
      statsPools: new Set(parsed ? (statsPools ?? []) : []),
      locale,
    };
  }, [profiles, prices, stats, statsPools, locale]);
  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>;
}

/**
 * The token profile the snapshot carries for this URI (as /api/token-meta
 * returns it); null when the server could not read it lately (nothing to
 * load); undefined when the snapshot does not have it.
 */
export function useSnapshotProfile(uri?: string): ProfileBody | null | undefined {
  const c = useContext(SnapshotContext);
  return uri && c && Object.hasOwn(c.profiles, uri) ? c.profiles[uri] : undefined;
}

/** USD per share of the stock behind a quote symbol: a number, null (no usable price), or undefined (not in the snapshot). */
export function useSnapshotPrice(symbol: string): number | null | undefined {
  const c = useContext(SnapshotContext);
  return c && Object.hasOwn(c.prices, symbol) ? c.prices[symbol] : undefined;
}

/**
 * A pool's 24h stats from the snapshot: its row, null when the snapshot
 * covers the pool but has no row for it, or undefined when it does not cover
 * the pool (no stats in the snapshot, or a market listed after it was taken).
 */
export function useSnapshotStats(pool: string): PoolStats | null | undefined {
  const c = useContext(SnapshotContext);
  if (!c?.stats || !c.statsPools.has(pool)) return undefined;
  return c.stats.get(pool) ?? null;
}

const subscribe = () => () => {};
/** False on the server and during hydration, true once the browser has taken over. */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/**
 * The locale for numbers: the one the server formatted with until hydration
 * is done, then the browser's own (undefined), as before.
 */
export function useNumberLocale(): string | undefined {
  const hydrated = useHydrated();
  const locale = useContext(SnapshotContext)?.locale;
  return hydrated ? undefined : locale;
}
