/** returnColumns.test.ts (§53.1) — MWR/XIRR divergence guard */
import { describe, expect, it } from "vitest"
import { buildMwr, buildSimple } from "./returnColumns.js"

describe("buildMwr XIRR guard (§53.1)", () => {
  it("Crypto-shaped history (tiny capital + one deposit that moons) stays finite and within the column bound", () => {
    // 1 PLN of capital, flat, then a 10 000 PLN deposit that "grows" 2 000 000x
    // in six months. The unguarded Newton solver "converges" to r ≈ 1.7e10 on
    // this shape and Math.pow(1+r, t) produced cumulative_mwr ≈ 1.85e12 —
    // exactly the PROD `numeric field overflow` on the Crypto portfolio
    // (numeric(20,8) caps at ~1e12).
    const dates = ["2024-01-01", "2024-04-01", "2024-07-01", "2025-01-01"]
    const values = [1, 1, 1, 20_000_001]
    const flows = [0, 0, 10_000, 0]

    const mwr = buildMwr(values, flows, dates)
    expect(mwr).toHaveLength(4)
    for (const v of mwr) {
      expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(v)).toBeLessThan(1e12)
    }
    // The guarded solver must fall back to the simple index (no garbage curve).
    expect(mwr).toEqual(buildSimple(values))
  })

  it("healthy mixed-flow history still yields a real MWR (no fallback regression)", () => {
    const dates = ["2024-01-01", "2024-04-01", "2024-07-01", "2024-10-01", "2025-01-01"]
    const values = [100, 105, 205, 210, 215]
    const flows = [0, 0, 100, 0, 0]

    const mwr = buildMwr(values, flows, dates)
    // XIRR ≈ 10%/yr on this shape → end index ≈ 110 (the buildSimple fallback
    // would give 215, so this pins the real MWR path).
    expect(mwr[0]).toBe(100)
    expect(mwr[4]).toBeCloseTo(110.06, 0)
    // Mid-point after the deposit: MWR ≈ 104.9, NOT the simple index 205.
    expect(mwr[2]).toBeCloseTo(104.88, 0)
  })
})
