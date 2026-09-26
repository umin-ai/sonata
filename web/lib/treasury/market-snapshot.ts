// The server's market snapshot as pages and /api/markets carry it, shared by
// the server (lib/server/market-snapshot.ts) and the browser. Types and small
// helpers only: nothing here reads the chain.
//
// Everything in a snapshot is public chain data the server checked with the
// same code the browser runs. It is for display: the browser rebuilds a
// Market from the identity (marketFromIdentity, which derives what it can and
// takes nothing else), and anything that moves funds reads fresh state and
// passes readTreasury's binding check first.
import type { MarketIdentity, SkippedMarket, TreasuryState } from "./runtime";
import type { FeeModel, SplitRecipient } from "../token-profile";

export type { MarketIdentity, SkippedMarket };
/** A card's numbers: readTreasury's, without a graduated pool's fees (poolFees null). */
export type CardData = TreasuryState;
export type SnapshotEntry = {
  market: MarketIdentity;
  data: CardData | null;
  error?: string;
  /** When the pool opened for trading (unix seconds), when known: the list shows the newest first. */
  launchedAt?: number;
  /**
   * The newest slot among the accounts this entry was decoded from. Live
   * updates and re-reads replace an entry only with one at least as new, so
   * numbers never go back (versionOf).
   */
  version?: number;
};
/** Where a page's snapshot sits in the indexer's live stream (/api/index/stream): its process epoch and sequence. */
export type StreamPosition = { epoch: string; seq: number };
/** A token profile as app/api/token-meta returns it (validated again by parseProfile before display). */
export type ProfileBody = {
  description?: string;
  image?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  sonata?: { feeModel: FeeModel; split?: SplitRecipient[] };
};
/** The indexer's /stats answer as it is. */
export type RawStats = { supply: number; pools: Record<string, string | number | null>[] };
/** How old the snapshot's chain data was when it was served. */
type Served = { ageMs: number };
export type HomeSnapshot = Served & {
  v: 1;
  /** When the chain reads finished (ms). */
  readAt: number;
  /** The lowest slot of those reads. */
  slot: number;
  /** The listed markets, newest first (newestFirst). */
  entries: SnapshotEntry[];
  /** Registered markets that could not be verified (not listed). */
  skipped: SkippedMarket[];
  /**
   * Token profiles by URI: image and fee model only. null: the server could not
   * read it lately (the page shows no image and does not ask again). A URI
   * missing here was not read yet, and the browser loads it itself.
   */
  profiles: Record<string, ProfileBody | null>;
  /** USD per quote stock symbol; missing means unknown. */
  prices: Record<string, number | null>;
  stats: RawStats | null;
  /** The visitor's number locale, so the server's HTML and the first browser render format alike. */
  locale: string;
  /** Present when the indexer pushes live updates: the page opens its stream from here. */
  stream?: StreamPosition;
};
export type MarketPageSnapshot = Served & {
  v: 1;
  readAt: number;
  slot: number;
  entry: SnapshotEntry;
  /** As in HomeSnapshot.profiles: null when it could not be read lately, missing when not read yet. */
  profile?: ProfileBody | null;
  price?: number | null;
  locale: string;
  stream?: StreamPosition;
};

/** What /api/markets serves: the chain part of the home snapshot, without the extras (no caller uses them). */
export type MarketsAnswer = Omit<HomeSnapshot, "profiles" | "prices" | "stats" | "locale">;
/** What /api/markets?pool= serves: one market's chain part (the market page's fallback while its live stream is down). */
export type MarketAnswer = Omit<MarketPageSnapshot, "profile" | "price" | "locale">;

/** A snapshot younger than this at hydration is used as it is. */
export const SNAPSHOT_FRESH_MS = 15_000;
/** Up to this age the browser asks /api/markets for a newer copy; beyond it, it reads the chain itself. */
export const SNAPSHOT_CHAIN_AFTER_MS = 60_000;
/** The market page shows a snapshot's numbers only up to this age; older, it waits for the live read. */
export const SNAPSHOT_NUMBERS_MAX_AGE_MS = 60_000;

/** The most markets a list holds (the indexer reads at most this many, newest first). */
export const MAX_LISTED_MARKETS = 200;

/** An entry's version (see SnapshotEntry.version); entries read before versions existed use their numbers' slot. */
export const versionOf = (e: Pick<SnapshotEntry, "version" | "data">) => e.version ?? e.data?.slot ?? -1;

/** The market list's order: newest launch first; markets whose launch time is unknown last; then by pool. */
export function newestFirst<T extends { market: { pool: string }; launchedAt?: number }>(a: T, b: T) {
  const x = a.launchedAt ?? -1,
    y = b.launchedAt ?? -1;
  return x !== y ? y - x : a.market.pool < b.market.pool ? -1 : a.market.pool > b.market.pool ? 1 : 0;
}

/**
 * `next` in the order already shown: markets from `previous` keep their
 * place, and new ones follow in `next`'s order. Markets gone from `next` go.
 */
export function stableOrder<T extends { market: { pool: string } }>(previous: readonly T[] | undefined, next: T[]) {
  if (!previous?.length) return next;
  const rank = new Map(previous.map((e, i) => [e.market.pool, i]));
  return next
    .map((e, i) => ({ e, key: rank.get(e.market.pool) ?? previous.length + i }))
    .sort((a, b) => a.key - b.key)
    .map(({ e }) => e);
}
