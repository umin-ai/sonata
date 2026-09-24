// SPDX-License-Identifier: GPL-3.0-or-later
// Proves "creators keep earning after graduation" on Devnet, end to end:
//   1. create a per-launch DBC config and pool exactly as the app does, but
//      with the locked liquidity split 50/50 between the Sonata Vault
//      (partner) and the pool creator, and a small graduation target,
//   2. register its treasury (Refrain mode),
//   3. fill the curve, collect and allocate partner fees, migrate to DAMM v2,
//   4. make one trade on the DAMM v2 pool,
//   5. claim the creator position's fees as the creator (the deployer),
// then checks from chain that the pool has exactly two positions, that the
// creator's is owned by the creator and permanently locked, that fees accrued
// to it, and that the claim moved them to the creator's token accounts.
//
// Steps 4-5 use cash-access/lib/liquidity/creator-position.ts, the same code
// the app runs, so this also proves the app's read and claim builder.
//
// State is saved to the output file after every step; rerunning with an
// incomplete output file resumes it. A complete file is never overwritten.
//
// Usage (from stockroom-protocol/):
//   node --experimental-strip-types scripts/verify-creator-position.mjs [out.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
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
  buildCurveWithMarketCap,
  deriveDbcPoolAddress,
  deriveDbcTokenVaultAddress,
  deriveDammV2PoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  getCurrentPoint,
  SwapMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  TokenType,
  TokenDecimal,
  TokenAuthorityOption,
  ActivationType,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  BaseFeeMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, SwapMode as DammSwapMode, getUnClaimLpFee, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import assert from "node:assert/strict";

const env = process.env;
const INITIAL_MARKET_CAP = Number(env.SONATA_INITIAL ?? 2),
  MIGRATION_MARKET_CAP = Number(env.SONATA_TARGET ?? 4),
  FEE_BPS = Number(env.SONATA_FEE_BPS ?? 125),
  QUOTE_SYMBOL = env.SONATA_QUOTE_SYMBOL ?? "mQQQ",
  QUOTE_MINT = new PublicKey(env.SONATA_QUOTE_MINT ?? "dXrPEzAYgn5H3y7GwCfCr6okHsWXidpMQrRq33LNTJh"),
  TOKEN_NAME = "Creator Position Proof",
  TOKEN_SYMBOL = "CPOS",
  MODE = "refrain",
  PARTNER_LOCKED = 50,
  CREATOR_LOCKED = 50,
  TRADE_IN = 10_000_000n; // 0.1 quote token bought on the graduated pool
const FLAGSHIP_POOL = "BZVxHsS8DQAkigYvQAPfssFGZRVSuWSYHrYQn2QmeFSf";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
// DBC MigrationProgress: 2 LockedVesting (ready to migrate), 3 CreatedPool.
const LOCKED_VESTING = 2, CREATED_POOL = 3;

// The public Devnet RPC rate-limits per IP and is shared: every HTTP call,
// including those made inside the SDKs and the app library, starts at least
// 450 ms after the previous one, and a 429 backs off exponentially.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextStart = 0;
const pacedFetch = async (input, init) => {
  const start = Math.max(Date.now(), nextStart);
  nextStart = start + 450;
  await sleep(start - Date.now());
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, init);
    if (response.status !== 429 || attempt >= 6) return response;
    const wait = 1000 * 2 ** attempt;
    console.log(`429 from Devnet RPC; waiting ${wait} ms`);
    nextStart = Date.now() + wait + 450;
    await sleep(wait);
  }
};
const conn = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  fetch: pacedFetch,
  disableRetryOnRateLimit: true,
});
assert.equal(await conn.getGenesisHash(), GENESIS, "Not Devnet.");

let lib;
try {
  lib = await import(new URL("../../cash-access/lib/liquidity/creator-position.ts", import.meta.url));
} catch (e) {
  throw Error(`Cannot load the app library (run node with --experimental-strip-types): ${e.message}`);
}

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".keys/deployer.json"))));
const treasuryIdl = JSON.parse(readFileSync("../cash-access/lib/treasury/stockroom_treasury.json"));
const DBC = JSON.parse(readFileSync("../cash-access/lib/treasury/dbc-addresses.json"));
const program = new anchor.Program(
  treasuryIdl,
  new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }),
);
const dbc = new DynamicBondingCurveClient(conn, "confirmed");
const amm = new CpAmm(conn);
const pk = (s) => new PublicKey(s);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], program.programId);

