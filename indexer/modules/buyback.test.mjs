import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CP_AMM_PROGRAM_ID } from "@meteora-ag/cp-amm-sdk";
import {
  BUYBACK_SLIPPAGE_BPS,
  buybackSteps,
  dammVenue,
  dbcVenue,
  executeBuyback,
  largestQuotable,
  receivedFrom,
  runBuyback,
} from "./buyback.mjs";
import { DBC_PROGRAM } from "./common.mjs";
import { readDammPool, readDbc } from "./meteora.mjs";
import { MAX_TX_BYTES, txBytes } from "./payout.mjs";
import { dammPoolAccount, dbcAccounts, fakeChain, memLedger, moduleContext, quotedOut, rewardMarket, sonataCurve, tokenAccount } from "./testkit.mjs";

const baseAtaOf = (m, owner) => getAssociatedTokenAddressSync(m.baseMint, owner, false, TOKEN_PROGRAM_ID);

// A buyback market on a Sonata curve (or graduated), its crank key funded with what it is owed.
async function market({ owed = 100_000_000n, migrated = false, progress, quoteReserve = 0n, leftover = 0n, swapOut, landOut, dryRun = false } = {}) {
  const authority = Keypair.generate();
  const chain = fakeChain({ swapOut, landOut });
  const m = rewardMarket(chain, authority.publicKey, { owed });
  const dbc = dbcAccounts(m, { migrated, progress, quoteReserve });
  chain.put(m.pool, dbc.poolInfo);
  chain.put(m.config, dbc.configInfo);
  const damm = dammPoolAccount(m, { migrationFeeOption: dbc.config.migrationFeeOption });
  if (migrated) chain.put(damm.address, damm.info);
  if (leftover) chain.put(baseAtaOf(m, authority.publicKey), tokenAccount({ owner: authority.publicKey, mint: m.baseMint, amount: leftover, program: TOKEN_PROGRAM_ID }));
  const ledger = memLedger();
  const ctx = await moduleContext({ chain, m, authority, owed, ledger, dryRun, model: { feeModel: "buyback" } });
  return { authority, chain, m, dbc, damm, ledger, ctx, crankBase: baseAtaOf(m, authority.publicKey) };
}

