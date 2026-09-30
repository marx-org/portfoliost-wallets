import { afterEach, describe, expect, it } from "vitest"
import { makeHarness } from "../routes/test-utils.js"
import { composePortfolioValue, dominantPriceSource, oldestPriceAsOf, snapshotRate, splitPortfolioValue } from "./valuation.js"
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

/**
 * §70 — a position with no market value is worth an UNKNOWN amount, not its
 * purchase price.
 *
 * `splitPortfolioValue` used to fall back to `quantity × average_cost_basis`,
 * which reported the position's COST as its market value. On PROD that
 * understated the headline by ~261k PLN: 75 of 85 open positions had
 * `market_value` NULL, because the BUY path never sets it and nothing in the
 * scheduled pipeline maintains it — only opening a portfolio refreshes quotes.
 *
 * These tests assert the ABSENCE of a value. A test that asserted the fallback
 * returned *some* number would have passed with the lie in place, which is
 * exactly what the old suite did.
 */
describe("§70: no market value is never valued at cost", () => {
  const toBase = async () => 1 // same-currency, so conversion is identity

  it("excludes an unpriced position and counts it", async () => {
    const r = await splitPortfolioValue(
      toBase,
      [{ marketValue: null, quantity: "10", averageCostBasis: "500", instrumentCurrency: "PLN" }],
      new Map(),
    )
    // 10 × 500 = 5000 of cost must NOT appear
    expect(r.instrumentsValue).toBe(0)
    expect(r.unpricedPositions).toBe(1)
  })

  it("still counts the priced ones alongside it", async () => {
    const r = await splitPortfolioValue(
      toBase,
      [
        { marketValue: "1000", quantity: "10", averageCostBasis: "500", instrumentCurrency: "PLN" },
        { marketValue: null, quantity: "10", averageCostBasis: "500", instrumentCurrency: "PLN" },
        { marketValue: "300", quantity: "1", averageCostBasis: "999", instrumentCurrency: "PLN" },
      ],
      new Map(),
    )
    expect(r.instrumentsValue).toBe(1300)
    expect(r.unpricedPositions).toBe(1)
  })

  it("distinguishes a market value of 0 from a missing one", async () => {
    // 0 is a real value (a delisted/worthless position); null is unknown.
    const zero = await splitPortfolioValue(
      toBase,
      [{ marketValue: "0", quantity: "10", averageCostBasis: "500", instrumentCurrency: "PLN" }],
      new Map(),
    )
    const missing = await splitPortfolioValue(
      toBase,
      [{ marketValue: null, quantity: "10", averageCostBasis: "500", instrumentCurrency: "PLN" }],
      new Map(),
    )
    expect(zero.instrumentsValue).toBe(0)
    expect(zero.unpricedPositions).toBe(0)
    expect(missing.unpricedPositions).toBe(1)
  })

  it("cash is unaffected by unpriced positions", async () => {
    const r = await splitPortfolioValue(
      toBase,
      [{ marketValue: null, quantity: "10", averageCostBasis: "500", instrumentCurrency: "PLN" }],
      new Map([["PLN", 250]]),
    )
    expect(r.cashValue).toBe(250)
    expect(r.totalValue).toBe(250)
  })
})

/**
 * §70.2 — provenance. The aggregate must be able to say how old it is, and
 * "oldest", not "newest".
 */
