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
  profiles: Record<string, ProfileBody>;
  prices: Record<string, number | null>;
  stats: Map<string, PoolStats> | null;
  locale?: string;
};
const SnapshotContext = createContext<Extras | null>(null);

export function SnapshotProvider({
  profiles,
  prices,
  stats,
  locale,
  children,
}: {
  profiles?: Record<string, ProfileBody>;
  prices?: Record<string, number | null>;
  stats?: RawStats | null;
  locale?: string;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({
      profiles: profiles ?? {},
      prices: prices ?? {},
      stats: stats ? parseStats(stats).pools : null,
      locale,
    }),
    [profiles, prices, stats, locale],
  );
  return <SnapshotContext.Provider value={value}>{children}</SnapshotContext.Provider>;
}

/** The token profile the snapshot carries for this URI (as /api/token-meta returns it), or undefined. */
export function useSnapshotProfile(uri?: string): ProfileBody | undefined {
  const c = useContext(SnapshotContext);
  return uri && c && Object.hasOwn(c.profiles, uri) ? c.profiles[uri] : undefined;
}

/** USD per share of the stock behind a quote symbol: a number, null (no usable price), or undefined (not in the snapshot). */
export function useSnapshotPrice(symbol: string): number | null | undefined {
  const c = useContext(SnapshotContext);
  return c && Object.hasOwn(c.prices, symbol) ? c.prices[symbol] : undefined;
}

/** The 24h stats by pool from the snapshot, or undefined when it has none. */
export function useSnapshotStats(): Map<string, PoolStats> | undefined {
  return useContext(SnapshotContext)?.stats ?? undefined;
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
