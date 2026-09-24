import test from "node:test";
import assert from "node:assert/strict";
import anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import { Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { WITHDRAW_SEARCH, airdropShares, airdropTotals, runAirdrops, withdrawLeftoverIx, withdrawnFromTransaction } from "./airdrop.mjs";
import { crankLedger, migrateCrank } from "./crank-schema.mjs";
import { airdropReserve, burnable, runBuyback } from "./buyback.mjs";
import { SONATA_VAULT, VAULT_ADMIN } from "./common.mjs";
import { selectHolders } from "./holders.mjs";
import { readDbc } from "./meteora.mjs";
import { MAX_TX_BYTES } from "./payout.mjs";
import { dammPoolAccount, dbcAccounts, fakeChain, key, memLedger, moduleContext, pda, quotedOut, rewardMarket, tokenAccount } from "./testkit.mjs";

const LEFTOVER = 50_000_000_000_000n; // 5% of 1B tokens, 6 decimals
const SUPPLY = 1_000_000_000_000_000n;
const TOKENS = 1_000_000n; // one token in atoms

// A graduated market whose config names the crank key as leftover receiver, and its holders' base accounts.
function setup({ holders = [], migrated = true, receiver, lost, leftover = LEFTOVER, landOut, finishCurveAt } = {}) {
  const authority = Keypair.generate();
  const crank = authority.publicKey;
  const chain = fakeChain({ leftover, lost, landOut });
  const m = rewardMarket(chain, crank, { supply: SUPPLY });
  const dbc = dbcAccounts(m, {
    migrated,
    edit: ({ config, pool }) => {
      config.leftoverReceiver = receiver ?? crank;
      if (finishCurveAt) pool.finishCurveTimestamp = new anchor.BN(finishCurveAt);
    },
  });
  chain.put(m.pool, dbc.poolInfo);
  chain.put(m.config, dbc.configInfo);
  const damm = dammPoolAccount(m, { migrationFeeOption: dbc.config.migrationFeeOption });
  chain.put(damm.address, damm.info);
  const accounts = holders.map((h) => {
    const address = h.address ?? key();
    chain.put(address, tokenAccount({ owner: h.owner, mint: m.baseMint, amount: h.amount, program: TOKEN_PROGRAM_ID }));
    return address;
  });
  const ledger = withWithdrawSearch(memLedger());
  const lines = [];
  const job = (over = {}) => ({
    markets: [m],
    infoOf: (k) => chain.accounts.get(k.toBase58()) ?? null,
    authority,
    connection: chain.connection,
    rpc: (fn) => fn(),
    blockhash: chain.blockhash,
    simulate: async (steps, payer, { accounts: returned } = {}) => {
      const tx = new Transaction().add(...steps.map((s) => s.ix));
      tx.feePayer = payer;
      tx.recentBlockhash = PublicKey.default.toBase58();
      const opts = returned ? { accounts: { encoding: "base64", addresses: returned.map(String) } } : {};
      return (await chain.connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), opts)).value;
    },
    ledger,
    dryRun: false,
    pollMs: 0,
    log: (tag, f) => lines.push({ tag, ...f }),
    feePayerOf: () => crank,
    excluded: [],
    ...over,
  });
  const run = (over) => runAirdrops(job(over));
  const pool = m.pool.toBase58();
  const crankBase = getAssociatedTokenAddressSync(m.baseMint, crank, false, TOKEN_PROGRAM_ID);
  const balance = (k) => chain.balance(k);
  return { authority, crank, chain, m, ledger, lines, run, pool, crankBase, accounts, balance, job };
}
const many = (n, amount = 1_000_000n * TOKENS) => Array.from({ length: n }, () => ({ owner: key(), amount }));
// crank-schema.mjs crankLedger's withdrawal search cursor, in memory (as its airdrop_withdraw_search table).
function withWithdrawSearch(ledger) {
  const searches = new Map();
  return Object.assign(ledger, {
    searches,
    airdropSearch: async (pool) => (searches.has(pool) ? { ...searches.get(pool) } : null),
    airdropSaveSearch: async (pool, cursor) => void (cursor ? searches.set(pool, { ...cursor }) : searches.delete(pool)),
  });
}

