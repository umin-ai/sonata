import test from "node:test";
import assert from "node:assert/strict";
import { METADATA_PROGRAM } from "./common.mjs";
import {
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
import { fakeFetch, key, memLedger, metadataAccount } from "./testkit.mjs";
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
  assert.match(metadataUri(metadataAccount(mint, "").info, mint).note, /no uri/);
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
  const ok = fakeFetch({ [cdnUrl()]: { body: json } });
  assert.deepEqual(await fetchMetadata(cdnUrl(), { fetchImpl: ok.fetchImpl }), json);
  assert.equal(ok.requests[0].init.headers["User-Agent"], USER_AGENT);
  assert.equal(ok.requests[0].init.redirect, "manual");
  assert.ok(ok.requests[0].init.signal);

  const rejects = async (routes, uri, pattern, permanent) => {
    const { fetchImpl } = fakeFetch(routes);
    await assert.rejects(fetchMetadata(uri, { fetchImpl }), (e) => {
      assert.match(e.message, pattern);
      assert.equal(e.permanent, permanent, e.message);
      return true;
    });
  };
  const big = JSON.stringify({ sonata: { feeModel: "buyback" }, pad: "x".repeat(MAX_METADATA_BYTES) });
  // Too large, whether declared or streamed.
  await rejects({ [cdnUrl()]: { body: big } }, cdnUrl(), /larger than 20480/, true);
  await rejects({ [cdnUrl()]: { body: "{}", headers: { "content-length": "999999" } } }, cdnUrl(), /larger than/, true);
  // Exactly 20,480 bytes is accepted.
  const edge = JSON.stringify("x".repeat(MAX_METADATA_BYTES - 2));
  assert.equal(Buffer.byteLength(edge), MAX_METADATA_BYTES);
  assert.equal(await fetchMetadata(cdnUrl(), { fetchImpl: fakeFetch({ [cdnUrl()]: { body: edge } }).fetchImpl }), "x".repeat(MAX_METADATA_BYTES - 2));
  await rejects({ [cdnUrl()]: { body: "not json" } }, cdnUrl(), /not valid JSON/, true);
  await rejects({}, cdnUrl(), /HTTP 404/, true);
  await rejects({ [cdnUrl()]: { status: 403, body: "" } }, cdnUrl(), /HTTP 403/, true);
  // Worth retrying: server errors, rate limits, timeouts and network failures.
  await rejects({ [cdnUrl()]: { status: 503, body: "" } }, cdnUrl(), /HTTP 503/, false);
  await rejects({ [cdnUrl()]: { status: 429, body: "" } }, cdnUrl(), /HTTP 429/, false);
  await rejects({ [cdnUrl()]: { throws: "fetch failed" } }, cdnUrl(), /fetch failed/, false);
  await rejects({}, "https://example.com/a.json", /not on a Sonata profile location/, true);
  // Redirects: followed within the allowed locations only, at most three.
  const hop = { status: 302, body: "", headers: { location: cdnUrl(2) } };
  assert.deepEqual(await fetchMetadata(IRYS, { fetchImpl: fakeFetch({ [IRYS]: hop, [cdnUrl(2)]: { body: json } }).fetchImpl }), json);
  await rejects({ [IRYS]: { status: 302, body: "", headers: { location: "https://evil.example/a.json" } } }, IRYS, /redirects off/, true);
  await rejects({ [IRYS]: { status: 301, body: "" } }, IRYS, /redirects off/, true);
  const loop = { status: 302, body: "", headers: { location: IRYS } };
  await rejects({ [IRYS]: loop }, IRYS, /too many times/, true);
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
  put(buyback, cdnUrl(1));
  put(plain, cdnUrl(2));
  put(noUri, "");
  put(flaky, cdnUrl(3));
  put(cached, cdnUrl(4));
  const web = fakeFetch({
    [cdnUrl(1)]: { body: { name: "B", sonata: { feeModel: "buyback" } } },
    [cdnUrl(2)]: { body: { name: "P" } },
    [cdnUrl(3)]: { status: 502, body: "" },
  });
  const ledger = memLedger();
  ledger.models.set(cached.pool.toBase58(), { feeModel: "topBuyers", uri: cdnUrl(4), config: null, note: null });
  const lines = [];
  const calls = [];
  const markets = [buyback, plain, noUri, flaky, noMetadata, cached];
  const models = await resolveFeeModels({ markets, ledger, fetchAll: fetchAllOf(accounts, calls), fetchImpl: web.fetchImpl, log: (tag, f) => lines.push({ tag, ...f }) });
  const model = (m) => models.get(m.pool.toBase58());
  assert.equal(model(buyback).feeModel, "buyback");
  assert.equal(model(buyback).uri, cdnUrl(1));
  assert.equal(model(plain).feeModel, "holders");
  assert.match(model(plain).note, /no sonata settings/);
  assert.equal(model(noUri).feeModel, "holders");
  assert.equal(model(noMetadata).feeModel, "holders");
  assert.match(model(noMetadata).note, /no Metaplex metadata/);
  assert.match(model(flaky).error, /HTTP 502/);
  assert.equal(model(cached).feeModel, "topBuyers");
  // One batched metadata read for the five uncached pools; the cached pool's JSON is never fetched.
  assert.deepEqual(calls, [5]);
  assert.deepEqual(web.requests.map((r) => r.url), [cdnUrl(1), cdnUrl(2), cdnUrl(3)]);
  // Everything definitive is cached; the transient failure is not.
  assert.deepEqual([...ledger.models.keys()].sort(), [buyback, plain, noUri, noMetadata, cached].map((m) => m.pool.toBase58()).sort());
  assert.ok(lines.some((l) => l.result === "unread" && l.pool === flaky.pool.toBase58()));

  // Next pass: only the flaky pool is read again, and now it answers.
  web.requests.length = 0;
  calls.length = 0;
  const later = fakeFetch({ [cdnUrl(3)]: { body: { sonata: { feeModel: "lpFarm" } } } });
  const again = await resolveFeeModels({ markets, ledger, fetchAll: fetchAllOf(accounts, calls), fetchImpl: later.fetchImpl });
  assert.equal(again.get(flaky.pool.toBase58()).feeModel, "lpFarm");
  assert.deepEqual(calls, [1]);
  assert.deepEqual(later.requests.map((r) => r.url), [cdnUrl(3)]);
  assert.equal(again.get(buyback.pool.toBase58()).feeModel, "buyback");
});

test("a dry run reads fee models but caches nothing, and an RPC failure leaves every uncached pool unread", async () => {
  const m = market();
  const accounts = new Map();
  const { address, info } = metadataAccount(m.baseMint, cdnUrl(1));
  accounts.set(address.toBase58(), info);
  const ledger = memLedger();
  const { fetchImpl } = fakeFetch({ [cdnUrl(1)]: { body: { sonata: { feeModel: "split", split: [] } } } });
  const models = await resolveFeeModels({ markets: [m], ledger, fetchAll: fetchAllOf(accounts), fetchImpl, dryRun: true });
  assert.equal(models.get(m.pool.toBase58()).feeModel, "split");
  assert.equal(ledger.models.size, 0);
  const down = await resolveFeeModels({ markets: [m], ledger, fetchAll: async () => { throw Error("429 Too Many Requests"); }, fetchImpl });
  assert.match(down.get(m.pool.toBase58()).error, /429/);
  assert.equal(ledger.models.size, 0);
});
