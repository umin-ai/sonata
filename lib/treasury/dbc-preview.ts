// One source of curve parameters for both the launch preview and the deployed
// config, so what a creator reviews is what createConfigAndPool receives.
// 1.25% is the default for new launches; the lower tiers stay valid for existing
// scripts and configs.
export const FEE_BPS_CHOICES = [25, 50, 100, 125, 200, 300] as const;

// Curve shapes, like Ember's. Same start, same graduation cap, same supply: the
// shape only sets how fast the price moves per dollar at each stage. Classic is
// Meteora's single constant-product curve; the others spread liquidity over 16
// segments with rising or falling weights (buildCurveWithLiquidityWeights).
export const CURVE_SHAPES = ["classic", "steady", "rocket", "whaleWall"] as const;
export type CurveShape = (typeof CURVE_SHAPES)[number];
const SHAPE_GROWTH: Record<Exclude<CurveShape, "classic">, number> = {
  steady: 1.08, // a slightly livelier start, a deeper pool at graduation
  rocket: 1.2, // thin at the start, the deepest pool at graduation
  whaleWall: 0.85, // thick at the start, the thinnest pool at graduation
};
// Graduation Airdrop: this share of supply is kept off the curve, withdrawn at
// graduation by Sonata's payout bot and airdropped to holders.
export const AIRDROP_PERCENT = 5;
export type CurveOptions = { shape?: CurveShape; volatility?: boolean; airdrop?: boolean };

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
  options: CurveOptions = {},
) {
  const {
    buildCurveWithMarketCap,
    buildCurveWithLiquidityWeights,
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
  const shape = options.shape ?? "classic";
  if (!(CURVE_SHAPES as readonly string[]).includes(shape)) throw Error("Unknown curve shape.");
  const airdrop = options.airdrop ? (1_000_000_000 * AIRDROP_PERCENT) / 100 : 0;
  const params = (leftover: number) => ({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.EIGHT,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear as typeof BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: fee,
          endingFeeBps: fee,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      // Meteora's dynamic fee: up to 20% above the base fee while the price moves fast.
      dynamicFeeEnabled: !!options.volatility,
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
    // At graduation the locked DAMM v2 liquidity is split 50/50: one position for
    // the Sonata vault (partner) and one owned by the creator, who keeps
    // claiming its trading fees after graduation. Both stay permanently locked.
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
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
  if (shape === "classic") return buildCurveWithMarketCap(params(airdrop));
  const liquidityWeights = Array.from({ length: 16 }, (_, i) => SHAPE_GROWTH[shape] ** i);
  // The 16-segment builder rounds its supply up slightly and needs that much left
  // over: at most 10,000 tokens (0.001%) at Sonata's price levels.
  if (airdrop) return buildCurveWithLiquidityWeights({ ...params(airdrop), liquidityWeights });
  for (const dust of [10, 100, 1_000, 10_000, 100_000])
    try {
      return buildCurveWithLiquidityWeights({ ...params(dust), liquidityWeights });
    } catch (e) {
      if (!/leftOverDelta/.test((e as Error).message)) throw e;
    }
  throw Error("This curve shape does not fit this stock's price. Use Classic.");
}

export async function previewDbc(
  initial: number,
  target: number,
  fee: number,
  options: CurveOptions = {},
) {
  const params = await buildCurveParams(initial, target, fee, options);
  return {
    quoteThreshold: params.migrationQuoteThreshold.toString(),
    segments: params.curve.length,
    // For quoting a dev buy on the fresh pool (see buyOut in graduation.ts).
    sqrtStartPrice: params.sqrtStartPrice.toString(),
    curve: params.curve.map((c) => ({ sqrtPrice: c.sqrtPrice.toString(), liquidity: c.liquidity.toString() })),
    initial,
    target,
    fee,
  };
}
