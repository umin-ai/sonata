// Where the browser takes its market list from (markets-client.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fixtureJson from "../../lib/treasury/fixtures/devnet-markets.json" with { type: "json" };
import { identityOf, type Market } from "../../lib/treasury/runtime.ts";
import { SNAPSHOT_CHAIN_AFTER_MS, SNAPSHOT_FRESH_MS, type SnapshotEntry } from "../../lib/treasury/market-snapshot.ts";
import { fetchSnapshot, listMarkets, mountPlan } from "./markets-client.ts";

const golden = (fixtureJson as unknown as { golden: { markets: Market[] } }).golden;
const entries: SnapshotEntry[] = golden.markets.map((m) => ({ market: identityOf(m), data: null }));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test("mountPlan: none without a snapshot; used as is up to 15 s; replaced quietly after; an alert on failure after 60 s", () => {
  assert.deepEqual(mountPlan(null, 0), { load: true, shown: true, alert: true });
  assert.deepEqual(mountPlan({ ageMs: 0 }, 0), { load: false });
  assert.deepEqual(mountPlan({ ageMs: 10_000 }, SNAPSHOT_FRESH_MS - 10_000), { load: false });
  assert.deepEqual(mountPlan({ ageMs: 10_000 }, SNAPSHOT_FRESH_MS - 10_000 + 1), { load: true, shown: false, alert: false });
  assert.deepEqual(mountPlan({ ageMs: SNAPSHOT_CHAIN_AFTER_MS }, 0), { load: true, shown: false, alert: false });
  assert.deepEqual(mountPlan({ ageMs: SNAPSHOT_CHAIN_AFTER_MS }, 1), { load: true, shown: false, alert: true });
  assert.deepEqual(mountPlan({ ageMs: 170_000 }, 0), { load: true, shown: false, alert: true });
});

test("fetchSnapshot takes only a well-formed answer with chain data at most 15 s old", async () => {
  // new Response rather than Response.json: a polyfill the Solana libraries load can replace Response.
  const answer = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  const ok = { v: 1, ageMs: 3_000, readAt: 1, slot: 1, entries, skipped: [] };
  assert.equal((await fetchSnapshot(1_000, answer(ok))).entries.length, 4);
  assert.equal((await fetchSnapshot(1_000, answer({ ...ok, ageMs: SNAPSHOT_FRESH_MS }))).ageMs, SNAPSHOT_FRESH_MS);
  for (const [label, get] of [
    ["503", answer({ error: "Market snapshot unavailable." }, 503)],
    ["older than 15 s", answer({ ...ok, ageMs: SNAPSHOT_FRESH_MS + 1 })],
    ["no age", answer({ ...ok, ageMs: undefined })],
    ["another version", answer({ ...ok, v: 2 })],
    ["no entries", answer({ ...ok, entries: null })],
  ] as const)
    await assert.rejects(fetchSnapshot(1_000, get), /temporarily unavailable/, label);
});

test("listMarkets: the snapshot when it answers with usable markets, else the chain", async () => {
  let discovered: number = 0;
  const discover = async () => (discovered++, golden.markets);
  const fetchList = (value: unknown) => async () => value as { entries: SnapshotEntry[]; skipped: [] };
  assert.deepEqual(clone(await listMarkets({ fetchList: fetchList({ entries, skipped: [] }), discover })), golden.markets);
  assert.equal(discovered, 0, "no chain read");
  // Unavailable, malformed, stale (fetchSnapshot throws), or nothing verifiable: the chain.
  const cases: [string, () => Promise<{ entries: SnapshotEntry[]; skipped: never[] }>][] = [
    ["unavailable", async () => { throw Error("Market data is temporarily unavailable."); }],
    ["every identity fails", fetchList({ entries: entries.map((e) => ({ ...e, market: { ...e.market, treasury: e.market.pool } })), skipped: [] })],
    ["none listed, some skipped", fetchList({ entries: [], skipped: [{ pool: "p", reason: "r" }] })],
  ];
  for (const [label, get] of cases) {
    const before: number = discovered;
    assert.deepEqual(clone(await listMarkets({ fetchList: get, discover })), golden.markets, label);
    assert.equal(discovered, before + 1, label);
  }
  // An empty list that is really empty is not re-read.
  assert.deepEqual(await listMarkets({ fetchList: fetchList({ entries: [], skipped: [] }), discover }), []);
  // `fresh` (after a transaction) always reads the chain.
  const before: number = discovered;
  await listMarkets({ fresh: true, fetchList: fetchList({ entries, skipped: [] }), discover });
  assert.equal(discovered, before + 1);
});
