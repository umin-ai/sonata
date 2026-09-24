import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CRANK_KEY, DBC_PROGRAM, KNOWN_PROGRAMS, SONATA_VAULT, VAULT_ADMIN } from "./common.mjs";
import { MAX_TX_BYTES } from "./payout.mjs";
import { SPLIT_BLOCKED_KEYS, runSplit, splitRecipients, splitShares, validateSplit } from "./split.mjs";
import * as rules from "../../lib/split-rules.mjs";
import { fakeChain, key, memLedger, moduleContext, passContext, payoutLedger, pda, quoteAccount, rewardMarket, tokenAccount } from "./testkit.mjs";

const entry = (weight = 1, wallet = key()) => ({ wallet: wallet.toBase58(), weight });

test("a split is 1 to 5 distinct wallets with whole weights from 1 to 100", () => {
  const ok = [entry(60), entry(30), entry(10)];
  const v = validateSplit(ok);
  assert.equal(v.ok, true);
  assert.deepEqual(v.recipients.map((r) => [r.wallet.toBase58(), r.weight]), ok.map((e) => [e.wallet, e.weight]));
  assert.equal(validateSplit([entry(100)]).ok, true);
  assert.equal(validateSplit(Array.from({ length: 5 }, () => entry(1))).ok, true);
  // Extra fields are ignored.
  assert.equal(validateSplit([{ ...entry(5), label: "team" }]).ok, true);
  const w = key();
  const bad = [
    [undefined, /not a list/],
    [null, /not a list/],
    [{ wallet: w.toBase58(), weight: 1 }, /not a list/],
    [[], /1 to 5/],
    [Array.from({ length: 6 }, () => entry(1)), /1 to 5/],
    [[null], /not an object/],
    [[[w.toBase58(), 1]], /not an object/],
    [[{ weight: 1 }], /canonical base58/],
    [[{ wallet: "not-an-address", weight: 1 }], /canonical base58/],
    [[{ wallet: `${w.toBase58()} `, weight: 1 }], /canonical base58/],
    [[{ wallet: w.toBase58().replace(/./, "0"), weight: 1 }], /canonical base58/],
    [[{ wallet: w.toBuffer().toString("hex"), weight: 1 }], /canonical base58/],
    [[entry(1, pda())], /off curve/],
    [[entry(1, w), entry(2, w)], /listed twice/],
    [[entry(0)], /1 to 100/],
    [[entry(101)], /1 to 100/],
    [[entry(1.5)], /1 to 100/],
    [[{ wallet: key().toBase58(), weight: "10" }], /1 to 100/],
    [[entry(-1)], /1 to 100/],
    // Sonata's own addresses and program ids (which are on curve) are never recipients.
    [[entry(1, CRANK_KEY)], /Sonata or program/],
    [[entry(1, VAULT_ADMIN)], /Sonata or program/],
    [[entry(1, TOKEN_PROGRAM_ID)], /Sonata or program/],
    [[entry(1, TOKEN_2022_PROGRAM_ID)], /Sonata or program/],
    [[entry(1, SystemProgram.programId)], /Sonata or program/],
  ];
  for (const [split, reason] of bad) {
    const r = validateSplit(split);
    assert.equal(r.ok, false, JSON.stringify(split));
    assert.match(r.reason, reason, JSON.stringify(split));
  }
  // The Vault is off curve anyway; the crank passes its own key and the Vault admin it reads.
  assert.equal(validateSplit([entry(1, SONATA_VAULT)]).ok, false);
  const crank = key();
  assert.match(validateSplit([entry(1, crank)], { excluded: [crank] }).reason, /Sonata or program/);
});

test("each wallet gets owed × weight ÷ total, rounded down; the dust stays owed", () => {
  const r = (weight) => ({ wallet: key(), weight });
  assert.deepEqual(splitShares([r(60), r(30), r(10)], 1_000_000n).map((s) => s.amount), [600_000n, 300_000n, 100_000n]);
  const thirds = splitShares([r(1), r(1), r(1)], 100n);
  assert.deepEqual(thirds.map((s) => s.amount), [33n, 33n, 33n]);
  assert.deepEqual(splitShares([r(1), r(99)], 50n).map((s) => s.amount), [49n]);
  assert.deepEqual(splitShares([r(3)], 0n), []);
  // Random splits: never more than owed, and less than one atom lost per wallet.
  let seed = 11n;
  const rand = (max) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n) % max) + 1n;
  for (let i = 0; i < 500; i++) {
    const recipients = Array.from({ length: Number(rand(5n)) }, () => ({ wallet: i, weight: Number(rand(100n)) }));
    const owed = rand(10n ** 13n);
    const shares = splitShares(recipients, owed);
    const paid = shares.reduce((s, x) => s + x.amount, 0n);
    assert.ok(paid <= owed && owed - paid < BigInt(recipients.length));
  }
});

