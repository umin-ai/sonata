// SPDX-License-Identifier: GPL-3.0-or-later
// Fresh Stockroom-only pool; refuses to replace existing market evidence.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  buildCurveWithMarketCap,
  deriveDbcPoolAuthority,
  deriveDbcEventAuthority,
  deriveDbcPoolAddress,
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
const RPC = "https://api.devnet.solana.com",
  conn = new Connection(RPC, "confirmed");
assert.equal(
  await conn.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))),
);
const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json"));
const programId = new PublicKey(idl.address),
  provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), {
    commitment: "confirmed",
  }),
  program = new anchor.Program(idl, provider),
  dbc = new DynamicBondingCurveClient(conn, "confirmed");
const MSPY = new PublicKey("6gat24puM23p74CeBKEPs53roxqpHcQpiGL8ZHtgNJqg");
const path = "artifacts/stockroom-treasury-market.json";
if (existsSync(path))
  throw Error(
    "Market evidence already exists. Use existing pool; do not duplicate launch.",
  );
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
  console.log(label, signature);
  return signature;
};
if (!(await conn.getAccountInfo(vault)))
  await send(
    "Initialize fee authority",
    await program.methods
      .initVault()
      .accounts({
        vault,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction(),
  );
const config = Keypair.generate(),
  baseMint = Keypair.generate(),
  recipient = Keypair.generate();
for (const [name, key] of [
  ["config", config],
  ["base", baseMint],
  ["recipient", recipient],
])
  writeFileSync(
    `.keys/stockroom-treasury-${name}.json`,
    JSON.stringify([...key.secretKey]),
    { mode: 0o600 },
  );
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
      feeSchedulerParam: {
        startingFeeBps: 100,
        endingFeeBps: 100,
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
  initialMarketCap: 2,
  migrationMarketCap: 12,
});

await send(
  "Create Meteora config",
  await dbc.partner.createConfig({
    config: config.publicKey,
    feeClaimer: vault,
    leftoverReceiver: vault,
    quoteMint: MSPY,
    payer: admin.publicKey,
    ...params,
  }),
  [admin, config],
);
await send(
  "Create ROOM / mSPY pool and first trade",
  await dbc.creator.createPoolWithFirstBuy({
    createPoolParam: {
      name: "Stockroom Treasury Demo",
      symbol: "ROOM",
      uri: "",
      payer: admin.publicKey,
      poolCreator: admin.publicKey,
      config: config.publicKey,
      baseMint: baseMint.publicKey,
    },
    firstBuyParam: {
      buyer: admin.publicKey,
      buyAmount: new BN("50000000"),
      minimumAmountOut: new BN(0),
      referralTokenAccount: null,
    },
  }),
  [admin, baseMint],
);
const pool = deriveDbcPoolAddress(MSPY, baseMint.publicKey, config.publicKey),
  [treasury] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), pool.toBuffer()],
    programId,
  );
const treasuryQuote = getAssociatedTokenAddressSync(
    MSPY,
    treasury,
    true,
    TOKEN_2022_PROGRAM_ID,
  ),
  treasuryBase = getAssociatedTokenAddressSync(
    baseMint.publicKey,
    treasury,
    true,
  ),
  payoutQuote = getAssociatedTokenAddressSync(
    MSPY,
    recipient.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  ),
  creatorQuote = getAssociatedTokenAddressSync(
    MSPY,
    admin.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
const accounts = {
  vault,
  treasury,
  pool,
  config: config.publicKey,
  quoteMint: MSPY,
  baseMint: baseMint.publicKey,
  creator: admin.publicKey,
  payer: admin.publicKey,
  systemProgram: SystemProgram.programId,
};
await send(
  "Register authorized treasury",
  await program.methods
    .initTreasury({ duet: {} }, recipient.publicKey)
    .accounts(accounts)
    .transaction(),
);
await send(
  "Create custody accounts",
  new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      treasuryQuote,
      treasury,
      MSPY,
      TOKEN_2022_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      treasuryBase,
      treasury,
      baseMint.publicKey,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      payoutQuote,
      recipient.publicKey,
      MSPY,
      TOKEN_2022_PROGRAM_ID,
    ),
  ),
);
let ps =
  (await dbc.state.getPool(pool)).poolState ?? (await dbc.state.getPool(pool));
