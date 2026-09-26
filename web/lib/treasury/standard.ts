// Sonata's standard launch settings, the ones lib/treasury/dbc-preview.ts builds.
// The treasury program refuses to register a market whose Meteora config differs
// (protocol/programs/stockroom-treasury: check_standard_config); the app applies the same rules to
// markets registered before that check existed, so none can be rugged through
// its config: no liquidity the creator can pull after graduation, no token that
// can still be minted, no tokens vesting to anyone, no hidden creator fee, and
// no fee that can climb against traders.

export const PAYOUT_BOT = "Fb83XLPdUM11FrUUBNaB1JXJ2feJacNkcPGUzP8dtGz";
// 3% of Meteora's 1e9 fee denominator: the highest fee the launch page offers.
export const MAX_BASE_FEE_NUMERATOR = 30_000_000n;

type Num = number | bigint | { toString(): string };
type Key = { toBase58(): string } | string;
export type StandardConfigFields = {
  tokenType: number;
  tokenUpdateAuthority: number;
  fixedTokenSupplyFlag: number;
  migrationOption: number;
  migrationFeeOption: number;
  migrationFeePercentage: number;
  creatorMigrationFeePercentage: number;
  partnerLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
  partnerPermanentLockedLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  partnerLiquidityVestingInfo: { isInitialized: number };
  creatorLiquidityVestingInfo: { isInitialized: number };
  lockedVestingConfig: { amountPerPeriod: Num; cliffUnlockAmount: Num };
  creatorTradingFeePercentage: number;
  collectFeeMode: number;
  leftoverReceiver: Key;
  poolFees: {
    baseFee: { baseFeeMode: number; firstFactor: number; cliffFeeNumerator: Num };
    dynamicFee: { initialized: number; maxVolatilityAccumulator: number; binStep: number; variableFeeControl: number };
  };
};

const big = (v: Num) => BigInt(v.toString());
const key = (k: Key) => (typeof k === "string" ? k : k.toBase58());

/** The first rule a config breaks, in plain words, or null when it is Sonata's standard. */
export function standardConfigProblem(c: StandardConfigFields, vault: string): string | null {
  const base = c.poolFees.baseFee,
    dyn = c.poolFees.dynamicFee;
  if (c.tokenType !== 0) return "the token is not a standard SPL token";
  if (c.tokenUpdateAuthority !== 1) return "the token's metadata or supply can still be changed";
  if (c.fixedTokenSupplyFlag !== 1) return "the token supply is not fixed";
  if (c.migrationOption !== 1 || c.migrationFeeOption !== 2) return "it does not graduate into a 1% Meteora DAMM v2 pool";
  if (c.migrationFeePercentage !== 0 || c.creatorMigrationFeePercentage !== 0) return "it takes a fee at graduation";
  if (c.partnerLiquidityPercentage !== 0 || c.creatorLiquidityPercentage !== 0)
    return "part of its graduated liquidity is not locked";
  if (c.partnerPermanentLockedLiquidityPercentage + c.creatorPermanentLockedLiquidityPercentage !== 100)
    return "its graduated liquidity is not 100% locked";
  if (c.partnerLiquidityVestingInfo.isInitialized !== 0 || c.creatorLiquidityVestingInfo.isInitialized !== 0)
    return "its graduated liquidity vests to someone";
  if (big(c.lockedVestingConfig.amountPerPeriod) !== 0n || big(c.lockedVestingConfig.cliffUnlockAmount) !== 0n)
    return "tokens vest to someone";
  if (c.creatorTradingFeePercentage !== 0) return "the creator takes a separate trading fee";
  if (c.collectFeeMode !== 0) return "fees are not collected in the stock";
  if (![vault, PAYOUT_BOT].includes(key(c.leftoverReceiver))) return "leftover tokens go to someone else";
  if (base.baseFeeMode > 1 || base.firstFactor !== 0) return "its fee changes over time or with trade size";
  if (big(base.cliffFeeNumerator) > MAX_BASE_FEE_NUMERATOR) return "its fee is above 3%";
  if (dyn.initialized !== 0) {
    // Meteora's variable fee at its peak: ceil((max accumulator × bin step)² × control / 1e11).
    const peak = (BigInt(dyn.maxVolatilityAccumulator) * BigInt(dyn.binStep)) ** 2n * BigInt(dyn.variableFeeControl);
    const maxVariable = (peak + 99_999_999_999n) / 100_000_000_000n;
    if (maxVariable * 5n > big(base.cliffFeeNumerator)) return "its volatility fee can rise more than 20% above the base fee";
  }
  return null;
}
