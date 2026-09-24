import test from "node:test";
import assert from "node:assert/strict";
import { diamondWeights, multiplierCounts, runDiamond, tenureStart, tierFor } from "./diamond.mjs";
import { rewardShares } from "./payout.mjs";
import { key, memLedger } from "./testkit.mjs";

const H = 3600, D = 24 * H;
const NOW = 1_900_000_000;

test("tenure starts at the later of the first buy and the last sell; without trades there is none", () => {
  assert.equal(tenureStart({ firstBuy: 100, lastSell: null }), 100);
  // Any sell restarts the clock, even after later buys.
  assert.equal(tenureStart({ firstBuy: 100, lastSell: 500 }), 500);
  // A sell before the first buy (tokens received by transfer, sold, then bought) does not.
  assert.equal(tenureStart({ firstBuy: 800, lastSell: 500 }), 800);
  assert.equal(tenureStart({ firstBuy: null, lastSell: 500 }), 500);
  assert.equal(tenureStart({}), null);
  assert.equal(tenureStart(undefined), null);
});

test("multipliers: under 24h 1x, from 24h 1.5x, from 3 days 2x, from 7 days 3x", () => {
  const label = (heldFor) => tierFor(NOW - heldFor, NOW).label;
  assert.equal(label(0), "1");
  assert.equal(label(D - 1), "1");
  assert.equal(label(D), "1.5");
  assert.equal(label(3 * D - 1), "1.5");
  assert.equal(label(3 * D), "2");
  assert.equal(label(7 * D - 1), "2");
  assert.equal(label(7 * D), "3");
  assert.equal(label(400 * D), "3");
  // No indexed trades: 1x.
  assert.equal(tierFor(null, NOW).label, "1");
  // A clock in the future (clock skew) is 1x.
  assert.equal(label(-60), "1");
});

test("weights are balance times multiplier; a sell resets a long holder to 1x", () => {
  const [longHolder, seller, fresh, gifted] = [key(), key(), key(), key()];
  const holders = [longHolder, seller, fresh, gifted].map((owner) => ({ owner, balance: 1_000n }));
  const tenures = new Map([
    [longHolder.toBase58(), { firstBuy: NOW - 10 * D, lastSell: null }],
    [seller.toBase58(), { firstBuy: NOW - 10 * D, lastSell: NOW - H }],
    [fresh.toBase58(), { firstBuy: NOW - 2 * D, lastSell: null }],
  ]);
  const w = diamondWeights(holders, tenures, NOW);
  assert.deepEqual(w.map((x) => x.multiplier), ["3", "1", "1.5", "1"]);
  assert.deepEqual(w.map((x) => x.held), [1_000n, 1_000n, 1_000n, 1_000n]);
  // 3 : 1 : 1.5 : 1 of 650000 (6 : 2 : 3 : 2 halves of 13).
  assert.deepEqual(rewardShares(w, 650_000n).map((s) => s.amount), [300_000n, 100_000n, 150_000n, 100_000n]);
  assert.deepEqual(multiplierCounts(w), { 1: 2, 1.5: 1, 2: 0, 3: 1 });
});

test("the diamond module pays through the holders path with tenure weights from the trades table", async () => {
  const [a, b] = [key(), key()];
  const pool = key();
  const at = (s) => new Date(s * 1000).toISOString();
  const ledger = memLedger({
    trades: [
      { pool: pool.toBase58(), trader: a.toBase58(), side: "buy", quote_amount: "1", block_time: at(NOW - 8 * D) },
      { pool: pool.toBase58(), trader: b.toBase58(), side: "buy", quote_amount: "1", block_time: at(NOW - 8 * D) },
      { pool: pool.toBase58(), trader: b.toBase58(), side: "sell", quote_amount: "1", block_time: at(NOW - 2 * H) },
    ],
  });
  let weighted, detail;
  const ctx = {
    m: { pool },
    ledger,
    fields: {},
    now: () => NOW * 1000,
    payHolders: async (opts) => {
      assert.equal(opts.module, "diamond");
      weighted = await opts.weigh([{ owner: a, balance: 10n }, { owner: b, balance: 10n }]);
      detail = opts.detail();
      return {};
    },
  };
  await runDiamond(ctx);
  assert.deepEqual(weighted.map((w) => [w.multiplier, w.balance]), [["3", 60n], ["1", 20n]]);
  assert.deepEqual(detail, { multipliers: { 1: 1, 1.5: 0, 2: 0, 3: 1 } });
  assert.equal(ctx.fields.multipliers, "1x:1,1.5x:0,2x:0,3x:1");
});
