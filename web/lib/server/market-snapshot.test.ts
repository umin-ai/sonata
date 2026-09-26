import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import fixtureJson from "../treasury/fixtures/devnet-markets.json" with { type: "json" };
import type { Fixture } from "../treasury/fixtures/fake-rpc.ts";
import { identityOf, type Market } from "../treasury/runtime.ts";
import { stableOrder, type ProfileBody, type RawStats } from "../treasury/market-snapshot.ts";
import { marketAccountsReader } from "../../indexer/modules/market-accounts.mjs";
import {
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

test("the indexer's accounts, checked with the browser's code, give the golden markets and card numbers", async () => {
  const snapshot = snapshotFromAccounts(await indexerAnswer());
  assert.deepEqual(snapshot.skipped, []);
  assert.deepEqual(clone(snapshot.entries.map((e) => e.market)), golden.markets.map((m) => clone(identityOf(m))));
  for (const e of snapshot.entries) {
    assert.ok(e.data, e.error);
    assert.deepEqual(comparable(clone(e.data)), comparable(golden.treasuries[e.market.pool]), e.market.symbol);
  }
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
  assert.deepEqual(snapshot.entries.map((e) => e.market.symbol), ["FPT", "RWDCHK", "BACKED"]);
  const fpt = snapshot.entries.find((e) => e.market.symbol === "FPT")!;
  assert.equal(fpt.data, null);
  assert.match(fpt.error ?? "", /was not read/);
  assert.deepEqual(snapshot.skipped.map((s) => s.pool).sort(), [fake, room.pool].sort());
  assert.throws(() => snapshotFromAccounts({ ...raw, v: 2 } as unknown as RawMarketAccounts), /Unexpected/);
});

test("stableOrder keeps the order shown and appends new markets", () => {
  const e = (pool: string) => ({ market: { pool } });
  assert.deepEqual(stableOrder([e("b"), e("a")], [e("a"), e("c"), e("b")]).map((x) => x.market.pool), ["b", "a", "c"]);
  assert.deepEqual(stableOrder(undefined, [e("a")]).map((x) => x.market.pool), ["a"]);
  assert.deepEqual(stableOrder([e("gone"), e("a")], [e("a")]).map((x) => x.market.pool), ["a"]);
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

function harness(overrides: Partial<SnapshotDeps> = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const counts = { accounts: 0, stats: 0, profiles: [] as string[], prices: [] as string[] };
  const scheduled: Promise<unknown>[] = [];
  let answer: Promise<RawMarketAccounts> | null = null;
  const deps: SnapshotDeps = {
    fetchAccounts: async () => {
      counts.accounts++;
      return structuredClone(await (answer ??= indexerAnswer(t)));
    },
    fetchStats: async () => {
      counts.stats++;
      return { supply: 1e15, pools: [{ pool: golden.markets[1].pool, volume_24h: "5", trades_24h: 1 }] } as RawStats;
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
    setAnswer: (p: Promise<RawMarketAccounts> | null) => (answer = p),
  };
}
const uris = golden.markets.map((m) => m.uri).filter(Boolean) as string[];

test("the home snapshot carries every card, trimmed profiles, prices and stats", async () => {
  const h = harness();
  const home = await h.snapshots.home({ schedule: h.schedule });
  assert.ok(home);
  assert.equal(home.entries.length, 4);
  assert.equal(home.ageMs, 0);
  assert.deepEqual(Object.keys(home.profiles).sort(), [...uris].sort());
  // Cards need only the image and the fee model.
  for (const body of Object.values(home.profiles)) assert.deepEqual(Object.keys(body).sort(), ["image", "sonata"]);
  // The fixture's markets trade against two stocks.
  assert.deepEqual(home.prices, { mSPY: 650, mQQQ: 650 });
  assert.equal(home.stats?.pools.length, 1);
});

test("the indexer is asked at most every 2 s, and chain data over 3 minutes old is not served", async () => {
  const h = harness();
  await h.snapshots.home({ schedule: h.schedule });
  await h.snapshots.home({ schedule: h.schedule });
  assert.equal(h.counts.accounts, 1);
  h.clock.advance(2_000);
  await h.snapshots.home({ schedule: h.schedule });
  assert.equal(h.counts.accounts, 2);
  // The indexer keeps answering its last read: served while young enough, then not.
  h.clock.advance(SNAPSHOT_MAX_AGE_MS - 2_000);
  assert.ok(await h.snapshots.home({ schedule: h.schedule }));
  h.clock.advance(2_001);
  assert.equal(await h.snapshots.home({ schedule: h.schedule }), null);
  assert.equal(await h.snapshots.marketPage(golden.markets[0].pool, { schedule: h.schedule }), null);
});

test("an indexer that fails keeps the last copy until it is too old, and costs requests no wait meanwhile", async () => {
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
  assert.ok(await snapshots.home({ schedule: h.schedule }));
  fail = true;
  h.clock.advance(2_000);
  const stale = await snapshots.home({ schedule: h.schedule });
  assert.equal(stale?.ageMs, 2_000);
  await snapshots.home({ schedule: h.schedule });
  assert.equal(h.counts.accounts, 2, "not asked again within 2 s of the failure");
});

test("a newer indexer read keeps the order already shown and appends new markets", async () => {
  const h = harness();
  const first = await h.snapshots.home({ schedule: h.schedule });
  const next = await indexerAnswer(2_000_000);
  next.treasuries.reverse();
  h.setAnswer(Promise.resolve(next));
  h.clock.advance(2_000);
  const second = await h.snapshots.home({ schedule: h.schedule });
  assert.deepEqual(second?.entries.map((e) => e.market.pool), first?.entries.map((e) => e.market.pool));
  assert.equal(second?.readAt, 2_000_000);
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
  const home = await h.snapshots.home({ schedule: h.schedule, budgetMs: 10 });
  assert.ok(home);
  assert.equal(home.entries.length, 4);
  assert.deepEqual(home.profiles, {});
  assert.deepEqual(home.prices, {});
  assert.equal(home.stats, null);
  assert.equal(h.scheduled.length, 1, "the unfinished work is handed to schedule()");
  release();
  await h.scheduled[0];
  h.clock.advance(100);
  const next = await h.snapshots.home({ schedule: h.schedule, budgetMs: 10 });
  assert.deepEqual(next?.profiles, { [uris[0]]: { image: "late.png" } });
});

test("profiles are read once; a failed one is retried after 5 minutes; prices refresh after 30 s", async () => {
  const failing = new Set([uris[1]]);
  const h = harness();
  const snapshots = createMarketSnapshots({
    fetchAccounts: async () => structuredClone(await indexerAnswer(h.clock.now())),
    fetchStats: async () => ({ supply: 0, pools: [] }),
    fetchProfile: async (uri) => {
      h.counts.profiles.push(uri);
      if (failing.has(uri)) throw Error("503");
      return { image: uri };
    },
    fetchPrice: async (symbol) => {
      h.counts.prices.push(symbol);
      return 1;
    },
    now: h.clock.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    timeout: () => new AbortController().signal,
    log: () => {},
  });
  await snapshots.home({ schedule: h.schedule });
  assert.equal(h.counts.profiles.length, uris.length);
  h.clock.advance(60_000);
  await snapshots.home({ schedule: h.schedule });
  assert.equal(h.counts.profiles.length, uris.length, "nothing re-read within 5 minutes");
  assert.equal(h.counts.prices.length, 4, "both stocks' prices refreshed after 30 s");
  failing.clear();
  h.clock.advance(4 * 60_000);
  const home = await snapshots.home({ schedule: h.schedule });
  assert.deepEqual(h.counts.profiles.slice(uris.length), [uris[1]], "only the failed one is retried");
  assert.equal(Object.keys(home?.profiles ?? {}).length, uris.length);
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