const out = process.argv[2] ?? "artifacts/creator-position-proof.json";
let st = existsSync(out) ? JSON.parse(readFileSync(out)) : null;
if (st?.complete) {
  console.log(`${out} is already a complete proof. Pass a new output path to run again.`);
  process.exit(0);
}
st ??= {
  network: "solana:devnet",
  createdAt: new Date().toISOString(),
  complete: false,
  intent:
    "Creators keep earning after graduation: a 50/50 partner/creator locked-liquidity split gives the pool creator a permanently locked DAMM v2 position whose trading fees the creator claims.",
  settings: {
    initialMarketCap: INITIAL_MARKET_CAP,
    migrationMarketCap: MIGRATION_MARKET_CAP,
    feeBps: FEE_BPS,
    quote: QUOTE_SYMBOL,
    quoteMint: QUOTE_MINT.toBase58(),
    mode: MODE,
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: PARTNER_LOCKED,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: CREATOR_LOCKED,
      creatorLiquidityPercentage: 0,
    },
    tradeIn: TRADE_IN.toString(),
  },
  creator: admin.publicKey.toBase58(),
  vault: vault.toBase58(),
  traces: [],
  steps: {},
};
const save = () => writeFileSync(out, JSON.stringify(st, null, 2));
const send = async (label, tx, extra = []) => {
  let signature;
  for (let attempt = 0; !signature; attempt++) {
    try {
      signature = await sendAndConfirmTransaction(conn, tx, [admin, ...extra], { commitment: "confirmed" });
    } catch (e) {
      // A lagging RPC node can reject a fresh blockhash in preflight. Nothing
      // was submitted then, so waiting and retrying cannot double-send.
      if (attempt >= 3 || !/Blockhash not found/.test(e.message)) throw e;
      console.log(`${label}: preflight saw no blockhash; retrying`);
      await sleep(3000);
    }
  }
  st.traces.push({ label, signature });
  save();
  console.log(`${label}: ${signature}`);
  return signature;
};
const str = (o) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v?.toString?.() ?? v]));

// 1. Per-launch config and pool, as lib/treasury/dbc-preview.ts buildCurveParams
// builds it, with the 50/50 locked-liquidity split.
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
      feeSchedulerParam: { startingFeeBps: FEE_BPS, endingFeeBps: FEE_BPS, numberOfPeriod: 0, totalDuration: 0 },
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
  liquidityDistribution: st.settings.liquidityDistribution,
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
console.log(`Curve: ${INITIAL_MARKET_CAP} -> ${MIGRATION_MARKET_CAP} ${QUOTE_SYMBOL} at ${FEE_BPS / 100}%; graduates at ${expectedThreshold} quote atoms`);

if (!st.pool || !(await conn.getAccountInfo(pk(st.pool)))) {
  const config = Keypair.generate(), baseMint = Keypair.generate();
  const pool = deriveDbcPoolAddress(QUOTE_MINT, baseMint.publicKey, config.publicKey);
  assert.notEqual(pool.toBase58(), FLAGSHIP_POOL);
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), pool.toBuffer()], program.programId);
  Object.assign(st, {
    config: config.publicKey.toBase58(), pool: pool.toBase58(), baseMint: baseMint.publicKey.toBase58(),
    quoteMint: QUOTE_MINT.toBase58(), treasury: treasury.toBase58(), expectedThreshold,
  });
  save();
  const createTx = await dbc.partner.createConfigAndPool({
    config: config.publicKey, feeClaimer: vault, leftoverReceiver: vault, quoteMint: QUOTE_MINT, payer: admin.publicKey,
    ...curveParams,
    preCreatePoolParam: { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: "", poolCreator: admin.publicKey, baseMint: baseMint.publicKey },
  });
  createTx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }));
  await send("Create 50/50 config and pool", createTx, [config, baseMint]);
}
assert.notEqual(st.pool, FLAGSHIP_POOL, "Refusing to touch the flagship pool.");
const pool = pk(st.pool), config = pk(st.config), treasury = pk(st.treasury);
const baseMint = pk(st.baseMint), quoteMint = pk(st.quoteMint);
const treasuryBase = getAssociatedTokenAddressSync(baseMint, treasury, true, TOKEN_PROGRAM_ID);
const treasuryQuote = getAssociatedTokenAddressSync(quoteMint, treasury, true, TOKEN_2022_PROGRAM_ID);

