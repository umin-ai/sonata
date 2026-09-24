import {
  KIND_LABEL,
  MAINNET_STOCKS,
  POOL_KINDS,
  XSTOCKS_LIST_URL,
  indexStocks,
  mergePools,
  parsePools,
  parseXStocks,
  poolDataUrl,
  transferFeeAt,
  type MainnetPool,
  type MainnetStock,
  type PoolKind,
  type StockIndex,
  type TransferFee,
} from "@/lib/liquidity/mainnet-pools";

// Live Meteora pools on mainnet that hold a tokenized stock, for the Pools
// page's Mainnet tab. Once a minute, shared by every visitor: one search per
// pool type finds every xStock pool (each xStock's token name contains
// "xStock"), checked against Backed's list of xStock mints; the PreStocks are
// looked up by mint. Each listed stock's transfer fee is read from its mint.
// Read-only.
type Payload = {
  pools: MainnetPool[];
  /** The stocks those pools hold. */
  stocks: MainnetStock[];
  updatedAt: number;
  /** Queries with no data at all: the list is incomplete for these. */
  missing: string[];
  /** Pools Meteora flags, left out. */
  flagged: number;
  transferFees: Record<string, TransferFee>;
  stale?: boolean;
};

// Read-only mainnet RPCs, tried in order. Solana's own public endpoint refuses
// requests that carry an Origin header, which some server runtimes add.
const MAINNET_RPCS = [
  process.env.SOLANA_MAINNET_RPC_URL,
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
].filter((u): u is string => !!u);
const TTL_MS = 60_000;
// After a failed read, answer from the last list for a while instead of asking Meteora again.
const RETRY_MS = 30_000;
// The pool reads never take longer than this, nor the transfer-fee reads longer
// than FEE_DEADLINE_MS; a visitor with a cached list waits at most WAIT_MS.
const READ_DEADLINE_MS = 12_000;
const FEE_DEADLINE_MS = 8_000;
// Backed's list is read first, with its own limit.
const LIST_DEADLINE_MS = 8_000;
const WAIT_MS = 3_000;
// A query's last good pools stand in for a failed one, up to this age.
const KEEP_MS = 30 * 60_000;
// Backed's xStock list changes rarely.
const XSTOCKS_TTL_MS = 6 * 60 * 60_000;
const CONCURRENCY = 8;
// A mint's transfer fee is re-read at most this often.
const FEE_TTL_MS = 10 * 60_000;

type Job = { key: string; kind: PoolKind; query: string; pages: number };
const JOBS: Job[] = [
  // Results come largest first, so a few pages reach the listing floor.
  ...POOL_KINDS.map((kind) => ({ key: `xStocks ${KIND_LABEL[kind]}`, kind, query: "xStock", pages: 6 })),
  ...MAINNET_STOCKS.filter((s) => s.family === "PreStocks").flatMap((s) =>
    POOL_KINDS.map((kind) => ({ key: `${s.symbol} ${KIND_LABEL[kind]}`, kind, query: s.mint, pages: 2 })),
  ),
];

// A free RPC call that hangs gives up after this, so the next RPC gets its turn.
const RPC_ATTEMPT_MS = 3_000;

const lastGood = new Map<string, { at: number; pools: MainnetPool[]; flagged: number }>();
let xStocks: { at: number; stocks: MainnetStock[] } | null = null;
const feeCache = new Map<string, { at: number; fee?: TransferFee }>();
let epochCache: { at: number; info: EpochInfo } | null = null;
let cached: { until: number; body: Payload } | null = null;
let retryAt = 0;
let pending: Promise<Payload> | null = null;
let pendingSince = 0;

async function getJson(url: string, signal: AbortSignal, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal, headers: { accept: "application/json", ...init?.headers } });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json();
}