test("before graduation the buy is quoted by the DBC SDK with 2% slippage and swaps on the market's pool", async () => {
  const { m, dbc, chain, authority, crankBase } = await market();
  const state = readDbc(m, chain.accounts.get(m.pool.toBase58()), chain.accounts.get(m.config.toBase58()));
  const venue = dbcVenue({ m, dbc: state, crank: authority.publicKey, crankBase, point: 1_900_000_000 });
  const q = venue.quote(100_000_000n);
  assert.ok(q.expectedOut > 0n);
  assert.equal(q.minOut, (q.expectedOut * BigInt(10_000 - BUYBACK_SLIPPAGE_BPS)) / 10_000n);
  assert.equal(BUYBACK_SLIPPAGE_BPS, 200);
  const ix = await venue.swapIx(100_000_000n, q.minOut);
  assert.ok(ix.programId.equals(DBC_PROGRAM));
  // DBC swap: pool authority, config, pool, input, output, base vault, quote vault, base mint, quote mint, payer, programs...
  const k = ix.keys.map((x) => x.pubkey);
  assert.ok(k[1].equals(m.config) && k[2].equals(m.pool));
  assert.ok(k[3].equals(m.payoutQuote), "spends from the crank's quote account");
  assert.ok(k[4].equals(crankBase), "into the crank's base account");
  assert.ok(k[9].equals(authority.publicKey) && ix.keys[9].isSigner);
  assert.ok(k[10].equals(TOKEN_PROGRAM_ID) && k[11].equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(ix.data.readBigUInt64LE(8), 100_000_000n);
  assert.equal(ix.data.readBigUInt64LE(16), q.minOut);
  assert.ok(dbc.curve.migrationQuoteThreshold.gtn(0));
});

test("after graduation the buy is quoted by the cp-amm SDK with 2% slippage and swaps on the graduated DAMM v2 pool", async () => {
  const { m, damm, chain, authority, crankBase } = await market({ migrated: true });
  const pool = readDammPool(m, chain.accounts.get(damm.address.toBase58()));
  const venue = dammVenue({ m, dammPool: damm.address, pool, crank: authority.publicKey, crankBase, point: 1_900_000_000 });
  const q = venue.quote(100_000_000n);
  assert.ok(q.expectedOut > 0n);
  assert.ok(q.minOut < q.expectedOut && q.minOut >= (q.expectedOut * 9_799n) / 10_000n);
  const ix = await venue.swapIx(100_000_000n, q.minOut);
  assert.ok(ix.programId.equals(CP_AMM_PROGRAM_ID));
  const k = ix.keys.map((x) => x.pubkey);
  assert.ok(k[1].equals(damm.address) && k[2].equals(m.payoutQuote) && k[3].equals(crankBase));
  assert.ok(k[6].equals(m.baseMint) && k[7].equals(m.quoteMint) && k[8].equals(authority.publicKey));
  assert.equal(ix.data.readBigUInt64LE(8), 100_000_000n);
  assert.equal(ix.data.readBigUInt64LE(16), q.minOut);
});

test("the buy never spends more than owed; near the curve's end it stops short of the migration price", async () => {
  const { m, chain, authority, crankBase, dbc } = await market();
  const state = readDbc(m, chain.accounts.get(m.pool.toBase58()), chain.accounts.get(m.config.toBase58()));
  const venue = dbcVenue({ m, dbc: state, crank: authority.publicKey, crankBase, point: 1_900_000_000 });
  const full = largestQuotable(venue, 100_000_000n);
  assert.equal(full.amountIn, 100_000_000n);
  assert.equal(full.capped, false);
  // More than the whole curve takes: capped below what the SDK can still quote.
  const threshold = BigInt(dbc.curve.migrationQuoteThreshold.toString());
  const capped = largestQuotable(venue, threshold * 10n);
  assert.equal(capped.capped, true);
  assert.ok(capped.amountIn < threshold * 10n);
  assert.throws(() => venue.quote(threshold * 10n), /Insufficient Liquidity/);
  assert.ok(venue.quote(capped.amountIn).minOut > 0n);
  for (const max of [1n, 12_345n, 10n ** 8n, threshold, threshold * 3n]) {
    const pick = largestQuotable(venue, max);
    assert.ok(!pick || pick.amountIn <= max);
  }
  assert.equal(largestQuotable(venue, 0n), null);
  // Other quote errors are not mistaken for the curve's end.
  assert.throws(() => largestQuotable({ quote: () => { throw Error("boom"); }, capacityError: () => false }, 5n), /boom/);
});

test("received is read from the simulated base account; the burn takes exactly that", () => {
  // The probe burned before + minimum out: what is left over is received - minimum out.
  assert.equal(receivedFrom({ before: 0n, after: 40n, burned: 960n }), 1_000n);
  assert.equal(receivedFrom({ before: 5n, after: 40n, burned: 965n }), 1_000n);
  assert.equal(receivedFrom({ before: 7n, after: 1_007n, burned: 0n }), 1_000n);
});

test("a buyback swaps what is owed and burns every token bought in the same transaction", async () => {
  const { chain, m, ctx, ledger, crankBase } = await market();
  assert.deepEqual(await runBuyback(ctx), {});
  const [bought] = chain.delivered;
  assert.ok(bought > 0n);
  const [sent] = chain.sent;
  assert.equal(chain.sent.length, 1);
  assert.ok(sent.bytes <= MAX_TX_BYTES, `${sent.bytes} bytes`);
  // compute budget, create the crank's base account, swap, burn.
  assert.deepEqual(sent.tx.instructions.map((ix) => ix.programId.toBase58().slice(0, 6)), ["Comput", "AToken", "dbcij3", "Tokenk"]);
  const burn = sent.tx.instructions[3];
  assert.equal(burn.data[0], 15); // burn_checked
  assert.equal(burn.data.readBigUInt64LE(1), bought);
  assert.equal(burn.data[9], 6);
  assert.ok(burn.keys[0].pubkey.equals(crankBase) && burn.keys[1].pubkey.equals(m.baseMint));
  // Spent exactly owed; everything bought burned; nothing left behind.
  assert.equal(chain.balance(m.payoutQuote), 0n);
  assert.equal(chain.balance(crankBase), 0n);
  assert.deepEqual(ledger.payouts.map((r) => [r.module, r.amount, r.recipients, r.detail.spent, r.detail.received, r.detail.burned, r.detail.venue]), [
    ["buyback", 100_000_000n, 0, 100_000_000n, bought, bought, "dbc"],
  ]);
  assert.equal(ctx.result.paid, 100_000_000n);
  assert.equal(ctx.fund.owed, 0n);
  assert.equal(ctx.fields.burned, bought);
});

test("tokens left by an earlier buyback are burned with the next one", async () => {
  const { chain, ctx, ledger, crankBase } = await market({ leftover: 1_234n });
  await runBuyback(ctx);
  assert.equal(chain.balance(crankBase), 0n);
  const [row] = ledger.payouts;
  assert.equal(row.detail.received, chain.delivered[0]);
  assert.equal(row.detail.burned, chain.delivered[0] + 1_234n);
  assert.equal(row.detail.leftover, 1_234n);
  // No base account creation when one exists.
  assert.equal(chain.sent[0].tx.instructions.length, 3);
});

test("a better price at landing leaves a surplus, burned right after; a worse one fails the whole transaction", async () => {
  const better = await market({ landOut: (x, min) => quotedOut(x, min) + 77n });
  await runBuyback(better.ctx);
  const simulated = better.ledger.payouts[0].detail.received;
  assert.equal(better.chain.delivered[0], simulated + 77n);
  assert.equal(better.chain.sent.length, 2);
  assert.equal(better.chain.balance(better.crankBase), 0n);
  assert.deepEqual(better.ledger.payouts.map((r) => [r.amount, r.detail.burned]), [[100_000_000n, simulated], [0n, 77n]]);
  assert.equal(better.ctx.fields.burned, better.chain.delivered[0]);
  assert.equal(better.ctx.result.paid, 100_000_000n);

  // Worse, but above the 2% minimum: the burn of the simulated amount fails, so the swap does not happen either.
  const worse = await market({ landOut: (x, min) => quotedOut(x, min) - 1n });
  await assert.rejects(runBuyback(worse.ctx), /failed; the amount stays owed/);
  assert.equal(worse.chain.balance(worse.m.payoutQuote), 100_000_000n);
  assert.equal(worse.ledger.payouts.length + worse.ledger.pendingRows.size, 0);
  assert.equal(worse.ctx.fund.owed, 100_000_000n);
  assert.equal(worse.ctx.result.paid, 0n);
});

test("when swap and burn do not fit one transaction, the burn follows right after", async () => {
  const { chain, m, ctx, ledger, crankBase, authority } = await market({ swapOut: (x) => x * 4n });
  const burnBytes = 16; // burn_checked: program index, 3 account indexes and 10 bytes of data, with their lengths
  // A stand-in venue whose swap instruction is too large to share a transaction with the burn.
  const real = readDbc(m, chain.accounts.get(m.pool.toBase58()), chain.accounts.get(m.config.toBase58()));
  const venue = dbcVenue({ m, dbc: real, crank: authority.publicKey, crankBase, point: 1 });
  // Padded so the buy alone fits and one more burn does not.
  const plain = await buybackSteps({ m, venue, spend: 1n, minOut: 1n, crank: authority.publicKey, crankBase, feePayer: authority.publicKey, createBase: true });
  const pad = MAX_TX_BYTES - txBytes(plain.buy.map((s) => s.ix), authority.publicKey) - burnBytes + 4;
  const fat = {
    ...venue,
    swapIx: async (a, b) => {
      const ix = await venue.swapIx(a, b);
      return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.concat([ix.data, Buffer.alloc(pad)]) });
    },
  };
  const steps = await buybackSteps({ m, venue: fat, spend: 1n, minOut: 1n, crank: authority.publicKey, crankBase, feePayer: authority.publicKey, createBase: true });
  assert.equal(steps.together, false);
  assert.ok(txBytes(steps.buy.map((s) => s.ix), authority.publicKey) <= MAX_TX_BYTES);
  await executeBuyback(ctx, { venue: fat, spend: 100_000_000n, minOut: 390_000_000n, before: 0n, createBase: true, crankBase });
  assert.equal(chain.sent.length, 2);
  assert.ok(chain.sent.every((s) => s.bytes <= MAX_TX_BYTES));
  assert.equal(chain.balance(crankBase), 0n);
  assert.deepEqual(ledger.payouts.map((r) => [r.amount, r.detail.burned]), [[100_000_000n, 0n], [0n, 400_000_000n]]);
});

