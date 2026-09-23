import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeTrades, priceFromSqrt, SUPPLY_TOKENS } from "./parse.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test("decodes a real Devnet buy made through the app", () => {
  // 2kjcad7q…: 0.02 mQQQ for 1,905,864.930164 FLOOR on the Stock Floor proof pool.
  const trades = decodeTrades(fixture("app-buy.json"), "sig");
  assert.equal(trades.length, 1, "legacy evtSwap is not double counted");
  const [t] = trades;
  assert.equal(t.pool, "9iuQLtqQETzEjGrPVycWFoANL22W9s3MoNfTt2dfxong");
  assert.equal(t.side, "buy");
  assert.equal(t.trader, "GX3N5UEDE4YBSC46ZND8YZbxP8ynZWtyQNtp5EqjezQ3");
  assert.equal(t.quoteAmount, "2000000");
  assert.equal(t.baseAmount, "1905864930164");
  assert.equal(t.fee, "60000"); // 3%
  // Market cap after the trade, in mQQQ: about 10.2.
  assert.ok(Math.abs(t.price * SUPPLY_TOKENS - 10.198) < 0.01);
});

test("failed transactions produce no trades", () => {
  const tx = fixture("app-buy.json");
  assert.deepEqual(decodeTrades({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, "x"] } } }, "s"), []);
});

test("Q64.64 sqrt price converts to quote tokens per base token", () => {
  // sqrt = 2^64 means 1 quote atom per base atom = 0.01 quote tokens per base token at 6/8 decimals.
  assert.equal(priceFromSqrt(2n ** 64n), 0.01);
});
