// Graduation progress for a DBC pool, from the pool's own quote reserve and its
// config's migration threshold. Every market has its own threshold, so this is
// never computed against a hard-coded target.
export type GraduationStage = "curve" | "complete" | "graduated";

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
  return {
    stage,
    bps,
    remaining: complete ? 0n : threshold - quoteReserve,
  };
}

/** One decimal place, rounded down: 2307 bps -> "23.0%". */
export const formatProgress = (bps: number) =>
  `${(Math.floor(bps / 10) / 10).toFixed(1)}%`;
