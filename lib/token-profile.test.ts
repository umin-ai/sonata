import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLink,
  normalizeLinks,
  normalizeDescription,
  buildMetadata,
  normalizeSplit,
  parseProfile,
  isProfileUrl,
  sniffImage,
} from "./token-profile.ts";

test("accepts https links on the right hosts", () => {
  assert.equal(normalizeLink("website", "https://sonata.gg"), "https://sonata.gg/");
  assert.equal(normalizeLink("x", "https://x.com/sonata"), "https://x.com/sonata");
  assert.equal(normalizeLink("x", "https://www.twitter.com/sonata"), "https://www.twitter.com/sonata");
  assert.equal(normalizeLink("telegram", "https://t.me/sonata"), "https://t.me/sonata");
});

test("refuses unsafe or mismatched links", () => {
  assert.throws(() => normalizeLink("website", "javascript:alert(1)"), /https/);
  assert.throws(() => normalizeLink("website", "http://sonata.gg"), /https/);
  assert.throws(() => normalizeLink("website", "https://user:pw@sonata.gg"), /password/);
  assert.throws(() => normalizeLink("x", "https://evil.com/x.com"), /x\.com/);
  assert.throws(() => normalizeLink("x", "https://x.com.evil.com/a"), /x\.com/);
  assert.throws(() => normalizeLink("telegram", "https://t.me/"), /account or group/);
  assert.throws(() => normalizeLink("website", "sonata.gg"), /https/);
});

test("empty links are dropped, descriptions are trimmed and capped", () => {
  assert.deepEqual(normalizeLinks({ website: " ", x: "https://x.com/a" }), { x: "https://x.com/a" });
  assert.equal(normalizeDescription("  a \n  b "), "a b");
  assert.throws(() => normalizeDescription("x".repeat(281)), /280/);
});

test("metadata carries socials in both common shapes and reads back", () => {
  const image = "https://devnet.irys.xyz/3ZDD8QHrpuhtXMT3tGK7hFDo4MkimPWN7YL7fgBB1Shv";
  const meta = buildMetadata({
    name: "Nasdoge",
    symbol: "NDOGE",
    description: "QQQ-backed doge",
    image,
    links: { website: "https://sonata.gg/", x: "https://x.com/sonata", telegram: "https://t.me/sonata" },
  });
  assert.equal(meta.twitter, "https://x.com/sonata");
  assert.equal(meta.extensions.telegram, "https://t.me/sonata");
  assert.equal(meta.external_url, "https://sonata.gg/");
  const back = parseProfile(JSON.parse(JSON.stringify(meta)));
  assert.equal(back.image, image);
  assert.equal(back.description, "QQQ-backed doge");
  assert.deepEqual(back.links, { website: "https://sonata.gg/", x: "https://x.com/sonata", telegram: "https://t.me/sonata" });
});

test("every metadata file names Sonata, even with no profile", () => {
  const meta = buildMetadata({ name: "Plain", symbol: "PLN", description: "", links: {} });
  assert.equal(meta.createdOn, "https://sonata.umin.ai");
  assert.deepEqual(parseProfile(JSON.parse(JSON.stringify(meta))).links, {});
});

test("untrusted metadata cannot smuggle links or images", () => {
  const back = parseProfile({
    image: "https://evil.example/tracker.png",
    twitter: "javascript:alert(1)",
    telegram: "https://t.me.evil.com/x",
    website: "http://plain.example",
    description: 42,
  });
  assert.deepEqual(back, { description: undefined, image: undefined, links: {} });
  assert.equal(isProfileUrl("https://devnet.irys.xyz/../../x"), false);
  const h = "a".repeat(64);
  assert.equal(isProfileUrl(`https://d3lwm4c3ge2mv2.cloudfront.net/tokens/${h}.json`), true);
  assert.equal(isProfileUrl(`https://d3lwm4c3ge2mv2.cloudfront.net/tokens/${h}.webp`), true);
  assert.equal(isProfileUrl(`https://d3lwm4c3ge2mv2.cloudfront.net/other/${h}.webp`), false);
  assert.equal(isProfileUrl(`https://d3lwm4c3ge2mv2.cloudfront.net/tokens/${h}.webp?x=1`), false);
  assert.equal(isProfileUrl(`http://d3lwm4c3ge2mv2.cloudfront.net/tokens/${h}.webp`), false);
});

