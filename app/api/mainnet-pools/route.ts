import {
  KIND_LABEL,
  MAINNET_STOCKS,
  POOL_KINDS,
  mergePools,
  parsePools,
  poolDataUrl,
  transferFeeAt,
  type MainnetPool,
  type PoolKind,
  type TransferFee,
} from "@/lib/liquidity/mainnet-pools";

// Live Meteora pools on mainnet that hold one of Sonata's stocks, for the Pools
// page's Mainnet tab: one read of Meteora's public pool data per minute (each
// stock, DLMM and DAMM v2), shared by every visitor, plus each stock's
// transfer fee from its mint. Read-only.
type Payload = {
  pools: MainnetPool[];
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
// A single read never takes longer than this; a visitor with a cached list waits at most WAIT_MS.
const READ_DEADLINE_MS = 12_000;
const WAIT_MS = 3_000;
// A stock's last good pools stand in for a failed query, up to this age.
const KEEP_MS = 30 * 60_000;
const CONCURRENCY = 8;

type Job = { symbol: string; mint: string; kind: PoolKind };
const JOBS: Job[] = MAINNET_STOCKS.flatMap((s) => POOL_KINDS.map((kind) => ({ symbol: s.symbol, mint: s.mint, kind })));
const jobKey = (j: Job) => `${j.symbol} ${KIND_LABEL[j.kind]}`;

const lastGood = new Map<string, { at: number; pools: MainnetPool[]; flagged: number }>();
let lastFees: Record<string, TransferFee> = {};
let cached: { until: number; body: Payload } | null = null;
let retryAt = 0;
let pending: Promise<Payload> | null = null;
let pendingSince = 0;

async function getJson(url: string, signal: AbortSignal, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal, headers: { accept: "application/json", ...init?.headers } });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json();
}

async function readJob(job: Job, signal: AbortSignal) {
  const pools: MainnetPool[] = [];
  let flagged = 0;
  // Two pages at most: past that, every pool is far below the listing floor.
  for (let page = 1; page <= 2; page++) {
    const result = parsePools(job.kind, await getJson(poolDataUrl(job.kind, job.mint, page), signal));
    pools.push(...result.pools);
    flagged += result.flagged;
    if (!result.more) break;
  }
  return { pools, flagged };
}

type Parsed = { data?: { parsed?: { info?: { extensions?: { extension: string; state: unknown }[] } } } } | null;
async function readTransferFees(signal: AbortSignal): Promise<Record<string, TransferFee>> {
  async function rpc(method: string, params: unknown[]) {
    let failure: unknown;
    for (const url of MAINNET_RPCS)
      try {
        const body = (await getJson(url, signal, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })) as { result?: unknown };
        if (body.result) return body.result;
        failure = Error(`${method} returned no result`);
      } catch (e) {
        failure = e;
      }
    throw failure;
  }
  // Free RPCs cap the accounts per request, so the mints are read 8 at a time.
  const mints = MAINNET_STOCKS.map((s) => s.mint);
  const batches = Array.from({ length: Math.ceil(mints.length / 8) }, (_, i) => mints.slice(i * 8, i * 8 + 8));
  const [epochInfo, ...pages] = (await Promise.all([
    rpc("getEpochInfo", []),
    ...batches.map((batch) => rpc("getMultipleAccounts", [batch, { encoding: "jsonParsed" }])),
  ])) as [{ epoch: number; slotIndex: number; slotsInEpoch: number }, ...{ value: Parsed[] }[]];
  const accounts = { value: pages.flatMap((page) => page.value) };
  const fees: Record<string, TransferFee> = {};
  MAINNET_STOCKS.forEach((s, i) => {
    const ext = accounts.value[i]?.data?.parsed?.info?.extensions?.find((e) => e.extension === "transferFeeConfig");
    const fee = transferFeeAt(
      ext?.state as Parameters<typeof transferFeeAt>[0],
      epochInfo.epoch,
      epochInfo.slotsInEpoch - epochInfo.slotIndex,
      epochInfo.slotsInEpoch,
    );
    if (fee) fees[s.symbol] = fee;
  });
  return fees;
}

async function read(): Promise<Payload> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), READ_DEADLINE_MS);
  try {
    const now = Date.now();
    const fresh = new Map<string, { pools: MainnetPool[]; flagged: number }>();
    let next = 0;
    async function worker() {
      while (next < JOBS.length) {
        const job = JOBS[next++];
        try {
          const result = await readJob(job, deadline.signal);
          fresh.set(jobKey(job), result);
          lastGood.set(jobKey(job), { at: now, ...result });
        } catch {
          // Counted below: the job's last good read stands in if it is recent.
        }
      }
    }
    const [, fees] = await Promise.all([
      Promise.all(Array.from({ length: CONCURRENCY }, worker)),
      readTransferFees(deadline.signal).catch((e) => {
        console.warn("mainnet-pools: transfer fees unavailable:", e instanceof Error ? e.message : e);
        return null;
      }),
    ]);
    if (!fresh.size) throw Error("Meteora's pool data is unavailable.");
    if (fees) lastFees = fees;
    const lists: MainnetPool[][] = [];
    const missing: string[] = [];
    let flagged = 0;
    for (const job of JOBS) {
      const key = jobKey(job);
      const result = fresh.get(key) ?? (now - (lastGood.get(key)?.at ?? 0) < KEEP_MS ? lastGood.get(key) : undefined);
      if (!result) missing.push(key);
      else {
        lists.push(result.pools);
        flagged += result.flagged;
      }
    }
    return { pools: mergePools(lists), updatedAt: now, missing: missing.sort(), flagged, transferFees: lastFees };
  } finally {
    clearTimeout(timer);
  }
}

// The runtime can drop work left running after a response; a read that never
// settled is abandoned rather than awaited forever.
function refresh() {
  if (pending && Date.now() - pendingSince > READ_DEADLINE_MS + WAIT_MS) pending = null;
  if (pending) return pending;
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
  return (pending = run);
}

const unavailable = () =>
  Response.json({ error: "Meteora's pool data is unavailable right now. Try again in a minute." }, { status: 502 });

export async function GET() {
  const now = Date.now();
  if (cached && cached.until > now) return Response.json(cached.body);
  if (retryAt > now) return cached ? Response.json({ ...cached.body, stale: true }) : unavailable();
  const reading = refresh();
  if (!cached) return reading.then((body) => Response.json(body), unavailable);
  // A list is on hand: wait briefly for the new one, else answer with the last one.
  const last = cached.body;
  const fallback = new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_MS));
  const body = await Promise.race([reading.catch(() => null), fallback]);
  return Response.json(body ?? { ...last, stale: true });
}
