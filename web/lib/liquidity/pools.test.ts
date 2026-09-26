import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { maximum } from "./math.ts";
import { readFileSync } from "node:fs";
import {
  DAMM_V2_PROGRAM,
  DBC_PROGRAM,
  baseFeeBps,
  depositLimits,
  displayAmount,
  RESERVE_POOL,
  poolProblem,
  poolValue,
  priceRatioBps,
  reservePoolProblem,
  positionProblem,
  sharePercent,
  underBuffer,
  type PoolFacts,
  type PoolMarket,
} from "./pools.ts";

// A graduated Devnet market and its DAMM v2 pool, as read on 2026-09-24
// (stockroom-protocol/artifacts/creator-position-proof.json).
const market: PoolMarket = {
  pool: "51fyqN7fdXAdRMagYya92cQ7caSP5FUDJpQvaefKrecR",
  config: "Bvdjyp4t7Z3jpYkMrRvj8cQcArthBhvwDT52222JAAnR",
  baseMint: "FW79M7iwThNrrrLdJ541bqt6eggCdeW8MWbkcWQsSBm3",
  quoteMint: "dXrPEzAYgn5H3y7GwCfCr6okHsWXidpMQrRq33LNTJh",
  vault: "5XMFEnW8Ur3EswbFhCr1LEKtHDioTs8oeQEHKyPHNpp5",
  baseDecimals: 6,
  quoteDecimals: 8,
};
const DAMM_POOL = "3Ye4dSicqEiceZeHFvcbKTMSiiti7nJtf7o2PNeeaaXV";
const OTHER = "GHHFvUXdyEwVgadW7LRnrnVFPhSwWMs5qauNfcYZuH9v";
const facts = (): PoolFacts => ({
  dbcPool: {
    owner: DBC_PROGRAM,
    config: market.config,
    baseMint: market.baseMint,
    isMigrated: 1,
    migrationProgress: 3,
  },
  dbcConfig: { owner: DBC_PROGRAM, quoteMint: market.quoteMint, feeClaimer: market.vault },
  derived: DAMM_POOL,
  address: DAMM_POOL,
  damm: {
    owner: DAMM_V2_PROGRAM,
    tokenAMint: market.baseMint,
    tokenBMint: market.quoteMint,
    tokenAProgram: TOKEN_PROGRAM_ID.toBase58(),
    tokenBProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    poolStatus: 0,
    collectFeeMode: 1,
    liquidity: 4_822_860_871_832_551_968_702_748_650_164n,
    baseFeeMode: 0,
    cliffFeeNumerator: 10_000_000n,
    numberOfPeriod: 0,
    reductionFactor: 0n,
  },
  baseMint: { owner: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, freezeAuthority: false, extensions: [] },
  quoteMint: {
    owner: TOKEN_2022_PROGRAM_ID.toBase58(),
    decimals: 8,
    freezeAuthority: false,
    extensions: [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata],
  },
});

test("the Devnet graduated pool passes every check", () => {
  assert.equal(poolProblem(market, facts()), null);
  // Fees in both tokens is also a claimable mode.
  const both = facts();
  both.damm!.collectFeeMode = 0;
  assert.equal(poolProblem(market, both), null);
});

