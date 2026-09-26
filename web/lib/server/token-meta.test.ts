// The token profile cache behind /api/token-meta (token-meta.ts): every open
// page asks for a new market's profile at once.
import test from "node:test";
import assert from "node:assert/strict";
import { createProfileCache, PROFILE_CACHE_SIZE, PROFILE_FAILURE_MS, ProfileError } from "./token-meta.ts";

test("a profile is fetched once and then served from memory; a failure is remembered for a minute", async () => {
  let t = 0;
  const fetched: string[] = [];
  let fail = false;
  const cache = createProfileCache(async (uri) => {
    fetched.push(uri);
    if (fail) throw new ProfileError("Profile unavailable.", 502);
    return { image: `${uri}#i` };
  }, () => t);
  assert.deepEqual(await cache("a"), { image: "a#i" });
  assert.deepEqual(await cache("a"), { image: "a#i" });
  assert.deepEqual(fetched, ["a"]);
  fail = true;
  await assert.rejects(cache("b"), /unavailable/);
  await assert.rejects(cache("b"), /unavailable/);
  assert.deepEqual(fetched, ["a", "b"], "the failure is not asked again right away");
  t += PROFILE_FAILURE_MS;
  fail = false;
  assert.deepEqual(await cache("b"), { image: "b#i" });
  assert.deepEqual(fetched, ["a", "b", "b"]);
  // A location that is never served (400) costs nothing to refuse again, and is not kept.
  const refusing = createProfileCache(async () => {
    throw new ProfileError("Unsupported profile location.", 400);
  });
  await assert.rejects(refusing("x"), (e: unknown) => e instanceof ProfileError && e.status === 400);
});

test("at most PROFILE_CACHE_SIZE bodies are kept, the oldest dropped first", async () => {
  const fetched: string[] = [];
  const cache = createProfileCache(async (uri) => (fetched.push(uri), { image: uri }));
  for (let i = 0; i <= PROFILE_CACHE_SIZE; i++) await cache(`u${i}`);
  await cache(`u${PROFILE_CACHE_SIZE}`);
  await cache("u0");
  assert.equal(fetched.filter((u) => u === "u0").length, 2, "the oldest was dropped");
  assert.equal(fetched.filter((u) => u === `u${PROFILE_CACHE_SIZE}`).length, 1);
});
