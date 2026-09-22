// SPDX-License-Identifier: GPL-3.0-or-later
// Buys a small amount on a graduated DAMM v2 pool and checks that the trader
// received at least the quoted minimum and that the pool's quote vault grew by
// exactly the input. Shows the graduated pool trades after migration.
//
// Usage: node scripts/verify-graduated-trade.mjs [graduation-proof.json] [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { CpAmm, SwapMode } from "@meteora-ag/cp-amm-sdk";
import assert from "node:assert/strict";

const proofPath = process.argv[2] ?? "artifacts/graduation-proof.json";
const out = process.argv[3] ?? "artifacts/graduated-trade-proof.json";
const IN_ATOMS = 1_000_000n; // 0.01 mSPY
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const trader = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))));
const proof = JSON.parse(readFileSync(proofPath));
const pool = new PublicKey(proof.dammPool);
const amm = new CpAmm(conn);
const s = await amm.fetchPoolState(pool);

const bal = async (mint, program) =>
  BigInt((await getAccount(conn, getAssociatedTokenAddressSync(mint, trader.publicKey, false, program), "confirmed", program)).amount);
const vaultBal = async () => BigInt((await getAccount(conn, s.tokenBVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount);

const time = await conn.getBlockTime(await conn.getSlot("confirmed"));
const q = amm.getQuote2({
  poolState: s, inputTokenMint: s.tokenBMint, amountIn: new BN(IN_ATOMS.toString()), slippage: 50,
  currentPoint: new BN(time), tokenADecimal: 6, tokenBDecimal: 8, hasReferral: false, swapMode: SwapMode.ExactIn,
});
assert.ok(q.minimumAmountOut?.gtn(0), "Trade too small for a protected output.");
const baseBefore = await bal(s.tokenAMint, TOKEN_PROGRAM_ID).catch(() => 0n);
const vaultBefore = await vaultBal();
const tx = await amm.swap({
  payer: trader.publicKey, pool,
  tokenAMint: s.tokenAMint, tokenBMint: s.tokenBMint, tokenAVault: s.tokenAVault, tokenBVault: s.tokenBVault,
  tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID,
  inputTokenMint: s.tokenBMint, outputTokenMint: s.tokenAMint,
  amountIn: new BN(IN_ATOMS.toString()), minimumAmountOut: q.minimumAmountOut,
  referralTokenAccount: null, poolState: s,
});
tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
const signature = await sendAndConfirmTransaction(conn, tx, [trader], { commitment: "confirmed" });
console.log(`Buy 0.01 mSPY on the graduated DAMM v2 pool: ${signature}`);
const received = (await bal(s.tokenAMint, TOKEN_PROGRAM_ID)) - baseBefore;
const vaultDelta = (await vaultBal()) - vaultBefore;

const checks = {
  receivedAtLeastQuotedMinimum: received >= BigInt(q.minimumAmountOut.toString()),
  // Fees are retained in the pool, so the vault grows by the full input.
  poolQuoteVaultGrewByInput: vaultDelta === IN_ATOMS,
};
console.log({ received: received.toString(), minimumOut: q.minimumAmountOut.toString(), vaultDelta: vaultDelta.toString(), checks });
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Verification failed: ${name}`);
writeFileSync(out, JSON.stringify({
  network: "solana:devnet", createdAt: new Date().toISOString(),
  intent: "Trade on the DAMM v2 pool produced by graduation.",
  dammPool: pool.toBase58(), amountIn: IN_ATOMS.toString(), received: received.toString(),
  minimumOut: q.minimumAmountOut.toString(), checks, traces: [{ label: "Buy on graduated pool", signature }],
}, null, 2));
console.log(`\nAll checks passed. ${out}`);