test("a pool that is not this market's graduated pool is never offered", () => {
  const cases: [string, (f: PoolFacts) => void, RegExp][] = [
    ["DBC pool missing", (f) => (f.dbcPool = null), /not owned by Meteora DBC/],
    ["DBC pool owned elsewhere", (f) => (f.dbcPool!.owner = DAMM_V2_PROGRAM), /not owned by Meteora DBC/],
    ["config owned elsewhere", (f) => (f.dbcConfig!.owner = OTHER), /not owned by Meteora DBC/],
    ["another config", (f) => (f.dbcPool!.config = OTHER), /does not match this market/],
    ["another base mint", (f) => (f.dbcPool!.baseMint = OTHER), /does not match this market/],
    ["another quote mint", (f) => (f.dbcConfig!.quoteMint = OTHER), /does not match this market/],
    ["fees not claimed by the Sonata vault", (f) => (f.dbcConfig!.feeClaimer = OTHER), /does not match this market/],
    ["still on its curve", (f) => (f.dbcPool!.isMigrated = 0), /not graduated/],
    ["migrating, pool not created yet", (f) => (f.dbcPool!.migrationProgress = 2), /not graduated/],
    ["unknown migration fee option", (f) => (f.derived = null), /migration fee option/],
    // Someone else's pool of the same pair, under another DAMM v2 config.
    ["another pool of the same pair", (f) => (f.address = OTHER), /not the pool DBC created/],
    ["pool account missing", (f) => (f.damm = null), /not found/],
    ["pool owned by another program", (f) => (f.damm!.owner = DBC_PROGRAM), /not found/],
    ["tokens swapped", (f) => {
      f.damm!.tokenAMint = market.quoteMint;
      f.damm!.tokenBMint = market.baseMint;
    }, /this market's tokens/],
    ["other token program", (f) => (f.damm!.tokenBProgram = TOKEN_PROGRAM_ID.toBase58()), /token programs/],
    ["disabled", (f) => (f.damm!.poolStatus = 1), /disabled/],
    ["compounding fees", (f) => (f.damm!.collectFeeMode = 2), /fee mode/],
    ["empty", (f) => (f.damm!.liquidity = 0n), /no liquidity/],
    ["fee scheduler still running", (f) => {
      f.damm!.numberOfPeriod = 10;
      f.damm!.reductionFactor = 5n;
    }, /changes over time/],
    ["rate limiter fee", (f) => (f.damm!.baseFeeMode = 2), /changes over time/],
    ["token decimals", (f) => (f.baseMint!.decimals = 9), /Token mint not supported: unexpected decimals/],
    ["freezable token", (f) => (f.baseMint!.freezeAuthority = true), /Token mint not supported: it can be frozen/],
    ["token mint missing", (f) => (f.baseMint = null), /Token mint not supported/],
    ["stock with a transfer fee", (f) => f.quoteMint!.extensions.push(ExtensionType.TransferFeeConfig), /Stock mint not supported: unsupported token extension/],
    ["stock with a transfer hook", (f) => f.quoteMint!.extensions.push(ExtensionType.TransferHook), /unsupported token extension/],
    ["stock on SPL Token", (f) => (f.quoteMint!.owner = TOKEN_PROGRAM_ID.toBase58()), /Stock mint not supported: unexpected token program/],
    ["freezable stock", (f) => (f.quoteMint!.freezeAuthority = true), /Stock mint not supported: it can be frozen/],
  ];
  for (const [name, change, reason] of cases) {
    const f = facts();
    change(f);
    const problem = poolProblem(market, f);
    assert.ok(problem, `${name}: accepted`);
    assert.match(problem, reason, name);
  }
});

// The flagship ROOM market's reserve pool: listed by address, still on its
// curve, and compounding its fees back into the pool.
const reserveMarket: PoolMarket = { ...market, pool: RESERVE_POOL.market };
const reserveFacts = (): PoolFacts => {
  const f = facts();
  f.dbcPool!.isMigrated = 0;
  f.dbcPool!.migrationProgress = 0;
  f.address = RESERVE_POOL.address;
  f.damm!.collectFeeMode = 2;
  return f;
};

test("the ROOM / mSPY reserve pool is listed by its address, not by graduation", () => {
  const manifest = JSON.parse(readFileSync(new URL("./market.json", import.meta.url), "utf8"));
  assert.equal(RESERVE_POOL.address, manifest.pool);
  assert.equal(RESERVE_POOL.market, manifest.sourceMarket);
  assert.equal(reservePoolProblem(reserveMarket, reserveFacts()), null);
  // The graduation check still refuses it, so it never passes as a graduated pool.
  assert.match(poolProblem(reserveMarket, reserveFacts())!, /not graduated/);
  const cases: [string, PoolMarket, (f: PoolFacts) => void, RegExp][] = [
    ["another market", market, () => {}, /not Sonata's reserve pool/],
    ["another pool", reserveMarket, (f) => (f.address = DAMM_POOL), /not Sonata's reserve pool/],
    ["fees not claimed by the vault", reserveMarket, (f) => (f.dbcConfig!.feeClaimer = OTHER), /does not match/],
    ["claimable fees instead of compounding", reserveMarket, (f) => (f.damm!.collectFeeMode = 0), /fee mode/],
    ["tokens of another market", reserveMarket, (f) => (f.damm!.tokenBMint = OTHER), /this market's tokens/],
    ["stock with a transfer fee", reserveMarket, (f) => f.quoteMint!.extensions.push(ExtensionType.TransferFeeConfig), /unsupported token extension/],
    ["pool missing", reserveMarket, (f) => (f.damm = null), /not found/],
  ];
  for (const [name, m, change, reason] of cases) {
    const f = reserveFacts();
    change(f);
    const problem = reservePoolProblem(m, f);
    assert.ok(problem, `${name}: accepted`);
    assert.match(problem, reason, name);
  }
});

test("a pool's price against its market's curve price", () => {
  const q64 = 1n << 64n;
  assert.equal(priceRatioBps(q64, q64), 10_000);
  // Half the square-root price is a quarter of the price.
  assert.equal(priceRatioBps(q64 / 2n, q64), 2_500);
  assert.equal(priceRatioBps(q64 * 2n, q64), 40_000);
  assert.equal(priceRatioBps(q64, 0n), null);
});

test("base fee: fixed fees in bps, anything that changes is rejected", () => {
  const fee = { baseFeeMode: 0, cliffFeeNumerator: 10_000_000n, numberOfPeriod: 0, reductionFactor: 0n };
  assert.equal(baseFeeBps(fee), 100);
  assert.equal(baseFeeBps({ ...fee, cliffFeeNumerator: 2_500_000n }), 25);
  assert.equal(baseFeeBps({ ...fee, baseFeeMode: 1 }), 100);
  // Periods with no reduction still charge the cliff fee throughout.
  assert.equal(baseFeeBps({ ...fee, numberOfPeriod: 5 }), 100);
  assert.equal(baseFeeBps({ ...fee, numberOfPeriod: 5, reductionFactor: 1n }), null);
  assert.equal(baseFeeBps({ ...fee, baseFeeMode: 3 }), null);
  assert.equal(baseFeeBps({ ...fee, cliffFeeNumerator: 0n }), null);
  assert.equal(baseFeeBps({ ...fee, cliffFeeNumerator: 1_000_000_000n }), null);
});

test("only the NFT holder can act on a position of this pool", () => {
  const wallet = "vb4pminVbRa8BRaRCDa7JmAkFx6LSmnwMiDtsKvkXVF";
  const position = { address: OTHER, derived: OTHER, pool: DAMM_POOL, nftMint: market.baseMint };
  const nft = { owner: wallet, amount: 1n, mint: market.baseMint };
  assert.equal(positionProblem(wallet, DAMM_POOL, position, nft), null);
  assert.match(positionProblem(wallet, DAMM_POOL, null, nft)!, /not found/);
  assert.match(positionProblem(wallet, DAMM_POOL, { ...position, pool: OTHER }, nft)!, /not in this pool/);
  assert.match(positionProblem(wallet, DAMM_POOL, { ...position, derived: DAMM_POOL }, nft)!, /not in this pool/);
  assert.match(positionProblem(wallet, DAMM_POOL, position, null)!, /does not hold/);
  assert.match(positionProblem(wallet, DAMM_POOL, position, { ...nft, owner: OTHER })!, /does not hold/);
  assert.match(positionProblem(wallet, DAMM_POOL, position, { ...nft, amount: 0n })!, /does not hold/);
  assert.match(positionProblem(wallet, DAMM_POOL, position, { ...nft, mint: OTHER })!, /does not hold/);
});

test("pool value counts the token side at the pool price", () => {
  // Price 1 (sqrt price 2^64): value is simply A + B.
  assert.equal(poolValue(5n, 7n, 1n << 64n), 12n);
  // The Devnet pool: full range, so both sides are worth about the same.
  const tokenB = 195_028_215n;
  const value = poolValue(350_487_425_262_675n, tokenB, 13_760_439_103_392_168n);
  assert.ok(value > tokenB * 2n - tokenB / 100n && value < tokenB * 2n + tokenB / 100n, `${value}`);
});

test("pool share wording", () => {
  assert.equal(sharePercent(1n, 8n), "12.5%");
  assert.equal(sharePercent(1n, 1n), "100%");
  assert.equal(sharePercent(1_004n, 100_000n), "1%");
  assert.equal(sharePercent(1_250n, 100_000n), "1.25%");
  assert.equal(sharePercent(42n, 1_000_000n), "0.0042%");
  assert.equal(sharePercent(5n, 10_000_000n), "<0.0001%");
  assert.equal(sharePercent(0n, 10n), "0%");
  assert.equal(sharePercent(1n, 0n), "0%");
});

test("display amounts round down and stay short", () => {
  assert.equal(displayAmount(350_487_425_262_675n, 6), "350,487,425.26");
  assert.equal(displayAmount(390_039_999n, 8), "3.9003");
  assert.equal(displayAmount(1_200n, 8), "0.000012");
  assert.equal(displayAmount(1n, 8), "0.00000001");
  assert.equal(displayAmount(100_000_000n, 8), "1");
  assert.equal(displayAmount(0n, 6), "0");
});

test("Max leaves room for the 0.5% slippage buffer", () => {
  for (const balance of [1n, 2n, 199n, 201n, 10_050n, 123_456_789n, 18_446_744_073_709_551_615n]) {
    const most = underBuffer(balance);
    if (most > 0n) assert.ok(maximum(most) <= balance, `${balance}: ${most}`);
    assert.ok(maximum(most + 1n) > balance, `${balance}: ${most} is not the largest`);
  }
  assert.equal(underBuffer(0n), 0n);
});

test("deposit limits say which side the wallet cannot cover", () => {
  const d = depositLimits(1_000_000n, 500n, 1_005_000n, 503n);
  assert.deepEqual(d, { maxA: 1_005_000n, maxB: 503n, short: null });
  assert.equal(depositLimits(1_000_000n, 500n, 1_004_999n, 10_000n).short, "base");
  assert.equal(depositLimits(1_000_000n, 500n, 2_000_000n, 502n).short, "quote");
  assert.throws(() => depositLimits(1n, 0n, 10n, 10n));
});
