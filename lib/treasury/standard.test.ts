import test from "node:test";
import assert from "node:assert/strict";
import { PAYOUT_BOT, standardConfigProblem, type StandardConfigFields } from "./standard.ts";

const VAULT = "5XMFEnW8Ur3EswbFhCr1LEKtHDioTs8oeQEHKyPHNpp5";
// Sonata's launch settings, as the treasury program reads them from a Meteora config.
const standard = (): StandardConfigFields => ({
  tokenType: 0,
  tokenUpdateAuthority: 1,
  fixedTokenSupplyFlag: 1,
  migrationOption: 1,
  migrationFeeOption: 2,
  migrationFeePercentage: 0,
  creatorMigrationFeePercentage: 0,
  partnerLiquidityPercentage: 0,
  creatorLiquidityPercentage: 0,
  partnerPermanentLockedLiquidityPercentage: 50,
  creatorPermanentLockedLiquidityPercentage: 50,
  partnerLiquidityVestingInfo: { isInitialized: 0 },
  creatorLiquidityVestingInfo: { isInitialized: 0 },
  lockedVestingConfig: { amountPerPeriod: 0n, cliffUnlockAmount: 0n },
  creatorTradingFeePercentage: 0,
  collectFeeMode: 0,
  leftoverReceiver: VAULT,
  poolFees: {
    baseFee: { baseFeeMode: 0, firstFactor: 0, cliffFeeNumerator: 12_500_000n },
    dynamicFee: { initialized: 0, maxVolatilityAccumulator: 0, binStep: 0, variableFeeControl: 0 },
  },
});

test("Sonata's launch settings are standard, with or without the airdrop", () => {
  assert.equal(standardConfigProblem(standard(), VAULT), null);
  assert.equal(standardConfigProblem({ ...standard(), leftoverReceiver: PAYOUT_BOT }, VAULT), null);
});

test("rug-capable settings are named, one rule at a time", () => {
  const cases: [string, (c: StandardConfigFields) => void, RegExp][] = [
    ["unlocked creator liquidity", (c) => ((c.creatorLiquidityPercentage = 50), (c.creatorPermanentLockedLiquidityPercentage = 0)), /not locked/],
    ["mint authority kept", (c) => (c.tokenUpdateAuthority = 3), /can still be changed/],
    ["vesting", (c) => (c.lockedVestingConfig.amountPerPeriod = 1n), /vest/],
    ["creator fee", (c) => (c.creatorTradingFeePercentage = 50), /separate trading fee/],
    ["leftover elsewhere", (c) => (c.leftoverReceiver = "11111111111111111111111111111111"), /leftover/],
    ["fee above 3%", (c) => (c.poolFees.baseFee.cliffFeeNumerator = 30_000_001n), /above 3%/],
    ["rate limiter", (c) => (c.poolFees.baseFee.baseFeeMode = 2), /changes over time/],
    ["volatility fee too high", (c) => Object.assign(c.poolFees.dynamicFee, { initialized: 1, maxVolatilityAccumulator: 1_000_000, binStep: 100, variableFeeControl: 1_000_000 }), /volatility/],
  ];
  for (const [name, mutate, reason] of cases) {
    const c = standard();
    mutate(c);
    assert.match(standardConfigProblem(c, VAULT) ?? "standard", reason, name);
  }
});
