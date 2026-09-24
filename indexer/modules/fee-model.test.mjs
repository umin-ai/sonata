import test from "node:test";
import assert from "node:assert/strict";
import { METADATA_PROGRAM } from "./common.mjs";
import {
  FALLBACK_AFTER_MS,
  FEE_MODELS,
  MAX_METADATA_BYTES,
  USER_AGENT,
  allowedMetadataUrl,
  fetchMetadata,
  metadataAddress,
  metadataUri,
  parseFeeModel,
  resolveFeeModels,
} from "./fee-model.mjs";
import { cdnProfile, fakeFetch, key, memLedger, metadataAccount, withFeeModelFailures } from "./testkit.mjs";
import { crankLedger, migrateCrank } from "./crank-schema.mjs";
import { PublicKey } from "@solana/web3.js";

const CDN = "https://d3lwm4c3ge2mv2.cloudfront.net/tokens/";
const cdnUrl = (n = 1) => `${CDN}${String(n).padStart(64, "0")}.json`;
const IRYS = "https://devnet.irys.xyz/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

test("the fee model comes from sonata.feeModel; anything missing or unknown is holders", () => {
  for (const feeModel of ["holders", "buyback", "topBuyers", "lpFarm", "diamond"])
    assert.deepEqual(parseFeeModel({ name: "X", sonata: { feeModel } }), { feeModel, config: null, note: null });
  assert.deepEqual(FEE_MODELS, ["holders", "buyback", "topBuyers", "lpFarm", "split", "diamond"]);
  const split = [{ wallet: key().toBase58(), weight: 1 }];
  assert.deepEqual(parseFeeModel({ sonata: { feeModel: "split", split } }), { feeModel: "split", config: { split }, note: null });
  // A split without recipients is still a split (it pays nobody; see split.test.mjs).
  assert.deepEqual(parseFeeModel({ sonata: { feeModel: "split" } }).config, { split: null });
  const fallback = [
    [null, /not an object/],
    [[{ sonata: { feeModel: "buyback" } }], /not an object/],
    ["buyback", /not an object/],
    [{}, /no sonata settings/],
    [{ sonata: "buyback" }, /no sonata settings/],
    [{ sonata: {} }, /no sonata.feeModel/],
    [{ sonata: { feeModel: 3 } }, /no sonata.feeModel/],
    [{ sonata: { feeModel: "Buyback" } }, /unknown fee model "Buyback"/],
    [{ sonata: { feeModel: "burn" } }, /unknown fee model/],
    // Top level only.
    [{ extensions: { sonata: { feeModel: "buyback" } } }, /no sonata settings/],
  ];
  for (const [json, note] of fallback) {
    const r = parseFeeModel(json);
    assert.equal(r.feeModel, "holders", JSON.stringify(json));
    assert.match(r.note, note);
  }
});

test("the uri is read from the base mint's Metaplex metadata account", () => {
  const mint = key();
  const { address, info } = metadataAccount(mint, cdnUrl());
  assert.ok(address.equals(PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM)[0]));
  assert.deepEqual(metadataUri(info, mint), { uri: cdnUrl() });
  // Older metadata pads each string with NULs to its maximum length.
  assert.deepEqual(metadataUri(metadataAccount(mint, IRYS, { pad: true }).info, mint), { uri: IRYS });
  assert.match(metadataUri(null, mint).note, /no Metaplex metadata/);
  assert.match(metadataUri({ ...info, owner: key() }, mint).note, /not owned by Metaplex/);
  assert.match(metadataUri(info, key()).note, /not this mint/);
  assert.deepEqual(metadataUri(metadataAccount(mint, "").info, mint), { note: "metadata has no uri", empty: true });
  const broken = Buffer.from(info.data);
  broken.writeUInt32LE(5000, 65);
  assert.match(metadataUri({ ...info, data: broken }, mint).note, /unreadable/);
  assert.ok(metadataAddress(mint).equals(address));
});

