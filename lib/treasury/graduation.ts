// Graduation progress for a DBC pool, from the pool's own quote reserve and its
// config's migration threshold. Every market has its own threshold, so this is
// never computed against a hard-coded target.
export type GraduationStage = "curve" | "complete" | "graduated";
// On the curve, a market "heats up" at a third of its threshold and is "on fire"
// at two thirds, the same milestones Raydium LaunchLab shows.
export type Heat = "new" | "heating" | "fire" | "complete" | "graduated";

export function graduationProgress(
  quoteReserve: bigint,
  threshold: bigint,
  migrated: boolean,
) {
  if (threshold <= 0n) throw Error("Pool config has no migration threshold.");
  const complete = quoteReserve >= threshold;
  // Floor, so the display cannot reach 100% before the curve actually completes.
  const bps = complete ? 10_000 : Number((quoteReserve * 10_000n) / threshold);
  const stage: GraduationStage = migrated
    ? "graduated"
    : complete
      ? "complete"
      : "curve";
  const heat: Heat =
    stage !== "curve"
      ? stage
      : quoteReserve * 3n >= threshold * 2n
        ? "fire"
        : quoteReserve * 3n >= threshold
          ? "heating"
          : "new";
  return {
    stage,
    heat,
    bps,
    remaining: complete ? 0n : threshold - quoteReserve,
  };
}

export type CurvePoint = { sqrtPrice: bigint; liquidity: bigint };

/**
 * The curve's sqrt price (Q64) once `quote` raw units have been bought into it,
 * with Meteora DBC's own math: a segment from sqrt price a to b with liquidity L
 * holds L * (b - a) / 2^128 quote, rounded up as the program rounds amounts in,
 * and a partial amount q moves a to a + q * 2^128 / L. Segment i runs from the
 * previous point (or sqrtStart) up to curve[i].sqrtPrice; unused points are zero.
 * Rounding up matters at a segment's end: rounded down, the threshold would spill
 * one raw unit into the next, much thinner segment and overshoot the price.
 */
export function sqrtPriceAtQuote(quote: bigint, sqrtStart: bigint, curve: CurvePoint[]) {
  let price = sqrtStart,
    left = quote;
  for (const { sqrtPrice, liquidity } of curve) {
    if (sqrtPrice === 0n || liquidity === 0n) break;
    const holds = (liquidity * (sqrtPrice - price) + (1n << 128n) - 1n) >> 128n;
    if (left <= holds) return price + (left << 128n) / liquidity;
    left -= holds;
    price = sqrtPrice;
  }
  return price;
}

/** Market cap in whole quote tokens at a Q64 sqrt price, for a raw base supply. */
export function marketCapAt(sqrtPrice: bigint, baseSupply: bigint, quoteDecimals = 8) {
  return Number((sqrtPrice * sqrtPrice * baseSupply) >> 64n) / 2 ** 64 / 10 ** quoteDecimals;
}

/**
 * Market cap now and at each milestone: heating up and on fire at a third and two
 * thirds of the threshold (read off the curve), and graduation at the config's
 * migration price, which is where DBC opens the DAMM v2 pool.
 */
export function milestoneCaps(
  sqrtPrice: bigint,
  sqrtStart: bigint,
  curve: CurvePoint[],
  threshold: bigint,
  migrationSqrtPrice: bigint,
  baseSupply: bigint,
) {
  const at = (quote: bigint) => marketCapAt(sqrtPriceAtQuote(quote, sqrtStart, curve), baseSupply);
  return {
    current: marketCapAt(sqrtPrice, baseSupply),
    milestones: [at(threshold / 3n), at((threshold * 2n) / 3n), marketCapAt(migrationSqrtPrice, baseSupply)] as [number, number, number],
  };
}

/** One decimal place, rounded down: 2307 bps -> "23.0%". */
export const formatProgress = (bps: number) =>
  `${(Math.floor(bps / 10) / 10).toFixed(1)}%`;

/**
 * Base tokens (raw) that a buy of `quoteIn` raw quote units gets from a pool at
 * `sqrtPrice`, with Meteora DBC's own swap math: the trading fee is taken from
 * the input first (fee bps × 100,000 over 1e9, rounded up), then each segment
 * gives L × (b − a) ÷ (a × b) base for moving its sqrt price from a to b,
 * rounded down. Used to quote a dev buy before its pool exists.
 */
export function buyOut(quoteIn: bigint, feeBps: number, sqrtPrice: bigint, curve: CurvePoint[]) {
  const fee = (quoteIn * BigInt(feeBps) * 100_000n + 999_999_999n) / 1_000_000_000n;
  let left = quoteIn - fee,
    price = sqrtPrice,
    out = 0n;
  for (const { sqrtPrice: upper, liquidity } of curve) {
    if (upper === 0n || liquidity === 0n || left === 0n) break;
    if (upper <= price) continue;
    const holds = (liquidity * (upper - price) + (1n << 128n) - 1n) >> 128n;
    const next = left < holds ? price + (left << 128n) / liquidity : upper;
    out += (liquidity * (next - price)) / (price * next);
    left = left < holds ? 0n : left - holds;
    price = next;
  }
  return { out, fee, unspent: left };
}
