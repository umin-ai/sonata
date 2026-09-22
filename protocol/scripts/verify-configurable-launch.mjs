// SPDX-License-Identifier: GPL-3.0-or-later
// Proves a creator-chosen DBC configuration deploys and registers end to end.
// Uses settings that differ from the shared config (2 -> 18 market cap, 3% fee)
// so a pass cannot be explained by the old fixed preset.
import { readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  buildCurveWithMarketCap,
  deriveDbcPoolAddress,
  deriveDbcTokenVaultAddress,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  ActivationType,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  BaseFeeMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import assert from "node:assert/strict";

const INITIAL_MARKET_CAP = 2,
  MIGRATION_MARKET_CAP = 18,
  FEE_BPS = 300,
  SHARED_CONFIG = "CUeJ6fgsw6wGXPCBchj9jxpkGVWzanXxYJFMiAPJea5J",
  MSPY = new PublicKey("6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(
  await conn.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "Not Devnet.",
);
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))),
);
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json")),
  programId = new PublicKey(idl.address),
  provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), {
    commitment: "confirmed",
  }),
  program = new anchor.Program(idl, provider),
  dbc = new DynamicBondingCurveClient(conn, "confirmed");
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from("stockroom")],
  programId,
);
const traces = [];
const send = async (label, tx, signers = [admin]) => {
  const signature = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: "confirmed",
  });
  traces.push({ label, signature });
  console.log(`${label}: ${signature}`);
  return signature;
};

const curveParams = buildCurveWithMarketCap({
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
      feeSchedulerParam: {
        startingFeeBps: FEE_BPS,
        endingFeeBps: FEE_BPS,
        numberOfPeriod: 0,
        totalDuration: 0,
      },
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
    partnerPermanentLockedLiquidityPercentage: 100,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 0,
  },
  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  activationType: ActivationType.Timestamp,
  initialMarketCap: INITIAL_MARKET_CAP,
  migrationMarketCap: MIGRATION_MARKET_CAP,
});
const expectedThreshold = curveParams.migrationQuoteThreshold.toString();
console.log(
  `Curve: ${INITIAL_MARKET_CAP} -> ${MIGRATION_MARKET_CAP} mSPY at ${FEE_BPS / 100}% ; quote reserve to graduate ${expectedThreshold}`,
);

const config = Keypair.generate(),
  baseMint = Keypair.generate();
assert.notEqual(
  config.publicKey.toBase58(),
  SHARED_CONFIG,
  "Must not reuse the shared config.",
);
const pool = deriveDbcPoolAddress(MSPY, baseMint.publicKey, config.publicKey);
const [treasury] = PublicKey.findProgramAddressSync(
  [Buffer.from("treasury"), pool.toBuffer()],
  programId,
);

const createTx = await dbc.partner.createConfigAndPool({
  config: config.publicKey,
  feeClaimer: vault,
  leftoverReceiver: vault,
  quoteMint: MSPY,
  payer: admin.publicKey,
  ...curveParams,
  preCreatePoolParam: {
    name: "Configurable Launch Proof",
    symbol: "CFGX",
    uri: "",
    poolCreator: admin.publicKey,
    baseMint: baseMint.publicKey,
  },
});
createTx.instructions.unshift(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 700000 }),
);
await send("Create creator config and pool", createTx, [
  admin,
  config,
  baseMint,
]);

const registerTx = await program.methods
  .initTreasury({ duet: {} }, admin.publicKey)
  .accounts({
    vault,
    treasury,
    pool,
    config: config.publicKey,
    quoteMint: MSPY,
    baseMint: baseMint.publicKey,
    creator: admin.publicKey,
    payer: admin.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .transaction();
for (const [authority, mint, tokenProgram] of [
  [treasury, baseMint.publicKey, TOKEN_PROGRAM_ID],
  [treasury, MSPY, TOKEN_2022_PROGRAM_ID],
  [admin.publicKey, MSPY, TOKEN_2022_PROGRAM_ID],
])
  registerTx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      getAssociatedTokenAddressSync(
        mint,
        authority,
        true,
        tokenProgram,
      ),
      authority,
      mint,
      tokenProgram,
    ),
  );
await send("Register treasury against the new config", registerTx);

// Read the deployed state back rather than trusting the send succeeded.
const onchainConfig = await dbc.state.getPoolConfig(config.publicKey);
const onchainTreasury = await program.account.treasury.fetch(treasury);
const checks = {
  configIsNew: config.publicKey.toBase58() !== SHARED_CONFIG,
  feeClaimerIsVault: onchainConfig.feeClaimer.equals(vault),
  leftoverReceiverIsVault: onchainConfig.leftoverReceiver.equals(vault),
  quoteMintMatches: onchainConfig.quoteMint.equals(MSPY),
  thresholdMatchesPreview:
    onchainConfig.migrationQuoteThreshold.toString() === expectedThreshold,
  feeIsChosenRate:
    onchainConfig.poolFees.baseFee.cliffFeeNumerator.toString() ===
    ((BigInt(FEE_BPS) * 1_000_000_000n) / 10_000n).toString(),
  treasuryBoundToConfig: onchainTreasury.config.equals(config.publicKey),
  treasuryBoundToPool: onchainTreasury.pool.equals(pool),
};
console.log(checks);
for (const [name, ok] of Object.entries(checks))
  assert.ok(ok, `Verification failed: ${name}`);

const evidence = {
  network: "solana:devnet",
  createdAt: new Date().toISOString(),
  intent:
    "Creator-chosen DBC configuration, distinct from the shared preset, deployed and registered.",
  settings: {
    initialMarketCap: INITIAL_MARKET_CAP,
    migrationMarketCap: MIGRATION_MARKET_CAP,
    feeBps: FEE_BPS,
    quote: "mSPY",
  },
  sharedConfig: SHARED_CONFIG,
  config: config.publicKey.toBase58(),
  pool: pool.toBase58(),
  treasury: treasury.toBase58(),
  baseMint: baseMint.publicKey.toBase58(),
  quoteMint: MSPY.toBase58(),
  vault: vault.toBase58(),
  expectedThreshold,
  onchainThreshold: onchainConfig.migrationQuoteThreshold.toString(),
  checks,
  traces,
};
writeFileSync(
  "artifacts/configurable-launch-proof.json",
  JSON.stringify(evidence, null, 2),
);
console.log("\nAll checks passed. artifacts/configurable-launch-proof.json");