test("recognises image types by their bytes", () => {
  assert.equal(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("RIFF1234WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>")), null);
});

test("the fee model is written into the metadata and read back", () => {
  const meta = buildMetadata({ name: "Burny", symbol: "BRN", description: "", links: {}, feeModel: "buyback" });
  assert.deepEqual(meta.sonata, { feeModel: "buyback" });
  assert.equal(parseProfile(JSON.parse(JSON.stringify(meta))).feeModel, "buyback");
  // Unknown models are dropped, never passed to the payout bot's readers.
  assert.equal(parseProfile({ sonata: { feeModel: "drain" } }).feeModel, undefined);
  assert.equal(buildMetadata({ name: "Plain", symbol: "PLN", description: "", links: {} }).sonata, undefined);
});

test("a split names 1 to 5 wallets with whole-number shares", () => {
  // Two Devnet test wallets (normal, on-curve addresses).
  const a = "F7w1MUYY9NH6WRRguxJdyWkmFRRmXWs5KraosRW8L4VQ",
    b = "5Tv5fAngULfJxpwcqWmL7aKnez4AgXnJtXB87d1HjiaT";
  const split = normalizeSplit([
    { wallet: ` ${a} `, weight: 60 },
    { wallet: b, weight: 40 },
  ]);
  assert.deepEqual(split, [
    { wallet: a, weight: 60 },
    { wallet: b, weight: 40 },
  ]);
  const meta = buildMetadata({ name: "Pair", symbol: "PR", description: "", links: {}, feeModel: "split", split });
  assert.deepEqual(parseProfile(JSON.parse(JSON.stringify(meta))).split, split);
  assert.throws(() => normalizeSplit([]), /1 to 5/);
  assert.throws(() => normalizeSplit(Array.from({ length: 6 }, (_, i) => ({ wallet: a.slice(0, -1) + i, weight: 1 }))), /1 to 5/);
  assert.throws(() => normalizeSplit([{ wallet: a, weight: 1 }, { wallet: a, weight: 1 }]), /once/);
  assert.throws(() => normalizeSplit([{ wallet: a, weight: 0 }]), /1 to 100/);
  assert.throws(() => normalizeSplit([{ wallet: a, weight: 2.5 }]), /1 to 100/);
  assert.throws(() => normalizeSplit([{ wallet: "not-a-wallet", weight: 5 }]), /Solana address/);
  assert.throws(() => normalizeSplit([{ wallet: "Fb83XLPdUM11FrUUBNaB1JXJ2feJacNkcPGUzP8dtGz", weight: 5 }]), /Sonata/);
  // A bad split in stored metadata is dropped rather than shown.
  assert.equal(parseProfile({ sonata: { feeModel: "split", split: [{ wallet: a, weight: 0 }] } }).split, undefined);
});

test("the launch accepts only splits the payout bot will pay", () => {
  // Program ids are on the ed25519 curve, so only the shared list catches them.
  for (const program of ["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "vb4pminVbRa8BRaRCDa7JmAkFx6LSmnwMiDtsKvkXVF"])
    assert.throws(() => normalizeSplit([{ wallet: program, weight: 10 }]), /Sonata's own wallets and program/, program);
  // Off-curve addresses (program-derived accounts, such as Sonata's Vault) are not wallets.
  for (const pda of ["HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC", "5XMFEnW8Ur3EswbFhCr1LEKtHDioTs8oeQEHKyPHNpp5"])
    assert.throws(() => normalizeSplit([{ wallet: pda, weight: 10 }]), /normal wallet/, pda);
});
