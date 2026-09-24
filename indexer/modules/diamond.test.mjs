import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TENURE_WINDOWS, diamondWeights, multiplierCounts, runDiamond, tenureWeight, tenured } from "./diamond.mjs";
import { rewardShares } from "./payout.mjs";
import { fakeChain, holdBase, key, passContext, payoutLedger, quoteAccount, rewardMarket, rewardsPass } from "./testkit.mjs";

const H = 3600, D = 24 * H;
const T0 = 1_900_000_000;
const lowsOf = (d7, d3, d1) => new Map([[7 * D, d7], [3 * D, d3], [D, d1]].filter(([, v]) => v != null));

test("weight = 3 H(7d) + 2 (H(3d) - H(7d)) + 1.5 (H(24h) - H(3d)) + 1 (balance - H(24h)), in halves", () => {
  assert.deepEqual(TENURE_WINDOWS, [7 * D, 3 * D, D]);
  // Held all of it for 7 days: 3x.
  assert.equal(tenureWeight(100n, lowsOf(100n, 100n, 100n)), 600n);
  // Never seen before (a new buyer, or tokens received): 1x.
  assert.equal(tenureWeight(100n, new Map()), 200n);
  assert.equal(tenureWeight(100n, undefined), 200n);
  // 20 held 7 days, 40 more for 3 days, 40 more for a day: 6·20 + 4·40 + 3·40.
  assert.equal(tenureWeight(100n, lowsOf(20n, 60n, 100n)), 400n);
  // A top-up: only what was held counts at its tier, the new 50 is 1x.
  assert.equal(tenureWeight(150n, lowsOf(100n, 100n, 100n)), 700n);
  // A sell: the tier applies to what is left (never more than the balance now).
  assert.equal(tenureWeight(90n, lowsOf(100n, 100n, 100n)), 540n);
  // A longer window never holds more than a shorter one.
  assert.deepEqual(tenured(100n, lowsOf(80n, 50n, 100n)), [50n, 50n, 100n]);
  assert.deepEqual(tenured(100n, lowsOf(100n, null, 100n)), [0n, 0n, 100n]);
});

test("tiers from the crank's snapshots: 1x day one, 1.5x after 24h, 2x after 3 days, 3x after 7 days", async () => {
  const ledger = payoutLedger();
  const [pool, holder] = [key().toBase58(), key()];
  // A snapshot every hour for 8 days, the same 1000 each time.
  for (let t = T0; t <= T0 + 8 * D; t += H) await ledger.recordSnapshot(pool, "holders", t, [[holder.toBase58(), 1000n]]);
  const label = async (at) => {
    const lows = await ledger.heldMinimums(pool, "holders", [holder.toBase58()], at, TENURE_WINDOWS);
    return diamondWeights([{ owner: holder, balance: 1000n }], lows)[0].multiplier;
  };
  assert.equal(await label(T0), "1");
  assert.equal(await label(T0 + D - 1), "1");
  assert.equal(await label(T0 + D), "1.5");
  assert.equal(await label(T0 + 3 * D - 1), "1.5");
  assert.equal(await label(T0 + 3 * D), "2");
  assert.equal(await label(T0 + 7 * D - 1), "2");
  assert.equal(await label(T0 + 7 * D), "3");
  // One snapshot without the wallet (it held nothing then) restarts the clock.
  ledger.snapshots.get(`${pool}|holders`).get(T0 + 8 * D - 2 * H).delete(holder.toBase58());
  assert.equal(await label(T0 + 8 * D), "1");
  assert.equal(await label(T0 + 8 * D + D), "1.5");
});

// A market paid by the diamond module, one pass at a time (unix seconds `at`,
// the treasury having distributed `distributed` in total).
async function diamondMarket() {
  const authority = Keypair.generate();
  const chain = fakeChain();
  const m = rewardMarket(chain, authority.publicKey, { owed: 10n ** 9n, held: 10n ** 9n });
  const ledger = payoutLedger();
  const pass = async (at, distributed) => {
    const ctx = await passContext({ chain, m, authority, distributed, ledger, model: { feeModel: "diamond" }, now: () => at * 1000 });
    await runDiamond(ctx);
    return ctx;
  };
  const paidTo = (w) => chain.balance(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID));
  return { chain, m, ledger, pass, paidTo };
}

