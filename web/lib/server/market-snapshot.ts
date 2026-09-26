import "server-only";
import { Buffer } from "buffer";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { cardsFromAccounts, identityOf, treasuryEntries } from "@/lib/treasury/runtime";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
import {
  stableOrder,
  type HomeSnapshot,
  type MarketPageSnapshot,
  type ProfileBody,
  type RawStats,
  type SkippedMarket,
  type SnapshotEntry,
} from "@/lib/treasury/market-snapshot";
import { fetchProfileBody } from "./token-meta";
import { cachedStockPrice, isPricedSymbol, resolveStockPrice } from "./stock-price";

// The market list and market pages are rendered on the server from a snapshot,
// so a visitor sees every card complete in the first HTML instead of waiting
// for their browser to read Solana. Import this only from server components
// and route handlers ("server-only" stops it reaching the browser or the SSR
// copy of the app, which would hold a second cache).
//
// Chain data: the indexer reads every market's raw accounts every 10 seconds
// (indexer/modules/market-accounts.mjs, /api/index/accounts on loopback). This
// module fetches that at most every 2 seconds per process and checks it with
// the browser's own code (treasuryEntries, marketsFromAccounts,
// treasuryFromAccounts), so the listing rule and the card checks are the same
// ones. Chain data older than 3 minutes is never served; pages then fall back
// to the browser reading the chain, as before.
//
// Extras, each in its own cache of plain values: token profiles (kept for good
// once read: their files are content-addressed; retried 5 minutes after a
// failure), USD prices (60 seconds, served up to 5 minutes while a refresh
// runs) and the indexer's 24h stats (20 seconds, served up to 2 minutes). A
// request waits a short budget for missing extras and renders without the
// rest; those keep running through `schedule` (after(), so the Workers runtime
// lets them finish) and are there for the next request. A request only ever
// awaits work it started itself: the Workers runtime does not let one request
// wait on another's I/O.

type RawAccount = { owner: string; lamports: number; executable: boolean; data: string; slot: number } | null;
/** The indexer's /api/index/accounts answer. */
export type RawMarketAccounts = {
  v: 1;
  readAt: number;
  slot: number;
  treasuries: string[];
  accounts: Record<string, RawAccount>;
};
type Info = AccountInfo<Buffer> | null;

/**
 * The listed markets and their card numbers from the indexer's raw accounts,
 * checked with the browser's code. An account the indexer did not read fails
 * that market (it shows an error), never the list. `previous` keeps the order.
 */
export function snapshotFromAccounts(raw: RawMarketAccounts, previous?: readonly SnapshotEntry[]) {
  if (
    raw?.v !== 1 ||
    typeof raw.readAt !== "number" ||
    !Array.isArray(raw.treasuries) ||
    !raw.accounts ||
    typeof raw.accounts !== "object"
  )
    throw Error("Unexpected market accounts answer.");
  const decoded = new Map<string, Info>();
  const info = (key: string): Info => {
    if (decoded.has(key)) return decoded.get(key)!;
    if (!Object.hasOwn(raw.accounts, key)) throw Error(`Account ${key} was not read.`);
    const a = raw.accounts[key];
    const value =
      a &&
      ({
        owner: new PublicKey(a.owner),
        lamports: Number(a.lamports),
        executable: a.executable === true,
        data: Buffer.from(String(a.data), "base64"),
        rentEpoch: 0,
      } as AccountInfo<Buffer>);
    decoded.set(key, value);
    return value;
  };
  const listed = treasuryEntries(
    raw.treasuries.filter((k) => typeof k === "string"),
    info,
  );
  const { cards, skipped } = cardsFromAccounts(listed.entries, info, (k) => raw.accounts[k]?.slot ?? raw.slot);
  const entries = cards.map(
    (c): SnapshotEntry => ({ market: identityOf(c.market), data: c.data, ...(c.error ? { error: c.error } : {}) }),
  );
  return {
    readAt: raw.readAt,
    slot: Number(raw.slot) || 0,
    entries: stableOrder(previous, entries),
    skipped: [...listed.skipped, ...skipped],
  };
}