test("airdrop rows are withdrawn × balance ÷ total, rounded down, to each holder's largest account", () => {
  const mint = key();
  const [a, b] = [key(), key()];
  const [a1, a2, b1] = [key(), key(), key()];
  const listed = [
    { pubkey: a1, account: tokenAccount({ owner: a, mint, amount: 300n * TOKENS, program: TOKEN_PROGRAM_ID }) },
    { pubkey: a2, account: tokenAccount({ owner: a, mint, amount: 500n * TOKENS, program: TOKEN_PROGRAM_ID }) },
    { pubkey: b1, account: tokenAccount({ owner: b, mint, amount: 200n * TOKENS, program: TOKEN_PROGRAM_ID }) },
  ];
  const holders = selectHolders(listed, { mint, supply: 1_000_000n * TOKENS });
  const rows = airdropShares(holders, 1_000_001n);
  assert.deepEqual(rows.map((r) => [r.recipient.toBase58(), r.owner.toBase58(), r.amount]), [
    [a2.toBase58(), a.toBase58(), 800_000n],
    [b1.toBase58(), b.toBase58(), 200_000n],
  ]);
  // Random snapshots: never more than withdrawn, less than one atom lost per holder.
  let seed = 5n;
  const rand = (max) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n) % max) + 1n;
  for (let i = 0; i < 300; i++) {
    const hs = Array.from({ length: Number(rand(200n)) }, () => ({ owner: key(), account: key(), balance: rand(10n ** 15n) }));
    const withdrawn = rand(10n ** 14n);
    const total = airdropShares(hs, withdrawn).reduce((s, r) => s + r.amount, 0n);
    assert.ok(total <= withdrawn && withdrawn - total < BigInt(hs.length));
  }
  assert.throws(() => airdropTotals([{ status: "sent", amount: 6n }, { status: "unpaid", amount: 5n }], 10n), /more than the 10 withdrawn/);
  assert.deepEqual(airdropTotals([{ status: "sent", amount: 6n }, { status: "unpaid", amount: 4n }], 10n), { sent: 6n, pending: 0n, unpaid: 4n, skipped: 0n, all: 10n });
});

test("before graduation the airdrop waits; markets without the crank as leftover receiver are ignored", async () => {
  const waiting = setup({ migrated: false, holders: many(3) });
  assert.deepEqual(await waiting.run(), { markets: 1, txs: 0, atoms: 0n, failed: 0 });
  assert.equal(waiting.chain.sent.length, 0);
  assert.equal((await waiting.ledger.airdropState(waiting.pool)).withdrawn, null);
  assert.ok(waiting.lines.some((l) => l.action === "wait"));
  const other = setup({ receiver: key(), holders: many(3) });
  assert.deepEqual(await other.run(), { markets: 0, txs: 0, atoms: 0n, failed: 0 });
  assert.equal(other.ledger.airdrops.size, 0);
});

test("after graduation it withdraws the leftover, snapshots holders once and airdrops exactly what it withdrew", async () => {
  const holders = [
    ...many(45),
    { owner: pda(), amount: 1_000_000n * TOKENS }, // a program vault
    { owner: VAULT_ADMIN, amount: 1_000_000n * TOKENS },
    { owner: SONATA_VAULT, amount: 1_000_000n * TOKENS },
    { owner: key(), amount: 99_999n * TOKENS }, // under 0.01% of supply
  ];
  const s = setup({ holders });
  const r = await s.run();
  assert.equal(r.failed, 0);
  const state = await s.ledger.airdropState(s.pool);
  assert.equal(state.withdrawn, LEFTOVER);
  assert.ok(state.done);
  const rows = await s.ledger.airdropRows(s.pool);
  assert.equal(rows.length, 45);
  assert.ok(rows.every((x) => x.status === "sent"));
  // 45 equal holders: LEFTOVER / 45 each, the dust stays with the crank.
  const each = LEFTOVER / 45n;
  for (const [i, h] of holders.slice(0, 45).entries()) assert.equal(s.balance(s.accounts[i]), h.amount + each);
  assert.equal(s.balance(s.crankBase), LEFTOVER - each * 45n);
  // Excluded holders got nothing.
  for (const i of [45, 46, 47, 48]) assert.equal(s.balance(s.accounts[i]), holders[i].amount);
  // One withdrawal, then 20 + 20 + 5 transfers, each under the size limit.
  assert.equal(r.txs, 4);
  const sizes = s.chain.sent.map((x) => [x.tx.instructions.length, x.bytes]);
  assert.deepEqual(sizes.slice(1).map(([n]) => n), [20, 20, 5]);
  assert.ok(sizes.every(([, b]) => b <= MAX_TX_BYTES), JSON.stringify(sizes));
  assert.equal(r.atoms, each * 45n);
  // A later pass does nothing.
  const again = await s.run();
  assert.equal(again.txs, 0);
  assert.equal(s.chain.sent.length, 4);
});