// 2. Register the treasury (Refrain: 100% of net fees to the payout wallet).
if (!(await conn.getAccountInfo(treasury))) {
  const tx = await program.methods.initTreasury({ [MODE]: {} }, admin.publicKey).accounts({
    vault, treasury, pool, config, quoteMint, baseMint,
    creator: admin.publicKey, payer: admin.publicKey, systemProgram: SystemProgram.programId,
  }).transaction();
  for (const [authority, mint, tokenProgram] of [
    [treasury, baseMint, TOKEN_PROGRAM_ID],
    [treasury, quoteMint, TOKEN_2022_PROGRAM_ID],
    [admin.publicKey, quoteMint, TOKEN_2022_PROGRAM_ID],
  ])
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey, getAssociatedTokenAddressSync(mint, authority, true, tokenProgram), authority, mint, tokenProgram,
    ));
  await send("Register treasury (Refrain)", tx);
}

const poolConfig = await dbc.state.getPoolConfig(config);
const threshold = BigInt(poolConfig.migrationQuoteThreshold.toString());
const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[poolConfig.migrationFeeOption];
const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint);
assert.notEqual(dammPool.toBase58(), FLAGSHIP_POOL);
Object.assign(st, { dammConfig: dammConfig.toBase58(), dammPool: dammPool.toBase58(), onchainThreshold: threshold.toString() });
save();
const state = async () => (await dbc.state.getPool(pool)).poolState;

// 3a. Complete the curve. PartialFill takes only what the curve needs.
let s = await state();
if (BigInt(s.quoteReserve.toString()) < threshold) {
  const fillIn = new BN(((threshold * 115n) / 100n).toString());
  const quote = dbc.pool.swapQuote2({
    virtualPool: await dbc.state.getPool(pool), config: poolConfig, swapBaseForQuote: false,
    hasReferral: false, eligibleForFirstSwapWithMinFee: false,
    currentPoint: await getCurrentPoint(conn, poolConfig.activationType),
    slippageBps: 100, swapMode: SwapMode.PartialFill, amountIn: fillIn,
  });
  await send("Complete the curve (PartialFill buy)", await dbc.pool.swap2({
    owner: admin.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null,
    swapMode: SwapMode.PartialFill, amountIn: fillIn, minimumAmountOut: quote.minimumAmountOut,
  }));
  s = await state();
}
st.steps.fill ??= { quoteReserve: s.quoteReserve.toString(), progress: s.migrationProgress };
save();
assert.ok(BigInt(s.quoteReserve.toString()) >= threshold, "Curve not complete.");

// 3b. Collect and allocate partner fees while the pool is still a DBC pool.
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
  await send("Allocate collected fees (Refrain: all to payout)", new Transaction().add(
    await program.methods.distribute().accounts({
      treasury, treasuryQuote, quoteMint, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID,
      payoutQuote: getAssociatedTokenAddressSync(quoteMint, t0.payoutOwner, true, TOKEN_2022_PROGRAM_ID),
    }).instruction(),
  ));
  const t1 = await program.account.treasury.fetch(treasury);
  st.steps.collect = { claimed: t1.totalClaimed.sub(t0.totalClaimed).toString(), paidOut: t1.totalDistributed.sub(t0.totalDistributed).toString() };
  save();
  s = await state();
}

// 3c. Migrate to DAMM v2. The NFT mints are saved before sending so a resumed
// run can still find both positions.
if (s.isMigrated === 0) {
  assert.equal(s.migrationProgress, LOCKED_VESTING, "Pool is not ready to migrate.");
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
    await dbc.migration.migrateToDammV2({ payer: admin.publicKey, pool, dammConfig });
  // Two positions (create, add liquidity, lock, set authority each) need more
  // than the SDK's 600k units; raise the limit, which costs nothing unpriced.
  transaction.instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ...transaction.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)),
  ];
  st.nftMints = [firstPositionNftKeypair.publicKey.toBase58(), secondPositionNftKeypair.publicKey.toBase58()];
  save();
  await send("Migrate to DAMM v2", transaction, [firstPositionNftKeypair, secondPositionNftKeypair]);
  s = await state();
}
assert.ok(st.nftMints, "Migration NFT mints unknown; cannot verify positions.");

