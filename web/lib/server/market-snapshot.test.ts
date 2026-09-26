import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import fixtureJson from "../treasury/fixtures/devnet-markets.json" with { type: "json" };
import type { Fixture } from "../treasury/fixtures/fake-rpc.ts";
import { setConfigByte } from "../treasury/fixtures/config-bytes.ts";
import { identityOf, type Market } from "../treasury/runtime.ts";
import type { ProfileBody, RawStats } from "../treasury/market-snapshot.ts";
import { marketAccountsReader } from "../../indexer/modules/market-accounts.mjs";
import {
  ACCOUNTS_RETRY_MS,
  ACCOUNTS_TIMEOUT_MS,
  PRICE_MAX_AGE_MS,
  PRICE_REFRESH_MS,
  PRICE_RETRY_MS,
  PROFILE_RETRY_MS,
  STATS_FRESH_MS,
  STATS_MAX_AGE_MS,
  createMarketSnapshots,
  requestLocale,
  snapshotFromAccounts,
  SNAPSHOT_MAX_AGE_MS,
  type RawMarketAccounts,
  type SnapshotDeps,
} from "./market-snapshot.ts";

const fixture = fixtureJson as unknown as Fixture;
const golden = fixture.golden as { markets: Market[]; treasuries: Record<string, Record<string, unknown>> };
const idl = JSON.parse(readFileSync(new URL("../treasury/stockroom_treasury.json", import.meta.url), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const without = (s: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k)));
const comparable = (s: Record<string, unknown>) =>
  without(s, "fetchedAt", "poolFees", ...(s.migrated ? ["uncollected"] : []));

// What the indexer serves for the fixture's markets: its own reader over the capture.
async function indexerAnswer(readAt = 1_000_000): Promise<RawMarketAccounts> {
  const toInfo = (a: Fixture["accounts"][string]) =>
    a && { owner: new PublicKey(a.owner), lamports: a.lamports, executable: a.executable, data: Buffer.from(a.data[0], "base64") };
  const conn = {
    getProgramAccounts: async () =>
      fixture.programAccounts.map((p) => ({ pubkey: new PublicKey(p.pubkey), account: toInfo(p.account) })),
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({
      context: { slot: fixture.slot },
      value: keys.map((k) => toInfo(fixture.accounts[k.toBase58()])),
    }),
  };
  const reader = marketAccountsReader({
    conn,
    programId: idl.address,
    discriminator: idl.accounts.find((a: { name: string }) => a.name === "Treasury").discriminator,
    quoteMints: new Set(JSON.parse(readFileSync(new URL("../treasury/quote-assets.json", import.meta.url), "utf8")).assets.map((a: { mint: string }) => a.mint)),
    now: () => readAt,
    log: () => {},
  });
  return (await reader.read()) as unknown as RawMarketAccounts;
}

// The fixture's markets, newest launch first (their pools' activation points).
const NEWEST_FIRST = ["BACKED", "RWDCHK", "FPT", "ROOM"];
const bySymbol = (symbol: string) => golden.markets.find((m) => m.symbol === symbol)!;

test("the indexer's accounts, checked with the browser's code, give the golden markets and card numbers, newest first", async () => {
  const snapshot = snapshotFromAccounts(await indexerAnswer());
  assert.deepEqual(snapshot.skipped, []);
  assert.deepEqual(clone(snapshot.entries.map((e) => e.market)), NEWEST_FIRST.map((s) => clone(identityOf(bySymbol(s)))));
  for (const e of snapshot.entries) {
    assert.ok(e.data, e.error);
    assert.deepEqual(comparable(clone(e.data)), comparable(golden.treasuries[e.market.pool]), e.market.symbol);
    // Each entry is dated by its accounts' newest slot, and knows when its pool opened.
    assert.equal(e.version, fixture.slot);
    assert.ok(e.launchedAt! > 1_789_000_000 && e.launchedAt! < 1_791_000_000);
  }
  assert.deepEqual(snapshot.entries.map((e) => e.launchedAt), [1790248048, 1790246238, 1790155702, 1789665187]);
  // Plain JSON all the way: what the page carries is what the browser gets.
  assert.deepEqual(clone(snapshot.entries), snapshot.entries.map((e) => ({ ...e, data: clone(e.data) })));
});