test("a transfer that never landed is resent once expired; one that landed is never paid again", async () => {
  // The third send (the second airdrop batch) is dropped.
  const s = setup({ holders: many(45), lost: new Set([2]) });
  await s.run();
  let rows = await s.ledger.airdropRows(s.pool);
  // An unsettled batch stops the pass for this market.
  assert.deepEqual(count(rows), { sent: 20, pending: 20, unpaid: 5 });
  // Its blockhash is still valid: it stays pending and is not resent; the rest are paid.
  await s.run();
  rows = await s.ledger.airdropRows(s.pool);
  assert.deepEqual(count(rows), { sent: 25, pending: 20, unpaid: 0 });
  assert.equal((await s.ledger.airdropState(s.pool)).done, false);
  // Expired: those twenty are unpaid again and paid once.
  s.chain.setHeight(2_000);
  await s.run();
  rows = await s.ledger.airdropRows(s.pool);
  assert.deepEqual(count(rows), { sent: 45, pending: 0, unpaid: 0 });
  assert.ok((await s.ledger.airdropState(s.pool)).done);
  const each = LEFTOVER / 45n;
  s.accounts.forEach((a) => assert.equal(s.balance(a), 1_000_000n * TOKENS + each));

  // A crash after a batch landed but before it was recorded: settled from the chain, not resent.
  const c = setup({ holders: many(5) });
  await c.run();
  const sentBefore = c.chain.sent.length;
  for (const row of c.ledger.drops.get(c.pool).values()) row.status = "pending";
  c.ledger.airdrops.get(c.pool).done = false;
  await c.run();
  assert.equal(c.chain.sent.length, sentBefore);
  assert.deepEqual(count(await c.ledger.airdropRows(c.pool)), { sent: 5, pending: 0, unpaid: 0 });
  assert.ok((await c.ledger.airdropState(c.pool)).done);
});
const count = (rows) => ({
  sent: rows.filter((r) => r.status === "sent").length,
  pending: rows.filter((r) => r.status === "pending").length,
  unpaid: rows.filter((r) => r.status === "unpaid").length,
});

test("the snapshot is taken once: holders who buy in later are not added", async () => {
  const s = setup({ holders: many(3), lost: new Set([1]) });
  await s.run();
  const first = (await s.ledger.airdropRows(s.pool)).map((r) => r.recipient.toBase58());
  const late = key();
  s.chain.put(key(), tokenAccount({ owner: late, mint: s.m.baseMint, amount: 5_000_000n * TOKENS, program: TOKEN_PROGRAM_ID }));
  s.chain.setHeight(2_000);
  await s.run();
  const rows = await s.ledger.airdropRows(s.pool);
  assert.deepEqual(rows.map((r) => r.recipient.toBase58()), first);
  assert.ok(!rows.some((r) => r.owner.equals(late)));
  // Writing a second snapshot changes nothing.
  await s.ledger.airdropSnapshot(s.pool, [{ recipient: key(), owner: late, amount: 1n }]);
  assert.equal((await s.ledger.airdropRows(s.pool)).length, 3);
});

test("never more than was withdrawn: an inconsistent ledger or a short balance sends nothing", async () => {
  const s = setup({ holders: many(3), lost: new Set([1]) });
  await s.run(); // withdrawn; the first batch was dropped
  s.chain.setHeight(2_000);
  // Rows adding up to more than the withdrawal.
  const [row] = s.ledger.drops.get(s.pool).values();
  row.amount += LEFTOVER;
  const sends = s.chain.sent.length;
  const r = await s.run();
  assert.equal(r.failed, 1);
  assert.match(s.lines.at(-1).reason, /more than the \d+ withdrawn; nothing sent/);
  assert.equal(s.chain.sent.length, sends);
  row.amount -= LEFTOVER;
  // The crank's base account holding less than is still to be airdropped.
  const info = s.chain.accounts.get(s.crankBase.toBase58());
  const a = AccountLayout.decode(info.data);
  a.amount = 10n;
  const data = Buffer.from(info.data);
  AccountLayout.encode(a, data);
  s.chain.accounts.set(s.crankBase.toBase58(), { ...info, data });
  const short = await s.run();
  assert.equal(short.failed, 1);
  assert.match(s.lines.at(-1).reason, /crank holds 10 base atoms, below the \d+ still to airdrop; nothing sent/);
  assert.equal(s.chain.sent.length, sends);
});

