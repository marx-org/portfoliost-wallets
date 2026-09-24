import { afterEach, describe, expect, it } from "vitest"
import { makeHarness } from "../routes/test-utils.js"
import { snapshotRate } from "./valuation.js"
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"

afterEach(() => unmockInstrumentsFx())

async function seedWorld() {
  const h = await makeHarness("valuer")
  // plan §48.3 — FX data lives in instruments; the stand-in serves the
  // EUR-based demo closes over the internal route.
  mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 }, asOf: "2026-08-21" })
  return h
}

describe("snapshotRate (D21)", () => {
  it("same-currency is 1 even without instruments; manual wins verbatim", async () => {
    expect((await snapshotRate("Bearer t", "USD", "USD")).rate).toBe(1)
    const m = await snapshotRate("Bearer t", "EUR", "USD", 1.23)
    expect(m).toEqual({ rate: 1.23, source: "manual" })
  })

  it("auto resolves via instruments' fx_rates", async () => {
    const h = await seedWorld()
    void h
    const r = await snapshotRate("Bearer t", "EUR", "USD")
    expect(r.source).toBe("automatic")
    expect(r.rate).toBeCloseTo(1.08, 8)
  })
})
