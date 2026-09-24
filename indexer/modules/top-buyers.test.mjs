import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SONATA_VAULT, VAULT_ADMIN } from "./common.mjs";
import { MAX_TX_BYTES } from "./payout.mjs";
import { pgLedger } from "../rewards.mjs";
import {
  BOUNTY_MAX_WINDOW_SECONDS,
  BOUNTY_SETTLE_SECONDS,
  INDEX_STALE_SECONDS,
  bountyShares,
  bountyWindow,
  netByTrader,
  rankTopBuyers,
  runTopBuyers,
} from "./top-buyers.mjs";
import { fakeChain, holdBase, key, memLedger, moduleContext, payoutLedger, pda, rewardMarket, rewardsPass, tokenAccount, withOwnerLookup } from "./testkit.mjs";

const NOW = 1_900_000_000; // unix seconds
const at = (s) => new Date(s * 1000).toISOString();
const trade = (pool, trader, side, quote, time, base) => ({
  pool, trader: trader.toBase58?.() ?? trader, side, quote_amount: String(quote), block_time: at(time), ...(base === undefined ? {} : { base_amount: String(base) }),
});

test("net base is base bought minus base sold per trader, inside the window only, most base first, with the net quote", () => {
  const [a, b, c, d, e, f] = [key(), key(), key(), key(), key(), key()].map(String);
  const trades = [
    trade("p", a, "buy", 500, 100, 5_000),
    trade("p", a, "sell", 200, 150, 1_500), // a: 3500 base, 300 quote
    trade("p", b, "buy", 400, 120, 4_000), // b: 4000
    trade("p", c, "buy", 900, 130, 9_000),
    trade("p", c, "sell", 950, 140, 9_000), // c: 0 base, out
    trade("p", d, "buy", 1_000, 99, 1), // before the window
    trade("p", d, "buy", 1_000, 200, 1), // at its end: the next round's
    trade("p", d, "sell", 10, 199, 1), // d: -1 base, out
    // e flips: buys 1000000 for 10000 and sells 999999 for 9700. 300 quote, but 1 base kept.
    trade("p", e, "buy", 10_000, 110, 1_000_000), trade("p", e, "sell", 9_700, 111, 999_999),
    // f buys cheaply: least quote, more base than e.
    trade("p", f, "buy", 100, 112, 2_000),
  ];
  assert.deepEqual(netByTrader(trades, { start: 100, end: 200 }), [
    { trader: b, net: 400n, base: 4_000n }, { trader: a, net: 300n, base: 3_500n }, { trader: f, net: 100n, base: 2_000n }, { trader: e, net: 300n, base: 1n },
  ]);
  // Rows without base amounts count none, so they never rank.
  assert.deepEqual(netByTrader([trade("p", a, "buy", 5, 100)], { start: 0, end: 200 }), []);
});

test("the window starts where the last paid round ended, never more than an hour back, and ends a minute ago", () => {
  const now = NOW * 1000;
  assert.deepEqual(bountyWindow({ now }), { start: NOW - BOUNTY_SETTLE_SECONDS - BOUNTY_MAX_WINDOW_SECONDS, end: NOW - BOUNTY_SETTLE_SECONDS });
  assert.deepEqual(bountyWindow({ now, lastRoundEnd: NOW - 900 }), { start: NOW - 900, end: NOW - 60 });
  // A stalled crank does not reward stale buys.
  assert.deepEqual(bountyWindow({ now, lastRoundEnd: NOW - 5 * 3600 }), { start: NOW - 60 - 3600, end: NOW - 60 });
  assert.equal(BOUNTY_MAX_WINDOW_SECONDS, 3600);
  // Never past what the indexer has read; its progress only ever lowers the end.
  assert.deepEqual(bountyWindow({ now, lastRoundEnd: NOW - 900, indexedThrough: NOW - 300 }), { start: NOW - 900, end: NOW - 300 });
  assert.deepEqual(bountyWindow({ now, lastRoundEnd: NOW - 900, indexedThrough: NOW }), { start: NOW - 900, end: NOW - 60 });
});

