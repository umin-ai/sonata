import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SONATA_VAULT, VAULT_ADMIN } from "./common.mjs";
import { MAX_TX_BYTES } from "./payout.mjs";
import {
  BOUNTY_MAX_WINDOW_SECONDS,
  BOUNTY_SETTLE_SECONDS,
  bountyShares,
  bountyWindow,
  netByTrader,
  rankTopBuyers,
  runTopBuyers,
} from "./top-buyers.mjs";
import { fakeChain, key, memLedger, moduleContext, pda, rewardMarket, tokenAccount } from "./testkit.mjs";

const NOW = 1_900_000_000; // unix seconds
const at = (s) => new Date(s * 1000).toISOString();
const trade = (pool, trader, side, quote, time) => ({ pool, trader: trader.toBase58?.() ?? trader, side, quote_amount: String(quote), block_time: at(time) });

test("net is buys minus sells per trader, inside the window only, largest first", () => {
  const [a, b, c, d] = [key(), key(), key(), key()].map(String);
  const trades = [
    trade("p", a, "buy", 500, 100),
    trade("p", a, "sell", 200, 150), // a: 300
    trade("p", b, "buy", 400, 120), // b: 400
    trade("p", c, "buy", 900, 130),
    trade("p", c, "sell", 950, 140), // c: -50, out
    trade("p", d, "buy", 1_000, 99), // before the window
    trade("p", d, "buy", 1_000, 200), // at its end: the next round's
    trade("p", d, "sell", 10, 199), // d: -10
  ];
  assert.deepEqual(netByTrader(trades, { start: 100, end: 200 }), [{ trader: b, net: 400n }, { trader: a, net: 300n }]);
});

test("the window starts where the last paid round ended, never more than an hour back, and ends a minute ago", () => {
  const now = NOW * 1000;
  assert.deepEqual(bountyWindow({ now }), { start: NOW - BOUNTY_SETTLE_SECONDS - BOUNTY_MAX_WINDOW_SECONDS, end: NOW - BOUNTY_SETTLE_SECONDS });
  assert.deepEqual(bountyWindow({ now, lastRoundEnd: NOW - 900 }), { start: NOW - 900, end: NOW - 60 });
  // A stalled crank does not reward stale buys.
  assert.deepEqual(bountyWindow({ now, lastRoundEnd: NOW - 5 * 3600 }), { start: NOW - 60 - 3600, end: NOW - 60 });
  assert.equal(BOUNTY_MAX_WINDOW_SECONDS, 3600);
});

test("the top three net buyers win 50/30/20; the creator, Sonata's keys and non-wallets are excluded", () => {
  const creator = key(), crank = key();
  const [w1, w2, w3, w4] = [key(), key(), key(), key()];
  const nets = [
    { trader: creator.toBase58(), net: 10_000n },
    { trader: crank.toBase58(), net: 9_000n },
    { trader: VAULT_ADMIN.toBase58(), net: 8_000n },
    { trader: SONATA_VAULT.toBase58(), net: 7_500n },
    { trader: pda().toBase58(), net: 7_000n },
    { trader: "not-an-address", net: 6_500n },
    { trader: w2.toBase58(), net: 5_000n },
    { trader: w1.toBase58(), net: 6_000n },
    { trader: w3.toBase58(), net: 4_000n },
    { trader: w4.toBase58(), net: 3_000n },
  ];
  const winners = rankTopBuyers(nets, { excluded: [creator, crank] });
  assert.deepEqual(winners.map((w) => [w.trader, w.rank]), [[w1.toBase58(), 1], [w2.toBase58(), 2], [w3.toBase58(), 3]]);
  // 50/30/20 of owed, rounded down; the rounding stays owed.
  assert.deepEqual(bountyShares(winners, 1_000_001n).map((w) => w.amount), [500_000n, 300_000n, 200_000n]);
  // Fewer than three: only their shares are paid, the rest rolls over.
  assert.deepEqual(bountyShares(winners.slice(0, 2), 1_000_000n).map((w) => w.amount), [500_000n, 300_000n]);
  assert.deepEqual(bountyShares(winners.slice(0, 1), 1_000_000n).map((w) => w.amount), [500_000n]);
  assert.deepEqual(bountyShares([], 1_000_000n), []);
  // Ties by address; no one with a zero or negative net.
  const [x, y] = [key(), key()].map(String).sort();
  assert.deepEqual(rankTopBuyers([{ trader: y, net: 5n }, { trader: x, net: 5n }, { trader: key().toBase58(), net: 0n }]).map((w) => w.trader), [x, y]);
});

async function bounty({ trades = [], owed = 1_000_000n, withAta = [], now = NOW * 1000, ledger }) {
  const authority = Keypair.generate();
  const chain = fakeChain();
  const m = rewardMarket(chain, authority.publicKey, { owed, held: owed * 3n });
  for (const w of withAta) chain.put(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID), tokenAccount({ owner: w, mint: m.quoteMint }));
  const l = ledger ?? memLedger();
  l.trades.push(...trades.map((t) => ({ ...t, pool: m.pool.toBase58() })));
  const ctx = await moduleContext({ chain, m, authority, owed, ledger: l, now: () => now, model: { feeModel: "topBuyers" } });
  return { chain, m, ctx, ledger: l, authority };
}
const quoteOf = (chain, m, w) => chain.balance(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID));