/** The visitor's number locale from Accept-Language: its first tag Intl supports, else en-US. */
export function requestLocale(headers: Pick<Headers, "get">) {
  const header = (headers.get("accept-language") ?? "").slice(0, 200);
  for (const part of header.split(",").slice(0, 8)) {
    const tag = part.split(";")[0].trim();
    if (!tag || tag === "*" || tag.length > 35) continue;
    try {
      const [supported] = Intl.NumberFormat.supportedLocalesOf([tag]);
      if (supported) return supported;
    } catch {
      /* not a language tag */
    }
  }
  return "en-US";
}

export type SnapshotDeps = {
  fetchAccounts: (signal: AbortSignal) => Promise<RawMarketAccounts>;
  fetchStats: (signal: AbortSignal) => Promise<RawStats>;
  fetchProfile: (uri: string, signal: AbortSignal) => Promise<ProfileBody>;
  /** USD per share of the stock behind a quote symbol; null when it has no usable price; throws on failure. */
  fetchPrice: (symbol: string) => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeout?: (ms: number) => AbortSignal;
  log?: (line: string) => void;
};
/** Keeps work alive after the response is sent: next/server's after() in the app. */
export type Schedule = (work: Promise<unknown>) => void;

export const ACCOUNTS_REFETCH_MS = 2_000;
/** After the indexer failed or timed out, it is asked again this much later. */
export const ACCOUNTS_RETRY_MS = 10_000;
export const ACCOUNTS_TIMEOUT_MS = 1_500;
/** Chain data older than this is not served. */
export const SNAPSHOT_MAX_AGE_MS = 3 * 60_000;
const STATS_FRESH_MS = 20_000,
  STATS_MAX_AGE_MS = 2 * 60_000,
  STATS_TIMEOUT_MS = 1_500;
const PRICE_REFRESH_MS = 30_000,
  PRICE_FRESH_MS = 60_000,
  PRICE_MAX_AGE_MS = 5 * 60_000;
const PROFILE_RETRY_MS = 5 * 60_000,
  PROFILE_TIMEOUT_MS = 2_000,
  PROFILE_CONCURRENCY = 6;
// Work another request started is left to it for this long before it counts as lost.
const PENDING_MS = 10_000;