test("tenure comes from balances, not trades: a top-up counts 1x until held, and any sell or transfer out restarts the clock for that amount", async () => {
  const { chain, m, pass, paidTo } = await diamondMarket();
  const [steady, topUp, seller] = [key(), key(), key()];
  const acct = { steady: holdBase(chain, m, steady, 10n ** 12n), topUp: holdBase(chain, m, topUp, 10n ** 11n), seller: holdBase(chain, m, seller, 10n ** 12n) };
  for (const w of [steady, topUp, seller]) quoteAccount(chain, m, w);
  // Eight days of passes with nothing to pay: each one records the holders.
  for (let day = 0; day < 8; day++) await pass(T0 + day * D, 0n);
  // Day 8: topUp's dust wallet receives 900000000000 more (a buy or a transfer,
  // on the curve or on DAMM v2: no trade is read), and seller sells half.
  holdBase(chain, m, topUp, 10n ** 12n, acct.topUp);
  holdBase(chain, m, seller, 5n * 10n ** 11n, acct.seller);
  const ctx = await pass(T0 + 8 * D, 1_140_000n);
  // Weights: steady 6e12 (all 3x); topUp 6e11 + 2·9e11 (only the dust is 3x);
  // seller 6·5e11 (3x on what is left). 11.4e12 halves in all.
  assert.deepEqual([steady, topUp, seller].map(paidTo), [600_000n, 240_000n, 300_000n]);
  assert.equal(ctx.fields.multipliers, "1x:1,1.5x:0,2x:0,3x:2");
  // Seller buys the half back: that half is 1x again, the rest keeps 3x.
  holdBase(chain, m, seller, 10n ** 12n, acct.seller);
  await pass(T0 + 8 * D + H, 1_140_000n + 1_280_000n);
  // steady 6e12, topUp 2.4e12, seller 6·5e11 + 2·5e11 = 4e12: of 12.4e12.
  assert.deepEqual([steady, topUp, seller].map(paidTo), [600_000n + 619_354n, 240_000n + 247_741n, 300_000n + 412_903n]);
});

test("each weighted round is allocated once; the module's ledger rows carry its multipliers", async () => {
  const { chain, m, ledger, pass } = await diamondMarket();
  const [a, b] = [key(), key()];
  holdBase(chain, m, a, 10n ** 12n);
  holdBase(chain, m, b, 10n ** 12n);
  quoteAccount(chain, m, a);
  await pass(T0, 0n);
  await pass(T0 + 7 * D, 800_000n);
  // a and b both 3x; b has no quote account, so its half stays allocated to it.
  const rows = ledger.allocationRows.filter((r) => r.module === "diamond");
  assert.deepEqual(rows.map((r) => [r.recipient, r.amount, r.status]).sort(), [[a.toBase58(), 400_000n, "paid"], [b.toBase58(), 400_000n, "unpaid"]].sort());
  assert.deepEqual(ledger.payouts.map((p) => p.detail), [{ multipliers: { 1: 0, 1.5: 0, 2: 0, 3: 2 } }]);
  // Later b opens its account: it gets its 400000, and a gets nothing of it.
  quoteAccount(chain, m, b);
  await pass(T0 + 7 * D + H, 800_000n);
  assert.deepEqual([a, b].map((w) => chain.balance(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID))), [400_000n, 400_000n]);
});

test("a pass that does not pay a diamond market still records its holders", async () => {
  const authority = Keypair.generate();
  const chain = fakeChain();
  const m = rewardMarket(chain, authority.publicKey);
  const ledger = payoutLedger();
  ledger.models.set(m.pool.toBase58(), { feeModel: "diamond" });
  const holder = key();
  holdBase(chain, m, holder, 10n ** 12n);
  // Owed 50000 is below the minimum: nothing is paid, the snapshot is taken.
  const { lines } = await rewardsPass({ chain, markets: [m], authority, ledger, distributed: 50_000n, minAtoms: 100_000n, now: () => T0 * 1000 });
  assert.match(lines.find((l) => l.tag === "rewards").reason, /owed below 100000/);
  assert.deepEqual([...ledger.snapshots.get(`${m.pool.toBase58()}|holders`)].map(([t, s]) => [t, [...s]]), [[T0, [[holder.toBase58(), 10n ** 12n]]]]);
  // A dry run writes none.
  await rewardsPass({ chain, markets: [m], authority, ledger, distributed: 50_000n, minAtoms: 100_000n, now: () => (T0 + H) * 1000, dryRun: true });
  assert.equal(ledger.snapshots.get(`${m.pool.toBase58()}|holders`).size, 1);
});

test("weights are balance times the tier's multiplier, in halves; shares follow them", () => {
  const [held, fresh] = [key(), key()];
  const w = diamondWeights([{ owner: held, balance: 1_000n }, { owner: fresh, balance: 1_000n }], new Map([[held.toBase58(), lowsOf(1_000n, 1_000n, 1_000n)]]));
  assert.deepEqual(w.map((x) => [x.multiplier, x.held, x.balance]), [["3", 1_000n, 6_000n], ["1", 1_000n, 2_000n]]);
  assert.deepEqual(rewardShares(w, 800_000n).map((s) => s.amount), [600_000n, 200_000n]);
  assert.deepEqual(multiplierCounts(w), { 1: 1, 1.5: 0, 2: 0, 3: 1 });
});
