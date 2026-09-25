import test from "node:test";
import assert from "node:assert/strict";
import { createRpcFetch, RPC_BUSY } from "./rpc-fetch.ts";
const req = (
  method: string,
  id: number,
  params: unknown = [],
): RequestInit => ({
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", method, id, params }),
});
const body = async (response: Response) =>
  (await response.json()) as {
    id: number;
    result: number;
    error: { message: string };
  };
const ok = () => Response.json({ jsonrpc: "2.0", id: 1, result: 42 });
test("concurrent identical reads share a request and preserve each caller's ID", async () => {
  let calls = 0;
  const f = createRpcFetch(
    async () => {
      calls++;
      return ok();
    },
    { intervalMs: 0 },
  );
  const [a, b] = await Promise.all([
    f("https://rpc", req("getBalance", 1, ["a"])),
    f("https://rpc", req("getBalance", 2, ["a"])),
  ]);
  assert.equal(calls, 1);
  assert.equal((await body(a)).id, 1);
  assert.equal((await body(b)).id, 2);
  await f("https://rpc", req("getBalance", 3, ["a"]));
  assert.equal(calls, 2, "completed results are not cached");
});
test("rate-limited reads back off once and recover", async () => {
  let calls = 0;
  const waits: number[] = [];
  const f = createRpcFetch(
    async () => (++calls === 1 ? new Response("busy", { status: 429 }) : ok()),
    {
      intervalMs: 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.equal(
    (await body(await f("https://rpc", req("getSlot", 1)))).result,
    42,
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [4000]);
});
test("persistent JSON-RPC limits become a readable error and release the queue", async () => {
  let limited = true,
    calls = 0;
  const f = createRpcFetch(
    async () => {
      calls++;
      return limited
        ? Response.json({
            error: { code: 429, message: "private raw upstream details" },
          })
        : ok();
    },
    { intervalMs: 0, sleep: async () => {} },
  );
  await assert.rejects(f("https://rpc", req("getSlot", 1)), {
    message: RPC_BUSY,
  });
  assert.equal(calls, 2);
  limited = false;
  assert.equal(
    (await body(await f("https://rpc", req("getSlot", 2)))).result,
    42,
  );
});
test("writes are never retried or deduplicated", async () => {
  let calls = 0;
  const f = createRpcFetch(
    async () => {
      calls++;
      return new Response("busy", { status: 429 });
    },
    { intervalMs: 0 },
  );
  await Promise.all([
    assert.rejects(f("https://rpc", req("sendTransaction", 1)), {
      message: RPC_BUSY,
    }),
    assert.rejects(f("https://rpc", req("sendTransaction", 2)), {
      message: RPC_BUSY,
    }),
  ]);
  assert.equal(calls, 2);
});
test("different accounts remain distinct and non-rate-limit errors remain intact", async () => {
  let calls = 0;
  const f = createRpcFetch(
    async () => {
      calls++;
      return Response.json({
        error: { code: -32000, message: "Account unavailable" },
      });
    },
    { intervalMs: 0 },
  );
  const [a, b] = await Promise.all([
    f("https://rpc", req("getBalance", 1, ["a"])),
    f("https://rpc", req("getBalance", 2, ["b"])),
  ]);
  assert.equal(calls, 2);
  assert.equal((await body(a)).error.message, "Account unavailable");
  assert.equal((await body(b)).id, 2);
});

// --- Failover across endpoints ---
const A = "https://a.example", B = "https://b.example";
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
test("a rate-limited endpoint rests and the same request moves to the next one", async () => {
  const c = clock(), hits: string[] = [];
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return String(url) === A ? new Response("busy", { status: 429 }) : ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {} },
  );
  assert.equal((await body(await f(A, req("getSlot", 1)))).result, 42);
  assert.deepEqual(hits, [A, B]);
  // While A rests, requests go straight to B.
  await f(A, req("getSlot", 2));
  assert.deepEqual(hits, [A, B, B]);
  // After the cooldown A is preferred again.
  c.advance(16_000);
  await f(A, req("getSlot", 3)).catch(() => {});
  assert.equal(hits[3], A);
});
test("network errors and server errors fail over too", async () => {
  const c = clock(), hits: string[] = [];
  let mode: "throw" | "500" = "throw";
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      if (String(url) === A) {
        if (mode === "throw") throw new TypeError("Failed to fetch");
        return new Response("oops", { status: 502 });
      }
      return ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {} },
  );
  await f(A, req("getBalance", 1, ["x"]));
  c.advance(61_000);
  mode = "500";
  await f(A, req("getBalance", 2, ["y"]));
  assert.deepEqual(hits, [A, B, A, B]);
});
test("a hung endpoint times out and the request moves on", async () => {
  const hits: string[] = [];
  const f = createRpcFetch(
    (url, init) => {
      hits.push(String(url));
      if (String(url) === B) return Promise.resolve(ok());
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    },
    { intervalMs: 0, endpoints: [A, B], timeoutMs: 20, sleep: async () => {} },
  );
  assert.equal((await body(await f(A, req("getSlot", 1)))).result, 42);
  assert.deepEqual(hits, [A, B]);
});
test("Retry-After lengthens the rest", async () => {
  const c = clock(), hits: string[] = [];
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return String(url) === A ? new Response("busy", { status: 429, headers: { "retry-after": "45" } }) : ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {} },
  );
  await f(A, req("getSlot", 1));
  c.advance(30_000); // past the 15 s base cooldown, still inside Retry-After
  await f(A, req("getSlot", 2));
  assert.deepEqual(hits, [A, B, B]);
});
test("a write tries each endpoint once, then reports busy", async () => {
  const c = clock(), hits: string[] = [];
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return new Response("busy", { status: 429 });
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {} },
  );
  await assert.rejects(f(A, req("sendTransaction", 1)), { message: RPC_BUSY });
  assert.deepEqual(hits, [A, B]);
});
test("a read every endpoint refused waits once and retries them all", async () => {
  const c = clock(), hits: string[] = [], waits: number[] = [];
  let busy = true;
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return busy ? new Response("busy", { status: 429 }) : ok();
    },
    {
      intervalMs: 0,
      endpoints: [A, B],
      now: c.now,
      timeoutMs: 0,
      sleep: async (ms) => {
        waits.push(ms);
        busy = false;
      },
    },
  );
  assert.equal((await body(await f(A, req("getSlot", 1)))).result, 42);
  assert.deepEqual(waits, [4000]);
  assert.deepEqual(hits, [A, B, A]);
});
test("a reply that stalls midway times out and the request moves on", async () => {
  const hits: string[] = [];
  const f = createRpcFetch(
    async (url, init) => {
      hits.push(String(url));
      if (String(url) === B) return ok();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","res'));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(stream, { status: 200 });
    },
    { intervalMs: 0, endpoints: [A, B], timeoutMs: 30, sleep: async () => {} },
  );
  const [slot, sent] = await Promise.all([f(A, req("getSlot", 1)), f(A, req("sendTransaction", 2))]);
  assert.equal((await body(slot)).result, 42);
  assert.equal((await body(sent)).result, 42);
  assert.deepEqual(hits, [A, B, B]);
});