test("metadata is fetched only from Sonata's profile locations", () => {
  for (const ok of [cdnUrl(), IRYS, "https://gateway.irys.xyz/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"]) assert.ok(allowedMetadataUrl(ok), ok);
  for (const bad of [
    "http://d3lwm4c3ge2mv2.cloudfront.net/tokens/a.json",
    "https://d3lwm4c3ge2mv2.cloudfront.net/other/a.json",
    "https://d3lwm4c3ge2mv2.cloudfront.net/tokens/",
    "https://d3lwm4c3ge2mv2.cloudfront.net/tokens/../other/a.json",
    // The CDN serves content-addressed profiles only: tokens/<sha256>.json.
    "https://d3lwm4c3ge2mv2.cloudfront.net/tokens/a.json",
    `${CDN}${"A".repeat(64)}.json`,
    `${CDN}${"0".repeat(63)}.json`,
    `${CDN}${"0".repeat(64)}.webp`,
    `${CDN}sub/${"0".repeat(64)}.json`,
    "https://d3lwm4c3ge2mv2.cloudfront.net:8443/tokens/a.json",
    `${cdnUrl()}?x=1`,
    `${cdnUrl()}#x`,
    "https://user@devnet.irys.xyz/abc",
    "https://devnet.irys.xyz.evil.example/abc",
    "https://evil.example/https://devnet.irys.xyz/abc",
    "https://arweave.net/abc",
    "ipfs://abc",
    "not a url",
    42,
  ])
    assert.equal(allowedMetadataUrl(bad), null, String(bad));
});

test("the metadata fetch sends a User-Agent, caps the size at 20 KB and follows redirects only within the allowed locations", async () => {
  const json = { sonata: { feeModel: "buyback" } };
  const profile = await cdnProfile(json);
  const ok = fakeFetch({ [profile.uri]: profile.route });
  assert.deepEqual(await fetchMetadata(profile.uri, { fetchImpl: ok.fetchImpl }), json);
  assert.equal(ok.requests[0].init.headers["User-Agent"], USER_AGENT);
  assert.equal(ok.requests[0].init.redirect, "manual");
  assert.ok(ok.requests[0].init.signal);

  // kind: "permanent" (cache holders now), "suspect" (retried for 24 hours) or "transient" (retried every pass).
  const rejects = async (routes, uri, pattern, kind) => {
    const { fetchImpl } = fakeFetch(routes);
    await assert.rejects(fetchMetadata(uri, { fetchImpl }), (e) => {
      assert.match(e.message, pattern);
      assert.equal(e.permanent ? "permanent" : e.suspect ? "suspect" : "transient", kind, e.message);
      return true;
    });
  };
  const big = await cdnProfile(JSON.stringify({ sonata: { feeModel: "buyback" }, pad: "x".repeat(MAX_METADATA_BYTES) }));
  // Too large, whether declared or streamed.
  await rejects({ [big.uri]: big.route }, big.uri, /larger than 20480/, "suspect");
  await rejects({ [cdnUrl()]: { body: "{}", headers: { "content-length": "999999" } } }, cdnUrl(), /larger than/, "suspect");
  // Exactly 20,480 bytes is accepted.
  const edge = await cdnProfile(JSON.stringify("x".repeat(MAX_METADATA_BYTES - 2)));
  assert.equal(Buffer.byteLength(edge.route.body), MAX_METADATA_BYTES);
  assert.equal(await fetchMetadata(edge.uri, { fetchImpl: fakeFetch({ [edge.uri]: edge.route }).fetchImpl }), "x".repeat(MAX_METADATA_BYTES - 2));
  // Answers that may not last: retried for 24 hours before the market falls back to holders.
  const html = await cdnProfile("<html>checking your browser</html>");
  await rejects({ [html.uri]: { ...html.route, status: 202 } }, html.uri, /not valid JSON/, "suspect");
  await rejects({ [IRYS]: { body: "not json" } }, IRYS, /not valid JSON/, "suspect");
  await rejects({}, cdnUrl(), /HTTP 404/, "suspect");
  await rejects({ [cdnUrl()]: { status: 403, body: "" } }, cdnUrl(), /HTTP 403/, "suspect");
  await rejects({ [cdnUrl()]: { status: 410, body: "" } }, cdnUrl(), /HTTP 410/, "suspect");
  // Worth retrying every pass: server errors, rate limits, timeouts and network failures.
  await rejects({ [cdnUrl()]: { status: 503, body: "" } }, cdnUrl(), /HTTP 503/, "transient");
  await rejects({ [cdnUrl()]: { status: 429, body: "" } }, cdnUrl(), /HTTP 429/, "transient");
  await rejects({ [cdnUrl()]: { status: 408, body: "" } }, cdnUrl(), /HTTP 408/, "transient");
  await rejects({ [cdnUrl()]: { throws: "fetch failed" } }, cdnUrl(), /fetch failed/, "transient");
  // Not a Sonata profile at all: final.
  await rejects({}, "https://example.com/a.json", /not on a Sonata profile location/, "permanent");
  // Redirects: followed within the allowed locations only, at most three.
  const hop = { status: 302, body: "", headers: { location: profile.uri } };
  assert.deepEqual(await fetchMetadata(IRYS, { fetchImpl: fakeFetch({ [IRYS]: hop, [profile.uri]: profile.route }).fetchImpl }), json);
  await rejects({ [IRYS]: { status: 302, body: "", headers: { location: "https://evil.example/a.json" } } }, IRYS, /redirects off/, "suspect");
  await rejects({ [IRYS]: { status: 301, body: "" } }, IRYS, /redirects off/, "suspect");
  const loop = { status: 302, body: "", headers: { location: IRYS } };
  await rejects({ [IRYS]: loop }, IRYS, /too many times/, "suspect");
});

