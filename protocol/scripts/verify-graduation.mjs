// SPDX-License-Identifier: GPL-3.0-or-later
// Graduates a Sonata per-launch DBC pool into Meteora DAMM v2 and verifies the
// result on-chain. Order matters and is enforced:
//   1. complete the curve with a PartialFill buy (fills to the migration price
//      and returns the unused input),
//   2. claim and allocate the partner fees while the pool is still a DBC pool,
//   3. migrate with the DAMM v2 config matching the pool's migration fee option.
// Each step is skipped if already done, so a failed run can be resumed.
//
// Refuses to touch the flagship ROOM/mSPY pool, whose curve must stay open for
// the live trading demo.
//
// Usage: node scripts/verify-graduation.mjs [proof.json] [out.json]
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
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  deriveDbcTokenVaultAddress,
  deriveDammV2PoolAddress,
  derivePositionAddress,
  getCurrentPoint,
  SwapMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import assert from "node:assert/strict";

const FLAGSHIP_POOL = "BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf";
// MigrationProgress in DBC: 0 PreBondingCurve, 1 PostBondingCurve, 2 LockedVesting, 3 CreatedPool.
const LOCKED_VESTING = 2, CREATED_POOL = 3;
const FILL_IN = 480_000_000n; // 4.8 mSPY offered; PartialFill uses only what the curve needs

const proofPath = process.argv[2] ?? "artifacts/configurable-launch-proof-post-upgrade.json";
const out = process.argv[3] ?? "artifacts/graduation-proof.json";
const DBC = JSON.parse(readFileSync("../cash-access/lib/treasury/dbc-addresses.json"));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))));
const program = new anchor.Program(
  JSON.parse(readFileSync("target/idl/stockroom_treasury.json")),
  new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }),
);
const dbc = new DynamicBondingCurveClient(conn, "confirmed");

const proof = JSON.parse(readFileSync(proofPath));
const pk = (s) => new PublicKey(s);
assert.notEqual(proof.pool, FLAGSHIP_POOL, "Refusing to graduate the flagship demo pool.");
const pool = pk(proof.pool), config = pk(proof.config), treasury = pk(proof.treasury);
const baseMint = pk(proof.baseMint), quoteMint = pk(proof.quoteMint), vault = pk(proof.vault);
const treasuryBase = getAssociatedTokenAddressSync(baseMint, treasury, true, TOKEN_PROGRAM_ID);
const treasuryQuote = getAssociatedTokenAddressSync(quoteMint, treasury, true, TOKEN_2022_PROGRAM_ID);

const traces = [];
const send = async (label, tx, extra = []) => {
  const signature = await sendAndConfirmTransaction(conn, tx, [admin, ...extra], { commitment: "confirmed" });
  traces.push({ label, signature });
  console.log(`${label}: ${signature}`);
};
const state = async () => (await dbc.state.getPool(pool)).poolState;
const poolConfig = await dbc.state.getPoolConfig(config);
const threshold = BigInt(poolConfig.migrationQuoteThreshold.toString());
const feeOption = poolConfig.migrationFeeOption;
const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[feeOption];
console.log(`Pool ${pool.toBase58()} | threshold ${threshold} | migration fee option ${feeOption} -> DAMM v2 config ${dammConfig.toBase58()}`);

// 1. Complete the curve.
let s = await state();
const before = { quoteReserve: s.quoteReserve.toString(), progress: s.migrationProgress };
if (BigInt(s.quoteReserve.toString()) < threshold) {
  const wrapped = await dbc.state.getPool(pool);
  const quote = dbc.pool.swapQuote2({
    virtualPool: wrapped, config: poolConfig, swapBaseForQuote: false,
    hasReferral: false, eligibleForFirstSwapWithMinFee: false,
    currentPoint: await getCurrentPoint(conn, poolConfig.activationType),
    slippageBps: 100, swapMode: SwapMode.PartialFill, amountIn: new BN(FILL_IN.toString()),
  });
  console.log("Fill quote:", Object.fromEntries(Object.entries(quote).map(([k, v]) => [k, v?.toString?.() ?? v])));
  await send("Complete the curve (PartialFill buy)", await dbc.pool.swap2({
    owner: admin.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.PartialFill, amountIn: new BN(FILL_IN.toString()),
    minimumAmountOut: quote.minimumAmountOut,
  }));
  s = await state();
}
const afterFill = {
  quoteReserve: s.quoteReserve.toString(), progress: s.migrationProgress,
  finishCurveTimestamp: s.finishCurveTimestamp.toString(),
};
assert.ok(BigInt(s.quoteReserve.toString()) >= threshold, "Curve not complete.");