async function splitMarket({ split, owed = 1_000_000n, accountsFor = [] }) {
  const authority = Keypair.generate();
  const chain = fakeChain();
  const m = rewardMarket(chain, authority.publicKey, { owed });
  for (const w of accountsFor) chain.put(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID), tokenAccount({ owner: w, mint: m.quoteMint }));
  const ledger = payoutLedger(memLedger());
  const ctx = await moduleContext({ chain, m, authority, owed, ledger, model: { feeModel: "split", config: { split } } });
  // Later passes: the treasury has distributed `distributed` in total.
  const pass = async (distributed) => {
    const c = await passContext({ chain, m, authority, distributed, ledger, model: { feeModel: "split", config: { split } } });
    await runSplit(c);
    return c;
  };
  return { authority, chain, m, ledger, ctx, pass };
}
const quoteOf = (chain, m, w) => chain.balance(getAssociatedTokenAddressSync(m.quoteMint, w, false, TOKEN_2022_PROGRAM_ID));

test("a split pays every wallet in one transaction, creating missing quote accounts", async () => {
  const wallets = Array.from({ length: 5 }, key);
  const split = wallets.map((w, i) => entry([40, 25, 20, 10, 5][i], w));
  const { chain, m, ledger, ctx } = await splitMarket({ split, owed: 1_000_003n, accountsFor: [wallets[0]] });
  assert.deepEqual(await runSplit(ctx), {});
  assert.equal(chain.sent.length, 1);
  const [{ tx, bytes }] = chain.sent;
  assert.ok(bytes <= MAX_TX_BYTES, `${bytes} bytes`);
  // Four idempotent account creations (the crank pays) and five transfers.
  assert.equal(tx.instructions.length, 9);
  assert.deepEqual(wallets.map((w) => quoteOf(chain, m, w)), [400_001n, 250_000n, 200_000n, 100_000n, 50_000n]);
  assert.equal(ctx.result.paid, 1_000_001n);
  assert.equal(ctx.fund.balance, 2n);
  const [row] = ledger.payouts;
  assert.equal(row.module, "split");
  assert.equal(row.amount, 1_000_001n);
  assert.deepEqual(row.detail.recipients.map((r) => [r.wallet.toBase58(), r.weight, r.amount]), wallets.map((w, i) => [w.toBase58(), [40, 25, 20, 10, 5][i], [400_001n, 250_000n, 200_000n, 100_000n, 50_000n][i]]));
});

test("an invalid split or a program wallet pays nobody and keeps the funds owed", async () => {
  for (const split of [[entry(0)], [], null, [entry(1, CRANK_KEY)]]) {
    const { chain, ctx } = await splitMarket({ split });
    const r = await runSplit(ctx);
    assert.match(r.skip, /invalid split: .*nothing paid, funds stay owed/);
    assert.equal(chain.sent.length + chain.simulated.length, 0);
  }
  // A wallet whose account is executable is a program, whatever its address.
  const program = key();
  const { chain, ctx } = await splitMarket({ split: [entry(50), entry(50, program)] });
  chain.put(program, { data: Buffer.alloc(36), owner: key(), lamports: 1, executable: true });
  assert.match((await runSplit(ctx)).skip, new RegExp(`${program.toBase58()} is a program`));
  assert.equal(chain.sent.length, 0);
});

test("the API lists the split's wallets with what each has been paid", () => {
  const [a, b] = [key(), key()];
  const config = { split: [entry(70, a), entry(30, b)] };
  assert.deepEqual(splitRecipients(config, new Map([[a.toBase58(), "700"]])), {
    recipients: [{ wallet: a.toBase58(), weight: 70, paid: "700" }, { wallet: b.toBase58(), weight: 30, paid: "0" }],
  });
  assert.deepEqual(splitRecipients({ split: [entry(0)] }, new Map()).recipients, []);
  assert.match(splitRecipients(null, new Map()).splitError, /not a list/);
});

test("the split rules are one set, shared with the app: Sonata's keys and every known program are blocked", () => {
  assert.equal(SPLIT_BLOCKED_KEYS, rules.SPLIT_BLOCKED_KEYS);
  assert.equal(validateSplit, rules.validateSplit);
  assert.ok(Object.isFrozen(SPLIT_BLOCKED_KEYS));
  const expected = [CRANK_KEY, SONATA_VAULT, VAULT_ADMIN, ...KNOWN_PROGRAMS].map((k) => k.toBase58());
  assert.deepEqual([...SPLIT_BLOCKED_KEYS].sort(), [...new Set(expected)].sort());
  assert.ok(SPLIT_BLOCKED_KEYS.every((k) => typeof k === "string"));
  // Every one is refused as a wallet, on curve or not.
  for (const k of SPLIT_BLOCKED_KEYS) assert.equal(validateSplit([{ wallet: k, weight: 1 }]).ok, false, k);
  // The API lists only what the bot would pay: a program id makes the split invalid there too.
  const r = splitRecipients({ split: [entry(50), { wallet: DBC_PROGRAM.toBase58(), weight: 50 }] }, new Map());
  assert.deepEqual(r.recipients, []);
  assert.match(r.splitError, /Sonata or program/);
  // And the keys the bot adds at run time (the key it runs with, the admin it reads).
  const runtime = key();
  assert.match(splitRecipients({ split: [entry(1, runtime)] }, new Map(), { excluded: [runtime] }).splitError, /Sonata or program/);
});

