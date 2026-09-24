import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CRANK_KEY, VAULT_ADMIN } from "./common.mjs";
import { payHolders } from "./holders.mjs";
import { allocationOf, payAllocated } from "./payout.mjs";
import { dbcAccounts, fakeChain, holdBase, key, passContext, payoutLedger, quoteAccount, rewardMarket, rewardsPass } from "./testkit.mjs";

const TOKENS = 10n ** 12n;

// A holders market with `holders` (owner → base balance), each with a quote account.
function holdersMarket(holders, { feeModel = "holders", owed = 1_000_000n } = {}) {
  const authority = Keypair.generate();
  const chain = fakeChain();
  const m = rewardMarket(chain, authority.publicKey, { owed, held: owed });
  for (const [owner, amount] of holders) {
    holdBase(chain, m, owner, amount);
    quoteAccount(chain, m, owner);
  }
  const ledger = payoutLedger();
  ledger.models.set(m.pool.toBase58(), { feeModel });
  const paidTo = (w) => chain.balance(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID));
  return { authority, chain, m, ledger, paidTo };
}

test("a send left unsettled stops the pass; the rest of the round goes to the same holders later, never re-split", async () => {
  const holders = Array.from({ length: 40 }, key);
  const { authority, chain, m, ledger, paidTo } = holdersMarket(holders.map((h) => [h, TOKENS]), { owed: 1_000n });
  const pass = () => rewardsPass({ chain, markets: [m], authority, ledger, distributed: 1_000n });
  // 40 equal holders, 25 each; the second transaction (holders 21 to 40) is never seen landing.
  chain.lost.add(1);
  const first = await pass();
  assert.equal(first.out.failed, 1);
  assert.match(first.lines.find((l) => l.tag === "rewards").reason, /not confirmed yet/);
  assert.equal(holders.map(paidTo).filter((v) => v === 25n).length, 20);
  // Next pass: still pending (its blockhash is valid), so it counts as paid and nothing is sent.
  const sends = () => chain.calls.filter((c) => c === "sendRawTransaction").length;
  assert.equal(sends(), 2);
  await pass();
  assert.equal(sends(), 2);
  // Once it has expired, those 20 holders are paid their own 25 each; the first 20 get nothing more.
  chain.setHeight(10_000);
  const third = await pass();
  assert.equal(third.out.atoms, 500n);
  assert.deepEqual(holders.map(paidTo), Array(40).fill(25n));
  assert.ok(ledger.allocationRows.every((r) => r.round === 1 && r.status === "paid"));
});

test("a pass that runs out of time finishes its round next pass before anything new is allocated", async () => {
  const holders = Array.from({ length: 40 }, key);
  const { authority, chain, m, ledger, paidTo } = holdersMarket(holders.map((h) => [h, TOKENS]), { owed: 3_000n });
  const ctxFor = async (distributed, budgetMs = Infinity) => {
    const ctx = await passContext({ chain, m, authority, distributed, ledger });
    ctx.deadline = Date.now() + budgetMs;
    // Each simulation takes 250 ms: the first batch starts within the budget, the second does not.
    const simulate = ctx.simulate;
    ctx.simulate = async (...a) => (await new Promise((r) => setTimeout(r, 250)), simulate(...a));
    return ctx;
  };
  const first = await ctxFor(1_000n, 200);
  await payHolders(first);
  assert.match(first.result.note, /time budget/);
  assert.equal(first.result.txs, 1);
  // 2000 more distributed since: the open round's 20 unpaid holders are paid
  // their 25 first, then the 2000 is a new round of 50 each.
  const second = await ctxFor(3_000n);
  await payHolders(second);
  assert.deepEqual(holders.map(paidTo), Array(40).fill(75n));
  assert.deepEqual([...new Set(ledger.allocationRows.map((r) => r.round))], [1, 2]);
  assert.equal(ledger.allocationRows.filter((r) => r.round === 1).length, 40);
});

