// SPDX-License-Identifier: GPL-3.0-or-later
// Proves on Devnet that a market built outside Sonata's launch page cannot be
// listed if its Meteora config is rug-capable: a config that names the Vault as
// fee claimer but leaves half the graduated liquidity UNLOCKED for the creator
// is created with its pool, then registration with the treasury program is sent
// and refused on-chain with NonStandardConfig. No treasury account is created.
//
// Usage: node scripts/verify-standard-config.mjs [out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import {
  DynamicBondingCurveClient,
  buildCurveWithMarketCap,
  deriveDbcPoolAddress,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  BaseFeeMode,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  ActivationType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import assert from "node:assert/strict";

const out = process.argv[2] ?? "artifacts/standard-config-proof.json";
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not Devnet.");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))));
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json"));
const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], program.programId);
const asset = JSON.parse(readFileSync("../cash-access/lib/treasury/quote-assets.json", "utf8")).assets.find((a) => a.symbol === "mSPY");
const quoteMint = new PublicKey(asset.mint);
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const traces = [];

// Everything as Sonata's launch page builds it, except the liquidity split: half
// of the graduated pool goes to the creator UNLOCKED, which they could withdraw.
const params = buildCurveWithMarketCap({
  token: {
    tokenType: TokenType.SPLToken,
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.EIGHT,
    tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: 1_000_000_000,
    leftover: 0,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 125, endingFeeBps: 125, numberOfPeriod: 0, totalDuration: 0 },
    },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 0,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps100,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 50,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 50,
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  initialMarketCap: 2,
  migrationMarketCap: 30,
});
const config = Keypair.generate(),
  mint = Keypair.generate();
const createTx = await dbc.partner.createConfigAndPool({
  config: config.publicKey,
  feeClaimer: vault,
  leftoverReceiver: vault,
  quoteMint,
  payer: admin.publicKey,
  ...params,
  preCreatePoolParam: { name: "Rug Check", symbol: "RUGCHK", uri: "", poolCreator: admin.publicKey, baseMint: mint.publicKey },
});
createTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }));
const sig1 = await sendAndConfirmTransaction(conn, createTx, [admin, config, mint], { commitment: "confirmed" });
traces.push({ label: "Create a rug-capable Meteora config (half the graduated liquidity unlocked for the creator) and its pool", signature: sig1 });
console.log("config and pool:", sig1);
const pool = deriveDbcPoolAddress(quoteMint, mint.publicKey, config.publicKey);
const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), pool.toBuffer()], program.programId);

// Registration, sent without preflight so the refusal is recorded on-chain.
const tx = new Transaction().add(
  await program.methods
    .initTreasury({ standard: {} }, admin.publicKey)
    .accounts({
      vault,
      treasury,
      pool,
      config: config.publicKey,
      quoteMint,
      baseMint: mint.publicKey,
      creator: admin.publicKey,
      payer: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction(),
);
tx.feePayer = admin.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
tx.sign(admin);
const sig3 = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
await conn.confirmTransaction(sig3, "confirmed").catch(() => {});
let result = null;
for (let i = 0; i < 10 && !result; i++) {
  result = await conn.getTransaction(sig3, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!result) await new Promise((r) => setTimeout(r, 1500));
}
assert.ok(result, "registration transaction not found");
traces.push({ label: "Register it with Sonata: refused (NonStandardConfig)", signature: sig3 });
const logs = result.meta.logMessages.join("\n");
const checks = {
  registrationFailed: result.meta.err !== null,
  refusedAsNonStandard: /NonStandardConfig/.test(logs),
  noTreasuryCreated: (await conn.getAccountInfo(treasury)) === null,
};
console.log({ sig3, checks });
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Verification failed: ${name}`);
writeFileSync(
  out,
  JSON.stringify(
    {
      network: "solana:devnet",
      createdAt: new Date().toISOString(),
      intent: "A Meteora config built outside Sonata's launch page with unlocked creator liquidity cannot be registered as a Sonata market.",
      pool: pool.toBase58(),
      config: config.publicKey.toBase58(),
      treasury: treasury.toBase58(),
      unlockedCreatorLiquidityPercent: 50,
      checks,
      traces,
    },
    null,
    2,
  ) + "\n",
);
console.log(`\nAll checks passed. ${out}`);
