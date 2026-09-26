import "server-only";
import { quoteSymbolOf } from "@/lib/treasury/quote-assets";
import type {
  HomeSnapshot,
  MarketPageSnapshot,
  ProfileBody,
  RawStats,
  SkippedMarket,
  SnapshotEntry,
  StreamPosition,
} from "@/lib/treasury/market-snapshot";
import { decodedByIndexer, snapshotFromAccounts, streamOf, type RawMarketAccounts } from "@/lib/treasury/snapshot-decode";
import { fetchProfileBody } from "./token-meta";
import { cachedStockPrice, isPricedSymbol, resolveStockPrice } from "./stock-price";
import { cleanStats } from "@/lib/market-data";

// The market list and market pages are rendered on the server from a snapshot,
// so a visitor sees every card complete in the first HTML instead of waiting
// for their browser to read Solana. Import this only from server components
// and route handlers ("server-only" stops it reaching the browser or the SSR
// copy of the app, which would hold a second cache).
//
// Chain data: the indexer reads every market's raw accounts every 10 seconds
// (indexer/modules/market-accounts.mjs, /api/index/accounts on loopback). This
// module fetches that at most every 2 seconds per process and checks it with
// the browser's own code (lib/treasury/snapshot-decode.ts: treasuryEntries,
// marketsFromAccounts, treasuryFromAccounts), so the listing rule and the card
// checks are the same ones. With live push the indexer also keeps the accounts
// current between its reads and sends the entries it decoded with that same
// code, with the stream position they were taken at (`stream`): pages carry
// it, and open the live stream (/api/index/stream) from there. Chain data
// older than 3 minutes is never served; pages then fall back to the browser
// reading the chain, as before.
//
// Stale-while-revalidate: a request that finds usable data (chain data under 3
// minutes old, an extra under its max age) never waits for its refresh; the
// refresh starts in that request and runs on through `schedule` (after(), so
// the Workers runtime lets it finish after the response), and the next request
// gets its result. A request waits only for what it cannot serve at all: chain
// data in a fresh process or after a long idle (up to 1.5 s), a market page
// whose market is not in the copy in memory (one fresh read, up to 1.5 s: it
// may have launched a moment ago), and extras never read or expired (up to a
// short budget). Extras whose source failed are retried in the background
// only, so a broken source costs no visitor a wait. A request only ever awaits
// work it started itself: the Workers runtime does not let one request wait on
// another's I/O.
//
// Extras, each in its own cache of plain values: token profiles (kept for good
// once read: their files are content-addressed; retried 5 minutes after a
// failure, and served as null meanwhile), USD prices (refreshed after 30
// seconds, served up to 5 minutes) and the indexer's 24h stats (refreshed after
// 20 seconds, served up to 2 minutes, malformed rows dropped).

export { snapshotFromAccounts, type RawMarketAccounts };

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
/** The indexer answers 503 until its first read after a (re)start: asked again this soon. */
export const ACCOUNTS_NOT_READY_RETRY_MS = 1_000;
export const ACCOUNTS_TIMEOUT_MS = 1_500;
/** A market page whose market is not in the copy in memory asks the indexer again, at most this often. */
export const MISS_REFETCH_MS = 250;
/** Chain data older than this is not served. */
export const SNAPSHOT_MAX_AGE_MS = 3 * 60_000;
/** A time up to this far ahead of the clock counts as now; further, as unknown (a clock that stepped back). */
export const CLOCK_SKEW_MS = 5_000;
export const STATS_FRESH_MS = 20_000,
  STATS_MAX_AGE_MS = 2 * 60_000,
  STATS_TIMEOUT_MS = 1_500;
export const PRICE_REFRESH_MS = 30_000,
  PRICE_RETRY_MS = 60_000,
  PRICE_MAX_AGE_MS = 5 * 60_000;
export const PROFILE_RETRY_MS = 5 * 60_000;
const PROFILE_TIMEOUT_MS = 2_000,
  PROFILE_CONCURRENCY = 6;
// Work another request started is left to it for this long before it counts as lost.
const PENDING_MS = 10_000;

const POOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The HTTP status an error carries (getJson's), if any. */
const statusOf = (e: unknown) => (e && typeof e === "object" && "status" in e ? Number(e.status) : undefined);

export function createMarketSnapshots(deps: SnapshotDeps) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  const log = deps.log ?? ((line: string) => console.log(line));

  type Chain = ReturnType<typeof snapshotFromAccounts> & { stream: StreamPosition | null };
  let chain: Chain | null = null;
  // When the indexer may be asked next (2 s after an answer, 10 s after a failure), how many reads
  // are out, and the order they were started in (a read that ends after a later one is dropped).
  let nextAskAt = -Infinity,
    reading = 0,
    started = 0,
    applied = 0;
  let lastSummary = "";
  let failing = false;
  // When a market page last asked the indexer again for a market it did not find.
  let missAskedAt = -Infinity;
  // Stats, and when a fetch started (undefined: none out) or last failed (undefined: not since the last success).
  let stats: { value: RawStats; at: number } | null = null;
  let statsPending: number | undefined, statsFailedAt: number | undefined;
  const profiles = new Map<string, { body?: ProfileBody; failedAt?: number; pending?: number }>();
  const prices = new Map<string, { value?: number | null; at?: number; pending?: number; failedAt?: number }>();

  /**
   * How long ago `at` was: Infinity when there is no such time or it is further
   * ahead than CLOCK_SKEW_MS (the clock stepped back), so the value it dates
   * counts as expired and due, never as fresh.
   */
  const since = (at: number | undefined) => {
    if (at === undefined || !Number.isFinite(at)) return Infinity;
    const age = now() - at;
    return age < -CLOCK_SKEW_MS ? Infinity : Math.max(0, age);
  };
  const usable = () => (chain && since(chain.readAt) <= SNAPSHOT_MAX_AGE_MS ? chain : null);

  /** One indexer read, decoded when it is a new one. Never rejects. */
  async function refreshChain() {
    nextAskAt = now() + ACCOUNTS_REFETCH_MS;
    reading++;
    const id = ++started,
      startedAt = now();
    try {
      const raw = await deps.fetchAccounts(timeout(ACCOUNTS_TIMEOUT_MS));
      if (id < applied) return;
      applied = id;
      // A new read is one with another read time, earlier or later (a clock can
      // step back), or, with live push, another stream position (live changes
      // between the indexer's reads).
      const stream = streamOf(raw);
      if (!chain || raw?.readAt !== chain.readAt || stream?.epoch !== chain.stream?.epoch || stream?.seq !== chain.stream?.seq) {
        // The indexer's own decode (the same function) when it sends one; else decoded here.
        const decoded: Chain = { ...(decodedByIndexer(raw) ?? snapshotFromAccounts(raw)), stream };
        chain = decoded;
        const errors = decoded.entries.filter((e) => !e.data).length;
        const summary = `${decoded.entries.length} listed, ${decoded.skipped.length} skipped, ${errors} without numbers`;
        if (summary !== lastSummary || failing)
          log(`market snapshot: ${summary} (slot ${decoded.slot}, decoded in ${now() - startedAt} ms)`);
        lastSummary = summary;
      }
      failing = false;
    } catch (e) {
      // A read older than one already applied does not count.
      if (id < applied) return;
      if (!failing) log(`market snapshot: indexer accounts unavailable: ${e instanceof Error ? e.message : String(e)}`);
      failing = true;
      // An indexer that has not read yet (a restart) is asked again soon; one that failed, later.
      nextAskAt = now() + (statusOf(e) === 503 ? ACCOUNTS_NOT_READY_RETRY_MS : ACCOUNTS_RETRY_MS);
    } finally {
      reading--;
    }
  }

  /**
   * The latest usable chain data. The indexer is asked at most every 2 s (10 s
   * after a failure, 1 s after "not read yet"). With usable data in memory the
   * request gets it at once and the read goes to `schedule`, unless
   * `awaitRead` (a caller that needs the latest read more than speed); a
   * request with nothing usable waits for the read. While another request is
   * reading and nothing is usable (a fresh process), this one checks every
   * 50 ms, up to `waitMs`, instead of awaiting that request's fetch.
   */
  async function chainData(schedule: Schedule, waitMs: number, awaitRead = false) {
    // A next ask further off than any backoff means the clock stepped back: ask now.
    if (nextAskAt - now() > ACCOUNTS_RETRY_MS) nextAskAt = -Infinity;
    if (now() < nextAskAt) {
      for (let waited = 0; !usable() && reading && waited < waitMs; waited += 50) await sleep(50);
      return usable();
    }
    const read = refreshChain();
    const current = usable();
    if (current && !awaitRead) {
      schedule(read);
      return current;
    }
    await read;
    return usable();
  }

  /**
   * The chain data after one more indexer read, for a market page whose market
   * the copy in memory does not have (launched moments ago): at most one such
   * read every MISS_REFETCH_MS for the whole process, awaited by the request
   * that started it (up to the indexer timeout). A request that finds one just
   * started by another watches memory for its result for up to `waitMs`.
   */
  async function freshChain(waitMs: number) {
    if (now() - missAskedAt >= MISS_REFETCH_MS || missAskedAt - now() > MISS_REFETCH_MS) {
      missAskedAt = now();
      await refreshChain();
      return usable();
    }
    const before = chain;
    for (let waited = 0; reading && chain === before && waited < waitMs; waited += 50) await sleep(50);
    return usable();
  }

  // ---- Extras ----------------------------------------------------------------

  const servedStats = () => (stats && since(stats.at) <= STATS_MAX_AGE_MS ? stats.value : null);
  const servedPrice = (symbol: string): number | null | undefined => {
    const p = prices.get(symbol);
    return p && since(p.at) <= PRICE_MAX_AGE_MS ? p.value : undefined;
  };
  // Work lists: what the request waits for (values it cannot serve), and what only refreshes.
  type Work = { wait: Promise<void>[]; background: Promise<void>[] };
  const push = (list: Promise<void>[], p: Promise<void> | null) => void (p && list.push(p));

  function statsWork(work: Work) {
    if (since(stats?.at) < STATS_FRESH_MS || since(statsPending) < PENDING_MS) return;
    if (since(statsFailedAt) < STATS_FRESH_MS / 2) return;
    // Waited for only when there is nothing to serve and the source has not just failed.
    const list = !servedStats() && statsFailedAt === undefined ? work.wait : work.background;
    statsPending = now();
    list.push(
      deps
        .fetchStats(timeout(STATS_TIMEOUT_MS))
        .then((value) => {
          // Only well-formed rows, in plain JSON: the page parses them during render.
          stats = { value: cleanStats(value), at: now() };
          statsFailedAt = undefined;
        })
        .catch(() => {
          statsFailedAt = now();
        })
        .finally(() => {
          statsPending = undefined;
        }),
    );
  }

  function readProfiles(due: string[]): Promise<void> | null {
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
  // Profiles never read are waited for; a failed one is retried after 5 minutes, in the background.
  function profileWork(uris: string[], work: Work) {
    const first: string[] = [],
      retry: string[] = [];
    for (const uri of uris) {
      const p = profiles.get(uri);
      if (p?.body || since(p?.pending) < PENDING_MS) continue;
      if (p?.failedAt === undefined) first.push(uri);
      else if (since(p.failedAt) >= PROFILE_RETRY_MS) retry.push(uri);
    }
    push(work.wait, readProfiles(first));
    push(work.background, readProfiles(retry));
  }
  /** A profile as a page carries it: the body, null after a failed read, undefined before any. */
  const servedProfile = (uri: string): ProfileBody | null | undefined => {
    const p = profiles.get(uri);
    return p?.body ?? (p?.failedAt !== undefined ? null : undefined);
  };

  function readPrices(due: string[]): Promise<void> | null {
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
  // Prices are refreshed after 30 s; a missing one is waited for unless its source has just failed.
  function priceWork(symbols: string[], work: Work) {
    const missing: string[] = [],
      refresh: string[] = [];
    for (const symbol of symbols) {
      const p = prices.get(symbol);
      if (since(p?.pending) < PENDING_MS || since(p?.failedAt) < PRICE_RETRY_MS || since(p?.at) < PRICE_REFRESH_MS)
        continue;
      (servedPrice(symbol) === undefined && p?.failedAt === undefined ? missing : refresh).push(symbol);
    }
    push(work.wait, readPrices(missing));
    push(work.background, readPrices(refresh));
  }

  /** Hands all started work to `schedule` and waits up to `budgetMs` for the values the page cannot serve. */
  async function settle(work: Work, { schedule, budgetMs }: { schedule: Schedule; budgetMs: number }) {
    const all = [...work.wait, ...work.background];
    if (!all.length) return;
    schedule(Promise.all(all));
    if (work.wait.length && budgetMs > 0) await Promise.race([Promise.all(work.wait), sleep(budgetMs)]);
  }

  const urisOf = (entries: SnapshotEntry[]) => [
    ...new Set(entries.map((e) => e.market.uri).filter((u): u is string => !!u)),
  ];
  const symbolsOf = (entries: SnapshotEntry[]) => [...new Set(entries.map((e) => quoteSymbolOf(e.market.quoteMint)))];

  return {
    /**
     * The market list with everything its cards show, or null when no chain
     * data young enough is available. `budgetMs` 0 waits for no extras (they
     * are still started, for the next request). `awaitRead`: when an indexer
     * read is due, wait for it (up to 1.5 s) instead of serving the copy in
     * memory (/api/markets, whose callers act on the list).
     */
    async home({
      schedule,
      budgetMs = 500,
      awaitRead = false,
    }: {
      schedule: Schedule;
      budgetMs?: number;
      awaitRead?: boolean;
    }): Promise<Omit<HomeSnapshot, "locale"> | null> {
      const c = await chainData(schedule, ACCOUNTS_TIMEOUT_MS, awaitRead);
      if (!c) return null;
      const uris = urisOf(c.entries),
        symbols = symbolsOf(c.entries);
      // Profiles of markets no longer listed are dropped.
      for (const uri of profiles.keys()) if (!uris.includes(uri)) profiles.delete(uri);
      const work: Work = { wait: [], background: [] };
      statsWork(work);
      profileWork(uris, work);
      priceWork(symbols, work);
      await settle(work, { schedule, budgetMs });
      const shownProfiles: HomeSnapshot["profiles"] = {};
      for (const uri of uris) {
        const body = servedProfile(uri);
        // Cards show only the image and the fee model.
        if (body)
          shownProfiles[uri] = { ...(body.image ? { image: body.image } : {}), ...(body.sonata ? { sonata: body.sonata } : {}) };
        else if (body === null) shownProfiles[uri] = null;
      }
      const shownPrices: HomeSnapshot["prices"] = {};
      for (const symbol of symbols) {
        const value = servedPrice(symbol);
        if (value !== undefined) shownPrices[symbol] = value;
      }
      return {
        v: 1,
        ageMs: since(c.readAt),
        readAt: c.readAt,
        slot: c.slot,
        entries: c.entries,
        skipped: c.skipped,
        profiles: shownProfiles,
        prices: shownPrices,
        stats: servedStats(),
        ...(c.stream ? { stream: c.stream } : {}),
      };
    },
    /**
     * One market's entry with its full profile and price, or null if it is not
     * in young enough chain data. A market the copy in memory does not have is
     * looked for in one more indexer read first (freshChain): a market page
     * opened moments after its launch is then rendered complete too.
     */
    async marketPage(
      pool: string,
      { schedule, budgetMs = 500 }: { schedule: Schedule; budgetMs?: number },
    ): Promise<Omit<MarketPageSnapshot, "locale"> | null> {
      let c = await chainData(schedule, ACCOUNTS_TIMEOUT_MS);
      let entry = c?.entries.find((e) => e.market.pool === pool);
      if (c && !entry && POOL.test(pool)) {
        c = await freshChain(ACCOUNTS_TIMEOUT_MS);
        entry = c?.entries.find((e) => e.market.pool === pool);
      }
      // A pool that is not listed starts no other work: the pool comes from the URL.
      if (!c || !entry) return null;
      const symbol = quoteSymbolOf(entry.market.quoteMint);
      const work: Work = { wait: [], background: [] };
      if (entry.market.uri) profileWork([entry.market.uri], work);
      priceWork([symbol], work);
      await settle(work, { schedule, budgetMs });
      const profile = entry.market.uri ? servedProfile(entry.market.uri) : undefined;
      const price = servedPrice(symbol);
      return {
        v: 1,
        ageMs: since(c.readAt),
        readAt: c.readAt,
        slot: c.slot,
        entry,
        ...(profile !== undefined ? { profile } : {}),
        ...(price !== undefined ? { price } : {}),
        ...(c.stream ? { stream: c.stream } : {}),
      };
    },
    /**
     * Where the chain data in memory sits in the indexer's live stream, when
     * it pushes live updates and the data is young enough: a market page
     * without its market (launched moments ago) still opens the stream from
     * here, and switches over when the market is listed.
     */
    streamPosition: (): StreamPosition | null => usable()?.stream ?? null,
    /** For logs and tests. */
    status: () => ({
      readAt: chain?.readAt ?? null,
      stream: chain?.stream ?? null,
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
  if (!r.ok) throw Object.assign(Error(`${new URL(url).pathname} answered ${r.status}`), { status: r.status });
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