// Both positions, straight from chain.
const readPositions = async () => {
  const poolState = await amm.fetchPoolState(dammPool);
  const positions = [];
  for (const mint of st.nftMints.map(pk)) {
    const address = derivePositionAddress(mint);
    const info = await conn.getAccountInfo(address);
    if (!info) { positions.push({ nftMint: mint.toBase58(), position: address.toBase58(), exists: false }); continue; }
    const ps = await amm.fetchPositionState(address);
    const nftAccount = derivePositionNftAccount(mint);
    const nft = await getAccount(conn, nftAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
    const fees = getUnClaimLpFee(poolState, ps);
    positions.push({
      nftMint: mint.toBase58(), position: address.toBase58(), exists: info.owner.equals(DAMM_V2_PROGRAM_ID),
      pool: ps.pool.toBase58(), nftAccount: nftAccount.toBase58(), owner: nft.owner.toBase58(), nftAmount: nft.amount.toString(),
      unlockedLiquidity: ps.unlockedLiquidity.toString(), vestedLiquidity: ps.vestedLiquidity.toString(),
      permanentLockedLiquidity: ps.permanentLockedLiquidity.toString(),
      unclaimedA: fees.feeTokenA.toString(), unclaimedB: fees.feeTokenB.toString(),
      claimedA: ps.metrics.totalClaimedAFee.toString(), claimedB: ps.metrics.totalClaimedBFee.toString(),
    });
  }
  return { poolState, positions };
};
const liq = (p) => BigInt(p.unlockedLiquidity) + BigInt(p.vestedLiquidity) + BigInt(p.permanentLockedLiquidity);
const marketRef = {
  pool: st.pool, config: st.config, baseMint: st.baseMint, quoteMint: st.quoteMint,
  vault: vault.toBase58(), symbol: TOKEN_SYMBOL, baseDecimals: 6, quoteDecimals: 8,
};
const tokenAProgram = (ps) => getTokenProgram(ps.tokenAFlag), tokenBProgram = (ps) => getTokenProgram(ps.tokenBFlag);
const balance = async (mint, program) => {
  try {
    return (await getAccount(conn, getAssociatedTokenAddressSync(mint, admin.publicKey, false, program), "confirmed", program)).amount;
  } catch { return 0n; }
};

let after = await readPositions();
st.steps.migrated ??= { dammPoolLiquidity: after.poolState.liquidity.toString(), positions: after.positions };
save();

// 4. One trade on the graduated pool: buy the launch token with the quote token.
if (!st.steps.trade) {
  const ps = after.poolState;
  const lpFeeBefore = BigInt(ps.metrics.totalLpBFee.toString());
  const time = await conn.getBlockTime(await conn.getSlot("confirmed"));
  const q = amm.getQuote2({
    poolState: ps, inputTokenMint: ps.tokenBMint, amountIn: new BN(TRADE_IN.toString()), slippage: 100,
    currentPoint: new BN(time), tokenADecimal: 6, tokenBDecimal: 8, hasReferral: false, swapMode: DammSwapMode.ExactIn,
  });
  assert.ok(q.minimumAmountOut?.gtn(0), "Trade too small for a protected output.");
  const tx = await amm.swap({
    payer: admin.publicKey, pool: dammPool,
    tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint, tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault,
    tokenAProgram: tokenAProgram(ps), tokenBProgram: tokenBProgram(ps),
    inputTokenMint: ps.tokenBMint, outputTokenMint: ps.tokenAMint,
    amountIn: new BN(TRADE_IN.toString()), minimumAmountOut: q.minimumAmountOut, referralTokenAccount: null, poolState: ps,
  });
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  await send(`Buy on the graduated DAMM v2 pool (${Number(TRADE_IN) / 1e8} ${QUOTE_SYMBOL})`, tx);
  after = await readPositions();
  st.steps.trade = {
    amountIn: TRADE_IN.toString(),
    quotedTradingFee: q.claimingFee.add(q.compoundingFee).toString(), quotedProtocolFee: q.protocolFee.toString(),
    lpFeeB: (BigInt(after.poolState.metrics.totalLpBFee.toString()) - lpFeeBefore).toString(),
    positions: after.positions,
  };
  save();
}

// 5. Claim the creator position's fees as the creator, with the app's code.
if (!st.steps.claim) {
  const read = await lib.findCreatorPosition(conn, marketRef);
  const before = { base: await balance(baseMint, TOKEN_PROGRAM_ID), quote: await balance(quoteMint, TOKEN_2022_PROGRAM_ID) };
  const tokenBVault = after.poolState.tokenBVault;
  const vaultBefore = (await getAccount(conn, tokenBVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const built = await lib.buildCreatorClaim(conn, admin.publicKey.toBase58(), marketRef, QUOTE_SYMBOL);
  const latest = await conn.getLatestBlockhash("confirmed");
  built.transaction.recentBlockhash = latest.blockhash;
  built.transaction.sign(admin);
  const signature = await conn.sendRawTransaction(built.transaction.serialize(), { maxRetries: 5 });
  const confirmed = await conn.confirmTransaction({ signature, ...latest }, "confirmed");
  assert.equal(confirmed.value.err, null, "Claim failed onchain.");
  st.traces.push({ label: "Creator claims position fees (app claim builder)", signature });
  save();
  console.log(`Creator claims position fees: ${signature}`);
  const readAfter = await lib.findCreatorPosition(conn, marketRef);
  const vaultAfter = (await getAccount(conn, tokenBVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  st.steps.claim = {
    description: built.description,
    instructions: built.transaction.instructions.map((ix) => ix.programId.toBase58()),
    libReadBefore: read,
    libReadAfter: readAfter,
    creatorBalancesBefore: str(before),
    creatorBalancesAfter: str({ base: await balance(baseMint, TOKEN_PROGRAM_ID), quote: await balance(quoteMint, TOKEN_2022_PROGRAM_ID) }),
    poolQuoteVaultBefore: vaultBefore.toString(),
    poolQuoteVaultAfter: vaultAfter.toString(),
  };
  save();
}

// Final read and checks.
const final = await readPositions();
const { poolState } = final;
const creatorPos = final.positions.find((p) => p.owner === admin.publicKey.toBase58());
const vaultPos = final.positions.find((p) => p.owner === vault.toBase58());
const poolLiquidity = BigInt(poolState.liquidity.toString());
let allPositionsByPool = null;
try {
  allPositionsByPool = (await amm.getAllPositionsByPool(dammPool)).map((p) => p.publicKey.toBase58()).sort();
} catch (e) {
  console.log(`getAllPositionsByPool unavailable on this RPC (${e.message}); relying on the liquidity sum.`);
}
const unlockedDust = creatorPos ? BigInt(creatorPos.unlockedLiquidity) : -1n;
let dustWithdraw = { outA: "0", outB: "0" };
if (unlockedDust > 0n) {
  const w = amm.getWithdrawQuote({
    liquidityDelta: new BN(unlockedDust.toString()), sqrtPrice: poolState.sqrtPrice, minSqrtPrice: poolState.sqrtMinPrice,
    maxSqrtPrice: poolState.sqrtMaxPrice, collectFeeMode: poolState.collectFeeMode, tokenAAmount: poolState.tokenAAmount,
    tokenBAmount: poolState.tokenBAmount, liquidity: poolState.liquidity,
  });
  dustWithdraw = { outA: w.outAmountA.toString(), outB: w.outAmountB.toString() };
}
const tradePos = st.steps.trade.positions;
const creatorAfterTrade = tradePos.find((p) => p.owner === admin.publicKey.toBase58());
const vaultAfterTrade = tradePos.find((p) => p.owner === vault.toBase58());
const lpFeeB = BigInt(st.steps.trade.lpFeeB);
const expectedCreatorFee = (lpFeeB * liq(creatorAfterTrade)) / poolLiquidity;
const claim = st.steps.claim;
const claimedQuote = BigInt(claim.creatorBalancesAfter.quote) - BigInt(claim.creatorBalancesBefore.quote);
const claimedBase = BigInt(claim.creatorBalancesAfter.base) - BigInt(claim.creatorBalancesBefore.base);
const creatorShareBps = creatorPos ? Number((liq(creatorPos) * 10_000n) / poolLiquidity) : 0;
const onchainConfig = await dbc.state.getPoolConfig(config);

const checks = {
  configSplitIs5050:
    onchainConfig.partnerPermanentLockedLiquidityPercentage === PARTNER_LOCKED &&
    onchainConfig.creatorPermanentLockedLiquidityPercentage === CREATOR_LOCKED &&
    onchainConfig.partnerLiquidityPercentage === 0 && onchainConfig.creatorLiquidityPercentage === 0,
  feeClaimerIsVault: onchainConfig.feeClaimer.equals(vault),
  tradingFeeIsChosenRate:
    onchainConfig.poolFees.baseFee.cliffFeeNumerator.toString() === ((BigInt(FEE_BPS) * 1_000_000_000n) / 10_000n).toString(),
  thresholdMatchesPreview: onchainConfig.migrationQuoteThreshold.toString() === expectedThreshold,
  curveCompletedAndMigrated: s.isMigrated === 1 && s.migrationProgress === CREATED_POOL,
  dammPoolCreated: (await conn.getAccountInfo(dammPool))?.owner.equals(DAMM_V2_PROGRAM_ID) === true,
  // pool.liquidity is the sum over all positions, so two positions holding all
  // of it means there is no third.
  poolHasExactlyTwoPositions:
    final.positions.length === 2 && final.positions.every((p) => p.exists && p.pool === dammPool.toBase58()) &&
    final.positions.reduce((sum, p) => sum + liq(p), 0n) === poolLiquidity &&
    (allPositionsByPool === null || allPositionsByPool.length === 2),
  creatorPositionOwnedByCreator: !!creatorPos && creatorPos.nftAmount === "1" && admin.publicKey.equals(s.creator),
  vaultPositionOwnedByVault: !!vaultPos && vaultPos.nftAmount === "1",
  // DBC splits with round-down percentages and gives the remainder to the
  // creator's unlocked bucket, so up to 1 liquidity unit (of ~1e30) can stay
  // unlocked; withdrawing it returns zero tokens.
  creatorPositionPermanentlyLocked:
    !!creatorPos && BigInt(creatorPos.vestedLiquidity) === 0n && unlockedDust <= 1n &&
    BigInt(creatorPos.permanentLockedLiquidity) > 0n && dustWithdraw.outA === "0" && dustWithdraw.outB === "0",
  vaultPositionFullyPermanentlyLocked:
    !!vaultPos && vaultPos.unlockedLiquidity === "0" && vaultPos.vestedLiquidity === "0" && BigInt(vaultPos.permanentLockedLiquidity) > 0n,
  creatorHoldsHalfOfPoolLiquidity: creatorShareBps >= 4990 && creatorShareBps <= 5010,
  appLibFindsCreatorPosition:
    claim.libReadBefore.owner === admin.publicKey.toBase58() && claim.libReadBefore.position?.address === creatorPos?.position &&
    claim.libReadBefore.dammPool === dammPool.toBase58(),
  feesAccruedToCreatorPosition:
    BigInt(creatorAfterTrade.unclaimedB) > 0n &&
    BigInt(creatorAfterTrade.unclaimedB) >= expectedCreatorFee - 1n && BigInt(creatorAfterTrade.unclaimedB) <= expectedCreatorFee + 1n,
  feesAccruedToVaultPosition: BigInt(vaultAfterTrade.unclaimedB) > 0n,
  claimMovedFeesToCreatorAccounts:
    claimedQuote > 0n && claimedQuote === BigInt(claim.libReadBefore.position.unclaimedB) &&
    claimedBase === BigInt(claim.libReadBefore.position.unclaimedA) &&
    BigInt(claim.poolQuoteVaultBefore) - BigInt(claim.poolQuoteVaultAfter) === claimedQuote,
  positionRecordsTheClaim: !!creatorPos && BigInt(creatorPos.claimedB) === claimedQuote,
  nothingLeftToClaim: claim.libReadAfter.position?.unclaimedA === "0" && claim.libReadAfter.position?.unclaimedB === "0",
  liquidityStillLockedAfterClaim: !!creatorPos && creatorPos.permanentLockedLiquidity === creatorAfterTrade.permanentLockedLiquidity,
  flagshipUntouched: st.pool !== FLAGSHIP_POOL && st.dammPool !== FLAGSHIP_POOL,
};
Object.assign(st, {
  finalRead: {
    dammPoolLiquidity: poolLiquidity.toString(),
    positions: final.positions,
    allPositionsByPool,
    creatorShareBps,
    creatorFeeShareBps: claim.libReadBefore.position.feeShareBps,
    creatorUnlockedDust: unlockedDust.toString(),
    dustWithdrawQuote: dustWithdraw,
    expectedCreatorFee: expectedCreatorFee.toString(),
    claimed: { quote: claimedQuote.toString(), base: claimedBase.toString() },
  },
  checks,
});
save();
console.log({ creatorShareBps, lpFeeB: lpFeeB.toString(), expectedCreatorFee: expectedCreatorFee.toString(), claimed: claimedQuote.toString(), checks });
for (const [name, ok] of Object.entries(checks)) assert.ok(ok, `Verification failed: ${name}`);
st.complete = true;
st.completedAt = new Date().toISOString();
save();
console.log(`\nAll checks passed. ${out}`);
