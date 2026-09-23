// SPDX-License-Identifier: GPL-3.0-or-later
// Proves the Stock Floor end to end on Devnet, on a launch whose treasury is in
// Floor mode (create one with SONATA_MODE=floor, see HANDOFF.md):
//   1. a holder who is not the creator buys on the curve;
//   2. anyone claims the partner fee into the treasury and splits it 50/50;
//   3. the holder burns half their tokens and receives exactly
//      floor * burned / supply of the quote stock;
//   4. the creator tries to withdraw the floor and the program refuses
//      (sent on-chain, so the refusal is a public failed transaction).
// Usage: node scripts/verify-stock-floor.mjs <launch-proof.json> [out.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getMint,
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  deriveDbcTokenVaultAddress,
  swapQuote,
  getCurrentPoint,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import assert from "node:assert/strict";

const [proofPath, out = "artifacts/stock-floor-proof.json"] = process.argv.slice(2);
assert.ok(proofPath, "Pass the launch proof JSON of a Floor-mode launch.");
const BUY_ATOMS = 200_000_000n; // 2 quote tokens at 8 decimals
const DBC = JSON.parse(readFileSync("../cash-access/lib/treasury/dbc-addresses.json"));

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p))));
const admin = load(".keys/deployer.json");
// A separate holder, so the proof shows a non-creator redeeming. Kept for re-runs.
const holderPath = ".keys/floor-holder.json";
if (!existsSync(holderPath)) writeFileSync(holderPath, JSON.stringify([...Keypair.generate().secretKey]));
const holder = load(holderPath);
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json"));
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));
const dbc = new DynamicBondingCurveClient(conn, "confirmed");

const proof = JSON.parse(readFileSync(proofPath));
const pk = (s) => new PublicKey(s);
const pool = pk(proof.pool), config = pk(proof.config), treasury = pk(proof.treasury);
const baseMint = pk(proof.baseMint), quoteMint = pk(proof.quoteMint), vault = pk(proof.vault);
const t0 = await program.account.treasury.fetch(treasury);
assert.deepEqual(Object.keys(t0.mode), ["floor"], "This treasury is not in Floor mode.");
assert.ok(t0.creator.equals(admin.publicKey), "This key did not create the pool.");
assert.ok(!holder.publicKey.equals(admin.publicKey));

const quoteAta = (owner) => getAssociatedTokenAddressSync(quoteMint, owner, true, TOKEN_2022_PROGRAM_ID);
const baseAta = (owner) => getAssociatedTokenAddressSync(baseMint, owner, true, TOKEN_PROGRAM_ID);
const treasuryQuote = quoteAta(treasury), treasuryBase = baseAta(treasury);
const payoutQuote = quoteAta(t0.payoutOwner), creatorQuote = quoteAta(admin.publicKey);
const holderQuote = quoteAta(holder.publicKey), holderBase = baseAta(holder.publicKey);
const quoteBal = async (a) => BigInt((await getAccount(conn, a, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);
const baseBal = async (a) => BigInt((await getAccount(conn, a, "confirmed", TOKEN_PROGRAM_ID)).amount);
const supply = async () => BigInt((await getMint(conn, baseMint, "confirmed", TOKEN_PROGRAM_ID)).supply);
const { decimals: quoteDecimals } = await getMint(conn, quoteMint, "confirmed", TOKEN_2022_PROGRAM_ID);

const traces = [];
const send = async (label, tx, signers = [admin]) => {
  const signature = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  traces.push({ label, signature });
  console.log(`${label}: ${signature}`);
  return signature;
};

// Fund the holder with Devnet SOL for fees and the quote token to buy with.
await send("Fund the holder with Devnet SOL and 2 test quote tokens", new Transaction().add(
  SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: holder.publicKey, lamports: 50_000_000 }),
  createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, holderQuote, holder.publicKey, quoteMint, TOKEN_2022_PROGRAM_ID),
  createTransferCheckedInstruction(creatorQuote, quoteMint, holderQuote, admin.publicKey, BUY_ATOMS, quoteDecimals, [], TOKEN_2022_PROGRAM_ID),
));

// 1. The holder buys on the curve.
const [wrapped, poolConfig] = await Promise.all([dbc.state.getPool(pool), dbc.state.getPoolConfig(config)]);
assert.equal(wrapped.poolState.isMigrated, 0, "Pool has migrated; the floor grows on the curve.");
const quote = swapQuote(wrapped, poolConfig, false, new BN(BUY_ATOMS.toString()), 100, false,
  await getCurrentPoint(conn, poolConfig.activationType), false);
const swapTx = await dbc.pool.swap({
  owner: holder.publicKey, pool, amountIn: new BN(BUY_ATOMS.toString()),
  minimumAmountOut: quote.minimumAmountOut, swapBaseForQuote: false, referralTokenAccount: null,
});
await send("Holder buys with 2 quote tokens on the curve", swapTx, [holder]);
const bought = await baseBal(holderBase);