test("a withdrawal made by someone else, or sent before a crash, is found and its exact amount used", async () => {
  // Someone else withdraws (the instruction is permissionless) before the crank does.
  const s = setup({ holders: many(4) });
  const dbc = readDbc(s.m, s.chain.accounts.get(s.m.pool.toBase58()), s.chain.accounts.get(s.m.config.toBase58()));
  const stranger = Keypair.generate();
  const { createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
  const tx = new Transaction({ feePayer: stranger.publicKey, blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 1000 }).add(
    createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, s.crankBase, s.crank, s.m.baseMint, TOKEN_PROGRAM_ID),
    await withdrawLeftoverIx({ m: s.m, dbc, crank: s.crank, crankBase: s.crankBase }),
  );
  tx.sign(stranger);
  await s.chain.connection.sendRawTransaction(tx.serialize());
  assert.equal(s.balance(s.crankBase), LEFTOVER);
  await s.run();
  const state = await s.ledger.airdropState(s.pool);
  assert.equal(state.withdrawn, LEFTOVER);
  assert.equal(state.withdrawSignature, bs58.encode(tx.signature));
  assert.ok(state.done);
  assert.equal(withdrawnFromTransaction(s.chain.sent[0].record, { pool: s.m.pool, crankBase: s.crankBase }), LEFTOVER);
  // Not a withdrawal of this pool, or failed: no amount.
  assert.equal(withdrawnFromTransaction(s.chain.sent[0].record, { pool: key(), crankBase: s.crankBase }), null);
  assert.equal(withdrawnFromTransaction(s.chain.sent[1].record, { pool: s.m.pool, crankBase: s.crankBase }), null);
  assert.equal(withdrawnFromTransaction({ ...s.chain.sent[0].record, meta: { ...s.chain.sent[0].record.meta, err: { x: 1 } } }, { pool: s.m.pool, crankBase: s.crankBase }), null);

  // The crank's own withdrawal, sent but not settled before a crash: read back from its signature.
  const c = setup({ holders: many(2), lost: new Set([0]) });
  await c.run();
  const pendingWithdraw = await c.ledger.airdropState(c.pool);
  assert.ok(pendingWithdraw.withdrawSignature && pendingWithdraw.withdrawn == null);
  // Expired unlanded: cleared and sent again.
  c.chain.setHeight(2_000);
  await c.run();
  const done = await c.ledger.airdropState(c.pool);
  assert.equal(done.withdrawn, LEFTOVER);
  assert.notEqual(done.withdrawSignature, pendingWithdraw.withdrawSignature);
  assert.ok(done.done);
});

test("a dry run simulates the withdrawal and writes nothing", async () => {
  const s = setup({ holders: many(2) });
  await s.run({ dryRun: true });
  assert.equal(s.chain.sent.length, 0);
  assert.equal(s.ledger.airdrops.size, 0);
  assert.ok(s.lines.some((l) => l.action === "withdraw" && l.result === "simulated" && l.amount === LEFTOVER));
});

test("a buyback market with the airdrop never burns the airdrop's tokens", async () => {
  assert.equal(burnable(100n, { amount: 30n }), 70n);
  assert.equal(burnable(20n, { amount: 30n }), 0n);
  assert.equal(burnable(100n, { unknown: true }), 0n);
  const ledger = memLedger();
  assert.deepEqual(await airdropReserve(ledger, "p", { airdropMarket: false, withdrawnFlag: true }), { amount: 0n });
  // Withdrawn by someone and not recorded yet: nothing but the buyback's own purchase may burn.
  assert.deepEqual(await airdropReserve(ledger, "p", { airdropMarket: true, withdrawnFlag: true }), { unknown: true });
  assert.deepEqual(await airdropReserve(ledger, "p", { airdropMarket: true, withdrawnFlag: false }), { amount: 0n });

  // The airdrop withdrew and paid part; the rest sits in the crank's base account when a buyback runs.
  const s = setup({ holders: many(3), lost: new Set([1]) });
  await s.run();
  const reserved = LEFTOVER - 0n; // nothing confirmed sent yet
  assert.equal(s.balance(s.crankBase), LEFTOVER);
  const owed = 100_000_000n;
  s.chain.put(s.m.payoutQuote, tokenAccount({ owner: s.crank, mint: s.m.quoteMint, amount: owed }));
  const ctx = await moduleContext({ chain: s.chain, m: s.m, authority: s.authority, owed, ledger: s.ledger, model: { feeModel: "buyback" } });
  await runBuyback(ctx);
  const [row, burnOnly] = ctx.ledger.payouts;
  assert.equal(row.module, "buyback");
  // With the airdrop's tokens in the same account the swap's transaction burns
  // only its minimum out; the rest of what it bought is burned right after.
  assert.equal(row.detail.burned, row.detail.minOut);
  assert.equal(row.detail.burned + burnOnly.detail.burned, row.detail.received);
  assert.equal(row.detail.received, s.chain.delivered[0]);
  assert.equal(row.detail.leftover, 0n);
  assert.equal(ctx.fields.airdropHeld, reserved);
  assert.equal(s.balance(s.crankBase), reserved);
  // The airdrop then completes from the same account.
  s.chain.setHeight(2_000);
  await s.run();
  assert.ok((await s.ledger.airdropState(s.pool)).done);
  assert.equal(s.balance(s.crankBase), LEFTOVER - (LEFTOVER / 3n) * 3n);
});