test("a holder without a usable quote account gets no row: each round is split among the holders who can be paid, and rows do not pile up (holders, diamond, lpFarm on the curve)", async () => {
  for (const feeModel of ["holders", "diamond", "lpFarm"]) {
    const [a, b, noAccount] = [key(), key(), key()];
    const { authority, chain, m, ledger, paidTo } = holdersMarket([[a, TOKENS], [b, TOKENS]], { feeModel, owed: 7_000_000n });
    holdBase(chain, m, noAccount, 2n * TOKENS);
    const dbc = dbcAccounts(m);
    chain.put(m.pool, dbc.poolInfo);
    chain.put(m.config, dbc.configInfo);
    const pass = (distributed) => rewardsPass({ chain, markets: [m], authority, ledger, distributed });
    // Six passes with 1000000 new each: all of it to a and b, none held back for a holder who cannot be paid.
    for (let i = 1n; i <= 6n; i++) {
      const { lines } = await pass(i * 1_000_000n);
      assert.equal(lines.find((l) => l.tag === "rewards").noAta, 1, feeModel);
    }
    assert.deepEqual([a, b].map(paidTo), [3_000_000n, 3_000_000n], feeModel);
    assert.ok(!ledger.allocationRows.some((r) => r.recipient === noAccount.toBase58()), feeModel);
    assert.equal(ledger.allocationRows.length, 12, feeModel);
    assert.ok(ledger.allocationRows.every((r) => r.status === "paid"), feeModel);
    // Once it opens a quote account it is in the next round.
    quoteAccount(chain, m, noAccount);
    const { out } = await pass(7_000_000n);
    assert.equal(out.atoms, 1_000_000n, feeModel);
    // Holding half, it gets half (diamond: all three are new to the snapshots at the same time, so all 1x).
    assert.equal(paidTo(noAccount), 500_000n, feeModel);
  }
});

test("rows allocated before a holder lost (or never had) its quote account stay its own and are paid once it can receive", async () => {
  const [a, b] = [key(), key()];
  const { authority, chain, m, ledger, paidTo } = holdersMarket([[a, TOKENS]]);
  holdBase(chain, m, b, TOKENS);
  // An earlier round (from before this rule) gave b 300000; b has no quote account.
  await ledger.allocate(m.pool.toBase58(), { module: "holders", shares: [allocationOf({ owner: b, amount: 300_000n, balance: 1n })] });
  const pass = (distributed) => rewardsPass({ chain, markets: [m], authority, ledger, distributed });
  const first = await pass(1_000_000n);
  assert.equal(first.lines.find((l) => l.tag === "rewards").carried, 300_000n);
  // The other 700000 is a new round, a's alone; b's row waits.
  assert.deepEqual([a, b].map(paidTo), [700_000n, null]);
  quoteAccount(chain, m, b);
  await pass(1_000_000n);
  assert.deepEqual([a, b].map(paidTo), [700_000n, 300_000n]);
  assert.ok(ledger.allocationRows.every((r) => r.status === "paid"));
});

test("a holder whose transfer keeps failing keeps one unpaid row, not one more per round", async () => {
  const [a, stuck] = [key(), key()];
  const authority = Keypair.generate();
  const poison = new Set();
  const chain = fakeChain({ poison });
  const m = rewardMarket(chain, authority.publicKey, { owed: 3_000_000n, held: 3_000_000n });
  for (const w of [a, stuck]) {
    holdBase(chain, m, w, TOKENS);
    quoteAccount(chain, m, w);
  }
  // Its account looks usable, but every transfer to it fails in simulation.
  poison.add(getAssociatedTokenAddressSync(m.quoteMint, stuck, false, TOKEN_2022_PROGRAM_ID).toBase58());
  const ledger = payoutLedger();
  ledger.models.set(m.pool.toBase58(), { feeModel: "holders" });
  const paidTo = (w) => chain.balance(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID));
  for (let i = 1n; i <= 3n; i++) await rewardsPass({ chain, markets: [m], authority, ledger, distributed: i * 1_000_000n });
  const stuckRows = ledger.allocationRows.filter((r) => r.recipient === stuck.toBase58());
  assert.deepEqual(stuckRows.map((r) => [r.round, r.amount, r.status]), [[1, 500_000n, "unpaid"]]);
  // a: half of the first round, then all of the next two.
  assert.equal(paidTo(a), 2_500_000n);
  assert.equal(paidTo(stuck), 0n);
});

