import test from "node:test";
import assert from "node:assert/strict";
import {
  balancesByMint,
  botModel,
  kindName,
  listsModel,
  parseMarketPayouts,
  parseWalletPayouts,
  paysWhom,
  sinceText,
  stockTotals,
  walletBacking,
} from "./overview.ts";

const WALLET = "vb4pminVbRa8BRaRCDa7JmAkFx6LSmnwMiDtsKvkXVF";
const OTHER = "Fb83XLPdUM11FrUUBNaB1JXJ2feJacNkcPGUzP8dtGz";
const POOL_A = "BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf";
const POOL_B = "51fyqN7fdXAdRMagYya92cQ7caSP5FUDJpQvaefKrecR";
const mSPY = "6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg";
const mQQQ = "dXrPEzAYgn5H3y7GwCfCr6okHsWXidpMQrRq33LNTJh";

test("a Reward token runs the bot's recorded model, else its metadata's, else holder rewards", () => {
  assert.equal(botModel("topBuyers", "holders"), "topBuyers");
  assert.equal(botModel(null, "buyback"), "buyback");
  assert.equal(botModel(undefined, undefined, "diamond"), "diamond");
  // Standard and Backed are launch choices, not something the bot runs.
  assert.equal(botModel(null, "standard"), "holders");
  assert.equal(botModel(null, "backed", undefined), "holders");
  assert.equal(botModel(), "holders");
});

test("fee modules are listed only once the new payout bot runs them; holder rewards always", () => {
  assert.equal(listsModel("holders", false), true);
  assert.equal(listsModel("holders", true), true);
  for (const m of ["buyback", "topBuyers", "lpFarm", "split", "diamond"] as const) {
    assert.equal(listsModel(m, false), false, m);
    assert.equal(listsModel(m, true), true, m);
  }
});

test("each payout kind says who it pays and has a name", () => {
  assert.equal(paysWhom("holders"), "Holders, pro rata");
  assert.equal(paysWhom("topBuyers"), "Top 3 buyers each round");
  assert.equal(paysWhom("lpFarm"), "Holders now, LPs after graduation");
  assert.equal(paysWhom("lpFarm", "lps"), "Liquidity providers, pro rata");
  for (const k of ["holders", "buyback", "topBuyers", "lpFarm", "split", "diamond", "airdrop"] as const) {
    assert.ok(paysWhom(k).length > 0, k);
    assert.notEqual(kindName(k), k, k);
  }
  assert.equal(kindName("somethingNew"), "somethingNew");
});

test("times read relative to when the data was read", () => {
  const now = 1_790_000_000_000;
  assert.equal(sinceText(1_790_000_000, now), "just now");
  assert.equal(sinceText(1_790_000_000 + 60, now), "just now", "a clock slightly ahead is not negative");
  assert.equal(sinceText(1_790_000_000 - 5 * 60, now), "5 min ago");
  assert.equal(sinceText(1_790_000_000 - 3 * 3600, now), "3 h ago");
  assert.equal(sinceText(1_790_000_000 - 3 * 86400, now), "3 d ago");
});

test("a market's payout record is checked field by field", () => {
  assert.deepEqual(
    parseMarketPayouts({
      pool: POOL_A, paid: "1000", payouts: 3, recipientsLast: 2, lastPaidAt: 1_790_000_000, feeModel: "buyback", burned: "77",
      airdrop: { status: "sent", amount: "5000", recipients: 12, sentAt: 1_790_000_100 },
    }),
    {
      paid: "1000", payouts: 3, lastPaidAt: 1_790_000_000, feeModel: "buyback", burned: "77",
      airdrop: { status: "sent", amount: "5000", recipients: 12, sentAt: 1_790_000_100 },
    },
  );
  // The indexer before fee modules: no feeModel.
  assert.deepEqual(parseMarketPayouts({ paid: "0", payouts: 0, lastPaidAt: null }), { paid: "0", payouts: 0, lastPaidAt: null, feeModel: null });
  assert.deepEqual(parseMarketPayouts({ paid: "5", airdrop: { status: "odd", amount: -1, recipients: "x", sentAt: "soon" } })?.airdrop, {
    status: "waiting", amount: null, recipients: 0, sentAt: null,
  });
  for (const bad of [null, "x", {}, { paid: 5 }, { paid: "-5" }, { paid: "1.5" }]) assert.equal(parseMarketPayouts(bad), null);
});