const claimAccounts = {
  vault,
  treasury,
  poolAuthority: deriveDbcPoolAuthority(),
  config: config.publicKey,
  pool,
  treasuryBase,
  treasuryQuote,
  baseVault: ps.baseVault,
  quoteVault: ps.quoteVault,
  baseMint: baseMint.publicKey,
  quoteMint: MSPY,
  tokenBaseProgram: TOKEN_PROGRAM_ID,
  tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
  dbcEventAuthority: deriveDbcEventAuthority(),
  dbcProgram: new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"),
};
const amount = async (key) =>
  BigInt((await conn.getTokenAccountBalance(key)).value.amount);
const payoutBefore = await amount(payoutQuote);
await send(
  "Collect real DBC trading fees",
  await program.methods.claim().accounts(claimAccounts).transaction(),
);
const claimed = await amount(treasuryQuote);
assert(claimed > 0n);
await send(
  "Allocate 50% payout / 50% retained",
  await program.methods
    .distribute()
    .accounts({
      treasury,
      treasuryQuote,
      payoutQuote,
      quoteMint: MSPY,
      tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
    })
    .transaction(),
);
const paid = (await amount(payoutQuote)) - payoutBefore,
  retained = await amount(treasuryQuote);
assert.equal(paid + retained, claimed);
assert.equal(paid, claimed / 2n);
const returnAmount = retained / 2n,
  beforeReturn = await amount(creatorQuote);
await send(
  "Withdraw half of retained stock",
  await program.methods
    .withdrawRetained(new BN(returnAmount.toString()))
    .accounts({
      treasury,
      creator: admin.publicKey,
      treasuryQuote,
      creatorQuote,
      quoteMint: MSPY,
      tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
    })
    .transaction(),
);
assert.equal((await amount(creatorQuote)) - beforeReturn, returnAmount);
// A final actual trade leaves collectable fees for the app, rather than fabricating accrued income.
await send(
  "Second trade; new fees available",
  await dbc.pool.swap({
    owner: admin.publicKey,
    pool,
    amountIn: new BN("30000000"),
    minimumAmountOut: new BN(0),
    swapBaseForQuote: false,
    referralTokenAccount: null,
  }),
);
const t = await program.account.treasury.fetch(treasury);
ps =
  (await dbc.state.getPool(pool)).poolState ?? (await dbc.state.getPool(pool));
const evidence = {
  network: "devnet",
  createdAt: new Date().toISOString(),
  programId: programId.toBase58(),
  vault: vault.toBase58(),
  treasury: treasury.toBase58(),
  pool: pool.toBase58(),
  config: config.publicKey.toBase58(),
  baseMint: baseMint.publicKey.toBase58(),
  quoteMint: MSPY.toBase58(),
  quoteDecimals: 8,
  baseDecimals: 6,
  creator: admin.publicKey.toBase58(),
  payoutOwner: recipient.publicKey.toBase58(),
  treasuryQuote: treasuryQuote.toBase58(),
  treasuryBase: treasuryBase.toBase58(),
  payoutQuote: payoutQuote.toBase58(),
  baseVault: ps.baseVault.toBase58(),
  quoteVault: ps.quoteVault.toBase58(),
  traces,
  proof: {
    claimed: claimed.toString(),
    paid: paid.toString(),
    retained: retained.toString(),
    withdrawn: returnAmount.toString(),
    uncollected: ps.partnerQuoteFee.toString(),
  },
  ledger: {
    totalClaimed: t.totalClaimed.toString(),
    totalDistributed: t.totalDistributed.toString(),
    totalRetained: t.totalRetained.toString(),
    totalWithdrawn: t.totalWithdrawn.toString(),
  },
};
writeFileSync(path, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
