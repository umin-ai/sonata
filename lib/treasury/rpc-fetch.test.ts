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
