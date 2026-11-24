/**
 * Simple return — indexed from the first portfolio value.
 *
 *   index_t = V_t / V_0 × 100
 *
 * A cash-flow-naive index: a deposit inflates it. Kept as the honest fallback
 * for histories where no rate can be solved, and as the baseline the TWR/MWR
 * series are compared against.
 */
export function buildSimple(values: number[]): number[] {
  const v0 = values[0] ?? 0
  if (v0 === 0) return values.map(() => 100)
  return values.map((v) => Math.round((v / v0) * 10000) / 100)
}