// SPDX-License-Identifier: GPL-3.0-or-later
// Mirrors credit-math's integer rounding and virtual shares (see notices).
export function atoms(value: string, decimals: number, max = 100000n): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || value.length > 30)
    throw Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw Error(`Use at most ${decimals} decimal places.`);
  const n =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (n <= 0n || n > max * 10n ** BigInt(decimals))
    throw Error("Amount is outside the demo limit.");
  return n;
}
export const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function assetsForShares(
  s: bigint,
  assets: bigint,
  shares: bigint,
  up = false,
) {
  const n = s * (assets + 1n),
    d = shares + 1000000n;
  return up ? ceilDiv(n, d) : n / d;
}
export function sharesForAssets(
  a: bigint,
  assets: bigint,
  shares: bigint,
  up = false,
) {
  const n = a * (shares + 1000000n),
    d = assets + 1n;
  return up ? ceilDiv(n, d) : n / d;
}
export function accruedDebt(
  debt: bigint,
  aprBps: bigint,
  elapsed: bigint,
  remainder: bigint,
) {
  const wad = 1000000000000000000n;
  const first =
    ((aprBps * wad) / (10000n * 31536000n)) * (elapsed > 0n ? elapsed : 0n);
  const second = (first * first) / (2n * wad),
    third = (second * first) / (3n * wad);
  return debt + (debt * (first + second + third) + remainder) / wad;
}
export const display = (n: bigint, decimals: number) =>
  Number(n) / 10 ** decimals;