// 2. Anyone claims and splits; the retained half becomes the floor.
const tBefore = await program.account.treasury.fetch(treasury);
await send("Claim partner fees into the treasury", new Transaction().add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  await program.methods.claim().accounts({
    vault, treasury, poolAuthority: pk(DBC.poolAuthority), config, pool, treasuryBase, treasuryQuote,
    baseVault: deriveDbcTokenVaultAddress(pool, baseMint), quoteVault: deriveDbcTokenVaultAddress(pool, quoteMint),
    baseMint, quoteMint, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
    dbcEventAuthority: pk(DBC.eventAuthority), dbcProgram: pk(DBC.program),
  }).instruction(),
));
await send("Split 50% to the payout wallet, 50% to the Stock Floor", new Transaction().add(
  await program.methods.distribute().accounts({
    treasury, treasuryQuote, payoutQuote, quoteMint, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction(),
));
const tSplit = await program.account.treasury.fetch(treasury);
const claimed = BigInt(tSplit.totalClaimed.sub(tBefore.totalClaimed).toString());
const paid = BigInt(tSplit.totalDistributed.sub(tBefore.totalDistributed).toString());
const floor = BigInt(tSplit.totalRetained.sub(tSplit.totalWithdrawn).toString());

// 3. The holder burns half their tokens for their share of the floor.
const burn = bought / 2n;
const supplyBefore = await supply();
const expected = (floor * burn) / supplyBefore;
const holderQuoteBefore = await quoteBal(holderQuote);
await send("Holder burns half their tokens for their share of the floor", new Transaction().add(
  await program.methods.redeem(new BN(burn.toString())).accounts({
    treasury, holder: holder.publicKey, holderBase, holderQuote, treasuryQuote, baseMint, quoteMint,
    tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction(),
), [holder]);
const tRedeem = await program.account.treasury.fetch(treasury);
const received = (await quoteBal(holderQuote)) - holderQuoteBefore;
const supplyAfter = await supply();
const floorAfter = BigInt(tRedeem.totalRetained.sub(tRedeem.totalWithdrawn).toString());

// 4. The creator tries to take the floor. Sent without preflight so the refusal
// is recorded on-chain.
const attempt = new Transaction().add(
  await program.methods.withdrawRetained(new BN(1)).accounts({
    treasury, creator: admin.publicKey, treasuryQuote, creatorQuote, quoteMint, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction(),
);
attempt.feePayer = admin.publicKey;
attempt.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
attempt.sign(admin);
const refusedSig = await conn.sendRawTransaction(attempt.serialize(), { skipPreflight: true });
await conn.confirmTransaction(refusedSig, "confirmed");
const refused = await conn.getTransaction(refusedSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
traces.push({ label: "Creator tries to withdraw the floor (refused)", signature: refusedSig, expectedFailure: true });
console.log(`Creator withdrawal attempt: ${refusedSig}`);
const tEnd = await program.account.treasury.fetch(treasury);

const checks = {
  treasuryIsFloorMode: Object.keys(tEnd.mode)[0] === "floor",
  holderIsNotCreator: !holder.publicKey.equals(tEnd.creator),
  splitIsFiftyFifty: paid === claimed / 2n && claimed - paid === BigInt(tSplit.totalRetained.sub(tBefore.totalRetained).toString()),
  floorGrewFromTheTrade: floor > BigInt(tBefore.totalRetained.sub(tBefore.totalWithdrawn).toString()),
  payoutIsExactShare: received === expected && expected > 0n,
  burnReducedSupply: supplyBefore - supplyAfter === burn,
  holderTokensBurned: (await baseBal(holderBase)) === bought - burn,
  floorPerTokenNotReduced: floorAfter * supplyBefore >= floor * supplyAfter,
  ledgerRecordsRedemption: BigInt(tRedeem.totalWithdrawn.sub(tSplit.totalWithdrawn).toString()) === received,
  creatorWithdrawalRefused: !!refused?.meta?.err && refused.meta.logMessages.some((l) => /FloorLocked/.test(l)),
  refusalMovedNothing: tEnd.totalWithdrawn.eq(tRedeem.totalWithdrawn),
};
console.log(checks);
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Verification failed: ${name}`);

writeFileSync(out, JSON.stringify({
  network: "solana:devnet",
  createdAt: new Date().toISOString(),
  intent: "Stock Floor: a non-creator holder buys, fees are split 50/50, the holder burns tokens for an exact share of the floor, and the creator cannot withdraw it.",
  launchProof: proofPath,
  pool: pool.toBase58(), treasury: treasury.toBase58(), baseMint: baseMint.toBase58(), quoteMint: quoteMint.toBase58(),
  holder: holder.publicKey.toBase58(), creator: admin.publicKey.toBase58(),
  amounts: {
    buyAtoms: BUY_ATOMS.toString(), tokensBought: bought.toString(), claimed: claimed.toString(),
    paidOut: paid.toString(), floorBeforeRedeem: floor.toString(), burned: burn.toString(),
    supplyBefore: supplyBefore.toString(), supplyAfter: supplyAfter.toString(),
    expectedPayout: expected.toString(), received: received.toString(), floorAfterRedeem: floorAfter.toString(),
  },
  refusalLog: refused?.meta?.logMessages?.find((l) => /FloorLocked/.test(l)),
  checks, traces,
}, null, 2));
console.log(`\nAll checks passed. ${out}`);