test("a profile on Sonata's CDN must hash to its content-addressed name; Irys ids are not re-hashed", async () => {
  const original = { name: "T", sonata: { feeModel: "split", split: [{ wallet: key().toBase58(), weight: 1 }] } };
  const { uri, route } = await cdnProfile(original);
  // The same bytes pass; anything else served under that name (an overwritten object) is refused.
  assert.deepEqual(await fetchMetadata(uri, { fetchImpl: fakeFetch({ [uri]: route }).fetchImpl }), original);
  const swapped = { ...original, sonata: { feeModel: "split", split: [{ wallet: key().toBase58(), weight: 1 }] } };
  for (const body of [JSON.stringify(swapped), `${route.body} `, route.body.replace("T", "U")])
    await assert.rejects(fetchMetadata(uri, { fetchImpl: fakeFetch({ [uri]: { body } }).fetchImpl }), (e) => {
      assert.match(e.message, /does not match its content-addressed name/);
      assert.ok(e.suspect && !e.permanent);
      return true;
    });
  // Also when a redirect lands on the CDN.
  const hop = { status: 302, body: "", headers: { location: uri } };
  await assert.rejects(fetchMetadata(IRYS, { fetchImpl: fakeFetch({ [IRYS]: hop, [uri]: { body: JSON.stringify(swapped) } }).fetchImpl }), /does not match/);
  // Irys: served as is.
  assert.deepEqual(await fetchMetadata(IRYS, { fetchImpl: fakeFetch({ [IRYS]: { body: swapped } }).fetchImpl }), swapped);
});

// Markets as the crank passes them: pool and base mint.
const market = () => ({ pool: key(), baseMint: key() });
const fetchAllOf = (accounts, calls = []) => async (keys) => (calls.push(keys.length), keys.map((k) => accounts.get(k.toBase58()) ?? null));