test("a round pays its top three in one transaction and the next round starts at its end", async () => {
  const [a, b, c, d] = [key(), key(), key(), key()];
  const t0 = NOW - 1800;
  const trades = [
    trade("", a, "buy", 5_000, t0), trade("", a, "sell", 1_000, t0 + 1), // 4000
    trade("", b, "buy", 3_000, t0 + 2), // 3000
    trade("", c, "buy", 2_000, t0 + 3), // 2000
    trade("", d, "buy", 1_000, t0 + 4), // 1000, fourth
  ];
  const { chain, m, ctx, ledger } = await bounty({ trades, withAta: [a, b, c, d] });
  assert.deepEqual(await runTopBuyers(ctx), {});
  assert.equal(chain.sent.length, 1);
  assert.ok(chain.sent[0].bytes <= MAX_TX_BYTES);
  assert.deepEqual([a, b, c, d].map((w) => quoteOf(chain, m, w)), [500_000n, 300_000n, 200_000n, 0n]);
  const [row] = ledger.payouts;
  assert.equal(row.module, "topBuyers");
  assert.equal(row.amount, 1_000_000n);
  assert.equal(row.detail.roundEnd, NOW - 60);
  assert.equal(row.detail.roundStart, NOW - 60 - 3600);
  assert.deepEqual(row.detail.winners.map((w) => [w.trader, w.rank, w.net, w.amount]), [
    [a.toBase58(), 1, 4_000n, 500_000n], [b.toBase58(), 2, 3_000n, 300_000n], [c.toBase58(), 3, 2_000n, 200_000n],
  ]);
  // Fifteen minutes later: the round starts where the last one ended, so the old buys no longer count.
  const later = await bounty({ trades, withAta: [a, b, c, d], now: (NOW + 900) * 1000, ledger });
  later.ledger.trades.length = 0;
  later.ledger.trades.push(...trades.map((t) => ({ ...t, pool: later.m.pool.toBase58() })));
  // Same pool as the first round, so its round end applies.
  later.ctx.m = { ...later.ctx.m, pool: m.pool };
  later.ledger.trades.forEach((t) => (t.pool = m.pool.toBase58()));
  const r = await runTopBuyers(later.ctx);
  assert.match(r.skip, /no net buyers this round; the pot rolls over/);
  assert.equal(later.ctx.fields.roundStart, NOW - 60);
});

test("with fewer than three net buyers only their shares are paid; with none the pot rolls over and the round does not end", async () => {
  const [a, b, seller] = [key(), key(), key()];
  const t = NOW - 600;
  const two = await bounty({ trades: [trade("", a, "buy", 900, t), trade("", b, "buy", 800, t), trade("", seller, "sell", 5_000, t)], withAta: [a, b, seller] });
  await runTopBuyers(two.ctx);
  assert.deepEqual([a, b, seller].map((w) => quoteOf(two.chain, two.m, w)), [500_000n, 300_000n, 0n]);
  assert.equal(two.ctx.result.paid, 800_000n);
  assert.equal(two.ctx.fund.owed, 200_000n);

  const none = await bounty({ trades: [trade("", seller, "sell", 5_000, t), trade("", a, "buy", 10, t - 4000)] });
  const r = await runTopBuyers(none.ctx);
  assert.match(r.skip, /no net buyers/);
  assert.equal(none.chain.sent.length, 0);
  assert.equal(await none.ledger.lastRoundEnd(none.m.pool.toBase58()), null);
});

test("a winner without a quote account is skipped and their share rolls over; if nobody can be paid the round continues", async () => {
  const [a, b, c] = [key(), key(), key()];
  const t = NOW - 600;
  const trades = [trade("", a, "buy", 3, t), trade("", b, "buy", 2, t), trade("", c, "buy", 1, t)];
  const some = await bounty({ trades, withAta: [a, c] });
  await runTopBuyers(some.ctx);
  assert.deepEqual([a, b, c].map((w) => quoteOf(some.chain, some.m, w)), [500_000n, null, 200_000n]);
  assert.equal(some.ctx.result.skipped.missing, 1);
  assert.deepEqual(some.ledger.payouts[0].detail.winners.map((w) => w.rank), [1, 3]);

  const nobody = await bounty({ trades });
  await runTopBuyers(nobody.ctx);
  assert.equal(nobody.chain.sent.length, 0);
  assert.match(nobody.ctx.result.note, /round continues/);
  assert.equal(await nobody.ledger.lastRoundEnd(nobody.m.pool.toBase58()), null);
});

test("a pending bounty payout ends its round too, until it settles", async () => {
  const ledger = memLedger();
  await ledger.begin({ signature: "s", pool: "p", amount: 1n, recipients: 1, lastValidBlockHeight: 1, module: "topBuyers", detail: { roundEnd: 123 } });
  assert.equal(await ledger.lastRoundEnd("p"), 123);
  await ledger.drop("s");
  assert.equal(await ledger.lastRoundEnd("p"), null);
});