// Sonata's stocks plus every xStock Backed lists (its own entry wins, for the logo).
async function stockIndex(signal: AbortSignal): Promise<{ index: StockIndex; complete: boolean }> {
  if (!xStocks || Date.now() - xStocks.at > XSTOCKS_TTL_MS)
    try {
      xStocks = { at: Date.now(), stocks: parseXStocks(await getJson(XSTOCKS_LIST_URL, signal)) };
    } catch (e) {
      console.warn("mainnet-pools: xStock list unavailable:", e instanceof Error ? e.message : e);
    }
  const listed = new Set(xStocks?.stocks.map((s) => s.mint));
  return {
    index: indexStocks([...MAINNET_STOCKS.filter((s) => !listed.has(s.mint)), ...(xStocks?.stocks ?? [])]),
    complete: !!xStocks?.stocks.length,
  };
}

async function readJob(job: Job, index: StockIndex, signal: AbortSignal) {
  const pools: MainnetPool[] = [];
  let flagged = 0,
    more = false;
  for (let page = 1; page <= job.pages; page++) {
    const result = parsePools(job.kind, await getJson(poolDataUrl(job.kind, job.query, page), signal), index);
    pools.push(...result.pools);
    flagged += result.flagged;
    more = result.more;
    if (!more) break;
  }
  // Still more pools above the floor after the last page read: the list is cut short.
  return { pools, flagged, capped: more };
}

// An abort signal for one attempt: its own time limit, and the caller's.
function attempt(outer: AbortSignal, ms: number) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  const stop = () => c.abort();
  if (outer.aborted) c.abort();
  else outer.addEventListener("abort", stop, { once: true });
  return {
    signal: c.signal,
    done() {
      clearTimeout(timer);
      outer.removeEventListener("abort", stop);
    },
  };
}

type Parsed = { data?: { parsed?: { info?: { extensions?: { extension: string; state: unknown }[] } } } } | null;
type EpochInfo = { epoch: number; slotIndex: number; slotsInEpoch: number };

async function rpc(method: string, params: unknown[], signal: AbortSignal) {
  let failure: unknown;
  for (const url of MAINNET_RPCS) {
    const a = attempt(signal, RPC_ATTEMPT_MS);
    try {
      const body = (await getJson(url, a.signal, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })) as { result?: unknown };
      if (body.result) return body.result;
      failure = Error(`${method} returned no result`);
    } catch (e) {
      failure = e;
    } finally {
      a.done();
    }
  }
  throw failure;
}

/** The transfer fee of each mint whose read succeeded; a failed batch leaves only its own mints unread. */
async function readTransferFees(mints: string[], signal: AbortSignal) {
  if (!epochCache || Date.now() - epochCache.at > FEE_TTL_MS)
    epochCache = { at: Date.now(), info: (await rpc("getEpochInfo", [], signal)) as EpochInfo };
  const { epoch, slotIndex, slotsInEpoch } = epochCache.info;
  // Free RPCs cap the accounts per request, so the mints are read 8 at a time.
  const batches = Array.from({ length: Math.ceil(mints.length / 8) }, (_, i) => mints.slice(i * 8, i * 8 + 8));
  const pages = await Promise.allSettled(
    batches.map((batch) => rpc("getMultipleAccounts", [batch, { encoding: "jsonParsed" }], signal)),
  );
  const fees = new Map<string, TransferFee | undefined>();
  pages.forEach((page, b) => {
    if (page.status !== "fulfilled") return;
    const accounts = (page.value as { value: Parsed[] }).value;
    batches[b].forEach((mint, i) => {
      const ext = accounts[i]?.data?.parsed?.info?.extensions?.find((e) => e.extension === "transferFeeConfig");
      fees.set(
        mint,
        transferFeeAt(ext?.state as Parameters<typeof transferFeeAt>[0], epoch, slotsInEpoch - slotIndex, slotsInEpoch),
      );
    });
  });
  return fees;
}

