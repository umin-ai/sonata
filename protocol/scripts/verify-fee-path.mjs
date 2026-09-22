// SPDX-License-Identifier: GPL-3.0-or-later
// Exercises the full fee path on a per-launch pool: a small buy through the
// Meteora DBC curve, then claim (CPI into DBC signed by the vault PDA),
// distribute (50/50) and a creator withdrawal of part of the retained share.
// Every step is checked against on-chain state read back afterwards.
//
// Usage: node scripts/verify-fee-path.mjs [proof.json] [out.json]
// The proof file is the output of verify-configurable-launch.mjs. The buy is
// kept far below the graduation threshold so the pool stays on its curve.
import { readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
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
  getAccount,
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  deriveDbcTokenVaultAddress,
  swapQuote,
  getCurrentPoint,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import assert from "node:assert/strict";

const proofPath = process.argv[2] ?? "artifacts/configurable-launch-proof.json";
const out = process.argv[3] ?? "artifacts/fee-path-proof.json";
const BUY_ATOMS = 5_000_000n; // 0.05 mSPY at 8 decimals
const DBC = JSON.parse(readFileSync("../cash-access/lib/treasury/dbc-addresses.json"));

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))));
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json"));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const dbc = new DynamicBondingCurveClient(conn, "confirmed");