// 2. Collect and allocate partner fees before migrating.
let collected = { claimed: "0", paidOut: "0", retained: "0" };
if (s.isMigrated === 0 && BigInt(s.partnerQuoteFee.toString()) > 0n) {
  const t0 = await program.account.treasury.fetch(treasury);
  await send("Claim partner fees before migration", new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    await program.methods.claim().accounts({
      vault, treasury, poolAuthority: pk(DBC.poolAuthority), config, pool, treasuryBase, treasuryQuote,
      baseVault: deriveDbcTokenVaultAddress(pool, baseMint), quoteVault: deriveDbcTokenVaultAddress(pool, quoteMint),
      baseMint, quoteMint, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
      dbcEventAuthority: pk(DBC.eventAuthority), dbcProgram: pk(DBC.program),
    }).instruction(),
  ));
  const payoutQuote = getAssociatedTokenAddressSync(quoteMint, t0.payoutOwner, true, TOKEN_2022_PROGRAM_ID);
  await send("Allocate 50/50 before migration", new Transaction().add(
    await program.methods.distribute().accounts({
      treasury, treasuryQuote, payoutQuote, quoteMint, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
    }).instruction(),
  ));
  const t1 = await program.account.treasury.fetch(treasury);
  collected = {
    claimed: t1.totalClaimed.sub(t0.totalClaimed).toString(),
    paidOut: t1.totalDistributed.sub(t0.totalDistributed).toString(),
    retained: t1.totalRetained.sub(t0.totalRetained).toString(),
  };
  s = await state();
}

// 3. Migrate to DAMM v2.
const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint);
let positions = [];
if (s.isMigrated === 0) {
  assert.equal(s.migrationProgress, LOCKED_VESTING, "Pool is not ready to migrate.");
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
    await dbc.migration.migrateToDammV2({ payer: admin.publicKey, pool, dammConfig });
  positions = [firstPositionNftKeypair.publicKey, secondPositionNftKeypair.publicKey];
  await send("Migrate to DAMM v2", transaction, [firstPositionNftKeypair, secondPositionNftKeypair]);
  s = await state();
}

// Read the result back.
const dammInfo = await conn.getAccountInfo(dammPool);
const positionReads = [];
for (const nft of positions) {
  const position = derivePositionAddress(nft);
  const info = await conn.getAccountInfo(position);
  const largest = await conn.getTokenLargestAccounts(nft);
  const holder = largest.value[0] ? await conn.getParsedAccountInfo(largest.value[0].address) : null;
  positionReads.push({
    nftMint: nft.toBase58(),
    position: position.toBase58(),
    positionExists: !!info && info.owner.equals(DAMM_V2_PROGRAM_ID),
    nftOwner: holder?.value?.data?.parsed?.info?.owner ?? null,
  });
}
const vaultOwnsAPosition = positionReads.some((p) => p.nftOwner === vault.toBase58());
const checks = {
  curveCompleted: BigInt(afterFill.quoteReserve) >= threshold,
  feesCollectedBeforeMigration: BigInt(collected.claimed) > 0n,
  poolMarkedMigrated: s.isMigrated === 1 && s.migrationProgress === CREATED_POOL,
  dammPoolCreated: !!dammInfo && dammInfo.owner.equals(DAMM_V2_PROGRAM_ID),
  lockedPartnerPositionOwnedByVault: vaultOwnsAPosition,
};
console.log({ positions: positionReads, checks });
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Verification failed: ${name}`);

writeFileSync(out, JSON.stringify({
  network: "solana:devnet",
  createdAt: new Date().toISOString(),
  intent: "Graduate a per-launch DBC pool into Meteora DAMM v2: complete curve, collect fees, migrate, read back.",
  dbcPool: pool.toBase58(), config: config.toBase58(), treasury: treasury.toBase58(),
  threshold: threshold.toString(), migrationFeeOption: feeOption, dammConfig: dammConfig.toBase58(),
  dammPool: dammPool.toBase58(), before, afterFill, collected, positions: positionReads, checks, traces,
}, null, 2));
console.log(`\nAll checks passed. ${out}`);
