// SPDX-License-Identifier: GPL-3.0-or-later
// A market registers with Sonata only if its Meteora config uses Sonata's
// standard launch settings (check_standard_config). A creator who builds a config
// outside the launch page, naming the Vault as fee claimer, cannot list a market
// whose liquidity can be pulled, whose token can still be minted, whose tokens
// vest to someone, or whose fees are hidden or can climb against traders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { getTransactionDecoder } from "@solana/kit";
import { Keypair, PublicKey, Connection, Transaction, SystemProgram } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";

const idl = JSON.parse(readFileSync("target/idl/stockroom_treasury.json")),
  id = new PublicKey(idl.address);
const PAYOUT_BOT = new PublicKey("Fb83XLPdUM11FrUUBNaB1JXJ2feJacNkcPGUzP8dtGz");

// Registers the flagship pool's real Devnet config (a standard Sonata launch),
// changed by `mutate`, and returns the result.
async function register(mutate = () => {}) {
  const { createDbcProgram } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const fixture = JSON.parse(readFileSync("tests/fixtures/treasury-dbc.json"));
  const svm = new LiteSVM();
  svm.addProgramFromFile(id.toBase58(), "target/deploy/stockroom_treasury.so");
  const creator = Keypair.generate();
  svm.airdrop(creator.publicKey.toBase58(), 10_000_000_000n);
  const conn = new Connection("http://127.0.0.1:8899"),
    program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(creator), {})),
    dbc = createDbcProgram(conn).program;
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("stockroom")], id),
    pool = new PublicKey(fixture.pool.address),
    config = new PublicKey(fixture.config.address),
    [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury"), pool.toBuffer()], id);
  const encode = (name, value) => {
    const info = dbc.coder.accounts.accountLayouts.get(name),
      buffer = Buffer.alloc(4096),
      size = info.layout.encode(value, buffer);
    return Buffer.concat([Buffer.from(info.discriminator), buffer.subarray(0, size)]);
  };
  const decodedPool = dbc.coder.accounts.decode("virtualPool", Buffer.from(fixture.pool.data, "base64"));
  (decodedPool.poolState ?? decodedPool).creator = creator.publicKey;
  const c = dbc.coder.accounts.decode("poolConfig", Buffer.from(fixture.config.data, "base64"));
  c.feeClaimer = vault;
  mutate(c, { vault, attacker: Keypair.generate().publicKey });
  const put = (row, data) =>
    svm.setAccount({
      address: row.address,
      programAddress: row.owner,
      lamports: BigInt(row.lamports),
      executable: false,
      data,
      space: BigInt(data.length),
    });
  for (const n of ["quoteMint", "baseMint"]) put(fixture[n], Buffer.from(fixture[n].data, "base64"));
  put(fixture.pool, encode("virtualPool", decodedPool));
  put(fixture.config, encode("poolConfig", c));
  const send = async (ix) => {
    svm.expireBlockhash();
    const tx = new Transaction({ feePayer: creator.publicKey, recentBlockhash: svm.latestBlockhash() }).add(await ix);
    tx.sign(creator);
    return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  };
  const initVault = await send(
    program.methods.initVault().accounts({ vault, admin: creator.publicKey, systemProgram: SystemProgram.programId }).instruction(),
  );
  assert(!(initVault instanceof FailedTransactionMetadata), "vault init failed");
  const res = await send(
    program.methods
      .initTreasury({ standard: {} }, creator.publicKey)
      .accounts({
        vault,
        treasury,
        pool,
        config,
        quoteMint: new PublicKey(fixture.quoteMint.address),
        baseMint: new PublicKey(fixture.baseMint.address),
        creator: creator.publicKey,
        payer: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );
  return { res, registered: svm.getAccount(treasury.toBase58()).exists };
}
const refused = async (why, mutate) => {
  const { res, registered } = await register(mutate);
  assert(res instanceof FailedTransactionMetadata, `${why}: should be refused`);
  assert.match(res.meta().logs().join("\n"), /NonStandardConfig/, why);
  assert.equal(registered, false, why);
};

test("Sonata's standard config registers, including a graduation airdrop to the payout bot", async () => {
  assert.equal((await register()).registered, true);
  assert.equal((await register((c) => (c.leftoverReceiver = PAYOUT_BOT))).registered, true);
});

test("liquidity the creator could pull after graduation is refused", async () => {
  await refused("unlocked creator liquidity", (c) => {
    c.creatorPermanentLockedLiquidityPercentage = 0;
    c.partnerPermanentLockedLiquidityPercentage = 50;
    c.creatorLiquidityPercentage = 50;
  });
  await refused("unlocked partner liquidity", (c) => {
    c.partnerPermanentLockedLiquidityPercentage = 0;
    c.partnerLiquidityPercentage = c.partnerLiquidityPercentage + 50;
  });
  await refused("liquidity vesting", (c) => (c.creatorLiquidityVestingInfo.isInitialized = 1));
});

test("a token that can still be minted or changed, or vests to someone, is refused", async () => {
  await refused("creator update and mint authority", (c) => (c.tokenUpdateAuthority = 3));
  await refused("creator update authority", (c) => (c.tokenUpdateAuthority = 0));
  await refused("Token-2022 base", (c) => (c.tokenType = 1));
  await refused("not a fixed supply", (c) => (c.fixedTokenSupplyFlag = 0));
  await refused("locked vesting", (c) => (c.lockedVestingConfig.amountPerPeriod = new anchor.BN(1)));
  await refused("cliff unlock", (c) => (c.lockedVestingConfig.cliffUnlockAmount = new anchor.BN(1)));
  await refused("leftover to an attacker", (c, { attacker }) => (c.leftoverReceiver = attacker));
});

test("hidden creator fees and fees that climb against traders are refused", async () => {
  await refused("creator trading fee", (c) => (c.creatorTradingFeePercentage = 50));
  await refused("creator migration fee", (c) => (c.creatorMigrationFeePercentage = 50));
  await refused("migration fee", (c) => (c.migrationFeePercentage = 5));
  await refused("fee above 3%", (c) => (c.poolFees.baseFee.cliffFeeNumerator = new anchor.BN(30_000_001)));
  await refused("rate limiter", (c) => (c.poolFees.baseFee.baseFeeMode = 2));
  await refused("fee schedule", (c) => (c.poolFees.baseFee.firstFactor = 10));
  await refused("fees in the token", (c) => (c.collectFeeMode = 1));
  await refused("DAMM v1 migration", (c) => (c.migrationOption = 0));
  await refused("a 6% graduated pool", (c) => (c.migrationFeeOption = 5));
  await refused("an unbounded volatility fee", (c) => {
    Object.assign(c.poolFees.dynamicFee, { initialized: 1, maxVolatilityAccumulator: 1_000_000, binStep: 100, variableFeeControl: 1_000_000 });
  });
});

test("a volatility fee of at most 20% of the base fee is standard", async () => {
  const { buildCurveWithMarketCap, getDynamicFeeParams } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  assert.equal(typeof getDynamicFeeParams, "function");
  const { registered } = await register((c) => {
    const base = BigInt(c.poolFees.baseFee.cliffFeeNumerator.toString());
    const bps = Number((base * 10_000n) / 1_000_000_000n);
    const d = getDynamicFeeParams(bps);
    Object.assign(c.poolFees.dynamicFee, {
      initialized: 1,
      maxVolatilityAccumulator: d.maxVolatilityAccumulator,
      binStep: d.binStep,
      variableFeeControl: d.variableFeeControl,
      filterPeriod: d.filterPeriod,
      decayPeriod: d.decayPeriod,
      reductionFactor: d.reductionFactor,
      binStepU128: d.binStepU128,
    });
  });
  assert.equal(registered, true);
  assert.ok(buildCurveWithMarketCap);
});
