// Stock Floor arithmetic, mirroring the treasury program's redeem instruction:
// a holder who burns `burn` base units receives floor * burn / supply quote
// units, rounded down. Base tokens have 6 decimals.
export const BASE_DECIMALS = 6;
const ONE_MILLION_TOKENS = 1_000_000n * 10n ** BigInt(BASE_DECIMALS);

export function floorShare(floor: bigint, burn: bigint, supply: bigint) {
  if (floor <= 0n || burn <= 0n || supply <= 0n) return 0n;
  return (floor * (burn > supply ? supply : burn)) / supply;
}

// Quote units backing one million whole community tokens.
export function floorPerMillion(floor: bigint, supply: bigint) {
  return floorShare(floor, ONE_MILLION_TOKENS, supply);
}

// What the next collect-and-split adds to the floor. The program pays out
// unallocated * 5000 / 10000 (rounded down) and retains the remainder.
export function pendingFloor(uncollected: bigint, unallocated: bigint) {
  const total = uncollected + unallocated;
  return total - (total * 5_000n) / 10_000n;
}