// Someone else's withdraw_leftover (the instruction is permissionless), sent before the crank's.
async function strangerWithdraws(s, blockhashByte = 7) {
  const dbc = readDbc(s.m, s.chain.accounts.get(s.m.pool.toBase58()), s.chain.accounts.get(s.m.config.toBase58()));
  const stranger = Keypair.generate();
  const tx = new Transaction({ feePayer: stranger.publicKey, blockhash: bs58.encode(Buffer.alloc(32, blockhashByte)), lastValidBlockHeight: 1000 }).add(
    createAssociatedTokenAccountIdempotentInstruction(stranger.publicKey, s.crankBase, s.crank, s.m.baseMint, TOKEN_PROGRAM_ID),
    await withdrawLeftoverIx({ m: s.m, dbc, crank: s.crank, crankBase: s.crankBase }),
  );
  tx.sign(stranger);
  await s.chain.connection.sendRawTransaction(tx.serialize());
  return bs58.encode(tx.signature);
}
// Transactions by a stranger with these instructions, each with its own blockhash.
async function strangerSends(s, count, instructions) {
  const stranger = Keypair.generate();
  for (let i = 0; i < count; i++) {
    const tx = new Transaction({ feePayer: stranger.publicKey, blockhash: bs58.encode(Buffer.alloc(32, 100 + (i % 150))), lastValidBlockHeight: 1000 })
      .add(new TransactionInstruction({ programId: key(), keys: [], data: Buffer.from([i >> 8, i & 255]) }), ...instructions(stranger.publicKey));
    tx.sign(stranger);
    await s.chain.connection.sendRawTransaction(tx.serialize());
  }
}
// The chain's connection, with getSignaturesForAddress honouring limit and before as the RPC does.
// `timeOf` gives signatures a blockTime, `hidden` ones are not listed (yet), `reads` records getTransaction;
// with the chain's `sent`, a listing is reused until something new is sent.
function pagedConnection(connection, calls = [], { timeOf, hidden = new Set(), reads = [], sent } = {}) {
  let cache = { at: -1, lists: new Map() };
  const listed = async (address) => {
    if (!sent) return connection.getSignaturesForAddress(address);
    if (cache.at !== sent.length) cache = { at: sent.length, lists: new Map() };
    const k = address.toBase58();
    if (!cache.lists.has(k)) cache.lists.set(k, await connection.getSignaturesForAddress(address));
    return cache.lists.get(k);
  };
  return {
    ...connection,
    getSignaturesForAddress: async (address, { limit = 1000, before } = {}) => {
      calls.push({ address: address.toBase58(), limit, before });
      const all = (await listed(address))
        .filter((x) => !hidden.has(x.signature))
        .map((x) => (timeOf ? { ...x, blockTime: timeOf.get(x.signature) ?? null } : x));
      const start = before ? all.findIndex((x) => x.signature === before) + 1 : 0;
      return all.slice(start, start + limit);
    },
    getTransaction: async (signature, opts) => (reads.push(signature), connection.getTransaction(signature, opts)),
  };
}
// A transaction naming `address` (read-only) that succeeds, and one that fails.
const naming = (address) => () => [new TransactionInstruction({ programId: key(), keys: [{ pubkey: address, isSigner: false, isWritable: false }], data: Buffer.alloc(0) })];
const failingOn = (address, mint) => (payer) => [new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID,
  keys: [key(), mint, key(), payer, address].map((pubkey, i) => ({ pubkey, isSigner: i === 3, isWritable: false })),
  data: Buffer.concat([Buffer.from([12]), Buffer.alloc(8, 1), Buffer.from([6])]),
})];

test("a buyback landing below its simulated output never burns the airdrop's reserve, recorded or not", async () => {
  // Worse than simulated by 500 atoms, still above the 2% minimum out.
  const worse = (x, min) => quotedOut(x, min) - 500n;
  const buyback = async (s) => {
    const owed = 100_000_000n;
    s.chain.put(s.m.payoutQuote, tokenAccount({ owner: s.crank, mint: s.m.quoteMint, amount: owed }));
    const ctx = await moduleContext({ chain: s.chain, m: s.m, authority: s.authority, owed, ledger: s.ledger, model: { feeModel: "buyback" } });
    assert.deepEqual(await runBuyback(ctx), {});
    return ctx;
  };

  // Recorded: the airdrop withdrew and its first batch was dropped, so every row is still owed.
  const s = setup({ holders: many(3), lost: new Set([1]), landOut: worse });
  await s.run();
  assert.equal(s.balance(s.crankBase), LEFTOVER);
  const ctx = await buyback(s);
  const [bought] = s.chain.delivered;
  assert.equal(bought, ctx.fields.received - 500n);
  // Everything bought is burned (the minimum out with the swap, the rest right after), none of the reserve.
  assert.deepEqual(s.ledger.payouts.map((r) => r.detail.burned), [ctx.fields.minOut, bought - ctx.fields.minOut]);
  assert.equal(ctx.fields.burned, bought);
  assert.equal(s.balance(s.crankBase), LEFTOVER);
  // The airdrop then completes from the same account.
  s.chain.setHeight(2_000);
  await s.run();
  assert.ok((await s.ledger.airdropState(s.pool)).done);
  assert.equal(s.balance(s.crankBase), LEFTOVER - (LEFTOVER / 3n) * 3n);

  // Not recorded yet: someone else withdrew and the crank has not run the airdrop since.
  const u = setup({ holders: many(3), landOut: worse });
  await strangerWithdraws(u);
  const uctx = await buyback(u);
  assert.equal(uctx.fields.airdropHeld, "unknown");
  const [ubought] = u.chain.delivered;
  // Only the swap's minimum out is burned; the surplus waits for the reserve to be known.
  assert.deepEqual(u.ledger.payouts.map((r) => r.detail.burned), [uctx.fields.minOut]);
  assert.equal(u.balance(u.crankBase), LEFTOVER + ubought - uctx.fields.minOut);
  await u.run();
  assert.ok((await u.ledger.airdropState(u.pool)).done);
  assert.equal(u.balance(u.crankBase), LEFTOVER - (LEFTOVER / 3n) * 3n + ubought - uctx.fields.minOut);
});

