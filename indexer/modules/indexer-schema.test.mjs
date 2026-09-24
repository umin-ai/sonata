import test from "node:test";
import assert from "node:assert/strict";
import { HEAD_LAG_SECONDS, buyerNets, indexProgress, indexedThrough, migrateIndexerSchema } from "./indexer-schema.mjs";

const T = 1_790_000_000;
const fakeDb = (rows = []) => {
  const queries = [];
  return { queries, query: async (sql, args) => (queries.push({ sql, args }), { rows }) };
};

test("a market's progress is its slowest address's last complete sync, less the lag; unknown until each has completed", () => {
  assert.equal(HEAD_LAG_SECONDS, 60);
  assert.equal(indexProgress(undefined), null, "a pool the indexer has never seen");
  assert.equal(indexProgress({ synced_at: null, damm_pool: null }), null);
  assert.equal(indexProgress({ synced_at: T + 0.9, damm_pool: null }), T - 60);
  // A quiet pool whose newest trade is days old is still current.
  assert.equal(indexProgress({ synced_at: T, synced_through: T - 5 * 86_400, damm_pool: null }), T - 60);
  // Graduated: the DAMM v2 pool counts too, and has none until its first sync.
  assert.equal(indexProgress({ synced_at: T, damm_pool: "D", damm_synced_at: null }), null);
  assert.equal(indexProgress({ synced_at: T, damm_pool: "D", damm_synced_at: T - 300 }), T - 360);
  assert.equal(indexProgress({ synced_at: T - 30, damm_pool: "D", damm_synced_at: T }), T - 90);
  assert.equal(indexProgress({ synced_at: T, damm_pool: null }, { lag: 0 }), T);
});

test("indexedThrough reads the pool's row; buyerNets reports net quote and net base per trader, both venues", async () => {
  const db = fakeDb([{ synced_at: T, damm_pool: "D", damm_synced_at: T - 10 }]);
  assert.equal(await indexedThrough(db, "P"), T - 70);
  assert.deepEqual(db.queries[0].args, ["P"]);
  assert.match(db.queries[0].sql, /extract\(epoch from synced_at\).*damm_pool.*extract\(epoch from damm_synced_at\).*from pools where pool = \$1/s);
  assert.equal(await indexedThrough(fakeDb([]), "P"), null);

  const nets = fakeDb([{ trader: "A", net: "500", base: "12345678901234567890" }, { trader: "B", net: "5", base: "-3" }]);
  assert.deepEqual(await buyerNets(nets, "P", 100, 200), [
    { trader: "A", net: 500n, base: 12_345_678_901_234_567_890n },
    { trader: "B", net: 5n, base: -3n },
  ]);
  const { sql, args } = nets.queries[0];
  assert.deepEqual(args, ["P", 100, 200, 50]);
  assert.match(sql, /sum\(case when side = 'buy' then base_amount else -base_amount end\)::text as base/);
  assert.match(sql, /block_time >= to_timestamp\(\$2\) and block_time < to_timestamp\(\$3\)/);
  assert.doesNotMatch(sql, /venue/, "every venue counts");
});

test("the schema only adds columns and an index, each guarded, so it runs on every start", async () => {
  const db = fakeDb();
  await migrateIndexerSchema(db);
  const [{ sql }] = db.queries;
  for (const column of ["venue", "synced_through", "synced_at", "damm_pool", "damm_last_signature", "damm_synced_through", "damm_synced_at"])
    assert.match(sql, new RegExp(`add column if not exists ${column} `));
  assert.match(sql, /venue text not null default 'dbc' check \(venue in \('dbc', 'damm'\)\)/);
  assert.match(sql, /create unique index if not exists pools_damm_pool on pools \(damm_pool\)/);
  assert.doesNotMatch(sql, /\bdrop\b|\bdelete\b|\bupdate\b/i);
});