const memoAccount = (m, owner, on) =>
  tokenAccount({ owner, mint: m.quoteMint, extensions: [[ExtensionType.ImmutableOwner], [ExtensionType.MemoTransfer, Buffer.from([on ? 1 : 0])]] });

test("a wallet that cannot receive keeps its share until it can; the others are never paid it", async () => {
  const [a, b] = [key(), key()];
  const { chain, m, ledger, pass } = await splitMarket({ split: [entry(50, a), entry(50, b)], accountsFor: [a] });
  // b's account requires memos: it cannot receive a plain transfer.
  const bAta = getAssociatedTokenAddressSync(m.quoteMint, b, false, TOKEN_2022_PROGRAM_ID);
  chain.put(bAta, memoAccount(m, b, true));
  const first = await pass(100_000n);
  assert.equal(first.result.skipped.memo, 1);
  assert.deepEqual([a, b].map((w) => quoteOf(chain, m, w)), [50_000n, 0n]);
  // New fees: a gets its half of them only; b's first half stays b's.
  await pass(200_000n);
  assert.deepEqual([a, b].map((w) => quoteOf(chain, m, w)), [100_000n, 0n]);
  assert.equal(await ledger.allocatedUnpaid(m.pool.toBase58()), 100_000n);
  // b turns memos off: it is paid both its halves, in one transfer.
  chain.put(bAta, memoAccount(m, b, false));
  const third = await pass(200_000n);
  assert.deepEqual([a, b].map((w) => quoteOf(chain, m, w)), [100_000n, 100_000n]);
  assert.equal(third.result.recipients, 1);
  assert.deepEqual(ledger.payouts.at(-1).detail.recipients.map((r) => [r.wallet.toBase58(), r.weight, r.amount]), [[b.toBase58(), 50, 100_000n]]);
});

test("the crank creates a wallet's quote account at most once per market; after it is closed the share waits", async () => {
  const [w1, w2] = [key(), key()];
  const { chain, m, ledger, pass } = await splitMarket({ split: [entry(50, w1), entry(50, w2)], accountsFor: [w2] });
  const creates = (s) => s.tx.instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).length;
  await pass(100_000n);
  assert.deepEqual(chain.sent.map(creates), [1]);
  assert.deepEqual([w1, w2].map((w) => quoteOf(chain, m, w)), [50_000n, 50_000n]);
  // w1 empties and closes it (its rent back); every later pass would pay for a new one.
  const w1Ata = getAssociatedTokenAddressSync(m.quoteMint, w1, false, TOKEN_2022_PROGRAM_ID);
  chain.accounts.delete(w1Ata.toBase58());
  const second = await pass(200_000n);
  const third = await pass(300_000n);
  assert.deepEqual(chain.sent.map(creates), [1, 0, 0]);
  assert.equal(second.result.skipped.closed, 1);
  assert.equal(third.result.skipped.closed, 1);
  assert.equal(quoteOf(chain, m, w2), 150_000n);
  assert.equal(await ledger.allocatedUnpaid(m.pool.toBase58()), 100_000n);
  // w1 opens it again (at its own cost): it is paid everything held for it.
  quoteAccount(chain, m, w1);
  await pass(300_000n);
  assert.deepEqual([w1, w2].map((w) => quoteOf(chain, m, w)), [100_000n, 150_000n]);
  assert.equal(chain.sent.map(creates).reduce((s, n) => s + n, 0), 1);
});

test("an account creation that never landed is not remembered: the next pass creates it", async () => {
  const w = key();
  const { chain, m, ledger, pass } = await splitMarket({ split: [entry(1, w)] });
  chain.lost.add(0);
  await assert.rejects(pass(100_000n), /not confirmed yet/);
  // Still pending: counted as paid, the account not yet known to exist.
  assert.equal(await ledger.paid(m.pool.toBase58()), 100_000n);
  // Its blockhash expires; the pending row is dropped and its allocation is unpaid again.
  chain.setHeight(10_000);
  const { resolvePending } = await import("../rewards.mjs");
  await resolvePending({ ledger, connection: chain.connection, rpc: (fn) => fn(), log: () => {} });
  assert.deepEqual([...(await ledger.createdAccounts(m.pool.toBase58()))], []);
  await pass(100_000n);
  assert.equal(quoteOf(chain, m, w), 100_000n);
  assert.deepEqual(ledger.allocationRows.map((r) => [r.status, r.createsAccount]), [["paid", true]]);
});