test("someone else's withdrawal is found in the pool's own history, newest first, however busy the crank's account is", async () => {
  const s = setup({ holders: many(3) });
  // The crank's base account gets 25 transactions before the withdrawal (as buybacks or anyone's dust would).
  await strangerSends(s, 25, (payer) => [createAssociatedTokenAccountIdempotentInstruction(payer, s.crankBase, s.crank, s.m.baseMint, TOKEN_PROGRAM_ID)]);
  const signature = await strangerWithdraws(s);
  // Then the pool: 5 successful transactions naming it and 25 failed ones.
  await strangerSends(s, 5, () => [new TransactionInstruction({ programId: key(), keys: [{ pubkey: s.m.pool, isSigner: false, isWritable: false }], data: Buffer.alloc(0) })]);
  const failing = (payer) => [new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [key(), s.m.baseMint, key(), payer, s.m.pool].map((pubkey, i) => ({ pubkey, isSigner: i === 3, isWritable: false })),
    data: Buffer.concat([Buffer.from([12]), Buffer.alloc(8, 1), Buffer.from([6])]),
  })];
  await strangerSends(s, 25, failing);
  assert.ok(s.chain.sent.slice(-25).every((t) => t.err));

  // Pages of 10: the withdrawal is the 31st newest of the pool's signatures.
  const calls = [];
  const connection = pagedConnection(s.chain.connection, calls);
  const tight = await s.run({ connection, withdrawSearch: { pageSize: 10, maxTransactions: 3 } });
  // Three transactions read (the failed ones are passed unread): not found yet, the search goes on.
  assert.equal(tight.failed, 0);
  assert.deepEqual(calls.map((c) => [c.address, c.limit, c.before]), [
    [s.m.pool.toBase58(), 10, undefined],
    [s.m.pool.toBase58(), 10, s.chain.sent[46].signature],
    [s.m.pool.toBase58(), 10, s.chain.sent[36].signature],
  ]);
  assert.equal(s.lines.at(-1).action, "wait");
  assert.match(s.lines.at(-1).reason, /someone else; searching the pool's history, 3 transactions read so far; continues from there next pass/);
  assert.equal((await s.ledger.airdropState(s.pool)).withdrawn, null);
  // Saved: the oldest signature checked, the third of the five successful ones.
  assert.deepEqual(s.ledger.searches.get(s.pool), { before: s.chain.sent[28].signature, read: 3, unreadable: 0 });
  calls.length = 0;
  const r = await s.run({ connection, withdrawSearch: { pageSize: 10 } });
  assert.equal(r.failed, 0);
  // The next pass carries on from there: one page, and the withdrawal is on it.
  assert.deepEqual(calls.map((c) => [c.address, c.limit, c.before]), [[s.m.pool.toBase58(), 10, s.chain.sent[28].signature]]);
  assert.equal(s.ledger.searches.has(s.pool), false, "the search is cleared once the withdrawal is recorded");
  const state = await s.ledger.airdropState(s.pool);
  assert.equal(state.withdrawn, LEFTOVER);
  assert.equal(state.withdrawSignature, signature);
  assert.ok(state.done);
  assert.equal(s.balance(s.crankBase), LEFTOVER - (LEFTOVER / 3n) * 3n);
});

