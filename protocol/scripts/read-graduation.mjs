// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only. Verifies a completed DBC -> DAMM v2 graduation from its migration
// transaction and writes the evidence file. Needs no keys. Position NFT mints
// are recovered from the migration transaction's account list, so this works
// even when the run that migrated did not record them.
//
// Usage: node scripts/read-graduation.mjs <proof.json> <out.json> <fill> <claim> <allocate> <migrate>
import { readFileSync, writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  deriveDammV2PoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import assert from "node:assert/strict";

const [proofPath, out, fillSig, claimSig, allocSig, migrateSig] = process.argv.slice(2);
assert.ok(migrateSig, "Pass the proof file, output file and four signatures.");
const conn = new Connection("https://api.devnet.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: false });
const pause = () => new Promise((r) => setTimeout(r, 700)); // public RPC rate limits
const pk = (s) => new PublicKey(s);
const proof = JSON.parse(readFileSync(proofPath));
const dbc = new DynamicBondingCurveClient(conn, "confirmed");

// Every signature must be finalized without error.
const sigs = { fill: fillSig, claim: claimSig, allocate: allocSig, migrate: migrateSig };
const statuses = (await conn.getSignatureStatuses(Object.values(sigs), { searchTransactionHistory: true })).value;
const traces = Object.entries(sigs).map(([label, signature], i) => ({
  label, signature, status: statuses[i]?.confirmationStatus ?? "not found", err: statuses[i]?.err ?? null,
}));
await pause();

// Recover the position NFT mints from the migration instruction's accounts.
const tx = await conn.getTransaction(migrateSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
await pause();
const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys;
const ix = tx.transaction.message.compiledInstructions.find(
  (i) => keys[i.programIdIndex].toBase58() === "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
);
const order = DynamicBondingCurveIdl.instructions.find((i) => i.name === "migration_damm_v2").accounts.map((a) => a.name);
const at = (name) => keys[ix.accountKeyIndexes[order.indexOf(name)]];
const nftMints = [at("first_position_nft_mint"), at("second_position_nft_mint")];
assert.equal(at("virtual_pool").toBase58(), proof.pool, "Migration transaction is for a different pool.");

const poolState = (await dbc.state.getPool(pk(proof.pool))).poolState;
await pause();
const poolConfig = await dbc.state.getPoolConfig(pk(proof.config));
await pause();
const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[poolConfig.migrationFeeOption];
const dammPool = deriveDammV2PoolAddress(dammConfig, pk(proof.baseMint), pk(proof.quoteMint));
assert.equal(at("pool").toBase58(), dammPool.toBase58(), "DAMM v2 pool address mismatch.");

const cp = new CpAmm(conn);
const damm = await cp.fetchPoolState(dammPool);
await pause();
const positions = [];
// With a 0% creator liquidity share DBC creates only the partner position, so
// the second position account is expected not to exist.
const missingPositions = [];
for (const nft of nftMints) {
  const position = derivePositionAddress(nft);
  const exists = await conn.getAccountInfo(position);
  await pause();
  if (!exists) { missingPositions.push(position.toBase58()); continue; }
  const state = await cp.fetchPositionState(position);
  await pause();
  // The NFT account is a Token-2022 account; its owner field (bytes 32-64) is the position owner.
  const nftAccount = await conn.getAccountInfo(derivePositionNftAccount(nft));
  await pause();
  positions.push({
    nftMint: nft.toBase58(),
    position: position.toBase58(),
    owner: nftAccount ? new PublicKey(nftAccount.data.subarray(32, 64)).toBase58() : null,
    unlockedLiquidity: state.unlockedLiquidity.toString(),
    permanentLockedLiquidity: state.permanentLockedLiquidity.toString(),
    vestedLiquidity: state.vestedLiquidity.toString(),
  });
}
const vault = proof.vault;
const partner = positions.find((p) => p.owner === vault);

const checks = {
  allTransactionsFinalized: traces.every((t) => t.status === "finalized" && !t.err),
  curveCompleted: BigInt(poolState.quoteReserve.toString()) >= BigInt(poolConfig.migrationQuoteThreshold.toString()),
  dbcPoolMarkedMigrated: poolState.isMigrated === 1 && poolState.migrationProgress === 3,
  dammPoolExistsUnderDammV2: (await conn.getAccountInfo(dammPool))?.owner.equals(DAMM_V2_PROGRAM_ID) === true,
  dammPoolHoldsBothMints: damm.tokenAMint.toBase58() === proof.baseMint && damm.tokenBMint.toBase58() === proof.quoteMint,
  partnerPositionOwnedByVault: !!partner,
  partnerLiquidityFullyPermanentlyLocked: !!partner && partner.unlockedLiquidity === "0" && BigInt(partner.permanentLockedLiquidity) > 0n,
  onlyPartnerPositionCreated: positions.length === 1 && missingPositions.length === 1
    && poolConfig.creatorLiquidityPercentage === 0 && poolConfig.creatorPermanentLockedLiquidityPercentage === 0,
};
console.log({ dammPool: dammPool.toBase58(), positions, checks });
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Verification failed: ${name}`);

writeFileSync(out, JSON.stringify({
  network: "solana:devnet",
  createdAt: new Date().toISOString(),
  intent: "DBC -> DAMM v2 graduation of a per-launch Sonata pool, verified from chain.",
  dbcPool: proof.pool, config: proof.config, treasury: proof.treasury,
  migrationQuoteThreshold: poolConfig.migrationQuoteThreshold.toString(),
  quoteReserveAtCompletion: poolState.quoteReserve.toString(),
  dammConfig: dammConfig.toBase58(), dammPool: dammPool.toBase58(),
  dammPoolLiquidity: damm.liquidity.toString(),
  positions, missingPositions, checks, traces,
}, null, 2));
console.log(`\nAll checks passed. ${out}`);