test("an account the indexer did not read fails only its market; a foreign treasury account is skipped", async () => {
  const raw = await indexerAnswer();
  const [room, floor] = golden.markets;
  delete raw.accounts[floor.treasuryQuote];
  delete raw.accounts[room.pool];
  const fake = "So11111111111111111111111111111111111111112";
  raw.treasuries.push(fake);
  raw.accounts[fake] = { owner: "11111111111111111111111111111111", lamports: 1, executable: false, data: "", slot: 1 };
  const snapshot = snapshotFromAccounts(raw);
  assert.deepEqual(snapshot.entries.map((e) => e.market.symbol), ["BACKED", "RWDCHK", "FPT"]);
  const fpt = snapshot.entries.find((e) => e.market.symbol === "FPT")!;
  assert.equal(fpt.data, null);
  assert.match(fpt.error ?? "", /was not read/);
  assert.deepEqual(snapshot.skipped.map((s) => s.pool).sort(), [fake, room.pool].sort());
  assert.throws(() => snapshotFromAccounts({ ...raw, v: 2 } as unknown as RawMarketAccounts), /Unexpected/);
});

test("the listing rule on the server: a non-standard config, or one not owned by DBC, is not listed", async () => {
  const floor = golden.markets.find((m) => m.mode === "floor")!;
  const others = NEWEST_FIRST.filter((s) => s !== floor.symbol);
  const nonStandard = await indexerAnswer();
  const config = nonStandard.accounts[floor.config]!;
  nonStandard.accounts[floor.config] = {
    ...config,
    data: setConfigByte(Buffer.from(config.data, "base64"), "creatorTradingFeePercentage", 50).toString("base64"),
  };
  const notDbc = await indexerAnswer();
  notDbc.accounts[floor.config] = { ...notDbc.accounts[floor.config]!, owner: "11111111111111111111111111111111" };
  for (const raw of [nonStandard, notDbc]) {
    const snapshot = snapshotFromAccounts(raw);
    assert.deepEqual(snapshot.entries.map((e) => e.market.symbol), others);
    assert.deepEqual(snapshot.skipped, []);
  }
});