test("the top three net buyers win 50/30/20; the creator, Sonata's keys and non-wallets are excluded", () => {
  const creator = key(), crank = key();
  const [w1, w2, w3, w4] = [key(), key(), key(), key()];
  const nets = [
    { trader: creator.toBase58(), net: 10_000n, base: 10_000n },
    { trader: crank.toBase58(), net: 9_000n, base: 9_000n },
    { trader: VAULT_ADMIN.toBase58(), net: 8_000n, base: 8_000n },
    { trader: SONATA_VAULT.toBase58(), net: 7_500n, base: 7_500n },
    { trader: pda().toBase58(), net: 7_000n, base: 7_000n },
    { trader: "not-an-address", net: 6_500n, base: 6_500n },
    { trader: w2.toBase58(), net: 5_000n, base: 5_000n },
    { trader: w1.toBase58(), net: 6_000n, base: 6_000n },
    { trader: w3.toBase58(), net: 4_000n, base: 4_000n },
    { trader: w4.toBase58(), net: 3_000n, base: 3_000n },
  ];
  const winners = rankTopBuyers(nets, { excluded: [creator, crank] });
  assert.deepEqual(winners.map((w) => [w.trader, w.rank]), [[w1.toBase58(), 1], [w2.toBase58(), 2], [w3.toBase58(), 3]]);
  // 50/30/20 of owed, rounded down; the rounding stays owed.
  assert.deepEqual(bountyShares(winners, 1_000_001n).map((w) => w.amount), [500_000n, 300_000n, 200_000n]);
  // Fewer than three: only their shares are paid, the rest rolls over.
  assert.deepEqual(bountyShares(winners.slice(0, 2), 1_000_000n).map((w) => w.amount), [500_000n, 300_000n]);
  assert.deepEqual(bountyShares(winners.slice(0, 1), 1_000_000n).map((w) => w.amount), [500_000n]);
  assert.deepEqual(bountyShares([], 1_000_000n), []);
  // Ties by address; no one with a zero, negative or unknown net base.
  const [x, y] = [key(), key()].map(String).sort();
  assert.deepEqual(rankTopBuyers([{ trader: y, net: 5n, base: 5n }, { trader: x, net: 5n, base: 5n }, { trader: key().toBase58(), net: 9n, base: 0n }, { trader: key().toBase58(), net: 9n }]).map((w) => w.trader), [x, y]);
  // Ranked by the base kept, whatever the quote: net quote plays no part.
  const [flip, dump, buyer, cheap] = [key(), key(), key(), key()].map(String);
  const ranked = rankTopBuyers([
    { trader: flip, net: 300n, base: 1n }, { trader: dump, net: 200n, base: -5n }, { trader: buyer, net: 100n, base: 25_000n }, { trader: cheap, net: -50n, base: 400n },
  ]);
  assert.deepEqual(ranked.map((w) => [w.trader, w.rank, w.base]), [[buyer, 1, 25_000n], [cheap, 2, 400n], [flip, 3, 1n]]);
});

