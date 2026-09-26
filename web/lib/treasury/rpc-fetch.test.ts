import test, { mock } from "node:test";
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
test("a 403 or 401 is a refusal: the endpoint rests and the request moves on", async () => {
  for (const status of [403, 401]) {
    const c = clock(), hits: string[] = [];
    const f = createRpcFetch(
      async (url) => {
        hits.push(String(url));
        return String(url) === A
          ? Response.json({ code: status, message: "Your IP or provider is blocked from this endpoint" }, { status })
          : ok();
      },
      { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {} },
    );
    assert.equal((await body(await f(A, req("getAccountInfo", 1, ["x"])))).result, 42, `status ${status}`);
    assert.deepEqual(hits, [A, B]);
    // A rests like a rate-limited endpoint: the next request goes straight to B.
    await f(A, req("getAccountInfo", 2, ["y"]));
    assert.deepEqual(hits, [A, B, B]);
    c.advance(16_000);
    await f(A, req("getAccountInfo", 3, ["z"]));
    assert.equal(hits[3], A);
  }
});
test("a write refused with 403 moves to the next endpoint once", async () => {
  const hits: string[] = [];
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return String(url) === A ? new Response("forbidden", { status: 403 }) : ok();
    },
    { intervalMs: 0, endpoints: [A, B], timeoutMs: 0, sleep: async () => {} },
  );
  assert.equal((await body(await f(A, req("sendTransaction", 1, ["tx"])))).result, 42);
  assert.deepEqual(hits, [A, B]);
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

// --- Hedged reads ---
const tick = () => new Promise((resolve) => setImmediate(resolve));
// A request that never answers; it ends only when its signal aborts.
const silent = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    if (init?.signal?.aborted) abort();
    init?.signal?.addEventListener("abort", abort);
  });
// Hedge timers the test controls: each records its delay and fires only when the
// test says the delay has passed (`fire`, or `fireSoon` from inside a request).
function hedges() {
  const delays: number[] = [];
  let due: (() => void)[] = [],
    stopped = 0;
  const fire = () => {
    const now = due;
    due = [];
    for (const f of now) f();
  };
  return {
    delays,
    stopped: () => stopped,
    fire,
    fireSoon: () => queueMicrotask(fire),
    hedgeTimer(ms: number, go: () => void) {
      delays.push(ms);
      let live = true;
      due.push(() => live && go());
      return () => {
        if (live) stopped++;
        live = false;
      };
    },
  };
}
// A stand-in for localStorage holding the saved rests.
const KEY = "sonata.rpc.rest.v1";
function memory(initial?: unknown) {
  let value: string | null = initial === undefined ? null : typeof initial === "string" ? initial : JSON.stringify(initial);
  return {
    getItem: (k: string) => (k === KEY ? value : null),
    setItem: (k: string, v: string) => {
      if (k === KEY) value = v;
    },
    saved: () => JSON.parse(value ?? "null") as Record<string, { restUntil: number; strikes: number }> | null,
  };
}
const MINUTE = 60_000;