test("a treasury account owned by another program is skipped, however well its bytes decode", async () => {
  const raw = await indexerAnswer();
  const [room] = golden.markets;
  raw.accounts[room.treasury] = { ...raw.accounts[room.treasury]!, owner: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG" };
  const snapshot = snapshotFromAccounts(raw);
  assert.equal(snapshot.entries.some((e) => e.market.pool === room.pool), false);
  assert.deepEqual(snapshot.skipped, [{ pool: room.treasury, reason: "Treasury account is not owned by the Sonata program." }]);
});

test("requestLocale takes the first supported Accept-Language tag, else en-US", () => {
  const h = (v: string | null) => ({ get: () => v });
  assert.equal(requestLocale(h("fr-FR,fr;q=0.9,en;q=0.8")), "fr-FR");
  assert.equal(requestLocale(h("*, de;q=0.5")), "de");
  assert.equal(requestLocale(h(null)), "en-US");
  assert.equal(requestLocale(h("x".repeat(10_000))), "en-US");
  assert.equal(requestLocale(h("!!!,en-GB")), "en-GB");
});

// ---- The cache ----------------------------------------------------------------

const statsRow = (pool: string, volume = "5") => ({
  pool,
  last_price: 0.5,
  price_24h_ago: null,
  volume_24h: volume,
  trades_24h: 1,
  trades_total: 3,
});
const never = <T>() => new Promise<T>(() => {});

// `liveReads`: the indexer's answer is dated now on every read, as the real one is
// (otherwise it keeps answering its first read, which ages).
function harness(overrides: Partial<SnapshotDeps> = {}, { liveReads = false } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
  const counts = { accounts: 0, stats: 0, profiles: [] as string[], prices: [] as string[] };
  const scheduled: Promise<unknown>[] = [];
  let answer: Promise<RawMarketAccounts> | null = null;
  const deps: SnapshotDeps = {
    fetchAccounts: async () => {
      counts.accounts++;
      const raw = structuredClone(await (answer ??= indexerAnswer(t)));
      return liveReads ? { ...raw, readAt: t } : raw;
    },
    fetchStats: async () => {
      counts.stats++;
      return { supply: 1e15, pools: [statsRow(golden.markets[1].pool)] } as RawStats;
    },
    fetchProfile: async (uri) => {
      counts.profiles.push(uri);
      return { image: `${uri}#image`, description: "long text", sonata: { feeModel: "holders" } } as ProfileBody;
    },
    fetchPrice: async (symbol) => {
      counts.prices.push(symbol);
      return 650;
    },
    now: clock.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    timeout: () => new AbortController().signal,
    log: () => {},
    ...overrides,
  };
  const snapshots = createMarketSnapshots(deps);
  const schedule = (p: Promise<unknown>) => void scheduled.push(p);
  return {
    clock,
    counts,
    scheduled,
    snapshots,
    schedule,
    home: (budgetMs?: number) => snapshots.home({ schedule, budgetMs }),
    /** Lets everything handed to schedule() finish, as the Workers runtime does after a response. */
    drain: async () => {
      while (scheduled.length) await Promise.all(scheduled.splice(0));
    },
    setAnswer: (p: Promise<RawMarketAccounts> | null) => (answer = p),
  };
}
const uris = golden.markets.map((m) => m.uri).filter(Boolean) as string[];
// Resolves with how long `p` took in real time, or rejects after `ms`.
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(Error(`took over ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

test("the home snapshot carries every card, trimmed profiles, prices and stats", async () => {
  const h = harness();
  const home = await h.home();
  assert.ok(home);
  assert.equal(home.entries.length, 4);
  assert.equal(home.ageMs, 0);
  assert.deepEqual(Object.keys(home.profiles).sort(), [...uris].sort());
  // Cards need only the image and the fee model.
  for (const body of Object.values(home.profiles)) assert.deepEqual(Object.keys(body ?? {}).sort(), ["image", "sonata"]);
  // The fixture's markets trade against two stocks.
  assert.deepEqual(home.prices, { mSPY: 650, mQQQ: 650 });
  assert.deepEqual(home.stats?.pools, [statsRow(golden.markets[1].pool)]);
});

test("the indexer is asked at most every 2 s, and chain data over 3 minutes old is not served", async () => {
  const h = harness();
  await h.home();
  await h.home();
  assert.equal(h.counts.accounts, 1);
  h.clock.advance(2_000);
  await h.home();
  assert.equal(h.counts.accounts, 2);
  await h.drain();
  // The indexer keeps answering its last read: served while young enough, then not.
  h.clock.advance(SNAPSHOT_MAX_AGE_MS - 2_000);
  assert.ok(await h.home());
  await h.drain();
  h.clock.advance(2_001);
  assert.equal(await h.home(), null);
  assert.equal(await h.snapshots.marketPage(golden.markets[0].pool, { schedule: h.schedule }), null);
});

test("stale-while-revalidate: with usable chain data a request never waits for the indexer", async () => {
  let second = false;
  const h = harness();
  const first = await indexerAnswer(h.clock.now());
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => {
      h.counts.accounts++;
      if (second) return never();
      second = true;
      return structuredClone(first);
    },
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  assert.ok(await snapshots.home({ schedule: h.schedule }));
  h.clock.advance(2_000);
  const scheduledBefore = h.scheduled.length;
  const home = await within(snapshots.home({ schedule: h.schedule }), 50);
  assert.equal(home?.ageMs, 2_000);
  assert.equal(h.counts.accounts, 2, "the read was started");
  assert.ok(h.scheduled.length > scheduledBefore, "and handed to schedule()");
  // The market page too, and a request while that read is still out does not ask again.
  assert.ok(await within(snapshots.marketPage(golden.markets[0].pool, { schedule: h.schedule }), 50));
  assert.equal(h.counts.accounts, 2);
});

test("a read is awaited only when nothing usable is in memory, or by a caller that asks to (/api/markets)", async () => {
  let release: () => void = () => {};
  const h = harness();
  const raw = await indexerAnswer(h.clock.now());
  let gate: Promise<void> | null = null;
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => {
      h.counts.accounts++;
      if (gate) await gate;
      return { ...structuredClone(raw), readAt: h.clock.now() };
    },
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  await snapshots.home({ schedule: h.schedule });
  h.clock.advance(5_000);
  gate = new Promise((r) => (release = r));
  let done = false;
  const waiting = snapshots.home({ schedule: h.schedule, awaitRead: true }).then((r) => ((done = true), r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, "awaitRead waits for the due read");
  release();
  assert.equal((await waiting)?.ageMs, 0, "and serves it");
});

test("concurrent requests in a fresh process share one indexer read, each awaiting only its own work", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const h = harness();
  const raw = await indexerAnswer(h.clock.now());
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => {
      h.counts.accounts++;
      await gate;
      return structuredClone(raw);
    },
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  const all = Promise.all([
    ...Array.from({ length: 10 }, () => snapshots.home({ schedule: h.schedule })),
    ...Array.from({ length: 10 }, () => snapshots.marketPage(golden.markets[0].pool, { schedule: h.schedule })),
  ]);
  setTimeout(release, 30);
  const results = await all;
  assert.equal(h.counts.accounts, 1);
  assert.ok(results.every((r) => r !== null), "every request got the chain data");
});

test("an indexer that fails keeps the last copy until it is too old, and is asked again 10 s later", async () => {
  let fail = false;
  const h = harness();
  const real = await indexerAnswer(1_000_000);
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => {
      h.counts.accounts++;
      if (fail) throw Error("connect ECONNREFUSED 127.0.0.1:8790");
      return structuredClone(real);
    },
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: async () => {},
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  const home = () => snapshots.home({ schedule: h.schedule });
  assert.ok(await home());
  fail = true;
  h.clock.advance(2_000);
  const stale = await home();
  assert.equal(stale?.ageMs, 2_000);
  await Promise.all(h.scheduled);
  await home();
  assert.equal(h.counts.accounts, 2, "not asked again right after the failure");
  h.clock.advance(9_000);
  await home();
  assert.equal(h.counts.accounts, 2, "a failure waits 10 s for the next try");
  h.clock.advance(1_000);
  fail = false;
  assert.equal((await home())?.ageMs, 12_000);
  assert.equal(h.counts.accounts, 3);
});

test("the indexer's 1.5 s timeout: a cold request gives up when it fires, and the indexer is asked again 10 s later", async () => {
  const signals: { ms: number; controller: AbortController }[] = [];
  const h = harness({
    fetchAccounts: (signal) => {
      h.counts.accounts++;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error("The operation was aborted"))));
    },
    timeout: (ms) => {
      const controller = new AbortController();
      signals.push({ ms, controller });
      return controller.signal;
    },
  });
  const cold = h.home();
  await new Promise((r) => setTimeout(r, 5));
  const accounts = signals.find((s) => s.ms === ACCOUNTS_TIMEOUT_MS);
  assert.ok(accounts, "the indexer read carries a 1.5 s timeout");
  accounts.controller.abort();
  assert.equal(await cold, null);
  h.clock.advance(ACCOUNTS_RETRY_MS - 1);
  assert.equal(await h.home(), null);
  assert.equal(h.counts.accounts, 1, "not asked again within 10 s");
  h.clock.advance(1);
  void h.home();
  assert.equal(h.counts.accounts, 2);
});

test("an indexer that has not read yet (503 after a restart) is asked again after 1 s, not 10 s", async () => {
  let ready = false;
  const h = harness();
  const raw = await indexerAnswer(h.clock.now());
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => {
      h.counts.accounts++;
      if (!ready) throw Object.assign(Error("/api/index/accounts answered 503"), { status: 503 });
      return structuredClone(raw);
    },
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: async () => {},
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  assert.equal(await snapshots.home({ schedule: h.schedule }), null);
  h.clock.advance(999);
  await snapshots.home({ schedule: h.schedule });
  assert.equal(h.counts.accounts, 1);
  h.clock.advance(1);
  ready = true;
  assert.ok(await snapshots.home({ schedule: h.schedule }));
  assert.equal(h.counts.accounts, 2);
});

test("a clock that steps back is neither stuck nor served as fresh", async () => {
  const h = harness();
  let readAt = h.clock.now();
  const raw = await indexerAnswer(readAt);
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => {
      h.counts.accounts++;
      return { ...structuredClone(raw), readAt };
    },
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: async () => {},
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  const home = () => snapshots.home({ schedule: h.schedule });
  assert.ok(await home());
  // One hour back: the copy in memory is dated in the future, so its age is unknown.
  h.clock.advance(-3_600_000);
  assert.equal(await home(), null, "data dated an hour ahead is not served");
  assert.equal(h.counts.accounts, 2, "the indexer is asked again at once, not an hour later");
  // The indexer's next read carries the stepped-back time: it replaces the copy, although its time is earlier.
  readAt = h.clock.now();
  h.clock.advance(2_000);
  assert.equal((await home())?.ageMs, 2_000);
  await Promise.all(h.scheduled);
  h.clock.advance(1_000);
  const next = await home();
  assert.equal(next?.readAt, readAt);
  assert.equal(next?.ageMs, 3_000);
});

test("a newer indexer read lists the markets newest first, whatever order the indexer lists them in", async () => {
  const h = harness();
  const first = await h.home();
  const next = await indexerAnswer(h.clock.now() + 1_000);
  next.treasuries.reverse();
  h.setAnswer(Promise.resolve(next));
  h.clock.advance(2_000);
  await h.home();
  await h.drain();
  const second = await h.home();
  assert.deepEqual(second?.entries.map((e) => e.market.pool), first?.entries.map((e) => e.market.pool));
  assert.equal(second?.readAt, next.readAt);
});

test("stats: fetched once within 20 s, refreshed in the background after, kept up to 2 minutes through failures", async () => {
  let fail = false,
    volume = "5",
    gate: Promise<void> | null = null,
    release: () => void = () => {};
  const h = harness({
    fetchStats: async () => {
      h.counts.stats++;
      if (gate) await gate;
      if (fail) throw Error("indexer down");
      return { supply: 1, pools: [statsRow(golden.markets[1].pool, volume)] };
    },
  });
  const volumeOf = (home: Awaited<ReturnType<typeof h.home>>) => home?.stats?.pools[0]?.volume_24h;
  assert.equal(volumeOf(await h.home()), "5");
  h.clock.advance(STATS_FRESH_MS - 1);
  await h.home();
  assert.equal(h.counts.stats, 1, "not refetched within 20 s");
  h.clock.advance(1);
  volume = "6";
  gate = new Promise((r) => (release = r));
  assert.equal(volumeOf(await h.home()), "5", "the stale value is served while the refresh runs");
  assert.equal(h.counts.stats, 2);
  gate = null;
  release();
  await h.drain();
  assert.equal(volumeOf(await h.home()), "6");
  // Every later fetch fails: the last value is served up to 2 minutes, then none.
  fail = true;
  const lastAt = h.clock.now();
  for (let t = 0; t < STATS_MAX_AGE_MS; t += 15_000) {
    h.clock.set(lastAt + t);
    assert.equal(volumeOf(await h.home()), "6", `still served at ${t} ms`);
    await h.drain();
  }
  h.clock.set(lastAt + STATS_MAX_AGE_MS + 1);
  const home = await h.home();
  assert.equal(home?.stats, null);
});

test("stats rows that are malformed are dropped on the server; an answer that is not stats counts as a failure", async () => {
  const pool = golden.markets[1].pool;
  let answer: unknown = {
    supply: 1,
    pools: [
      statsRow(pool),
      { ...statsRow(golden.markets[2].pool), volume_24h: null },
      { pool: golden.markets[3].pool, volume24h: "1", trades24h: 1, tradesTotal: 1 },
    ],
  };
  const h = harness({ fetchStats: async () => answer as RawStats });
  const home = await h.home();
  assert.deepEqual(home?.stats?.pools, [statsRow(pool)]);
  answer = { supply: 1, rows: [] };
  h.clock.advance(STATS_MAX_AGE_MS + 1);
  const later = await h.home();
  assert.equal(later?.stats, null);
});

test("prices: a price is served up to 5 minutes while every refresh fails, then left out", async () => {
  let fail = false;
  const h = harness(
    {
      fetchPrice: async (symbol) => {
        h.counts.prices.push(symbol);
        if (fail) throw Error("Jupiter 429");
        return 650;
      },
    },
    { liveReads: true },
  );
  const setAt = h.clock.now();
  assert.equal((await h.home())?.prices.mSPY, 650);
  fail = true;
  for (let t = PRICE_REFRESH_MS; t <= PRICE_MAX_AGE_MS; t += PRICE_RETRY_MS / 2) {
    h.clock.set(setAt + t);
    assert.equal((await h.home())?.prices.mSPY, 650, `served at ${t} ms`);
    await h.drain();
  }
  h.clock.set(setAt + PRICE_MAX_AGE_MS + 1);
  assert.equal(Object.hasOwn((await h.home())?.prices ?? {}, "mSPY"), false);
});

test("a due price refresh that never answers does not hold up the request", async () => {
  const asked = new Set<string>();
  let calls = 0;
  const h = harness({
    // Each stock's first price answers; every refresh after that never does.
    fetchPrice: async (symbol) => (calls++, asked.has(symbol) ? never<number>() : (asked.add(symbol), 650)),
    // Real waits: a request that waited for this refresh would take its whole budget.
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  await h.home();
  h.clock.advance(PRICE_REFRESH_MS + 5_000);
  const home = await within(h.home(2_000), 50);
  assert.equal(home?.prices.mSPY, 650);
  assert.equal(calls, 4, "both refreshes were started");
});

test("slow or failing extras never fail the snapshot; late ones finish in the background for the next request", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((r) => (release = r));
  const h = harness({
    fetchProfile: async (uri) => {
      if (uri === uris[0]) {
        await slow;
        return { image: "late.png" };
      }
      throw Error("CloudFront 503");
    },
    fetchStats: async () => {
      throw Error("indexer down");
    },
    fetchPrice: async () => {
      throw Error("Jupiter 429");
    },
  });
  const home = await h.home(10);
  assert.ok(home);
  assert.equal(home.entries.length, 4);
  // A failed profile is served as null (the page does not ask again); one still loading is left out.
  assert.deepEqual(home.profiles, Object.fromEntries(uris.slice(1).map((u) => [u, null])));
  assert.deepEqual(home.prices, {});
  assert.equal(home.stats, null);
  assert.equal(h.scheduled.length, 1, "the unfinished work is handed to schedule()");
  release();
  await h.drain();
  h.clock.advance(100);
  const next = await h.home(10);
  assert.deepEqual(next?.profiles[uris[0]], { image: "late.png" });
});

test("a failed source is retried in the background only: no request waits for it again", async () => {
  let profileCalls = 0;
  const h = harness(
    {
      fetchProfile: async () => {
        profileCalls++;
        if (profileCalls === 1) throw Error("502");
        return never<ProfileBody>();
      },
      fetchPrice: async () => {
        throw Error("Jupiter 429");
      },
      // Real waits: a request that waited for the retry would take its whole budget.
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    { liveReads: true },
  );
  const market = golden.markets.find((m) => m.uri)!;
  const first = await h.snapshots.marketPage(market.pool, { schedule: h.schedule, budgetMs: 10 });
  assert.equal(first?.profile, null);
  h.clock.advance(PROFILE_RETRY_MS);
  const page = await within(h.snapshots.marketPage(market.pool, { schedule: h.schedule, budgetMs: 2_000 }), 50);
  assert.equal(profileCalls, 2, "the retry was started");
  assert.equal(page?.profile, null);
  assert.equal(Object.hasOwn(page ?? {}, "price"), false);
});

test("profiles are read once; a failed one is retried after 5 minutes; prices refresh after 30 s", async () => {
  const failing = new Set([uris[1]]);
  const h = harness({
    fetchProfile: async (uri) => {
      h.counts.profiles.push(uri);
      if (failing.has(uri)) throw Error("503");
      return { image: uri };
    },
    fetchPrice: async (symbol) => {
      h.counts.prices.push(symbol);
      return 1;
    },
  });
  let answer = await indexerAnswer(h.clock.now());
  h.setAnswer(Promise.resolve(answer));
  await h.home();
  assert.equal(h.counts.profiles.length, uris.length);
  h.clock.advance(60_000);
  await h.home();
  await h.drain();
  assert.equal(h.counts.profiles.length, uris.length, "nothing re-read within 5 minutes");
  assert.equal(h.counts.prices.length, 4, "both stocks' prices refreshed after 30 s");
  failing.clear();
  h.clock.advance(PROFILE_RETRY_MS - 60_000);
  answer = await indexerAnswer(h.clock.now());
  h.setAnswer(Promise.resolve(answer));
  await h.home();
  await h.drain();
  assert.deepEqual(h.counts.profiles.slice(uris.length), [uris[1]], "only the failed one is retried");
  const home = await h.home();
  assert.deepEqual(home?.profiles[uris[1]], { image: uris[1] });
});

test("the market page gets its entry with the full profile and price; an unknown pool gets null and starts nothing", async () => {
  const h = harness();
  const market = golden.markets[2];
  const page = await h.snapshots.marketPage(market.pool, { schedule: h.schedule });
  assert.ok(page);
  assert.deepEqual(page.entry.market, clone(identityOf(market)));
  assert.equal(page.profile?.description, "long text");
  assert.equal(page.price, 650);
  const before = { ...h.counts, profiles: h.counts.profiles.length, prices: h.counts.prices.length };
  assert.equal(await h.snapshots.marketPage("11111111111111111111111111111111", { schedule: h.schedule }), null);
  assert.equal(h.counts.profiles.length, before.profiles);
  assert.equal(h.counts.prices.length, before.prices);
});

// ---- Live push --------------------------------------------------------------------

test("with live push the indexer's own decode is used, a new stream position counts as new data, and pages carry the position", async () => {
  const h = harness();
  const raw = await indexerAnswer(h.clock.now());
  const decoded = snapshotFromAccounts(raw);
  let seq = 7;
  // The indexer's entries, marked so the test can tell they were used as they are.
  const answer = () => ({ ...structuredClone(raw), epoch: "lq3k9x", seq, entries: decoded.entries.map((e) => ({ ...e, market: { ...e.market, name: `${e.market.name}*` } })), skipped: [] });
  h.setAnswer(null);
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => (h.counts.accounts++, answer() as unknown as RawMarketAccounts),
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: async () => {},
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  const home = await snapshots.home({ schedule: h.schedule });
  assert.ok(home?.entries.every((e) => e.market.name.endsWith("*")), "the indexer's decode, not decoded again");
  assert.deepEqual(home?.stream, { epoch: "lq3k9x", seq: 7 });
  assert.deepEqual(snapshots.streamPosition(), { epoch: "lq3k9x", seq: 7 });
  // Same read time, a later position (a live change between the indexer's reads): taken.
  seq = 9;
  h.clock.advance(2_000);
  await snapshots.home({ schedule: h.schedule });
  await Promise.all(h.scheduled);
  const later = await snapshots.marketPage(bySymbol("FPT").pool, { schedule: h.schedule });
  assert.deepEqual(later?.stream, { epoch: "lq3k9x", seq: 9 });
  // Without live push: no position, and the server decodes the raw accounts itself.
  const plain = harness();
  const off = await plain.home();
  assert.equal(off?.stream, undefined);
  assert.equal(plain.snapshots.streamPosition(), null);
});

test("a market page whose market is not in the copy in memory asks the indexer once more (launched a moment ago)", async () => {
  const h = harness();
  const raw = await indexerAnswer(h.clock.now());
  const [newest, ...older] = raw.treasuries;
  let listed = older;
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => (h.counts.accounts++, { ...structuredClone(raw), treasuries: listed, readAt: h.clock.now() }),
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: async () => {},
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  assert.equal((await snapshots.home({ schedule: h.schedule }))?.entries.length, 3);
  const pool = golden.markets.find((m) => m.treasury === newest)!.pool;
  // Registered since: the page asks again at once (not 2 s later) and renders it.
  listed = raw.treasuries;
  h.clock.advance(100);
  const page = await snapshots.marketPage(pool, { schedule: h.schedule });
  assert.equal(page?.entry.market.pool, pool);
  assert.equal(h.counts.accounts, 2);
  // A pool that is not a market asks again at most every second, and not for something that is not an address.
  await snapshots.marketPage("11111111111111111111111111111111", { schedule: h.schedule });
  assert.equal(h.counts.accounts, 2, "within a second of the last extra read");
  h.clock.advance(1_000);
  await snapshots.marketPage("11111111111111111111111111111111", { schedule: h.schedule });
  assert.equal(h.counts.accounts, 3);
  // Missed in that copy: not asked again for it until the copy changes.
  h.clock.advance(1_000);
  await snapshots.marketPage("11111111111111111111111111111111", { schedule: h.schedule });
  assert.equal(h.counts.accounts, 3);
  await snapshots.marketPage("not-a-pool", { schedule: h.schedule });
  assert.equal(h.counts.accounts, 3);
  // Once the copy is refreshed (every 2 s), a page for it may ask once more.
  h.clock.advance(1_000);
  await snapshots.home({ schedule: h.schedule, awaitRead: true });
  const before = h.counts.accounts;
  await snapshots.marketPage("11111111111111111111111111111111", { schedule: h.schedule });
  assert.equal(h.counts.accounts, before + 1);
});

test("a market page whose market is missing does not ask the indexer while it is failing", async () => {
  const h = harness();
  const raw = await indexerAnswer(h.clock.now());
  let fail = false;
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => {
      h.counts.accounts++;
      if (fail) throw Error("indexer down");
      return { ...structuredClone(raw), readAt: h.clock.now() };
    },
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async () => ({}),
    fetchPrice: async () => null,
    now: h.clock.now,
    sleep: async () => {},
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  await snapshots.home({ schedule: h.schedule });
  fail = true;
  h.clock.advance(2_000);
  await snapshots.home({ schedule: h.schedule, awaitRead: true });
  const failed = h.counts.accounts;
  for (let i = 0; i < 5; i++) {
    h.clock.advance(1_000);
    await snapshots.marketPage(`${"1".repeat(31)}${i + 2}`, { schedule: h.schedule });
  }
  assert.equal(h.counts.accounts, failed, "within the 10 s backoff");
});
