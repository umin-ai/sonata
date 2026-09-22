// One source of curve parameters for both the launch preview and the deployed
// config, so what a creator reviews is what createConfigAndPool receives.
export const FEE_BPS_CHOICES = [25, 50, 100, 200, 300] as const;

export function assertCurveInputs(initial: number, target: number, fee: number) {
  if (
    ![initial, target, fee].every(Number.isFinite) ||
    initial < 0.01 ||
    target <= initial ||
    target > 1000000 ||
    !(FEE_BPS_CHOICES as readonly number[]).includes(fee)
  )
    throw Error(
      "Use positive market caps with graduation above the starting value.",
    );
}

export async function buildCurveParams(
  initial: number,
  target: number,
  fee: number,
) {
  const {
    buildCurveWithMarketCap,
    TokenType,
    TokenDecimal,
    TokenAuthorityOption,
    BaseFeeMode,
    CollectFeeMode,
    MigrationOption,
    MigrationFeeOption,
    ActivationType,
  } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  assertCurveInputs(initial, target, fee);
  return buildCurveWithMarketCap({
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
          startingFeeBps: fee,
          endingFeeBps: fee,
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
    initialMarketCap: initial,
    migrationMarketCap: target,
  });
}

export async function previewDbc(
  initial: number,
  target: number,
  fee: number,
) {
  const params = await buildCurveParams(initial, target, fee);
  return {
    quoteThreshold: params.migrationQuoteThreshold.toString(),
    segments: params.curve.length,
    initial,
    target,
    fee,
  };
}