test("a read the first endpoint leaves unanswered is sent to the next one too, and the quiet one rests 10 minutes", async () => {
  const c = clock(), h = hedges(), store = memory(), hits: string[] = [];
  let aborted = false;
  const f = createRpcFetch(
    (url, init) => {
      hits.push(String(url));
      if (String(url) === B) return Promise.resolve(ok());
      init?.signal?.addEventListener("abort", () => (aborted = true));
      h.fireSoon();
      return silent(init);
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, hedgeTimer: h.hedgeTimer, storage: store },
  );
  assert.equal((await body(await f(A, req("getAccountInfo", 1, ["x"])))).result, 42);
  assert.deepEqual(hits, [A, B]);
  assert.equal(aborted, true, "the quiet request is cancelled");
  // One strike: the cancelled request did not count as an ordinary failure too.
  assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 1 } });
  // Well past an ordinary cooldown, reads still go straight to B.
  c.advance(9 * MINUTE);
  await f(A, req("getAccountInfo", 2, ["y"]));
  assert.deepEqual(hits, [A, B, B]);
  // After 10 minutes A is tried first again.
  c.advance(MINUTE + 1);
  await f(A, req("getAccountInfo", 3, ["z"]));
  assert.deepEqual(hits, [A, B, B, A, B]);
});
test("an endpoint that answers within the hedge delay is the only one asked", async () => {
  const h = hedges(), hits: string[] = [];
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return ok();
    },
    { intervalMs: 0, endpoints: [A, B], timeoutMs: 0, sleep: async () => {}, hedgeTimer: h.hedgeTimer },
  );
  assert.equal((await body(await f(A, req("getBalance", 1, ["x"])))).result, 42);
  assert.equal(h.delays.length, 1);
  assert.equal(h.stopped(), 1, "the hedge timer is stopped");
  h.fire();
  await tick();
  assert.deepEqual(hits, [A]);
});
test("a hedge that is rate limited rests as usual while the first endpoint's later answer is used", async () => {
  const c = clock(), h = hedges(), store = memory(), hits: string[] = [];
  const f = createRpcFetch(
    (url) => {
      hits.push(String(url));
      if (String(url) === B) return Promise.resolve(new Response("busy", { status: 429 }));
      h.fireSoon();
      // A answers only after the hedge has been refused.
      return new Promise((resolve) => setTimeout(() => resolve(ok()), 10));
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, hedgeTimer: h.hedgeTimer, storage: store },
  );
  assert.equal((await body(await f(A, req("getAccountInfo", 1, ["x"])))).result, 42);
  assert.deepEqual(hits, [A, B]);
  assert.deepEqual(store.saved(), { [B]: { restUntil: c.now() + 15_000, strikes: 1 } });
  await f(A, req("getAccountInfo", 2, ["y"]));
  assert.equal(hits[2], A, "A answered, so it is still preferred");
});
test("the first endpoint fails after the hedge went out; the hedge is still awaited and its answer used", async () => {
  const c = clock(), h = hedges(), store = memory(), hits: string[] = [], waits: number[] = [];
  const f = createRpcFetch(
    (url) => {
      hits.push(String(url));
      if (String(url) === B) return new Promise((resolve) => setTimeout(() => resolve(ok()), 10));
      h.fireSoon();
      return new Promise((resolve) => setImmediate(() => resolve(new Response("oops", { status: 500 }))));
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, hedgeTimer: h.hedgeTimer, storage: store, sleep: async (ms) => { waits.push(ms); } },
  );
  assert.equal((await body(await f(A, req("getAccountInfo", 1, ["x"])))).result, 42);
  assert.deepEqual(hits, [A, B]);
  assert.deepEqual(waits, []);
  // A refused rather than stayed silent, so an ordinary rest.
  assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 15_000, strikes: 1 } });
});
test("a first endpoint that times out or fails to connect after the hedge went out rests 10 minutes when the hedge answers", async () => {
  for (const failure of ["timeout", "network"]) {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const c = clock(), h = hedges(), store = memory();
      let answer: (response: Response) => void = () => {},
        fail = () => {};
      const f = createRpcFetch(
        (url, init) => {
          if (String(url) === B) return new Promise<Response>((resolve) => (answer = resolve));
          return new Promise<Response>((_, reject) => {
            fail = () => reject(new TypeError("Failed to fetch"));
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        },
        { intervalMs: 0, endpoints: [A, B], now: c.now, hedgeTimer: h.hedgeTimer, storage: store, sleep: async () => {} },
      );
      const pending = f(A, req("getAccountInfo", 1, ["x"]));
      await tick();
      mock.timers.tick(2_500);
      h.fire();
      await tick();
      // A ends with no response (its 12 s timeout, or a failed connection) while B is still out...
      if (failure === "timeout") mock.timers.tick(9_500);
      else fail();
      await tick();
      // ...and then B answers.
      answer(ok());
      assert.equal((await body(await pending)).result, 42, failure);
      // One strike: A's failure and its loss to B are the same event.
      assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 1 } }, failure);
    } finally {
      mock.timers.reset();
    }
  }
});
test("a hedge's error answer does not beat the first endpoint, and is used only if that one fails", async () => {
  // A JSON-RPC error with HTTP 200 (as a provider's plan restriction comes through the relay), or an HTTP
  // error that is not a refusal (401, 403 and 429 are refusals: the endpoint rests).
  for (const status of [200, 400])
    for (const first of ["answers", "500", "throw", "throws before the error answer"]) {
      const c = clock(), h = hedges(), store = memory(), hits: string[] = [];
      const early = first === "throws before the error answer";
      const f = createRpcFetch(
        (url) => {
          hits.push(String(url));
          if (String(url) === B) {
            const refusal = Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }, { status });
            return new Promise((resolve) => setTimeout(() => resolve(refusal), early ? 10 : 0));
          }
          h.fireSoon();
          // A settles after the hedge's error answer is in, or, in the last case, just after the hedge went out.
          return new Promise((resolve, reject) =>
            setTimeout(() => {
              if (first === "answers") resolve(ok());
              else if (first === "500") resolve(new Response("oops", { status: 500 }));
              else reject(new TypeError("Failed to fetch"));
            }, early ? 0 : 10),
          );
        },
        { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, hedgeTimer: h.hedgeTimer, storage: store },
      );
      const answer = await body(await f(A, req("getAccountInfo", 1, ["x"])));
      const label = `${status} ${first}`;
      assert.deepEqual(hits, [A, B], label);
      if (first === "answers") {
        assert.equal(answer.result, 42, label);
        assert.equal(store.saved(), null, `${label}: nothing rests`);
      } else {
        assert.equal(answer.error.message, "Method not found", label);
        assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 15_000, strikes: 1 } }, `${label}: an ordinary rest`);
      }
    }
});
test("a server error before the hedge delay fails over as before", async () => {
  const c = clock(), h = hedges(), store = memory(), hits: string[] = [];
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return String(url) === A ? new Response("oops", { status: 500 }) : ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, hedgeTimer: h.hedgeTimer, storage: store },
  );
  assert.equal((await body(await f(A, req("getAccountInfo", 1, ["x"])))).result, 42);
  assert.deepEqual(hits, [A, B]);
  assert.equal(h.stopped(), h.delays.length, "no hedge timer is left running");
  h.fire();
  await tick();
  assert.deepEqual(hits, [A, B]);
  // An ordinary 15 s rest, not the 10-minute one.
  assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 15_000, strikes: 1 } });
  c.advance(16_000);
  await f(A, req("getAccountInfo", 2, ["y"]));
  assert.equal(hits[2], A);
});
test("writes are never hedged", async () => {
  const h = hedges(), hits: string[] = [];
  const f = createRpcFetch(
    (url, init) => {
      hits.push(String(url));
      return String(url) === B ? Promise.resolve(ok()) : silent(init);
    },
    { intervalMs: 0, endpoints: [A, B], timeoutMs: 20, sleep: async () => {}, hedgeTimer: h.hedgeTimer },
  );
  assert.equal((await body(await f(A, req("sendTransaction", 1)))).result, 42);
  assert.deepEqual(hits, [A, B], "moved on only after A timed out");
  assert.deepEqual(h.delays, []);
});
test("a single endpoint is never hedged", async () => {
  for (const endpoints of [undefined, [A]]) {
    const h = hedges(), hits: string[] = [];
    const f = createRpcFetch(
      (url, init) => {
        hits.push(String(url));
        return silent(init);
      },
      { intervalMs: 0, endpoints, timeoutMs: 20, sleep: async () => {}, hedgeTimer: h.hedgeTimer },
    );
    await assert.rejects(f(A, req("getAccountInfo", 1, ["x"])), { message: RPC_BUSY });
    assert.deepEqual(hits, [A, A]);
    assert.deepEqual(h.delays, []);
  }
});
test("light reads are hedged after 2.5 s and heavy reads after 4 s", async () => {
  const h = hedges();
  const f = createRpcFetch(async () => ok(), {
    intervalMs: 0,
    endpoints: [A, B],
    timeoutMs: 0,
    sleep: async () => {},
    hedgeTimer: h.hedgeTimer,
  });
  await f(A, req("getBalance", 1, ["x"]));
  await f(A, req("getMultipleAccounts", 2, [["x"]]));
  await f(A, req("getProgramAccounts", 3, ["p"]));
  await f(A, req("getLatestBlockhash", 4));
  assert.deepEqual(h.delays, [2500, 4000, 4000, 2500]);
});
test("the hedge delays can be set, and the built-in timer keeps to them", async () => {
  // A answers after 60 ms: past the light delay, inside the heavy one.
  const run = async (method: string, params: unknown) => {
    const hits: string[] = [];
    const f = createRpcFetch(
      (url, init) => {
        hits.push(String(url));
        if (String(url) === B) return Promise.resolve(ok());
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(ok()), 60);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
      { intervalMs: 0, endpoints: [A, B], timeoutMs: 0, sleep: async () => {}, hedgeMs: { light: 5, heavy: 1_000 } },
    );
    assert.equal((await body(await f(A, req(method, 1, params)))).result, 42);
    return hits;
  };
  assert.deepEqual(await run("getAccountInfo", ["x"]), [A, B]);
  assert.deepEqual(await run("getMultipleAccounts", [["x"]]), [A]);
});
test("the retry round is hedged too", async () => {
  const c = clock(), h = hedges(), store = memory(), hits: string[] = [], waits: number[] = [];
  let round = 1;
  const f = createRpcFetch(
    (url, init) => {
      hits.push(String(url));
      if (round === 1) return Promise.resolve(new Response("busy", { status: 429 }));
      if (String(url) === B) return Promise.resolve(ok());
      h.fireSoon();
      return silent(init);
    },
    {
      intervalMs: 0,
      endpoints: [A, B],
      now: c.now,
      timeoutMs: 0,
      hedgeTimer: h.hedgeTimer,
      storage: store,
      sleep: async (ms) => {
        waits.push(ms);
        round = 2;
      },
    },
  );
  assert.equal((await body(await f(A, req("getAccountInfo", 1, ["x"])))).result, 42);
  assert.deepEqual(waits, [4000]);
  assert.deepEqual(hits, [A, B, A, B]);
  // A lost the race in the retry round, so it rests 10 minutes and B not at all.
  assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 2 } });
  c.advance(2 * MINUTE);
  await f(A, req("getAccountInfo", 2, ["y"]));
  assert.equal(hits[4], B);
});
test("in the last round the endpoint and its hedge get the full timeout, not the shorter probe", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const c = clock(), h = hedges(), hits: string[] = [], aborted: string[] = [];
    let round = 1;
    const f = createRpcFetch(
      (url, init) => {
        hits.push(String(url));
        if (round === 1) return Promise.resolve(new Response("busy", { status: 429 }));
        if (String(url) === A) h.fireSoon();
        init?.signal?.addEventListener("abort", () => aborted.push(String(url)));
        return silent(init);
      },
      {
        intervalMs: 0,
        endpoints: [A, B],
        now: c.now,
        hedgeTimer: h.hedgeTimer,
        sleep: async () => {
          round = 2;
        },
      },
    );
    const pending = f(A, req("getAccountInfo", 1, ["x"]));
    for (let i = 0; i < 50 && hits.length < 4; i++) await tick();
    assert.deepEqual(hits, [A, B, A, B]);
    // Both have a strike from the first round; the probe would end them at 4 s.
    mock.timers.tick(4_000);
    await tick();
    assert.deepEqual(aborted, []);
    mock.timers.tick(8_000);
    await assert.rejects(pending, { message: RPC_BUSY });
    assert.deepEqual(aborted, [A, B]);
  } finally {
    mock.timers.reset();
  }
});
test("when the quiet endpoint and its hedge both fail, the request moves on as before", async () => {
  const C = "https://c.example";
  const run = async (endpoints: string[]) => {
    const c = clock(), h = hedges(), hits: string[] = [];
    const f = createRpcFetch(
      (url, init) => {
        hits.push(String(url));
        if (String(url) === C) return Promise.resolve(ok());
        if (String(url) === B) return Promise.resolve(new Response("busy", { status: 429 }));
        h.fireSoon();
        return silent(init);
      },
      { intervalMs: 0, endpoints, now: c.now, timeoutMs: 20, sleep: async () => {}, hedgeTimer: h.hedgeTimer },
    );
    const answer = await f(A, req("getAccountInfo", 1, ["x"])).then(body, (e: Error) => e.message);
    return { answer, hits };
  };
  // The hedge already asked B, so the next endpoint is C.
  const three = await run([A, B, C]);
  assert.equal((three.answer as { result: number }).result, 42);
  assert.deepEqual(three.hits, [A, B, C]);
  // With two, the read waits once, retries both (hedged again, A first as both rest
  // equally long), then reports busy.
  const two = await run([A, B]);
  assert.equal(two.answer, RPC_BUSY);
  assert.deepEqual(two.hits, [A, B, A, B]);
});
test("after the last endpoint of a pass, the hedge goes to the best of the others", async () => {
  // A is still resting from an earlier page; B, asked alone, goes quiet.
  const c = clock(), h = hedges(), hits: string[] = [];
  const store = memory({ [A]: { restUntil: c.now() + 5 * MINUTE, strikes: 1 } });
  const f = createRpcFetch(
    (url, init) => {
      hits.push(String(url));
      if (String(url) === A) return Promise.resolve(ok());
      h.fireSoon();
      return silent(init);
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, hedgeTimer: h.hedgeTimer, storage: store },
  );
  assert.equal((await body(await f(A, req("getAccountInfo", 1, ["x"])))).result, 42);
  assert.deepEqual(hits, [B, A]);
  assert.deepEqual(store.saved(), { [B]: { restUntil: c.now() + 10 * MINUTE, strikes: 1 } }, "A answered and is reset");
});
test("a refusal ends another endpoint's 10-minute rest, and that one is asked before any wait", async () => {
  // Only a rest longer than the ordinary maximum (60 s) is ended.
  for (const [left, expected] of [
    [10 * MINUTE, { hits: [B, A], waits: [] }],
    [MINUTE, { hits: [B, A], waits: [10_000] }],
  ] as const) {
    const c = clock(), h = hedges(), hits: string[] = [], waits: number[] = [];
    const store = memory({ [A]: { restUntil: c.now() + left, strikes: 1 } });
    const f = createRpcFetch(
      async (url) => {
        hits.push(String(url));
        return String(url) === B ? new Response("busy", { status: 429, headers: { "retry-after": "60" } }) : ok();
      },
      {
        intervalMs: 0,
        endpoints: [A, B],
        now: c.now,
        timeoutMs: 0,
        hedgeTimer: h.hedgeTimer,
        storage: store,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    assert.equal((await body(await f(A, req("getAccountInfo", 1, ["x"])))).result, 42);
    assert.deepEqual({ hits, waits }, expected, String(left));
    // A answered, so it is preferred again and nothing of its rest is kept.
    assert.deepEqual(store.saved(), { [B]: { restUntil: c.now() + 60_000, strikes: 1 } });
    await f(A, req("getAccountInfo", 2, ["y"]));
    assert.equal(hits.at(-1), A);
  }
});
test("a quick refusal does not shorten a 10-minute rest that is still running", async () => {
  const c = clock(), hits: string[] = [];
  const store = memory({ [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 1 } });
  let down = true;
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      if (String(url) === A) return new Response("busy", { status: 429 });
      if (down) throw new TypeError("Failed to fetch");
      return ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: store },
  );
  // B cannot be reached, so the retry round asks A while it rests.
  await assert.rejects(f(A, req("getSlot", 1)), { message: RPC_BUSY });
  assert.deepEqual(hits, [B, B, A]);
  // Past the 30 s that A's second strike alone would give, reads still go to B.
  down = false;
  c.advance(31_000);
  await f(A, req("getSlot", 2));
  assert.deepEqual(hits, [B, B, A, B]);
  assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() - 31_000 + 10 * MINUTE, strikes: 2 } });
});
test("a hedge goes out without waiting for the pacing interval, and what follows is paced from it", async () => {
  const c = clock(), h = hedges(), hits: string[] = [], waits: number[] = [];
  const f = createRpcFetch(
    (url, init) => {
      hits.push(String(url));
      if (String(url) === B) return Promise.resolve(ok());
      queueMicrotask(() => {
        c.advance(2_500);
        h.fire();
      });
      return silent(init);
    },
    {
      intervalMs: 1_000,
      endpoints: [A, B],
      now: c.now,
      timeoutMs: 0,
      hedgeTimer: h.hedgeTimer,
      sleep: async (ms) => {
        waits.push(ms);
        c.advance(ms);
      },
    },
  );
  await f(A, req("getAccountInfo", 1, ["x"]));
  assert.deepEqual(hits, [A, B]);
  assert.deepEqual(waits, []);
  c.advance(400);
  await f(A, req("getAccountInfo", 2, ["y"]));
  assert.deepEqual(waits, [600]);
});
test("concurrent identical reads share one hedged request and keep their IDs", async () => {
  const h = hedges(), hits: string[] = [];
  const f = createRpcFetch(
    (url, init) => {
      hits.push(String(url));
      if (String(url) === B) return Promise.resolve(ok());
      h.fireSoon();
      return silent(init);
    },
    { intervalMs: 0, endpoints: [A, B], timeoutMs: 0, sleep: async () => {}, hedgeTimer: h.hedgeTimer },
  );
  const [a, b] = await Promise.all([f(A, req("getAccountInfo", 1, ["x"])), f(A, req("getAccountInfo", 2, ["x"]))]);
  assert.deepEqual(hits, [A, B]);
  assert.equal((await body(a)).id, 1);
  assert.equal((await body(b)).id, 2);
});
test("a caller's own signal: the read is not hedged, and its abort is not an endpoint failure", async () => {
  const h = hedges(), hits: string[] = [];
  const f = createRpcFetch(
    (url, init) => {
      hits.push(String(url));
      return hits.length === 1 ? silent(init) : Promise.resolve(ok());
    },
    { intervalMs: 0, endpoints: [A, B], timeoutMs: 0, sleep: async () => {}, hedgeTimer: h.hedgeTimer },
  );
  const controller = new AbortController();
  const pending = f(A, { ...req("getAccountInfo", 1, ["x"]), signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(h.delays, []);
  await f(A, req("getAccountInfo", 2, ["x"]));
  assert.deepEqual(hits, [A, A], "A was not rested");
});

// --- Rests kept between page loads ---
test("a rest saved by an earlier page is honoured on creation, for at most 10 minutes", async () => {
  const c = clock(), hits: string[] = [];
  const store = memory({ [A]: { restUntil: c.now() + 24 * 60 * MINUTE, strikes: 1 } });
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: store },
  );
  await f(A, req("getSlot", 1));
  assert.deepEqual(hits, [B]);
  c.advance(10 * MINUTE - 1);
  await f(A, req("getSlot", 2));
  assert.deepEqual(hits, [B, B]);
  c.advance(2);
  await f(A, req("getSlot", 3));
  assert.deepEqual(hits, [B, B, A]);
  assert.deepEqual(store.saved(), {}, "A answered, so nothing is resting");
});
test("expired and malformed saved rests are ignored", async () => {
  const c = clock();
  const later = c.now() + MINUTE;
  for (const saved of [
    { [A]: { restUntil: c.now() - 1, strikes: 1 } },
    { [A]: { restUntil: c.now(), strikes: 1 } },
    { [A]: "resting" },
    { [A]: null },
    { [A]: { restUntil: String(later), strikes: 1 } },
    { [A]: { restUntil: later } },
    { [A]: { restUntil: later, strikes: -1 } },
    { [A]: { restUntil: later, strikes: 1.5 } },
    [{ restUntil: later, strikes: 1 }],
    "not json",
    "42",
    "null",
  ]) {
    const hits: string[] = [];
    const f = createRpcFetch(
      async (url) => {
        hits.push(String(url));
        return ok();
      },
      { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: memory(saved) },
    );
    await f(A, req("getSlot", 1));
    assert.deepEqual(hits, [A], JSON.stringify(saved));
  }
});
test("an expired saved rest brings no strikes with it", async () => {
  const c = clock(), store = memory({ [A]: { restUntil: c.now() - 1, strikes: 3 } });
  const f = createRpcFetch(
    async (url) => (String(url) === A ? new Response("busy", { status: 429 }) : ok()),
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: store },
  );
  await f(A, req("getSlot", 1));
  assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 15_000, strikes: 1 } });
});
test("a storage that throws does not break requests", async () => {
  const c = clock(), hits: string[] = [];
  const broken = {
    getItem: (): string | null => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return String(url) === A ? new Response("busy", { status: 429 }) : ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: broken },
  );
  assert.equal((await body(await f(A, req("getSlot", 1)))).result, 42);
  await f(A, req("getSlot", 2));
  assert.deepEqual(hits, [A, B, B], "rests still work in memory");
});
test("only endpoint URLs and numbers are saved, and a new client picks them up", async () => {
  const c = clock(), store = memory(), hits: string[] = [];
  const base = async (url: RequestInfo | URL) => {
    hits.push(String(url));
    return String(url) === A ? new Response("busy", { status: 429, headers: { "retry-after": "45" } }) : ok();
  };
  const options = { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: store };
  await createRpcFetch(base, options)(A, req("getSlot", 1));
  assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 45_000, strikes: 1 } });
  // The next page load starts with B.
  c.advance(30_000);
  await createRpcFetch(base, options)(A, req("getSlot", 2));
  assert.deepEqual(hits, [A, B, B]);
});
test("a quick failure in one tab does not shorten a longer rest another tab saved", async () => {
  const c = clock(), store = memory(), hits: string[] = [];
  const base = async (url: RequestInfo | URL) => {
    hits.push(String(url));
    return String(url) === A ? new Response("down", { status: 503 }) : ok();
  };
  const options = { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: store };
  const f = createRpcFetch(base, options);
  // Another tab, after this one was created, saw A go quiet.
  store.setItem(KEY, JSON.stringify({ [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 1 } }));
  assert.equal((await body(await f(A, req("getSlot", 1)))).result, 42);
  assert.deepEqual(hits, [A, B]);
  assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 1 } });
  // So a new page load still starts with B, after this tab's own 15 s rest for A is over.
  c.advance(16_000);
  await createRpcFetch(base, options)(A, req("getSlot", 2));
  assert.deepEqual(hits, [A, B, B]);
});
test("a tab saves only the endpoint it saw and leaves the other entries alone", async () => {
  const c = clock(), hits: string[] = [];
  const store = memory({ [A]: { restUntil: c.now() + 5 * MINUTE, strikes: 1 } });
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      if (String(url) === B) throw new TypeError("Failed to fetch");
      return ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: store },
  );
  // Another tab has since made A's rest longer.
  store.setItem(KEY, JSON.stringify({ [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 2 } }));
  await assert.rejects(f(A, req("sendTransaction", 1)), { message: RPC_BUSY });
  assert.deepEqual(hits, [B]);
  assert.deepEqual(store.saved(), {
    [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 2 },
    [B]: { restUntil: c.now() + 15_000, strikes: 1 },
  });
});
test("an endpoint that answers clears a rest another tab saved for it, and only that one", async () => {
  const c = clock(), store = memory(), hits: string[] = [];
  const f = createRpcFetch(
    async (url) => {
      hits.push(String(url));
      return ok();
    },
    { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {}, storage: store },
  );
  // Another tab rests both after this one was created; this one has not struck either.
  store.setItem(
    KEY,
    JSON.stringify({ [A]: { restUntil: c.now() + 10 * MINUTE, strikes: 1 }, [B]: { restUntil: c.now() + 30_000, strikes: 2 } }),
  );
  await f(A, req("getSlot", 1));
  assert.deepEqual(hits, [A]);
  assert.deepEqual(store.saved(), { [B]: { restUntil: c.now() + 30_000, strikes: 2 } });
});
test("without a window, localStorage is left alone", async () => {
  let touched = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      touched = true;
      return memory();
    },
  });
  try {
    const f = createRpcFetch(
      async (url) => (String(url) === A ? new Response("busy", { status: 429 }) : ok()),
      { intervalMs: 0, endpoints: [A, B], timeoutMs: 0, sleep: async () => {} },
    );
    await f(A, req("getSlot", 1));
    assert.equal(touched, false);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
test("in a browser the rests go to localStorage by default, and storage: null keeps none", async () => {
  const c = clock(), store = memory(), hits: string[] = [];
  const g = globalThis as { window?: unknown; localStorage?: unknown };
  let touched = false;
  g.window = {};
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      touched = true;
      return store;
    },
  });
  try {
    const base = async (url: RequestInfo | URL) => {
      hits.push(String(url));
      return String(url) === A ? new Response("busy", { status: 429 }) : ok();
    };
    const options = { intervalMs: 0, endpoints: [A, B], now: c.now, timeoutMs: 0, sleep: async () => {} };
    await createRpcFetch(base, options)(A, req("getSlot", 1));
    assert.deepEqual(store.saved(), { [A]: { restUntil: c.now() + 15_000, strikes: 1 } });
    // The next page load goes straight to B.
    await createRpcFetch(base, options)(A, req("getSlot", 2));
    assert.deepEqual(hits, [A, B, B]);
    touched = false;
    await createRpcFetch(base, { ...options, storage: null })(A, req("getSlot", 3));
    assert.deepEqual(hits, [A, B, B, A, B], "a client that keeps nothing starts with A");
    assert.equal(touched, false);
  } finally {
    delete g.window;
    delete g.localStorage;
  }
});