const proof = JSON.parse(readFileSync(proofPath));
const pk = (s) => new PublicKey(s);
const pool = pk(proof.pool), config = pk(proof.config), treasury = pk(proof.treasury);
const baseMint = pk(proof.baseMint), quoteMint = pk(proof.quoteMint), vault = pk(proof.vault);
const t0 = await program.account.treasury.fetch(treasury);
assert.ok(t0.creator.equals(admin.publicKey), "This key did not create the pool.");
const payoutOwner = t0.payoutOwner;
const treasuryBase = getAssociatedTokenAddressSync(baseMint, treasury, true, TOKEN_PROGRAM_ID);
const treasuryQuote = getAssociatedTokenAddressSync(quoteMint, treasury, true, TOKEN_2022_PROGRAM_ID);
const payoutQuote = getAssociatedTokenAddressSync(quoteMint, payoutOwner, true, TOKEN_2022_PROGRAM_ID);
const creatorQuote = getAssociatedTokenAddressSync(quoteMint, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
const balance = async (a) => BigInt((await getAccount(conn, a, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);

const traces = [];
const send = async (label, tx) => {
  const signature = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
  traces.push({ label, signature });
  console.log(`${label}: ${signature}`);
};

// 1. Buy through the curve, quoting first so the fee is known in advance.
// getPool wraps the account as { poolState }; swapQuote takes the wrapper.
const poolState = async () => (await dbc.state.getPool(pool)).poolState;
const [wrappedPool, poolConfig] = await Promise.all([dbc.state.getPool(pool), dbc.state.getPoolConfig(config)]);
const virtualPool = wrappedPool.poolState;
assert.equal(virtualPool.isMigrated, 0, "Pool has migrated; this check targets the curve.");
const quote = swapQuote(
  wrappedPool, poolConfig, false, new BN(BUY_ATOMS.toString()), 100, false,
  await getCurrentPoint(conn, poolConfig.activationType), false,
);
const partnerFee = BigInt(quote.tradingFee.toString());
const protocolFee = BigInt(quote.protocolFee.toString());
const totalFee = partnerFee + protocolFee;
console.log(`Quote: ${BUY_ATOMS} in, fee ${totalFee} (partner ${partnerFee}, Meteora protocol ${protocolFee})`);
const partnerBefore = BigInt(virtualPool.partnerQuoteFee.toString());
const swapTx = await dbc.pool.swap({
  owner: admin.publicKey,
  pool,
  amountIn: new BN(BUY_ATOMS.toString()),
  minimumAmountOut: quote.minimumAmountOut,
  swapBaseForQuote: false,
  referralTokenAccount: null,
});
await send("Buy 0.05 mSPY through the 3% curve", swapTx);
const partnerAfter = BigInt((await poolState()).partnerQuoteFee.toString());

// 2. Claim: the treasury program signs as the vault PDA.
const tBeforeClaim = await program.account.treasury.fetch(treasury);
const custodyBefore = await balance(treasuryQuote);
const claimTx = new Transaction().add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  await program.methods.claim().accounts({
    vault, treasury,
    poolAuthority: pk(DBC.poolAuthority),
    config, pool, treasuryBase, treasuryQuote,
    baseVault: deriveDbcTokenVaultAddress(pool, baseMint),
    quoteVault: deriveDbcTokenVaultAddress(pool, quoteMint),
    baseMint, quoteMint,
    tokenBaseProgram: TOKEN_PROGRAM_ID,
    tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
    dbcEventAuthority: pk(DBC.eventAuthority),
    dbcProgram: pk(DBC.program),
  }).instruction(),
);
await send("Claim partner fees into treasury custody", claimTx);
const tAfterClaim = await program.account.treasury.fetch(treasury);
const claimed = BigInt(tAfterClaim.totalClaimed.sub(tBeforeClaim.totalClaimed).toString());
const custodyAfterClaim = await balance(treasuryQuote);

// 3. Distribute: 50% to the fixed payout owner, 50% retained.
const payoutBefore = await balance(payoutQuote);
await send("Allocate 50% payout / 50% retained", new Transaction().add(
  await program.methods.distribute().accounts({
    treasury, treasuryQuote, payoutQuote, quoteMint, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction(),
));
const tAfterDist = await program.account.treasury.fetch(treasury);
const paid = BigInt(tAfterDist.totalDistributed.sub(tAfterClaim.totalDistributed).toString());
const retained = BigInt(tAfterDist.totalRetained.sub(tAfterClaim.totalRetained).toString());
const payoutAfter = await balance(payoutQuote);

// 4. Creator withdraws half of what was just retained.
const withdraw = retained / 2n;
const creatorBefore = await balance(creatorQuote);
await send("Creator withdraws half of the retained share", new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, creatorQuote, admin.publicKey, quoteMint, TOKEN_2022_PROGRAM_ID),
  await program.methods.withdrawRetained(new BN(withdraw.toString())).accounts({
    treasury, creator: admin.publicKey, treasuryQuote, creatorQuote, quoteMint, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
  }).instruction(),
));
const tEnd = await program.account.treasury.fetch(treasury);
const creatorAfter = await balance(creatorQuote);

// Fee rate: DBC computes it from the config's 3% numerator; allow 1 atom rounding.
const expectedTotal = (BUY_ATOMS * 300n) / 10_000n;
const checks = {
  feeIsThreePercentOfInput: totalFee >= expectedTotal - 1n && totalFee <= expectedTotal + 1n,
  meteoraTakesTwentyPercent: protocolFee * 5n >= totalFee - 5n && protocolFee * 5n <= totalFee + 5n,
  partnerFeeAccruedOnPool: partnerAfter - partnerBefore === partnerFee,
  claimMatchesAccruedPartnerFee: claimed === partnerAfter,
  custodyReceivedClaim: custodyAfterClaim - custodyBefore === claimed,
  splitIsFiftyFifty: paid === claimed / 2n && paid + retained === claimed,
  payoutOwnerReceivedHalf: payoutAfter - payoutBefore === paid,
  creatorReceivedWithdrawal: creatorAfter - creatorBefore === withdraw,
  treasuryLedgerRecordsWithdrawal:
    BigInt(tEnd.totalWithdrawn.sub(tAfterDist.totalWithdrawn).toString()) === withdraw,
};
console.log(checks);
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Verification failed: ${name}`);

writeFileSync(out, JSON.stringify({
  network: "solana:devnet",
  createdAt: new Date().toISOString(),
  intent: "Full fee path on a per-launch 3% pool: buy, claim via vault-PDA CPI, 50/50 allocation, creator withdrawal.",
  pool: pool.toBase58(), config: config.toBase58(), treasury: treasury.toBase58(),
  amounts: {
    buyAtoms: BUY_ATOMS.toString(), totalFee: totalFee.toString(), meteoraProtocolFee: protocolFee.toString(),
    partnerFee: partnerFee.toString(), claimed: claimed.toString(), paidOut: paid.toString(),
    retained: retained.toString(), withdrawn: withdraw.toString(),
  },
  checks, traces,
}, null, 2));
console.log(`\nAll checks passed. ${out}`);