// `held`: [wallet, base atoms] classic SPL base-token accounts (one each) now.
// `before`: [wallet, base atoms], the balances at a snapshot taken at
// `snapshotAt` (by default before any round here starts); null takes none.
// `indexedThrough`: the ledger's indexer progress (a value, or a function of the pool).
async function bounty({ trades = [], owed = 1_000_000n, withAta = [], now = NOW * 1000, ledger, held = [], before = [], snapshotAt = NOW - 5000, indexedThrough }) {
  const authority = Keypair.generate();
  const chain = withOwnerLookup(fakeChain());
  const m = rewardMarket(chain, authority.publicKey, { owed, held: owed * 3n });
  for (const w of withAta) chain.put(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID), tokenAccount({ owner: w, mint: m.quoteMint }));
  for (const [w, amount] of held) holdBase(chain, m, w, amount);
  const l = payoutLedger(ledger ?? memLedger());
  if (before) await l.recordSnapshot(m.pool.toBase58(), "holders", snapshotAt, before.map(([w, a]) => [w.toBase58(), a]));
  if (indexedThrough !== undefined) l.indexedThrough = async (pool) => (typeof indexedThrough === "function" ? indexedThrough(pool) : indexedThrough);
  l.trades.push(...trades.map((t) => ({ ...t, pool: m.pool.toBase58() })));
  const ctx = await moduleContext({ chain, m, authority, owed, ledger: l, now: () => now, model: { feeModel: "topBuyers" } });
  return { chain, m, ctx, ledger: l, authority };
}
const quoteOf = (chain, m, w) => chain.balance(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID));

test("a round pays its top three in one transaction and the next round starts at its end", async () => {
  const [a, b, c, d] = [key(), key(), key(), key()];
  const t0 = NOW - 1800;
  const trades = [
    trade("", a, "buy", 5_000, t0, 50_000), trade("", a, "sell", 1_000, t0 + 1, 10_000), // 4000
    trade("", b, "buy", 3_000, t0 + 2, 30_000), // 3000
    trade("", c, "buy", 2_000, t0 + 3, 20_000), // 2000
    trade("", d, "buy", 1_000, t0 + 4, 10_000), // 1000, fourth
  ];
  const held = [[a, 40_000n], [b, 30_000n], [c, 20_000n], [d, 10_000n]];
  const { chain, m, ctx, ledger } = await bounty({ trades, withAta: [a, b, c, d], held });
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
  const two = await bounty({
    trades: [trade("", a, "buy", 900, t, 9_000), trade("", b, "buy", 800, t, 8_000), trade("", seller, "sell", 5_000, t, 50_000)],
    withAta: [a, b, seller], held: [[a, 9_000n], [b, 8_000n]],
  });
  await runTopBuyers(two.ctx);
  assert.deepEqual([a, b, seller].map((w) => quoteOf(two.chain, two.m, w)), [500_000n, 300_000n, 0n]);
  assert.equal(two.ctx.result.paid, 800_000n);
  assert.equal(two.ctx.fund.owed, 200_000n);

  const none = await bounty({ trades: [trade("", seller, "sell", 5_000, t, 50_000), trade("", a, "buy", 10, t - 4000, 100)] });
  const r = await runTopBuyers(none.ctx);
  assert.match(r.skip, /no net buyers/);
  assert.equal(none.chain.sent.length, 0);
  assert.equal(await none.ledger.lastRoundEnd(none.m.pool.toBase58()), null);
});

