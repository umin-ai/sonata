import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLink,
  normalizeLinks,
  normalizeDescription,
  buildMetadata,
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
});

test("recognises image types by their bytes", () => {
  assert.equal(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("RIFF1234WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>")), null);
});