test("a withdrawal behind 100 newer transactions and 1,000 failed ones naming the pool is found within three passes, each carrying on from the last", async () => {
  assert.deepEqual(WITHDRAW_SEARCH, { pageSize: 100, maxPages: 10, maxTransactions: 40 });
  const s = setup({ holders: many(3) });
  const signature = await strangerWithdraws(s);
  // Newest first, the pool's history is then: 40 successful, 1,000 failed, 60 successful, the withdrawal.
  await strangerSends(s, 60, naming(s.m.pool));
  await strangerSends(s, 1000, failingOn(s.m.pool, s.m.baseMint));
  await strangerSends(s, 40, naming(s.m.pool));
  assert.equal(s.chain.sent.filter((t) => t.err).length, 1000);
  const calls = [], reads = [];
  const connection = pagedConnection(s.chain.connection, calls, { reads, sent: s.chain.sent });
  const pass = async () => {
    calls.length = 0;
    reads.length = 0;
    return s.run({ connection });
  };

  // Pass 1: the 40 newest successful transactions read, then the failed ones passed unread, to the page limit.
  assert.deepEqual(await pass(), { markets: 1, txs: 0, atoms: 0n, failed: 0 });
  assert.equal(reads.length, 40);
  assert.equal(calls.length, 10);
  assert.equal(s.lines.at(-1).action, "wait");
  assert.match(s.lines.at(-1).reason, /40 transactions read so far; continues from there next pass/);
  const first = s.ledger.searches.get(s.pool);
  assert.equal(first.read, 40);
  assert.equal(first.before, s.chain.sent.at(-(40 + 960)).signature, "after the 960th failed one");
  assert.equal((await s.ledger.airdropState(s.pool)).withdrawn, null);

  // Pass 2 carries on from there (the newest are not read again): 40 more.
  assert.equal((await pass()).failed, 0);
  assert.equal(calls[0].before, first.before);
  assert.equal(reads.length, 40);
  assert.ok(!reads.some((r) => s.chain.sent.slice(-40).some((t) => t.signature === r)));
  assert.equal(s.ledger.searches.get(s.pool).read, 80);

  // Pass 3: the last 20 and the withdrawal. Its exact amount is recorded and airdropped.
  assert.equal((await pass()).failed, 0);
  assert.equal(reads.length, 21);
  assert.equal(reads.at(-1), signature);
  const state = await s.ledger.airdropState(s.pool);
  assert.equal(state.withdrawn, LEFTOVER);
  assert.equal(state.withdrawSignature, signature);
  assert.ok(state.done);
  assert.equal(s.ledger.searches.has(s.pool), false);
  assert.equal(s.balance(s.crankBase), LEFTOVER - (LEFTOVER / 3n) * 3n);
});