test("fee models are read once per pool and cached; transient failures are retried, not cached", async () => {
  const [buyback, plain, noUri, flaky, noMetadata, cached] = Array.from({ length: 6 }, market);
  const accounts = new Map();
  const put = (m, uri) => {
    const { address, info } = metadataAccount(m.baseMint, uri);
    accounts.set(address.toBase58(), info);
  };
  const bought = await cdnProfile({ name: "B", sonata: { feeModel: "buyback" } });
  const noSettings = await cdnProfile({ name: "P" });
  const later = await cdnProfile({ sonata: { feeModel: "lpFarm" } });
  put(buyback, bought.uri);
  put(plain, noSettings.uri);
  put(noUri, "");
  put(flaky, later.uri);
  put(cached, cdnUrl(4));
  const web = fakeFetch({
    [bought.uri]: bought.route,
    [noSettings.uri]: noSettings.route,
    [later.uri]: { status: 502, body: "" },
  });
  const ledger = withFeeModelFailures(memLedger());
  ledger.models.set(cached.pool.toBase58(), { feeModel: "topBuyers", uri: cdnUrl(4), config: null, note: null });
  const lines = [];
  const calls = [];
  const markets = [buyback, plain, noUri, flaky, noMetadata, cached];
  const models = await resolveFeeModels({ markets, ledger, fetchAll: fetchAllOf(accounts, calls), fetchImpl: web.fetchImpl, log: (tag, f) => lines.push({ tag, ...f }) });
  const model = (m) => models.get(m.pool.toBase58());
  assert.equal(model(buyback).feeModel, "buyback");
  assert.equal(model(buyback).uri, bought.uri);
  assert.equal(model(plain).feeModel, "holders");
  assert.match(model(plain).note, /no sonata settings/);
  assert.equal(model(noUri).feeModel, "holders");
  // No metadata account yet (an RPC node behind): retried, not cached as holders.
  assert.match(model(noMetadata).error, /no Metaplex metadata/);
  assert.match(model(flaky).error, /HTTP 502/);
  assert.equal(model(cached).feeModel, "topBuyers");
  // One batched metadata read for the five uncached pools; the cached pool's JSON is never fetched.
  assert.deepEqual(calls, [5]);
  assert.deepEqual(web.requests.map((r) => r.url), [bought.uri, noSettings.uri, later.uri]);
  // Everything definitive is cached; the failures are not. Only the one that may last starts the 24-hour clock.
  assert.deepEqual([...ledger.models.keys()].sort(), [buyback, plain, noUri, cached].map((m) => m.pool.toBase58()).sort());
  assert.deepEqual([...ledger.failures.keys()], [noMetadata.pool.toBase58()]);
  assert.ok(lines.some((l) => l.result === "unread" && l.pool === flaky.pool.toBase58()));

  // Next pass: only the failed pools are read again, and now they answer.
  web.requests.length = 0;
  calls.length = 0;
  const { address, info } = metadataAccount(noMetadata.baseMint, bought.uri);
  accounts.set(address.toBase58(), info);
  const answers = fakeFetch({ [later.uri]: later.route, [bought.uri]: bought.route });
  const again = await resolveFeeModels({ markets, ledger, fetchAll: fetchAllOf(accounts, calls), fetchImpl: answers.fetchImpl });
  assert.equal(again.get(flaky.pool.toBase58()).feeModel, "lpFarm");
  assert.equal(again.get(noMetadata.pool.toBase58()).feeModel, "buyback");
  assert.deepEqual(calls, [2]);
  assert.deepEqual(answers.requests.map((r) => r.url), [later.uri, bought.uri]);
  assert.equal(again.get(buyback.pool.toBase58()).feeModel, "buyback");
});