test("the crank key, the Vault admin and the keys the crank excludes are never paid as holders (holders, diamond, lpFarm on the curve)", async () => {
  const admin = key(); // the Vault admin the crank read this pass
  for (const feeModel of ["holders", "diamond", "lpFarm"]) {
    const holder = key();
    const { authority, chain, m, ledger, paidTo } = holdersMarket([[holder, TOKENS], [VAULT_ADMIN, TOKENS], [CRANK_KEY, TOKENS], [admin, TOKENS]], { feeModel });
    m.platformOwner = admin;
    // The crank key holds some too (its quote account is the market's payout account).
    holdBase(chain, m, authority.publicKey, TOKENS);
    const dbc = dbcAccounts(m);
    chain.put(m.pool, dbc.poolInfo);
    chain.put(m.config, dbc.configInfo);
    const { out, lines } = await rewardsPass({ chain, markets: [m], authority, ledger, distributed: 1_000_000n });
    assert.equal(out.atoms, 1_000_000n, feeModel);
    assert.equal(lines.find((l) => l.tag === "rewards").holders, 1, feeModel);
    assert.deepEqual([holder, VAULT_ADMIN, CRANK_KEY, admin, authority.publicKey].map(paidTo), [1_000_000n, 0n, 0n, 0n, 0n], feeModel);
  }
});

test("a dry run allocates in memory only: it simulates the first batch and writes nothing", async () => {
  const holders = Array.from({ length: 3 }, key);
  const { authority, chain, m, ledger } = holdersMarket(holders.map((h) => [h, TOKENS]));
  const { out } = await rewardsPass({ chain, markets: [m], authority, ledger, distributed: 1_000_000n, dryRun: true });
  assert.equal(out.simulated, 1);
  assert.equal(chain.sent.length, 0);
  assert.equal(ledger.allocationRows.length, 0);
  assert.equal(ledger.pendingRows.size + ledger.payouts.length, 0);
});

test("a transaction is recorded only if every allocation row it pays is still unpaid and they add up to its amount", async () => {
  const ledger = payoutLedger();
  const [a, b] = [key(), key()];
  const [ra, rb] = await ledger.allocate("p", { module: "holders", shares: [{ owner: a, amount: 10n, balance: 1n }, { owner: b, amount: 5n, balance: 1n }].map(allocationOf) });
  const row = (signature, amount, rows) => ({ signature, pool: "p", amount, recipients: rows.length, lastValidBlockHeight: 1, allocations: rows.map((r) => ({ round: r.round, recipient: r.recipient, paidTo: r.recipient })) });
  await assert.rejects(ledger.begin(row("s0", 11n, [ra])), /allocation rows changed/);
  await ledger.begin(row("s1", 10n, [ra]));
  // Already pending under s1: a second transaction for it is refused, and nothing of it is written.
  await assert.rejects(ledger.begin(row("s2", 15n, [ra, rb])), /allocation rows changed/);
  assert.deepEqual([...ledger.pendingRows.keys()], ["s1"]);
  assert.deepEqual(ledger.allocationRows.map((r) => r.status), ["pending", "unpaid"]);
  assert.equal(await ledger.allocatedUnpaid("p"), 5n);
  // Dropped (failed or expired): unpaid again, still a's.
  await ledger.drop("s1");
  assert.deepEqual((await ledger.allocations("p")).map((r) => [r.recipient, r.amount]), [[a.toBase58(), 10n], [b.toBase58(), 5n]]);
  await ledger.begin(row("s3", 10n, [ra]));
  await ledger.confirm("s3");
  assert.deepEqual(ledger.allocationRows.map((r) => r.status), ["paid", "unpaid"]);
  assert.equal(await ledger.paid("p"), 10n);
});

test("rounds never hold more than is owed, and a new round is taken only from what no round holds", async () => {
  const [a, b] = [key(), key()];
  const { authority, chain, m, ledger } = holdersMarket([[a, TOKENS], [b, TOKENS]]);
  await ledger.allocate(m.pool.toBase58(), { module: "holders", shares: [allocationOf({ owner: a, amount: 700n, balance: 1n })] });
  const ctx = await passContext({ chain, m, authority, distributed: 600n, ledger });
  await assert.rejects(payHolders(ctx), /more than the 600 owed/);
  // 1000 owed, 700 of it a's: the new round splits the other 300.
  const next = await passContext({ chain, m, authority, distributed: 1_000n, ledger });
  let offered;
  await payAllocated(next, { module: "holders", allocate: async (amount) => ((offered = amount), []) });
  assert.equal(offered, 300n);
});