test("the withdrawal search stops at the curve's finish time and then starts again from the newest; a dry run saves no progress", async () => {
  const F = 1_900_000_000;
  const s = setup({ holders: many(2), finishCurveAt: F });
  await strangerSends(s, 30, naming(s.m.pool)); // curve trades, before the curve finished
  const signature = await strangerWithdraws(s);
  await strangerSends(s, 5, naming(s.m.pool)); // after graduation
  const timeOf = new Map(s.chain.sent.map((t, i) => [t.signature, i < 30 ? F - 3600 + i : F + i]));
  // Not listed yet by the RPC node the crank asks (behind the one that served the pool account).
  const hidden = new Set([signature]);
  const calls = [], reads = [];
  const connection = pagedConnection(s.chain.connection, calls, { timeOf, hidden, reads, sent: s.chain.sent });

  const first = await s.run({ connection, withdrawSearch: { pageSize: 10 } });
  assert.equal(first.failed, 1);
  assert.match(s.lines.at(-1).reason, /cannot find \(not in the pool's history since the curve finished \(5 transactions read\); the search starts again from the newest\)/);
  assert.equal(calls.length, 1);
  assert.equal(reads.length, 5, "nothing from before the curve finished is read");
  assert.equal(s.ledger.searches.has(s.pool), false, "a walk that ended is cleared");

  // Listed now. A dry run reads, finds nothing within its budget, and saves nothing.
  hidden.clear();
  reads.length = 0;
  const dry = await s.run({ connection, dryRun: true, withdrawSearch: { pageSize: 10, maxTransactions: 2 } });
  assert.equal(dry.failed, 0);
  assert.equal(reads.length, 2);
  assert.match(s.lines.at(-1).note, /dry run: search progress not saved/);
  assert.equal(s.ledger.searches.has(s.pool), false);
  assert.equal((await s.ledger.airdropState(s.pool)).withdrawn, null);

  // The next pass starts from the newest again and finds it.
  calls.length = 0;
  reads.length = 0;
  assert.equal((await s.run({ connection, withdrawSearch: { pageSize: 10 } })).failed, 0);
  assert.equal(calls[0].before, undefined);
  assert.deepEqual(reads, [...s.chain.sent.slice(31, 36).map((t) => t.signature).reverse(), signature]);
  const state = await s.ledger.airdropState(s.pool);
  assert.equal(state.withdrawn, LEFTOVER);
  assert.equal(state.withdrawSignature, signature);
  assert.ok(state.done);
});

test("the crank's withdrawal search table: created if missing, one row per pool, saved by upsert and cleared by delete", async () => {
  const queries = [];
  let row = null;
  const db = {
    query: async (sql, args) => {
      queries.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
      return { rows: /^select/.test(sql) && row ? [row] : [] };
    },
  };
  await migrateCrank(db);
  assert.match(queries[0].sql, /create table if not exists airdrop_withdraw_search \( pool text primary key, before_signature text,/);
  assert.doesNotMatch(queries[0].sql, /\bdrop\b|\bdelete\b|\bupdate\b/i);
  const ledger = crankLedger({ ready: async () => true }, db);
  assert.equal(await ledger.airdropSearch("P"), null);
  assert.deepEqual(queries.at(-1).args, ["P"]);
  row = { before_signature: "S", read: 80, unreadable: 1 };
  assert.deepEqual(await ledger.airdropSearch("P"), { before: "S", read: 80, unreadable: 1 });
  await ledger.airdropSaveSearch("P", { before: "S2", read: 120, unreadable: 1 });
  assert.match(queries.at(-1).sql, /^insert into airdrop_withdraw_search .* on conflict \(pool\) do update set before_signature = excluded.before_signature, read = excluded.read, unreadable = excluded.unreadable/);
  assert.deepEqual(queries.at(-1).args, ["P", "S2", 120, 1]);
  await ledger.airdropSaveSearch("P", null);
  assert.equal(queries.at(-1).sql, "delete from airdrop_withdraw_search where pool = $1");
  assert.deepEqual(queries.at(-1).args, ["P"]);
});

test("a row whose account was closed or re-owned before its deferred send is paid to the holder's associated account", async () => {
  const holders = many(4);
  const s = setup({ holders, lost: new Set([1]) });
  const ata = (i) => getAssociatedTokenAddressSync(s.m.baseMint, holders[i].owner, false, TOKEN_PROGRAM_ID);
  await s.run(); // withdrawn and snapshotted; the batch was dropped
  // Holder 0 opens its associated account after the snapshot.
  s.chain.put(ata(0), tokenAccount({ owner: holders[0].owner, mint: s.m.baseMint, amount: 5n, program: TOKEN_PROGRAM_ID }));
  const rows = await s.ledger.airdropRows(s.pool);
  assert.ok(rows.every((r) => r.status === "pending"));
  assert.ok(rows.find((r) => r.owner.equals(holders[0].owner)).recipient.equals(s.accounts[0]));
  // Before the resend: holder 0 closes its snapshot account, holder 1 hands its account to someone else.
  s.chain.accounts.delete(s.accounts[0].toBase58());
  const taker = key();
  s.chain.put(s.accounts[1], tokenAccount({ owner: taker, mint: s.m.baseMint, amount: holders[1].amount, program: TOKEN_PROGRAM_ID }));
  s.chain.setHeight(2_000);
  const sends = s.chain.sent.length;
  await s.run();
  assert.ok((await s.ledger.airdropRows(s.pool)).every((r) => r.status === "sent"));
  assert.ok((await s.ledger.airdropState(s.pool)).done);
  const each = LEFTOVER / 4n;
  assert.equal(s.balance(ata(0)), 5n + each);
  assert.equal(s.balance(ata(1)), each);
  assert.equal(s.balance(s.accounts[1]), holders[1].amount); // the account's new owner gets nothing
  for (const i of [2, 3]) assert.equal(s.balance(s.accounts[i]), holders[i].amount + each);
  assert.equal(s.balance(s.crankBase), LEFTOVER - each * 4n);
  // One transaction: holder 1's associated account created (the crank pays), then the four transfers.
  const [tx] = s.chain.sent.slice(sends);
  assert.equal(s.chain.sent.length, sends + 1);
  const creates = tx.tx.instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.equal(creates.length, 1);
  assert.ok(creates[0].keys[0].pubkey.equals(s.crank) && creates[0].keys[1].pubkey.equals(ata(1)));
  assert.ok(tx.tx.instructions.filter((ix) => ix.programId.equals(TOKEN_PROGRAM_ID)).every((ix) => ix.data.readBigUInt64LE(1) === each));
  assert.equal(s.lines.filter((l) => l.result === "redirected").length, 2);
});

test("a row whose account closed and whose owner is off curve stays unpaid and reserved", async () => {
  const s = setup({ holders: many(3), lost: new Set([1]) });
  await s.run();
  // A row for a program-owned address (the holder rules never snapshot one; this is the ledger's worst case).
  const [row] = s.ledger.drops.get(s.pool).values();
  row.owner = pda();
  s.chain.accounts.delete(row.recipient.toBase58());
  s.chain.setHeight(2_000);
  const r = await s.run();
  assert.equal(r.failed, 0);
  const rows = await s.ledger.airdropRows(s.pool);
  assert.deepEqual(rows.map((x) => x.status).sort(), ["sent", "sent", "unpaid"]);
  assert.equal((await s.ledger.airdropState(s.pool)).done, false);
  assert.ok(s.lines.some((l) => l.result === "unpaid" && /off curve/.test(l.reason)));
  // Its amount stays in the crank's account, reserved for it.
  assert.equal(s.balance(s.crankBase), LEFTOVER - (LEFTOVER / 3n) * 2n);
  assert.equal((await s.ledger.airdropReserved(s.pool)).amount, LEFTOVER - (LEFTOVER / 3n) * 2n);
});
