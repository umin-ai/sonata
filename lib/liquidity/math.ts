// Integer boundaries for quotes. Keep rounding explicit; never Number(token atoms).
export function minimum(raw: bigint, bps = 50) {
  if (raw <= 0n || !Number.isInteger(bps) || bps < 0 || bps >= 10000)
    throw Error("Invalid minimum-output quote.");
  const result = (raw * BigInt(10000 - bps)) / 10000n;
  return result > 0n ? result : 1n;
}
export function maximum(raw: bigint, bps = 50) {
  if (raw <= 0n || !Number.isInteger(bps) || bps < 0 || bps >= 10000)
    throw Error("Invalid maximum-input quote.");
  return (raw * BigInt(10000 + bps) + 9999n) / 10000n;
}
export function portion(unlocked: bigint, bps: number) {
  if (!Number.isInteger(bps) || bps <= 0 || bps > 10000 || unlocked <= 0n)
    throw Error(
      "Choose a withdrawal between 0 and 100% of an unlocked position.",
    );
  const result = (unlocked * BigInt(bps)) / 10000n;
  if (!result) throw Error("Withdrawal is too small.");
  return result;
}