async function read(): Promise<Payload> {
  const now = Date.now();
  const { index, complete } = await stockIndex(AbortSignal.timeout(LIST_DEADLINE_MS));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), READ_DEADLINE_MS);
  try {
    // An xStock whose token name lacks "xStock" is missed by the search: looked up by mint.
    const jobs: Job[] = [
      ...JOBS,
      ...[...index.values()]
        .filter((s) => s.unnamed)
        .flatMap((s) =>
          POOL_KINDS.map((kind) => ({ key: `${s.symbol} ${KIND_LABEL[kind]}`, kind, query: s.mint, pages: 2 })),
        ),
    ];
    const fresh = new Map<string, { pools: MainnetPool[]; flagged: number }>();
    const capped: string[] = [];
    let next = 0;
    async function worker() {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          const result = await readJob(job, index, deadline.signal);
          fresh.set(job.key, result);
          lastGood.set(job.key, { at: now, ...result });
          if (result.capped) capped.push(`${job.key} past page ${job.pages}`);
        } catch {
          // Counted below: the job's last good read stands in if it is recent.
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (!fresh.size) throw Error("Meteora's pool data is unavailable.");
    const lists: MainnetPool[][] = [];
    const missing: string[] = [...(complete ? [] : ["the full xStock list"]), ...capped];
    let flagged = 0;
    for (const job of jobs) {
      const recent = now - (lastGood.get(job.key)?.at ?? 0) < KEEP_MS ? lastGood.get(job.key) : undefined;
      const result = fresh.get(job.key) ?? recent;
      if (!result) missing.push(job.key);
      else {
        lists.push(result.pools);
        flagged += result.flagged;
      }
    }
    const pools = mergePools(lists);
    const mints = [...new Set(pools.flatMap((p) => p.stockMints))];
    const stocks = mints.map((m) => index.get(m)!).filter(Boolean);
    const due = mints.filter((m) => now - (feeCache.get(m)?.at ?? 0) > FEE_TTL_MS);
    if (due.length)
      await readTransferFees(due, AbortSignal.timeout(FEE_DEADLINE_MS)).then(
        (fees) => fees.forEach((fee, mint) => feeCache.set(mint, { at: now, fee })),
        (e) => console.warn("mainnet-pools: transfer fees unavailable:", e instanceof Error ? e.message : e),
      );
    const transferFees: Record<string, TransferFee> = {};
    for (const s of stocks) {
      const fee = feeCache.get(s.mint)?.fee;
      if (fee) transferFees[s.symbol] = fee;
    }
    // A fee not read yet (its RPC read failed) is reported as unknown.
    const unread = stocks.filter((s) => !feeCache.has(s.mint)).length;
    if (unread) missing.push(unread === stocks.length ? "transfer fees" : "some transfer fees");
    return { pools, stocks, updatedAt: now, missing: missing.sort(), flagged, transferFees };
  } finally {
    clearTimeout(timer);
  }
}

// A read that never settled is abandoned rather than awaited forever.
function refresh(): { run: Promise<Payload>; started: boolean } {
  if (pending && Date.now() - pendingSince > LIST_DEADLINE_MS + READ_DEADLINE_MS + FEE_DEADLINE_MS + WAIT_MS)
    pending = null;
  if (pending) return { run: pending, started: false };
  pendingSince = Date.now();
  const run: Promise<Payload> = read()
    .then((body) => {
      cached = { until: Date.now() + TTL_MS, body };
      return body;
    })
    .catch((e) => {
      retryAt = Date.now() + RETRY_MS;
      throw e;
    })
    .finally(() => {
      if (pending === run) pending = null;
    });
  pending = run;
  return { run, started: true };
}

const unavailable = () =>
  Response.json({ error: "Meteora's pool data is unavailable right now. Try again in a minute." }, { status: 502 });

export async function GET() {
  const now = Date.now();
  if (cached && cached.until > now) return Response.json(cached.body);
  if (retryAt > now) return cached ? Response.json({ ...cached.body, stale: true }) : unavailable();
  const last = cached?.body;
  const orLast = () => (last ? Response.json({ ...last, stale: true }) : unavailable());
  const { run, started } = refresh();
  // The runtime (workerd) drops work a request leaves running once it has
  // answered, so the request that started a read waits for it to finish.
  // Others wait briefly, then answer with the last list.
  if (started || !last) return run.then((body) => Response.json(body), orLast);
  const fallback = new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_MS));
  const body = await Promise.race([run.catch(() => null), fallback]);
  return body ? Response.json(body) : orLast();
}
