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
import {
  SNAPSHOT_CHAIN_AFTER_MS,
  SNAPSHOT_FRESH_MS,
  type MarketsAnswer,
  type SnapshotEntry,
} from "@/lib/treasury/market-snapshot";

export type MarketList = { entries: SnapshotEntry[]; skipped: number };
const UNAVAILABLE = "Market data is temporarily unavailable.";

/**
 * The server's market list (/api/markets); throws when it is unavailable,
 * malformed, slower than `timeoutMs`, or its chain data is older than
 * SNAPSHOT_FRESH_MS: callers then read the chain themselves.
 */
export async function fetchSnapshot(
  timeoutMs = 4_000,
  get: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<MarketsAnswer> {
  const r = await get("/api/markets", { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw Error(UNAVAILABLE);
  const body = (await r.json()) as MarketsAnswer;
  if (body?.v !== 1 || !Array.isArray(body.entries) || typeof body.ageMs !== "number") throw Error(UNAVAILABLE);
  if (!(body.ageMs >= 0 && body.ageMs <= SNAPSHOT_FRESH_MS)) throw Error(UNAVAILABLE);
  return body;
}

export const listFromSnapshot = (s: Pick<MarketsAnswer, "entries" | "skipped">): MarketList => ({
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
 * snapshot when it answers with fresh data, else from the chain. `fresh`
 * (after a confirmed transaction, when the list may have just changed) reads
 * the chain. `fetchList` and `discover` are replaced only in tests.
 */
export async function listMarkets({
  fresh = false,
  fetchList = () => fetchSnapshot(),
  discover = () => discoverMarkets(),
}: {
  fresh?: boolean;
  fetchList?: () => Promise<Pick<MarketsAnswer, "entries" | "skipped">>;
  discover?: () => Promise<Market[]>;
} = {}): Promise<Market[]> {
  if (!fresh)
    try {
      const snapshot = await fetchList();
      const markets = fromSnapshot(snapshot.entries);
      // Nothing usable (or nothing verified) is left to the chain read, which reports why.
      if (markets.length || !(snapshot.entries.length || snapshot.skipped?.length)) return markets;
    } catch {
      /* The chain read below. */
    }
  return discover();
}

/**
 * What the market list does on mount, given the page's snapshot and the time
 * since the page started loading. Without one it loads behind today's
 * skeletons. Up to SNAPSHOT_FRESH_MS old it is used as it is. Older, it is
 * replaced quietly (fresh server data, else the chain); past
 * SNAPSHOT_CHAIN_AFTER_MS a failed replacement shows the error alert, so old
 * numbers never stay on screen without notice.
 */
export type MountPlan = { load: false } | { load: true; shown: boolean; alert: boolean };
export function mountPlan(initial: { ageMs: number } | null | undefined, elapsedMs: number): MountPlan {
  if (!initial) return { load: true, shown: true, alert: true };
  const age = initial.ageMs + elapsedMs;
  if (age <= SNAPSHOT_FRESH_MS) return { load: false };
  return { load: true, shown: false, alert: age > SNAPSHOT_CHAIN_AFTER_MS };
}