test("a winner without a quote account is skipped and their share rolls over; if nobody can be paid the round continues", async () => {
  const [a, b, c] = [key(), key(), key()];
  const t = NOW - 600;
  const trades = [trade("", a, "buy", 3, t, 30), trade("", b, "buy", 2, t, 20), trade("", c, "buy", 1, t, 10)];
  const held = [[a, 30n], [b, 20n], [c, 10n]];
  const some = await bounty({ trades, withAta: [a, c], held });
  await runTopBuyers(some.ctx);
  assert.deepEqual([a, b, c].map((w) => quoteOf(some.chain, some.m, w)), [500_000n, null, 200_000n]);
  assert.equal(some.ctx.result.skipped.missing, 1);
  assert.deepEqual(some.ledger.payouts[0].detail.winners.map((w) => w.rank), [1, 3]);

  const nobody = await bounty({ trades, held });
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

// ---- Indexer progress --------------------------------------------------------

test("a round ends no later than the indexer's progress, so a trade indexed late counts in the next round", async () => {
  const authority = Keypair.generate();
  const chain = withOwnerLookup(fakeChain());
  const m = rewardMarket(chain, authority.publicKey, { owed: 2_000_000n, held: 6_000_000n });
  const [a, b] = [key(), key()];
  for (const w of [a, b]) chain.put(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID), tokenAccount({ owner: w, mint: m.quoteMint }));
  holdBase(chain, m, a, 10_000n);
  holdBase(chain, m, b, 50_000n);
  const pool = m.pool.toBase58();
  const ledger = payoutLedger(memLedger());
  // Nobody held any before the first round.
  await ledger.recordSnapshot(pool, "holders", NOW - 5000, []);
  let progress = NOW - 600;
  ledger.indexedThrough = async (p) => (p === pool ? progress : null);
  ledger.trades.push(trade(pool, a, "buy", 1_000, NOW - 900, 10_000));
  const pass = async (now, owed) => runTopBuyers(await moduleContext({ chain, m, authority, owed, ledger, now: () => now * 1000, model: { feeModel: "topBuyers" } }));
  assert.deepEqual(await pass(NOW, 1_000_000n), {});
  assert.equal(ledger.payouts[0].detail.roundEnd, NOW - 600, "the round ends where the indexer is, not a minute ago");
  // b's buy landed before the old end (now − 60s) but was indexed only after that round closed.
  ledger.trades.push(trade(pool, b, "buy", 5_000, NOW - 300, 50_000));
  progress = NOW + 700;
  assert.deepEqual(await pass(NOW + 900, 1_000_000n), {});
  const second = ledger.payouts[1].detail;
  assert.equal(second.roundStart, NOW - 600);
  assert.deepEqual(second.winners.map((w) => [w.trader, w.rank]), [[b.toBase58(), 1]]);
  assert.equal(quoteOf(chain, m, b), 500_000n);
});

test("with no, stale or unreadable indexer progress the round stays open and nothing is paid", async () => {
  const a = key();
  const trades = [trade("", a, "buy", 1_000, NOW - 1200, 10_000)];
  const cases = [
    [null, /has not read this pool's trades yet/],
    [NOW - INDEX_STALE_SECONDS - 1, new RegExp(`indexer is ${INDEX_STALE_SECONDS + 1}s behind`)],
    [() => { throw Error("relation missing"); }, /indexer progress unreadable \(relation missing\)/],
  ];
  for (const [indexedThrough, reason] of cases) {
    const run = await bounty({ trades, withAta: [a], held: [[a, 10_000n]], indexedThrough });
    const r = await runTopBuyers(run.ctx);
    assert.match(r.skip, reason);
    assert.match(r.skip, /round stays open, the pot rolls over/);
    assert.equal(run.chain.sent.length, 0);
    assert.equal(await run.ledger.lastRoundEnd(run.m.pool.toBase58()), null);
  }
  // Ten minutes behind is still current.
  const current = await bounty({ trades, withAta: [a], held: [[a, 10_000n]], indexedThrough: NOW - INDEX_STALE_SECONDS });
  assert.deepEqual(await runTopBuyers(current.ctx), {});
  assert.equal(current.ledger.payouts[0].detail.roundEnd, NOW - INDEX_STALE_SECONDS);
  assert.equal(current.ctx.fields.indexedThrough, NOW - INDEX_STALE_SECONDS);
});

// ---- Winners must have kept what they bought -----------------------------------

test("a winner who moved away the tokens they bought is not paid: their share rolls over, nobody moves up", async () => {
  const [a, b, c, d, e] = [key(), key(), key(), key(), key()];
  const t = NOW - 600;
  const trades = [
    trade("", a, "buy", 5_000, t, 1_000_000), // a buys, sends the tokens to b...
    trade("", b, "sell", 4_000, t + 1, 1_000_000), // ...and b sells them
    trade("", c, "buy", 3_000, t + 2, 600_000),
    trade("", d, "buy", 2_000, t + 3, 400_000),
    trade("", e, "buy", 1_000, t + 4, 200_000), // fourth
  ];
  const run = await bounty({
    trades,
    withAta: [a, b, c, d, e],
    indexedThrough: NOW - 60,
    // a holds 1 atom short; c exactly what it bought, in two accounts; d more.
    held: [[a, 999_999n], [c, 300_000n], [c, 300_000n], [d, 500_000n], [e, 200_000n]],
  });
  // Another token does not count.
  run.chain.put(key(), tokenAccount({ owner: a, mint: key(), amount: 5_000_000n, program: TOKEN_PROGRAM_ID }));
  const r = await runTopBuyers(run.ctx);
  assert.ok(r.note.includes(`rank 1 ${a.toBase58()} (kept 999999 of the 1000000 base atoms bought (holds 999999, held 0 before the round))`), r.note);
  assert.deepEqual([a, b, c, d, e].map((w) => quoteOf(run.chain, run.m, w)), [0n, 0n, 300_000n, 200_000n, 0n]);
  assert.equal(run.ctx.result.paid, 500_000n);
  assert.equal(run.ctx.fund.owed, 500_000n, "rank 1's 50% stays owed for the next round");
  assert.equal(run.ctx.fields.notHolding, 1);
  assert.deepEqual(run.ledger.payouts[0].detail.winners.map((w) => w.rank), [2, 3]);
});

test("if no winner still holds, nothing is paid and the round stays open; a ledger without base amounts pays nobody", async () => {
  const a = key();
  const moved = await bounty({ trades: [trade("", a, "buy", 5_000, NOW - 600, 1_000)], withAta: [a], indexedThrough: NOW - 60 });
  const r = await runTopBuyers(moved.ctx);
  assert.match(r.skip, /no winner still holds what they bought this round; the pot rolls over/);
  assert.equal(moved.chain.sent.length, 0);
  assert.equal(await moved.ledger.lastRoundEnd(moved.m.pool.toBase58()), null);
  // Rows without the base bought (a ledger that does not report it) never rank.
  const blind = await bounty({ withAta: [a], held: [[a, 10n ** 12n]] });
  blind.ledger.buyerNets = async () => [{ trader: a.toBase58(), net: 5_000n }];
  const b = await runTopBuyers(blind.ctx);
  assert.match(b.skip, /no net buyers this round/);
  assert.equal(blind.chain.sent.length, 0);
});

test("a round trip or a net sell is not a buy: it never wins, and the real buyer takes the rank", async () => {
  const [flipper, dumper, buyer] = [key(), key(), key()];
  const t = NOW - 600;
  const trades = [
    // Buys 1000000 for 10000 and sells all of it back for 9700: net 300 quote, 0 base.
    trade("", flipper, "buy", 10_000, t, 1_000_000), trade("", flipper, "sell", 9_700, t + 1, 1_000_000),
    // Buys 1000000 for 10000 and sells 1500000 for 9000: net 1000 quote, -500000 base.
    trade("", dumper, "buy", 10_000, t + 2, 1_000_000), trade("", dumper, "sell", 9_000, t + 3, 1_500_000),
    trade("", buyer, "buy", 250, t + 4, 25_000),
  ];
  const run = await bounty({ trades, withAta: [flipper, dumper, buyer], held: [[flipper, 5_000_000n], [dumper, 5_000_000n], [buyer, 25_000n]], indexedThrough: NOW - 60 });
  assert.deepEqual(await runTopBuyers(run.ctx), {});
  assert.deepEqual([flipper, dumper, buyer].map((w) => quoteOf(run.chain, run.m, w)), [0n, 0n, 500_000n]);
  assert.deepEqual(run.ledger.payouts[0].detail.winners.map((w) => [w.trader, w.rank]), [[buyer.toBase58(), 1]]);
});

test("tokens held before the round do not count as kept: buying with one wallet while another sells the same amount does not win", async () => {
  const [a, b, c] = [key(), key(), key()];
  const t = NOW - 600;
  // a already held 10000000. It buys 5000000 and sends them to b, which sells them.
  const trades = [trade("", a, "buy", 5_000, t, 5_000_000), trade("", b, "sell", 4_900, t + 1, 5_000_000), trade("", c, "buy", 3_000, t + 2, 3_000_000)];
  const run = await bounty({ trades, withAta: [a, b, c], held: [[a, 10_000_000n], [c, 3_000_000n]], before: [[a, 10_000_000n]], indexedThrough: NOW - 60 });
  const r = await runTopBuyers(run.ctx);
  // a's 50% rolls over; c keeps its rank and 30%.
  assert.deepEqual([a, b, c].map((w) => quoteOf(run.chain, run.m, w)), [0n, 0n, 300_000n]);
  assert.match(r.note, /rank 1 \S+ \(kept 0 of the 5000000 base atoms bought \(holds 10000000, held 10000000 before the round\)\)/);
  assert.equal(run.ctx.fields.balancesAt, NOW - 5000);
});

test("buys between the round-start snapshot and the round's start cannot be counted as kept twice", async () => {
  const [a, b, c] = [key(), key(), key()];
  // The last round ended at NOW - 900; the newest snapshot before it is from NOW - 1500.
  const ledger = payoutLedger(memLedger());
  const last = { signature: "s0", pool: null, amount: 1n, recipients: 1, lastValidBlockHeight: 1, module: "topBuyers", detail: { roundEnd: NOW - 900 } };
  // a bought 5000000 at NOW - 1200 (the last round's) and still holds it. This round it buys
  // 5000000 more and b sells 5000000 of a's: a's gain since the snapshot is only the first 5000000.
  const trades = [trade("", a, "buy", 5_000, NOW - 1200, 5_000_000), trade("", a, "buy", 5_000, NOW - 600, 5_000_000), trade("", b, "sell", 4_900, NOW - 599, 5_000_000), trade("", c, "buy", 1_000, NOW - 598, 1_000_000)];
  const run = await bounty({ ledger, trades, withAta: [a, b, c], held: [[a, 5_000_000n], [c, 1_000_000n]], before: [], snapshotAt: NOW - 1500, indexedThrough: NOW - 60 });
  await ledger.begin({ ...last, pool: run.m.pool.toBase58() });
  await ledger.confirm("s0");
  const r = await runTopBuyers(run.ctx);
  assert.equal(run.ctx.fields.roundStart, NOW - 900);
  assert.deepEqual([a, c].map((w) => quoteOf(run.chain, run.m, w)), [0n, 300_000n]);
  // a held 5000000 at the round's start (none at the snapshot, plus the 5000000 bought after it).
  assert.match(r.note, /kept 0 of the 5000000 base atoms bought \(holds 5000000, held 5000000 before the round\)/);
});

test("with no balance snapshot from before the round's start the round stays open; every pass records the balances, paid or not", async () => {
  const a = key();
  const run = await bounty({ trades: [trade("", a, "buy", 1_000, NOW - 600, 10_000)], withAta: [a], held: [[a, 10_000n]], before: null, indexedThrough: NOW - 60 });
  const r = await runTopBuyers(run.ctx);
  assert.equal(run.chain.sent.length, 0);
  assert.match(r.skip, /no balance snapshot from before the round's start yet; the round stays open, the pot rolls over/);
  // This pass's balances are recorded, a later round's start.
  const pool = run.m.pool.toBase58();
  assert.deepEqual([...run.ledger.snapshots.get(`${pool}|holders`)].map(([t, s]) => [t, [...s]]), [[NOW, [[a.toBase58(), 10_000n]]]]);
  // A pass that does not pay the market (owed below the minimum) records them too.
  run.ledger.models.set(pool, { feeModel: "topBuyers" });
  await rewardsPass({ chain: run.chain, markets: [run.m], authority: run.authority, ledger: run.ledger, distributed: 50_000n, minAtoms: 100_000n, now: () => (NOW + 900) * 1000 });
  assert.deepEqual([...run.ledger.snapshots.get(`${pool}|holders`).keys()], [NOW, NOW + 900]);
  // A ledger without snapshots cannot check anyone: nothing is paid.
  const bare = await bounty({ trades: [trade("", a, "buy", 1_000, NOW - 600, 10_000)], withAta: [a], held: [[a, 10_000n]], indexedThrough: NOW - 60 });
  for (const f of ["recordSnapshot", "previousSnapshot"]) delete bare.ledger[f];
  const b = await runTopBuyers(bare.ctx);
  assert.equal(bare.chain.sent.length, 0);
  assert.match(b.skip, /ledger has no balance snapshots/);
});

// ---- Ranking by base kept, and the balance at the round's start -----------------

test("a flipper ranks on the tokens it kept, not its quote net: buying 1000000 and selling 999999 ranks last", async () => {
  const [flipper, b1, b2, b3] = [key(), key(), key(), key()];
  const t = NOW - 600;
  const trades = [
    // Net 300 quote (more than any real buyer spent) but 1 base atom kept.
    trade("", flipper, "buy", 10_000, t, 1_000_000), trade("", flipper, "sell", 9_700, t + 1, 999_999),
    trade("", b1, "buy", 250, t + 2, 25_000), trade("", b2, "buy", 200, t + 3, 20_000), trade("", b3, "buy", 150, t + 4, 15_000),
  ];
  const run = await bounty({ trades, withAta: [flipper, b1, b2, b3], held: [[flipper, 1n], [b1, 25_000n], [b2, 20_000n], [b3, 15_000n]], indexedThrough: NOW - 60 });
  assert.deepEqual(await runTopBuyers(run.ctx), {});
  assert.deepEqual([flipper, b1, b2, b3].map((w) => quoteOf(run.chain, run.m, w)), [0n, 500_000n, 300_000n, 200_000n]);
  assert.deepEqual(run.ledger.payouts[0].detail.winners.map((w) => [w.trader, w.rank, w.base]), [
    [b1.toBase58(), 1, 25_000n], [b2.toBase58(), 2, 20_000n], [b3.toBase58(), 3, 15_000n],
  ]);
});

test("a winner who sold before the round keeps its bounty when it kept this round's buy: the round-start balance counts every trade since the snapshot", async () => {
  // The snapshot is from NOW - 5000; this round starts at NOW - 3660.
  const [a, e, d] = [key(), key(), key()];
  const gapAt = NOW - 4000, t = NOW - 600;
  const trades = [
    // a held 10000000 at the snapshot, sold 1000000 after it, then bought 5000000 in the round and kept them all.
    trade("", a, "sell", 1_000, gapAt, 1_000_000), trade("", a, "buy", 5_000, t, 5_000_000),
    // e held 10000000 too and moved 2000000 to another wallet after the snapshot (a transfer, not a trade),
    // then bought 4000000 and kept them: transfers are seen only by snapshots, so e is refused (its share stays owed).
    trade("", e, "buy", 4_000, t + 1, 4_000_000),
    // d was outside the snapshot, sold 1000000 it held before the round, bought 3000000 in the round and moved
    // 1000000 of them away: its round-start balance is never below 0, so it must still hold all 3000000.
    trade("", d, "sell", 1_000, gapAt, 1_000_000), trade("", d, "buy", 3_000, t + 2, 3_000_000),
  ];
  const run = await bounty({
    trades, withAta: [a, e, d], indexedThrough: NOW - 60,
    before: [[a, 10_000_000n], [e, 10_000_000n]],
    held: [[a, 14_000_000n], [e, 12_000_000n], [d, 2_000_000n]],
  });
  const r = await runTopBuyers(run.ctx);
  assert.deepEqual([a, e, d].map((w) => quoteOf(run.chain, run.m, w)), [500_000n, 0n, 0n]);
  assert.equal(run.ctx.fund.owed, 500_000n, "ranks 2 and 3 stay owed");
  assert.ok(r.note.includes(`rank 2 ${e.toBase58()} (kept 2000000 of the 4000000 base atoms bought (holds 12000000, held 10000000 before the round))`), r.note);
  assert.ok(r.note.includes(`rank 3 ${d.toBase58()} (kept 2000000 of the 3000000 base atoms bought (holds 2000000, held 0 before the round))`), r.note);
  assert.equal(run.ctx.fields.balancesAt, NOW - 5000);
});

test("tokens bought after the snapshot and before the round count as held before it, whatever their quote net", async () => {
  // After the snapshot a buys 5000000 for 5000 and sells 1000000 for 6000: net quote -1000, net base +4000000.
  // In the round it buys 4000000 more and moves them to b, which sells them: a holds only the 4000000 from before.
  const [a, b, c] = [key(), key(), key()];
  const trades = [
    trade("", a, "buy", 5_000, NOW - 4000, 5_000_000), trade("", a, "sell", 6_000, NOW - 3900, 1_000_000),
    trade("", a, "buy", 4_000, NOW - 600, 4_000_000), trade("", b, "sell", 3_900, NOW - 599, 4_000_000),
    trade("", c, "buy", 1_000, NOW - 598, 1_000_000),
  ];
  const run = await bounty({ trades, withAta: [a, b, c], held: [[a, 4_000_000n], [c, 1_000_000n]], indexedThrough: NOW - 60 });
  const r = await runTopBuyers(run.ctx);
  assert.deepEqual([a, b, c].map((w) => quoteOf(run.chain, run.m, w)), [0n, 0n, 300_000n]);
  assert.ok(r.note.includes(`rank 1 ${a.toBase58()} (kept 0 of the 4000000 base atoms bought (holds 4000000, held 4000000 before the round))`), r.note);
});

test("a ledger that cannot read net base per wallet pays nobody; the round stays open and the balances are still recorded", async () => {
  const a = key();
  const run = await bounty({ trades: [trade("", a, "buy", 1_000, NOW - 600, 10_000)], withAta: [a], held: [[a, 10_000n]], indexedThrough: NOW - 60 });
  delete run.ledger.netBase;
  const r = await runTopBuyers(run.ctx);
  assert.match(r.skip, /ledger cannot read a wallet's net base before the round, so no winner can be checked; the round stays open, the pot rolls over/);
  assert.equal(run.chain.sent.length, 0);
  assert.equal(await run.ledger.lastRoundEnd(run.m.pool.toBase58()), null);
  assert.ok(run.ledger.snapshots.get(`${run.m.pool.toBase58()}|holders`).has(NOW));
});

test("the database ledger reads the round's buyers by net base, up to 200, and the winners' signed net base with no filter or limit", async () => {
  const queries = [];
  const ledger = pgLedger({ query: async (sql, args) => (queries.push({ sql: sql.replace(/\s+/g, " "), args }), { rows: [] }) });
  assert.deepEqual(await ledger.buyerNets("p", 1, 2), []);
  assert.deepEqual(queries[0].args, ["p", 1, 2, 200]);
  assert.match(queries[0].sql, /having sum\(case when side = 'buy' then base_amount else -base_amount end\) > 0 order by sum\(case when side = 'buy' then base_amount else -base_amount end\) desc, trader limit \$4/);
  assert.deepEqual([...(await ledger.netBase("p", ["w"], 1, 2))], [["w", 0n]]);
  assert.deepEqual(queries[1].args, ["p", ["w"], 1, 2]);
  assert.doesNotMatch(queries[1].sql, /having|limit/);
});
