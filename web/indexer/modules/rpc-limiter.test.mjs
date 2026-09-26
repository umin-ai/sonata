// The indexer's shared RPC budget (rpc-limiter.mjs) on a manual clock: totals,
// per-method caps, priority, and what a request body's method is.
import test from "node:test";
import assert from "node:assert/strict";
import { PRIORITY, rpcLimiter, rpcMethod } from "./rpc-limiter.mjs";
import { manualClock } from "./livekit.mjs";

const settle = () => new Promise((r) => setImmediate(r));

function setup(opts = {}) {
  const clock = manualClock();
  const limiter = rpcLimiter({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...opts });
  const granted = [];
  const ask = (method, priority, label = method) => limiter.acquire(method, priority).then(() => granted.push(label));
  return { clock, limiter, granted, ask };
}

test("at most a second's worth at once, then the rate; never more than the per-second total in any second after", async () => {
  const { clock, granted, ask } = setup({ perSecond: 6, perMethodPerSecond: 6 });
  for (let i = 0; i < 20; i++) void ask(`m${i % 5}`, PRIORITY.background, i);
  await settle();
  assert.equal(granted.length, 6, "the burst");
  clock.advance(500);
  await settle();
  assert.equal(granted.length, 9);
  clock.advance(500);
  await settle();
  assert.equal(granted.length, 12);
  clock.advance(10_000);
  await settle();
  assert.equal(granted.length, 20);
});

test("one method gets at most its own share, and waits without holding up the others", async () => {
  const { clock, granted, ask } = setup({ perSecond: 10, perMethodPerSecond: 3 });
  for (let i = 0; i < 6; i++) void ask("getTransaction", PRIORITY.background, `tx${i}`);
  void ask("getSlot", PRIORITY.background, "slot");
  await settle();
  assert.deepEqual(granted, ["tx0", "tx1", "tx2", "slot"]);
  clock.advance(1_000);
  await settle();
  assert.deepEqual(granted.slice(4), ["tx3", "tx4", "tx5"]);
});

test("the poll goes first: waiting requests are granted in priority order", async () => {
  const { clock, granted, ask } = setup({ perSecond: 2, perMethodPerSecond: 2 });
  void ask("a", PRIORITY.background, "bg1");
  void ask("b", PRIORITY.background, "bg2");
  await settle();
  // The budget is used up: these wait.
  void ask("c", PRIORITY.background, "bg3");
  void ask("d", PRIORITY.reader, "reader");
  void ask("e", PRIORITY.live, "live");
  void ask("f", PRIORITY.poll, "poll");
  await settle();
  clock.advance(1_000);
  await settle();
  assert.deepEqual(granted, ["bg1", "bg2", "poll", "live"]);
  clock.advance(1_000);
  await settle();
  assert.deepEqual(granted.slice(4), ["reader", "bg3"]);
});

test("a request body's method", () => {
  assert.equal(rpcMethod(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [] })), "getMultipleAccounts");
  assert.equal(rpcMethod(JSON.stringify([{ method: "getTransaction" }])), "getTransaction");
  assert.equal(rpcMethod(undefined), "unknown");
  assert.equal(rpcMethod("{not json"), "unknown");
});
