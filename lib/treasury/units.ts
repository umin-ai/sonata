export function parseUnits(value: string, decimals = 8): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    throw Error("Enter a positive decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw Error(`Use at most ${decimals} decimal places.`);
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if (raw <= 0n || raw > 18446744073709551615n)
    throw Error("Amount is outside the token range.");
  return raw;
}
export function formatUnits(value: string | bigint, decimals = 8) {
  const raw = BigInt(value),
    scale = 10n ** BigInt(decimals);
  const fraction = (raw % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${raw / scale}${fraction ? `.${fraction}` : ""}`;
}
