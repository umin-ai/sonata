// Where the browser gets the market list: the server's snapshot (/api/markets,
// checked on the server with the same listing rule and card checks), or its
// own batched chain read. Both give display data only; anything that moves
// funds re-reads the market with readTreasury.
import {
  discoverMarkets,
  marketFromIdentity,
  readMarketsAndCards,
  type Market,
} from "@/lib/treasury/runtime";
import type { HomeSnapshot, SnapshotEntry } from "@/lib/treasury/market-snapshot";

export type ServerSnapshot = Omit<HomeSnapshot, "locale">;
export type MarketList = { entries: SnapshotEntry[]; skipped: number };
const UNAVAILABLE = "Market data is temporarily unavailable.";

/** The server's market snapshot; throws when it is unavailable or slower than `timeoutMs`. */
export async function fetchSnapshot(timeoutMs = 4_000): Promise<ServerSnapshot> {
  const r = await fetch("/api/markets", { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw Error(UNAVAILABLE);
  const body = (await r.json()) as ServerSnapshot;
  if (body?.v !== 1 || !Array.isArray(body.entries)) throw Error(UNAVAILABLE);
  return body;
}

export const listFromSnapshot = (s: Pick<ServerSnapshot, "entries" | "skipped">): MarketList => ({
  entries: s.entries,
  skipped: s.skipped?.length ?? 0,
});

/** Every listed market with its card numbers, read by this browser: one getProgramAccounts and 1–2 getMultipleAccounts. */
export async function readLive(): Promise<MarketList> {
  const { cards, skipped } = await readMarketsAndCards();
  return {
    entries: cards.map((c) => ({ market: c.market, data: c.data, ...(c.error ? { error: c.error } : {}) })),
    skipped: skipped.length,
  };
}

/** Markets rebuilt from snapshot identities (marketFromIdentity); an entry that fails it is left out. */
export function fromSnapshot(entries: SnapshotEntry[]): Market[] {
  return entries.flatMap((e) => {
    try {
      return [marketFromIdentity(e.market)];
    } catch {
      return [];
    }
  });
}

/**
 * Every listed market, for pages that read or act on them: from the server's
 * snapshot when it answers, else from the chain. `fresh` (after a confirmed
 * transaction, when the list may have just changed) reads the chain.
 */
export async function listMarkets({ fresh = false } = {}): Promise<Market[]> {
  if (!fresh)
    try {
      const snapshot = await fetchSnapshot();
      const markets = fromSnapshot(snapshot.entries);
      // Nothing usable (or nothing verified) is left to the chain read, which reports why.
      if (markets.length || !(snapshot.entries.length || snapshot.skipped?.length)) return markets;
    } catch {
      /* The chain read below. */
    }
  return discoverMarkets();
}