// --- The app's endpoint order (runtime.ts) ---
test("the app asks Sonata's relay first in a browser, then public Devnet; elsewhere public Devnet only", async () => {
  const { devnetEndpoints, PUBLIC_DEVNET } = await import("./runtime.ts");
  assert.equal(PUBLIC_DEVNET, "https://api.devnet.solana.com");
  assert.deepEqual(devnetEndpoints("https://sonata.umin.ai"), ["https://sonata.umin.ai/api/rpc", PUBLIC_DEVNET]);
  assert.deepEqual(devnetEndpoints("http://localhost:5173"), ["http://localhost:5173/api/rpc", PUBLIC_DEVNET]);
  assert.deepEqual(devnetEndpoints(), [PUBLIC_DEVNET]);
});
test("the network check goes out at once, alongside a queued read, and does not delay the next one", async () => {
  const started: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const waits: number[] = [];
  const f = createRpcFetch(
    async (_input, init) => {
      const method = JSON.parse(String(init?.body)).method as string;
      started.push(method);
      if (method === "getMultipleAccounts") await gate;
      return ok();
    },
    { intervalMs: 350, sleep: async (ms) => void waits.push(ms), timeoutMs: 0 },
  );
  const read = f("https://rpc", req("getMultipleAccounts", 1, [["a"]]));
  await new Promise((r) => setTimeout(r, 0));
  const check = f("https://rpc", req("getGenesisHash", 2));
  assert.equal((await body(await check)).result, 42, "answered while the read is still out");
  assert.deepEqual(started, ["getMultipleAccounts", "getGenesisHash"]);
  release();
  await read;
  // Other requests still run one at a time, paced.
  await f("https://rpc", req("getSlot", 3));
  assert.deepEqual(started, ["getMultipleAccounts", "getGenesisHash", "getSlot"]);
  assert.equal(waits.length, 1, "the read after the first was paced; the network check was not");
});
