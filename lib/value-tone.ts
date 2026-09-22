/** Directional changes only; fees, debt rates and absolute prices are not gains. */
export function valueTone(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) || value === 0
    ? 'sr-change-neutral'
    : value > 0 ? 'sr-change-positive' : 'sr-change-negative';
}