describe("§70.2: price provenance", () => {
  const at = (iso: string) => new Date(iso)

  it("reports the OLDEST price, not the freshest", () => {
    expect(
      oldestPriceAsOf([
        { marketValue: "1", priceAsOf: at("2026-09-28T09:00:00Z") },
        { marketValue: "1", priceAsOf: at("2026-09-20T09:00:00Z") },
        { marketValue: "1", priceAsOf: at("2026-09-27T09:00:00Z") },
      ]),
    ).toBe("2026-09-20T09:00:00.000Z")
  })

  it("ignores unpriced positions rather than reporting a false age", () => {
    // an unpriced row has no price to be stale; it is counted separately
    expect(
      oldestPriceAsOf([
        { marketValue: "1", priceAsOf: at("2026-09-28T09:00:00Z") },
        { marketValue: null, priceAsOf: null },
      ]),
    ).toBe("2026-09-28T09:00:00.000Z")
  })

  it("is null when nothing could be priced", () => {
    expect(oldestPriceAsOf([{ marketValue: null, priceAsOf: null }])).toBeNull()
    expect(dominantPriceSource([{ marketValue: null, priceSource: null }])).toBeNull()
  })

  it("'fallback' wins over 'quote' — one remembered price is worth surfacing", () => {
    expect(
      dominantPriceSource([
        { marketValue: "1", priceSource: "quote" },
        { marketValue: "1", priceSource: "fallback" },
      ]),
    ).toBe("fallback")
    expect(
      dominantPriceSource([
        { marketValue: "1", priceSource: "quote" },
        { marketValue: "1", priceSource: "quote" },
      ]),
    ).toBe("quote")
  })

  it("accepts ISO strings as well as Dates (drizzle may hand back either)", () => {
    expect(
      oldestPriceAsOf([
        { marketValue: "1", priceAsOf: "2026-09-21T09:00:00Z" },
        { marketValue: "1", priceAsOf: "2026-09-25T09:00:00Z" },
      ]),
    ).toBe("2026-09-21T09:00:00.000Z")
  })
})


/**
 * §63.2 — the composition rule shared by the live and history valuation paths.
 *
 * This exists as a direct test because the failure it guards is not a wrong
 * number today — it is the two paths drifting apart tomorrow. The backfill and
 * the live quote path are NOT the same computation over the same inputs (the
 * live path converts out of each position's own currency; the batch receives
 * closes already in base), so they cannot be collapsed into one function. What
 * they can share is everything *after* a per-row number exists, and that is here.
 *
 * The per-path tests still matter and are not redundant: `backfill.test.ts:1102`
 * asserts the two paths agree to 7 decimal places, which is an end-to-end
 * statement this cannot make. This one states the rule each path is built on, so
 * a change to it fails in one place instead of surfacing as a divergence.
 */
describe("§63.2: composePortfolioValue", () => {
  it("sums contributions, adds cash, and counts unpriced rows as zero", () => {
    expect(composePortfolioValue([100, 250, null, 50], 500)).toEqual({
      instrumentsValue: 400, cashValue: 500, totalValue: 900, unpricedPositions: 1,
    })
  })

  it("an unpriced row contributes NOTHING — never a substituted value", () => {
    // The §70 rule, in the shape that matters: the caller passes `null`, so the
    // only way a cost basis could appear is if this function invented one.
    const priced = composePortfolioValue([1000], 0)
    const withGhost = composePortfolioValue([1000, null], 0)
    expect(withGhost.instrumentsValue).toBe(priced.instrumentsValue)
    expect(withGhost.unpricedPositions).toBe(1)
  })

  it("negative cash reduces the total and is never clamped (§62, margin accounts)", () => {
    // IBKR and IKE Beata both run negative. A clamp to zero would report a
    // solvent portfolio.
    expect(composePortfolioValue([1000], -1200).totalValue).toBe(-200)
  })

  it("totalValue is the sum by construction, so no caller can disagree (§68)", () => {
    const cases: [number[], number][] = [[[], 0], [[0.1, 0.2], 0.3], [[1e8, -1e8], 5]]
    for (const [c, cash] of cases) {
      const r = composePortfolioValue(c, cash)
      expect(r.totalValue).toBe(r.instrumentsValue + r.cashValue)
    }
  })

  it("does not round — rounding belongs at the JSON boundary", () => {
    // §53.6 asserts the two paths agree to 7dp. Rounding in here is what broke
    // that once, so the absence of rounding is part of the contract.
    const r = composePortfolioValue([0.1, 0.2], 0)
    expect(r.instrumentsValue).toBe(0.1 + 0.2)
    expect(r.instrumentsValue).not.toBe(0.3)
  })

  it("treats undefined and null alike — both mean 'no price'", () => {
    expect(composePortfolioValue([100, undefined, null], 0).unpricedPositions).toBe(2)
  })
})