test("a buyback never spends more than owed or held", async () => {
  const { ctx, crankBase, chain, m, authority } = await market();
  const venue = dbcVenue({ m, dbc: readDbc(m, chain.accounts.get(m.pool.toBase58()), chain.accounts.get(m.config.toBase58())), crank: authority.publicKey, crankBase, point: 1 });
  await assert.rejects(executeBuyback(ctx, { venue, spend: 100_000_001n, minOut: 1n, before: 0n, createBase: true, crankBase }), /more than is owed or held/);
  ctx.fund.balance = 10n;
  await assert.rejects(executeBuyback(ctx, { venue, spend: 11n, minOut: 1n, before: 0n, createBase: true, crankBase }), /more than is owed or held/);
  assert.equal(chain.simulated.length, 0);
});

test("after graduation the buyback swaps on DAMM v2; a complete curve or a pool still migrating waits", async () => {
  const graduated = await market({ migrated: true });
  await runBuyback(graduated.ctx);
  assert.equal(graduated.ctx.fields.venue, "damm");
  assert.ok(graduated.chain.sent[0].tx.instructions.some((ix) => ix.programId.equals(CP_AMM_PROGRAM_ID)));
  assert.equal(graduated.ledger.payouts[0].detail.venue, "damm");
  assert.equal(graduated.chain.balance(graduated.crankBase), 0n);

  const threshold = BigInt(sonataThreshold());
  const complete = await market({ quoteReserve: threshold });
  assert.match((await runBuyback(complete.ctx)).skip, /curve complete/);
  const migrating = await market({ migrated: true, progress: 1 });
  assert.match((await runBuyback(migrating.ctx)).skip, /graduating/);
  assert.equal(complete.chain.sent.length + migrating.chain.sent.length, 0);
});

test("a dry run simulates the buyback and sends nothing", async () => {
  const { chain, ctx, ledger } = await market({ dryRun: true });
  assert.deepEqual(await runBuyback(ctx), { note: "dry run" });
  assert.equal(chain.sent.length, 0);
  assert.equal(ledger.payouts.length + ledger.pendingRows.size, 0);
  assert.equal(ctx.result.simulated, 1);
  assert.ok(ctx.lines.some((l) => l.tag === "reward" && l.result === "simulated" && l.model === "buyback"));
});

function sonataThreshold() {
  return sonataCurve().migrationQuoteThreshold.toString();
}