test("a 4xx, a body that is not the uploaded JSON or a missing metadata account is retried for 24 hours, then paid to holders", async () => {
  const [gone, forbidden, challenge, tampered, noAccount, flaky] = Array.from({ length: 6 }, market);
  const accounts = new Map();
  const put = (m, uri) => {
    const { address, info } = metadataAccount(m.baseMint, uri);
    accounts.set(address.toBase58(), info);
  };
  const profile = await cdnProfile({ sonata: { feeModel: "buyback" } });
  const other = await cdnProfile({ sonata: { feeModel: "split", split: [] } });
  put(gone, cdnUrl(1));
  put(forbidden, profile.uri);
  put(challenge, IRYS);
  put(tampered, other.uri);
  put(flaky, cdnUrl(2));
  const failing = {
    [cdnUrl(1)]: { status: 404, body: "" },
    [profile.uri]: { status: 403, body: "" },
    [IRYS]: { status: 202, body: "<html>challenge</html>", headers: { "content-type": "text/html" } },
    [other.uri]: { body: JSON.stringify({ sonata: { feeModel: "split", split: [{ wallet: key().toBase58(), weight: 1 }] } }) },
    [cdnUrl(2)]: { status: 500, body: "" },
  };
  let clock = 1_900_000_000_000;
  const ledger = withFeeModelFailures(memLedger(), { now: () => clock });
  const markets = [gone, forbidden, challenge, tampered, noAccount, flaky];
  const lines = [];
  const pass = (routes = failing) => resolveFeeModels({ markets, ledger, fetchAll: fetchAllOf(accounts), fetchImpl: fakeFetch(routes).fetchImpl, log: (tag, f) => lines.push({ tag, ...f }) });
  const pools = (list) => list.map((m) => m.pool.toBase58()).sort();

  // First pass and 23 hours on: nothing cached, every market waits with its funds owed.
  for (const after of [0, 23 * 3600_000]) {
    clock = 1_900_000_000_000 + after;
    const models = await pass();
    for (const m of markets) assert.ok(models.get(m.pool.toBase58()).error, m.pool.toBase58());
    assert.equal(ledger.models.size, 0);
  }
  assert.deepEqual([...ledger.failures.keys()].sort(), pools([gone, forbidden, challenge, tampered, noAccount]));
  assert.equal(ledger.failures.get(gone.pool.toBase58()).failures, 2);
  assert.ok(lines.some((l) => l.result === "unread" && l.firstFailedAt === new Date(1_900_000_000_000).toISOString()));
  // The 403 clears up within the day: its real model is cached.
  const models = await pass({ ...failing, [profile.uri]: profile.route });
  assert.equal(models.get(forbidden.pool.toBase58()).feeModel, "buyback");

  // 24 hours after the first failure the rest fall back to holders, cached and logged; the 5xx never does.
  clock = 1_900_000_000_000 + FALLBACK_AFTER_MS;
  const last = await pass();
  for (const m of [gone, challenge, tampered, noAccount]) {
    const entry = last.get(m.pool.toBase58());
    assert.equal(entry.feeModel, "holders");
    assert.match(entry.note, /unreadable since 2030-03-17T17:46:40.000Z .*holders fallback/);
    assert.equal(ledger.models.get(m.pool.toBase58()).feeModel, "holders");
  }
  assert.match(last.get(flaky.pool.toBase58()).error, /HTTP 500/);
  assert.equal(lines.filter((l) => l.result === "fallback").length, 4);
  assert.deepEqual([...ledger.models.keys()].sort(), pools([gone, forbidden, challenge, tampered, noAccount]));

  // Without a failure record (an older ledger, or a dry run) nothing ever falls back.
  const bare = memLedger();
  const dry = withFeeModelFailures(memLedger(), { now: () => clock });
  for (const [l, dryRun] of [[bare, false], [dry, true]]) {
    const r = await resolveFeeModels({ markets: [gone], ledger: l, fetchAll: fetchAllOf(accounts), fetchImpl: fakeFetch(failing).fetchImpl, dryRun });
    assert.match(r.get(gone.pool.toBase58()).error, /HTTP 404/);
    assert.equal(l.models.size, 0);
  }
  assert.equal(dry.failures.size, 0);
  // A ledger that cannot record the failure: retried, the reason says so.
  const broken = Object.assign(memLedger(), { feeModelFailure: async () => { throw Error("relation does not exist"); } });
  const r = await resolveFeeModels({ markets: [gone], ledger: broken, fetchAll: fetchAllOf(accounts), fetchImpl: fakeFetch(failing).fetchImpl });
  assert.match(r.get(gone.pool.toBase58()).error, /HTTP 404; not recorded: relation does not exist/);
});

test("the crank's schema and failure record: idempotent SQL, one upsert per failure, elapsed time by the database's clock", async () => {
  const queries = [];
  const db = {
    query: async (sql, args) => {
      queries.push({ sql, args });
      return { rows: [{ first_failed_at: new Date("2030-01-01T00:00:00Z"), failures: 3, elapsed_ms: "90000000" }] };
    },
  };
  await migrateCrank(db);
  assert.match(queries[0].sql, /create table if not exists fee_model_failures/);
  const ledger = crankLedger({ ready: async () => true }, db);
  assert.equal(await ledger.ready(), true);
  const r = await ledger.feeModelFailure("pool1", "metadata HTTP 404");
  assert.deepEqual(r, { firstFailedAt: new Date("2030-01-01T00:00:00Z"), failures: 3, elapsedMs: 90_000_000 });
  assert.match(queries[1].sql, /on conflict \(pool\) do update/);
  assert.deepEqual(queries[1].args, ["pool1", "metadata HTTP 404"]);
});

test("a dry run reads fee models but caches nothing, and an RPC failure leaves every uncached pool unread", async () => {
  const m = market();
  const accounts = new Map();
  const profile = await cdnProfile({ sonata: { feeModel: "split", split: [] } });
  const { address, info } = metadataAccount(m.baseMint, profile.uri);
  accounts.set(address.toBase58(), info);
  const ledger = memLedger();
  const { fetchImpl } = fakeFetch({ [profile.uri]: profile.route });
  const models = await resolveFeeModels({ markets: [m], ledger, fetchAll: fetchAllOf(accounts), fetchImpl, dryRun: true });
  assert.equal(models.get(m.pool.toBase58()).feeModel, "split");
  assert.equal(ledger.models.size, 0);
  const down = await resolveFeeModels({ markets: [m], ledger, fetchAll: async () => { throw Error("429 Too Many Requests"); }, fetchImpl });
  assert.match(down.get(m.pool.toBase58()).error, /429/);
  assert.equal(ledger.models.size, 0);
});
