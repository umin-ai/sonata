import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { keyBatches, marketAccountsReader, MAX_KEYS_PER_CALL } from "./market-accounts.mjs";
import { api } from "../index.mjs";

// The app's capture of four Devnet markets: exactly the keys runtime.ts reads for their cards.
const fixture = JSON.parse(
  readFileSync(new URL("../../lib/treasury/fixtures/devnet-markets.json", import.meta.url), "utf8"),
);
const idl = JSON.parse(readFileSync(new URL("../../lib/treasury/stockroom_treasury.json", import.meta.url), "utf8"));
const DISCRIMINATOR = idl.accounts.find((a) => a.name === "Treasury").discriminator;
const QUOTE_MINTS = new Set(
  JSON.parse(readFileSync(new URL("../../lib/treasury/quote-assets.json", import.meta.url), "utf8")).assets.map((a) => a.mint),
);
const toInfo = (a) =>
  a && { owner: new PublicKey(a.owner), lamports: a.lamports, executable: a.executable, data: Buffer.from(a.data[0], "base64") };

function fakeConn({ programAccounts = fixture.programAccounts, fail } = {}) {
  const calls = [];
  return {
    calls,
    async getProgramAccounts(program, config) {
      calls.push({ method: "getProgramAccounts", program: program.toBase58(), config });
      if (fail) throw Error(fail);
      return programAccounts.map(({ pubkey, account }) => ({ pubkey: new PublicKey(pubkey), account: toInfo(account) }));
    },
    async getMultipleAccountsInfoAndContext(keys) {
      calls.push({ method: "getMultipleAccounts", keys: keys.map((k) => k.toBase58()) });
      return {
        context: { slot: fixture.slot },
        value: keys.map((k) => {
          const key = k.toBase58();
          if (!Object.hasOwn(fixture.accounts, key)) throw Error(`reader asked for ${key}, which the app never reads`);
          return toInfo(fixture.accounts[key]);
        }),
      };
    },
  };
}
const reader = (conn, extra = {}) =>
  marketAccountsReader({
    conn,
    programId: fixture.treasuryProgram,
    discriminator: DISCRIMINATOR,
    quoteMints: QUOTE_MINTS,
    now: () => 1_000,
    log: () => {},
    ...extra,
  });

test("reads exactly the accounts the app reads for each card, in one call for four markets", async () => {
  const conn = fakeConn();
  const snapshot = await reader(conn).read();
  assert.deepEqual(snapshot.treasuries, fixture.programAccounts.map((p) => p.pubkey));
  assert.deepEqual(Object.keys(snapshot.accounts).sort(), Object.keys(fixture.accounts).sort());
  for (const [key, a] of Object.entries(snapshot.accounts)) {
    const raw = fixture.accounts[key];
    assert.deepEqual(a, raw && { owner: raw.owner, lamports: raw.lamports, executable: raw.executable, data: raw.data[0], slot: fixture.slot }, key);
  }
  assert.equal(snapshot.slot, fixture.slot);
  assert.equal(snapshot.calls, 2);
  assert.deepEqual(conn.calls.map((c) => c.method), ["getProgramAccounts", "getMultipleAccounts"]);
  // Only treasury accounts: the discriminator filter is sent.
  assert.equal(conn.calls[0].config.filters[0].memcmp.offset, 0);
});

test("treasuries on a quote mint that is not a registered mock stock are not read", async () => {
  const programAccounts = structuredClone(fixture.programAccounts);
  const data = Buffer.from(programAccounts[0].account.data[0], "base64");
  new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(data, 72);
  programAccounts[0].account.data = [data.toString("base64"), "base64"];
  const snapshot = await reader(fakeConn({ programAccounts })).read();
  assert.deepEqual(snapshot.treasuries, fixture.programAccounts.slice(1).map((p) => p.pubkey));
});

test("a failed read keeps the last good one, and one read runs at a time", async () => {
  let fail = null;
  const conn = fakeConn();
  const wrapped = {
    getProgramAccounts: (...a) => (fail ? Promise.reject(Error(fail)) : conn.getProgramAccounts(...a)),
    getMultipleAccountsInfoAndContext: (...a) => conn.getMultipleAccountsInfoAndContext(...a),
  };
  const logs = [];
  const r = reader(wrapped, { log: (...a) => logs.push(a.join(" ")) });
  assert.equal(r.current(), null);
  await Promise.all([r.tick(), r.tick(), r.tick()]);
  assert.equal(conn.calls.filter((c) => c.method === "getProgramAccounts").length, 1);
  const good = r.current();
  assert.ok(good);
  fail = "fetch failed";
  await r.tick();
  await r.tick();
  assert.equal(r.current(), good);
  // One line when it starts failing, one when it recovers.
  assert.equal(logs.filter((l) => l.includes("failed")).length, 1);
  fail = null;
  await r.tick();
  assert.equal(logs.length, 3);
});

test("calls hold at most 100 keys, shared keys first, one market's keys never split", () => {
  const groups = Array.from({ length: 40 }, (_, i) => Array.from({ length: 7 }, (_, j) => `m${i}k${j}`));
  const batches = keyBatches(groups, ["q1", "q2", "program"]);
  assert.ok(batches.every((b) => b.length <= MAX_KEYS_PER_CALL));
  assert.deepEqual(batches[0].slice(0, 3), ["q1", "q2", "program"]);
  for (const g of groups) assert.equal(new Set(g.map((k) => batches.findIndex((b) => b.includes(k)))).size, 1);
  assert.equal(batches.flat().length, 283);
});

test("the API serves the last read at /api/index/accounts, and 503 before the first", async () => {
  let current = null;
  const { route } = api({ db: null, state: {}, accounts: () => current });
  const url = new URL("http://localhost/api/index/accounts");
  assert.equal(await route(url), 503);
  current = { v: 1, readAt: 1 };
  assert.equal(await route(url), current);
});
