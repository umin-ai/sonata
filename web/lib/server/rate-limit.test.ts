import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimit, clientKey } from "./rate-limit.ts";

test("limits each client within a window, then resets", () => {
  const allow = createRateLimit({ perKey: 2, total: 100, windowMs: 1000 });
  assert.equal(allow("a", 0), true);
  assert.equal(allow("a", 10), true);
  assert.equal(allow("a", 20), false);
  assert.equal(allow("b", 20), true);
  assert.equal(allow("a", 1000), true);
});

test("caps the total across all clients", () => {
  const allow = createRateLimit({ perKey: 10, total: 3, windowMs: 1000 });
  assert.equal(allow("a", 0), true);
  assert.equal(allow("b", 0), true);
  assert.equal(allow("c", 0), true);
  assert.equal(allow("d", 0), false);
});

test("reads the client address set by the proxy", () => {
  const r = new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
  assert.equal(clientKey(r), "203.0.113.9");
  assert.equal(clientKey(new Request("http://x/")), "local");
});
