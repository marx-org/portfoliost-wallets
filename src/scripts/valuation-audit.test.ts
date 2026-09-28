import { describe, expect, it } from "vitest"
import { findCurrencyMismatches, findReconciliationGaps } from "./valuation-audit.js"

/**
 * §71 — CRI.WA carried `CAD` on the position while both of its BUY transactions
 * said `PLN`, and nothing noticed for months. These lock the two rules that
 * would have caught it. The functions are pure so the policy is testable without
 * a database; the DB queries are a thin shell over them.
 */
describe("valuation audit — currency consistency", () => {
  const row = (o: Partial<Parameters<typeof findCurrencyMismatches>[0][number]>) => ({
    portfolioId: "pf-1",
    portfolioName: "IKE Marek",
    symbol: "CRI.WA",
    storedCurrency: "CAD",
    transactionCurrencies: ["PLN"],
    ...o,
  })

  it("flags the PROD shape: position CAD, transactions PLN", () => {
    const found = findCurrencyMismatches([row({})])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      kind: "currency-mismatch",
      symbol: "CRI.WA",
      storedCurrency: "CAD",
      transactionCurrencies: ["PLN"],
    })
  })

  it("is case- and whitespace-insensitive (char(3) blank-pads)", () => {
    expect(findCurrencyMismatches([row({ storedCurrency: " pln " })])).toEqual([])
  })

  it("accepts a position that agrees with its trades", () => {
    expect(findCurrencyMismatches([row({ storedCurrency: "PLN" })])).toEqual([])
  })

  it("stays silent when the position has no currency to compare", () => {
    // Blank-padded char(3) and genuinely empty are both "unset"; neither is
    // evidence of a contradiction.
    expect(findCurrencyMismatches([row({ storedCurrency: "   " })])).toEqual([])
  })

  it("stays silent when the trades carry no currency to compare against", () => {
    // A position bought before instrumentCurrency was tracked cannot be judged.
    expect(findCurrencyMismatches([row({ transactionCurrencies: [] })])).toEqual([])
    expect(findCurrencyMismatches([row({ transactionCurrencies: ["  "] })])).toEqual([])
  })

  it("does NOT flag a position paid in a currency other than the one it trades in", () => {
    // These accounts buy foreign listings paying in PLN, so a position can
    // legitimately read USD against trades in PLN *and* USD. The first PROD run
    // flagged 8 findings of exactly this shape; they are the normal case, and a
    // rule that cries wolf on them stops being read.
    expect(findCurrencyMismatches([row({ storedCurrency: "USD", transactionCurrencies: ["PLN", "USD"] })])).toEqual([])
    expect(findCurrencyMismatches([row({ storedCurrency: "EUR", transactionCurrencies: ["EUR", "PLN"] })])).toEqual([])
  })

  it("flags when the position cites a currency none of its trades used", () => {
    // SRT.F shape: a Frankfurt listing reading GBP against EUR-only trades.
    const found = findCurrencyMismatches([row({ symbol: "SRT.F", storedCurrency: "GBP", transactionCurrencies: ["EUR"] })])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ symbol: "SRT.F", storedCurrency: "GBP", transactionCurrencies: ["EUR"] })
  })
})

describe("valuation audit — reconciliation", () => {
  const gap = (o: Partial<Parameters<typeof findReconciliationGaps>[0][number]>) => ({
    portfolioId: "pf-1",
    portfolioName: "IKE Marek",
    snapshotDate: "2026-09-27",
    storedValue: 90_154.71,
    liveValue: 90_154.71,
    ...o,
  })

  it("is quiet when live matches stored", () => {
    expect(findReconciliationGaps([gap({})])).toEqual([])
  })

  it("tolerates ordinary drift below the threshold", () => {
    // Thin Warsaw listings move; 1% is not a defect.
    expect(findReconciliationGaps([gap({ liveValue: 91_056.26 })])).toEqual([])
  })

  it("flags a gap beyond the threshold", () => {
    const found = findReconciliationGaps([gap({ liveValue: 106_414.79 })])
    expect(found).toHaveLength(1)
    expect(found[0].deltaPct).toBeCloseTo(0.1805, 3)
    expect(found[0].kind).toBe("reconciliation-gap")
  })

  it("does not guess a currency from the size of the gap", () => {
    // PROD: one position out of thirteen was multiplied by 2.7131, so the
    // PORTFOLIO ratio was 0.847 — not any pair's rate. A ratio heuristic would
    // have reported a confident, wrong explanation here, so there isn't one.
    const found = findReconciliationGaps([gap({ liveValue: 106_414.79 })])
    expect(found[0]).not.toHaveProperty("impliedPair")
  })

  it("cannot judge a zero baseline and says nothing rather than flagging", () => {
    // A brand-new or emptied portfolio has no ratio; reporting it would be noise.
    expect(findReconciliationGaps([gap({ storedValue: 0, liveValue: 5_000 })])).toEqual([])
  })

  it("honours a caller-supplied tolerance", () => {
    const row = gap({ liveValue: 91_800 }) // +1.82% — inside the 2% default
    expect(findReconciliationGaps([row])).toEqual([])
    expect(findReconciliationGaps([{ ...row, tolerance: 0.01 }])).toHaveLength(1)
  })
})
