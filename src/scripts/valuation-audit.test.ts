import { describe, expect, it } from "vitest"
import {
  CROSS_LISTINGS,
  findCurrencyMismatches,
  findReconciliationGaps,
  findUnfundedPortfolios,
} from "./valuation-audit.js"

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

/**
 * §71.6 — `MFC` is a KNOWN false positive and the plan asks for a decision:
 * narrow the rule, or record the exception.
 *
 * **Recorded, not narrowed.** A wrong symbol produces the same signature — a
 * stored value that no longer matches the live one — so no threshold, ratio or
 * shape test separates "bought on the other line" from "the resolver picked the
 * wrong line". Narrowing would either eat real findings or need a guess about
 * provider conventions.
 *
 * **And not suppressed either.** The complaint in §71.6 is that a permanent red
 * line trains people to skim past real findings; deleting the evidence does not
 * fix that, it just makes the rule unchallengeable. So the finding is still
 * emitted, carries its reason, and is excluded from the exit code.
 */
describe("valuation audit — known cross-listings (§71.6)", () => {
  const gap = (o: Partial<Parameters<typeof findReconciliationGaps>[0][number]>) => ({
    portfolioId: "pf-1",
    portfolioName: "Rach. rejestrowy PKO BP",
    snapshotDate: "2026-09-27",
    storedValue: 45_000,
    liveValue: 45_000,
    ...o,
  })

  it("classifies a known cross-listing instead of reporting it as a defect", () => {
    const found = findReconciliationGaps([
      gap({ symbol: "MFC", positionSymbols: ["MFC"], liveValue: 52_000 }),
    ])
    expect(found).toHaveLength(1)
    expect(found[0].classification).toBe("known-cross-listing")
    expect(found[0].classificationReason).toMatch(/Mastercard/)
  })

  it("STILL REPORTS it — the finding is not deleted, only explained", () => {
    // Suppressing it would remove the evidence and leave the rule
    // unchallengeable, which is the failure §71.6 is actually about.
    const found = findReconciliationGaps([
      gap({ symbol: "MFC", positionSymbols: ["MFC"], liveValue: 52_000 }),
    ])
    expect(found).toHaveLength(1)
    expect(found[0].deltaPct).toBeCloseTo(52_000 / 45_000 - 1, 6)
  })

  it("does NOT classify a symbol that is not on the list", () => {
    // The whole value of the list is that it is curated. A typo in the lookup,
    // or a new holding, must not inherit a free pass.
    const found = findReconciliationGaps([
      gap({ symbol: "MFCX", positionSymbols: ["MFCX"], liveValue: 52_000 }),
    ])
    expect(found[0].classification).toBeUndefined()
  })

  it("does not classify anything when the position's symbol is unknown", () => {
    const found = findReconciliationGaps([gap({ liveValue: 52_000 })])
    expect(found[0].classification).toBeUndefined()
  })

  it("every entry carries a reason — an unexplained entry is a mistake", () => {
    for (const [symbol, reason] of Object.entries(CROSS_LISTINGS)) {
      expect(reason, `${symbol} has no recorded reason`).toBeTruthy()
      expect(reason.length, `${symbol}'s reason is too short to be a justification`).toBeGreaterThan(40)
    }
  })

  it("a cross-listing inside tolerance is still quiet", () => {
    expect(findReconciliationGaps([gap({ symbol: "MFC", liveValue: 45_500 })])).toEqual([])
  })
})

/**
 * §72.32 — PROD (XTB): 22 trades, not one DEPOSIT or TRANSFER anywhere in the
 * import, 1680 negative value snapshots and `invested = 0` on every day. The cash
 * ledger starts from an empty map, so a portfolio whose opening deposit was never
 * imported is valued as though the money never arrived.
 */
describe("valuation audit — unfunded portfolios", () => {
  const row = (o: Partial<Parameters<typeof findUnfundedPortfolios>[0][number]>) => ({
    portfolioId: "pf-xtb",
    portfolioName: "XTB",
    tradeCount: 22,
    externalInflow: 0,
    impliedFunding: 1925.7,
    minBalance: -56.5,
    ...o,
  })

  it("flags the PROD shape: trades, no inflow, negative cash", () => {
    expect(findUnfundedPortfolios([row({})])).toEqual([
      {
        kind: "unfunded-portfolio",
        portfolioId: "pf-xtb",
        portfolioName: "XTB",
        tradeCount: 22,
        impliedFunding: 1925.7,
        minBalance: -56.5,
      },
    ])
  })

  it("does not flag a portfolio that was funded", () => {
    expect(findUnfundedPortfolios([row({ externalInflow: 5000 })])).toEqual([])
  })

  it("does not flag a portfolio with no trades", () => {
    expect(findUnfundedPortfolios([row({ tradeCount: 0 })])).toEqual([])
  })

  it("does not flag a portfolio whose cash never went negative", () => {
    // No inflow and no negative balance is a genuinely cash-neutral, empty
    // portfolio — not a data defect.
    expect(findUnfundedPortfolios([row({ minBalance: 0 })])).toEqual([])
  })
})