test("a wallet's payouts must be for that wallet; malformed rows are left out", () => {
  const row = { pool: POOL_A, module: "holders", asset: "quote", paid: "175", payouts: 2, lastPaidAt: 1_790_000_900 };
  assert.equal(parseWalletPayouts({ wallet: OTHER, payouts: [row] }, WALLET), null);
  assert.equal(parseWalletPayouts({ wallet: WALLET }, WALLET), null);
  assert.equal(parseWalletPayouts({ error: "Not found." }, WALLET), null);
  assert.deepEqual(
    parseWalletPayouts(
      {
        wallet: WALLET,
        payouts: [
          row,
          // Airdrops are paid in the token itself, whatever the row says.
          { pool: POOL_B, module: "airdrop", asset: "quote", paid: "5000000", payouts: 1, lastPaidAt: null },
          { pool: "not a pool", module: "holders", paid: "1", payouts: 1 },
          { pool: POOL_A, module: "", paid: "1", payouts: 1 },
          { pool: POOL_A, module: "split", paid: "1e3", payouts: 1 },
          null,
        ],
      },
      WALLET,
    ),
    [row, { pool: POOL_B, module: "airdrop", asset: "base", paid: "5000000", payouts: 1, lastPaidAt: null }],
  );
});

test("totals per stock add quote payouts by the market's stock, largest first", () => {
  const quoteOf = (pool: string) => ({ [POOL_A]: mSPY, [POOL_B]: mQQQ })[pool];
  const totals = stockTotals(
    [
      { pool: POOL_A, module: "holders", asset: "quote", paid: "100", payouts: 1, lastPaidAt: null },
      { pool: POOL_A, module: "topBuyers", asset: "quote", paid: "50", payouts: 1, lastPaidAt: null },
      { pool: POOL_B, module: "holders", asset: "quote", paid: "400", payouts: 1, lastPaidAt: null },
      // The airdrop is in POOL_B's own token, and an unknown pool has no stock.
      { pool: POOL_B, module: "airdrop", asset: "base", paid: "999999", payouts: 1, lastPaidAt: null },
      { pool: OTHER, module: "holders", asset: "quote", paid: "7", payouts: 1, lastPaidAt: null },
    ],
    quoteOf,
  );
  assert.deepEqual(totals, [
    { mint: mQQQ, amount: 400n },
    { mint: mSPY, amount: 150n },
  ]);
});

test("balances add up a wallet's own unfrozen accounts per mint", () => {
  const balances = balancesByMint(
    [
      { mint: mSPY, owner: WALLET, amount: 5n, frozen: false },
      { mint: mSPY, owner: WALLET, amount: 7n, frozen: false },
      { mint: mSPY, owner: WALLET, amount: 100n, frozen: true },
      { mint: mQQQ, owner: OTHER, amount: 9n, frozen: false },
      { mint: mQQQ, owner: WALLET, amount: 0n, frozen: false },
    ],
    WALLET,
  );
  assert.deepEqual([...balances], [[mSPY, 12n]]);
});

test("the backing a wallet's tokens get matches the program's rounding", () => {
  const balances = new Map([
    ["BASE_A", 117_600_268_266_952n],
    ["BASE_B", 10n],
    ["BASE_C", 1n],
  ]);
  const rows = walletBacking(
    [
      // The Devnet Stock Floor proof (lib/treasury/floor.test.ts).
      { pool: POOL_A, baseMint: "BASE_A", floor: 2_400_000n, supply: 1_000_000_000_000_000n },
      { pool: POOL_B, baseMint: "BASE_B", floor: null, supply: null },
      { pool: OTHER, baseMint: "BASE_C", floor: 500n, supply: 1000n },
      { pool: WALLET, baseMint: "NOT_HELD", floor: 500n, supply: 1000n },
    ],
    balances,
  );
  assert.deepEqual(rows, [
    { pool: POOL_A, held: 117_600_268_266_952n, share: 282_240n },
    { pool: OTHER, held: 1n, share: 0n },
    { pool: POOL_B, held: 10n, share: null },
  ]);
});