export function createMarketSnapshots(deps: SnapshotDeps) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  const log = deps.log ?? ((line: string) => console.log(line));

  let chain: ReturnType<typeof snapshotFromAccounts> | null = null;
  // When the indexer may be asked next (2 s after an answer, 10 s after a failure), and whether a request is out.
  let nextAskAt = -Infinity,
    asking = false;
  let lastSummary = "";
  let failing = false;
  let stats: { value: RawStats; at: number } | null = null;
  let statsPending = 0,
    statsFailedAt = -Infinity;
  const profiles = new Map<string, { body?: ProfileBody; failedAt?: number; pending?: number }>();
  const prices = new Map<string, { value?: number | null; at?: number; pending?: number; failedAt?: number }>();

  const usable = () => (chain && now() - chain.readAt <= SNAPSHOT_MAX_AGE_MS ? chain : null);

  /**
   * The latest chain data: fetched from the indexer at most every 2 s (10 s
   * after a failure, so a slow or down indexer rarely costs a request a wait),
   * decoded once per indexer read. With no chain data yet (a fresh process) while another
   * request is fetching it, this request checks every 50 ms, up to `waitMs`,
   * instead of awaiting that request's fetch.
   */
  async function chainData(waitMs: number) {
    if (now() < nextAskAt) {
      for (let waited = 0; !usable() && asking && waited < waitMs; waited += 50) await sleep(50);
      return usable();
    }
    nextAskAt = now() + ACCOUNTS_REFETCH_MS;
    asking = true;
    const started = now();
    try {
      const raw = await deps.fetchAccounts(timeout(ACCOUNTS_TIMEOUT_MS));
      if (!chain || raw?.readAt > chain.readAt) {
        const decoded = snapshotFromAccounts(raw, chain?.entries);
        chain = decoded;
        const errors = decoded.entries.filter((e) => !e.data).length;
        const summary = `${decoded.entries.length} listed, ${decoded.skipped.length} skipped, ${errors} without numbers`;
        if (summary !== lastSummary || failing)
          log(`market snapshot: ${summary} (slot ${decoded.slot}, decoded in ${now() - started} ms)`);
        lastSummary = summary;
      }
      failing = false;
    } catch (e) {
      if (!failing) log(`market snapshot: indexer accounts unavailable: ${e instanceof Error ? e.message : String(e)}`);
      failing = true;
      nextAskAt = now() + ACCOUNTS_RETRY_MS;
    } finally {
      asking = false;
    }
    return usable();
  }

  // ---- Extras ----------------------------------------------------------------

  function statsWork(): Promise<void> | null {
    if (stats && now() - stats.at < STATS_FRESH_MS) return null;
    if (statsPending && now() - statsPending < PENDING_MS) return null;
    if (now() - statsFailedAt < STATS_FRESH_MS / 2) return null;
    statsPending = now();
    return deps
      .fetchStats(timeout(STATS_TIMEOUT_MS))
      .then((value) => {
        if (!value || !Array.isArray(value.pools)) throw Error("Unexpected stats answer.");
        stats = { value, at: now() };
      })
      .catch(() => {
        statsFailedAt = now();
      })
      .finally(() => {
        statsPending = 0;
      });
  }

  function profileWork(uris: string[]): Promise<void> | null {
    const due = uris.filter((uri) => {
      const p = profiles.get(uri);
      if (p?.body) return false;
      if (p?.pending && now() - p.pending < PENDING_MS) return false;
      return !p?.failedAt || now() - p.failedAt >= PROFILE_RETRY_MS;
    });
    if (!due.length) return null;
    for (const uri of due) profiles.set(uri, { ...profiles.get(uri), pending: now() });
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const uri = due[next++];
        try {
          const body = await deps.fetchProfile(uri, timeout(PROFILE_TIMEOUT_MS));
          profiles.set(uri, { body });
        } catch {
          profiles.set(uri, { failedAt: now() });
        }
      }
    };
    return Promise.all(Array.from({ length: Math.min(PROFILE_CONCURRENCY, due.length) }, worker)).then(() => {});
  }

  function priceWork(symbols: string[]): Promise<void> | null {
    const due = symbols.filter((symbol) => {
      const p = prices.get(symbol);
      if (p?.pending && now() - p.pending < PENDING_MS) return false;
      if (p?.failedAt !== undefined && now() - p.failedAt < PRICE_FRESH_MS) return false;
      return p?.at === undefined || now() - p.at >= PRICE_REFRESH_MS;
    });
    if (!due.length) return null;
    for (const symbol of due) prices.set(symbol, { ...prices.get(symbol), pending: now() });
    return Promise.all(
      due.map((symbol) =>
        deps.fetchPrice(symbol).then(
          (value) => void prices.set(symbol, { value, at: now() }),
          // A failure keeps the last price (served while it is young enough) and waits a minute to retry.
          () => void prices.set(symbol, { ...prices.get(symbol), pending: undefined, failedAt: now() }),
        ),
      ),
    ).then(() => {});
  }

  /** Starts the extras these entries need and waits up to `budgetMs` for them; the rest go to `schedule`. */
  async function fetchExtras(
    work: (Promise<void> | null)[],
    { schedule, budgetMs }: { schedule: Schedule; budgetMs: number },
  ) {
    const started = work.filter((w): w is Promise<void> => !!w);
    if (!started.length) return;
    const all = Promise.all(started);
    schedule(all);
    await Promise.race([all, sleep(budgetMs)]);
  }

  const servedStats = () => (stats && now() - stats.at <= STATS_MAX_AGE_MS ? stats.value : null);
  const servedPrice = (symbol: string): number | null | undefined => {
    const p = prices.get(symbol);
    return p?.at !== undefined && now() - p.at <= PRICE_MAX_AGE_MS ? p.value : undefined;
  };
  const urisOf = (entries: SnapshotEntry[]) => [
    ...new Set(entries.map((e) => e.market.uri).filter((u): u is string => !!u)),
  ];
  const symbolsOf = (entries: SnapshotEntry[]) => [...new Set(entries.map((e) => quoteSymbolOf(e.market.quoteMint)))];

  return {
    /** The market list with everything its cards show, or null when no chain data young enough is available. */
    async home({ schedule, budgetMs = 500 }: { schedule: Schedule; budgetMs?: number }): Promise<Omit<HomeSnapshot, "locale"> | null> {
      const c = await chainData(ACCOUNTS_TIMEOUT_MS);
      if (!c) return null;
      const uris = urisOf(c.entries),
        symbols = symbolsOf(c.entries);
      // Profiles of markets no longer listed are dropped.
      for (const uri of profiles.keys()) if (!uris.includes(uri)) profiles.delete(uri);
      await fetchExtras([statsWork(), profileWork(uris), priceWork(symbols)], { schedule, budgetMs });
      const shownProfiles: HomeSnapshot["profiles"] = {};
      for (const uri of uris) {
        const body = profiles.get(uri)?.body;
        // Cards show only the image and the fee model.
        if (body) shownProfiles[uri] = { ...(body.image ? { image: body.image } : {}), ...(body.sonata ? { sonata: body.sonata } : {}) };
      }
      const shownPrices: HomeSnapshot["prices"] = {};
      for (const symbol of symbols) {
        const value = servedPrice(symbol);
        if (value !== undefined) shownPrices[symbol] = value;
      }
      return {
        v: 1,
        ageMs: Math.max(0, now() - c.readAt),
        readAt: c.readAt,
        slot: c.slot,
        entries: c.entries,
        skipped: c.skipped,
        profiles: shownProfiles,
        prices: shownPrices,
        stats: servedStats(),
      };
    },
    /** One market's entry with its full profile and price, or null if it is not in young enough chain data. */
    async marketPage(
      pool: string,
      { schedule, budgetMs = 500 }: { schedule: Schedule; budgetMs?: number },
    ): Promise<Omit<MarketPageSnapshot, "locale"> | null> {
      const c = await chainData(ACCOUNTS_TIMEOUT_MS);
      // A pool that is not listed starts no work: the pool comes from the URL.
      const entry = c?.entries.find((e) => e.market.pool === pool);
      if (!c || !entry) return null;
      const symbol = quoteSymbolOf(entry.market.quoteMint);
      await fetchExtras([entry.market.uri ? profileWork([entry.market.uri]) : null, priceWork([symbol])], {
        schedule,
        budgetMs,
      });
      const profile = entry.market.uri ? profiles.get(entry.market.uri)?.body : undefined;
      const price = servedPrice(symbol);
      return {
        v: 1,
        ageMs: Math.max(0, now() - c.readAt),
        readAt: c.readAt,
        slot: c.slot,
        entry,
        ...(profile ? { profile } : {}),
        ...(price !== undefined ? { price } : {}),
      };
    },
    /** For logs and tests. */
    status: () => ({
      readAt: chain?.readAt ?? null,
      nextAskAt: Number.isFinite(nextAskAt) ? nextAskAt : null,
      profiles: profiles.size,
      prices: prices.size,
      stats: stats?.at ?? null,
    }),
  };
}

// ---- The app's instance ----------------------------------------------------------

const indexerBase = () => (process.env.INDEXER_URL || "https://sonata.umin.ai/api/index").replace(/\/+$/, "");
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!r.ok) throw Error(`${new URL(url).pathname} answered ${r.status}`);
  return (await r.json()) as T;
}

let instance: ReturnType<typeof createMarketSnapshots> | null = null;
/** The process's snapshot cache (one per server process). */
export function marketSnapshots() {
  instance ??= createMarketSnapshots({
    fetchAccounts: (signal) => getJson(process.env.MARKET_ACCOUNTS_URL || `${indexerBase()}/accounts`, signal),
    fetchStats: (signal) => getJson(`${indexerBase()}/stats`, signal),
    fetchProfile: fetchProfileBody,
    fetchPrice: async (symbol) => {
      if (!isPricedSymbol(symbol)) return null;
      const result = cachedStockPrice(symbol) ?? (await resolveStockPrice(symbol, { share: false }));
      return typeof result.price === "number" && result.price > 0 ? result.price : null;
    },
  });
  return instance;
}
export type { SkippedMarket };
