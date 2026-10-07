import { describe, expect, it } from "vitest"
import { instrumentsAuthHeaders } from "../services/instruments-fx.js"
import {
  MAX_CARRY_DAYS,
  ORDER_PRICED_WINDOW_DAYS,
  assessSymbol,
  deviationPct,
  isOrderPriced,
  normaliseToBarCurrency,
  logAuditProgress,
  priceAuditBarsUrl,
  pickBar,
  pickOrderPricedBar,
  resolveInstrumentsToken,
  summarise,
  type TradeVerdict,
} from "./price-audit.js"

import { vi } from "vitest"

/**
 * §72 — the rules that decide whether a symbol is reported. Pure, so the policy
 * is testable without a database or a network.
 *
 * The two shapes below are the real ones. CRI.WA is the currency signature: a
 * trade off by a factor that IS a currency pair's rate. SRT.F is the venue
 * signature: most trades agree and one is far out, and the out one is the lot
 * that decides what is still held.
 */
const bar = (d: string, c: number): Map<string, number> => new Map([[d, c]])

const trade = (o: Partial<TradeVerdict> = {}): TradeVerdict => ({
  portfolioName: "IKE Marek",
  symbol: "X",
  date: "2026-09-27",
  tradePrice: 100,
  barClose: 100,
  carriedDays: 0,
  deviation: 0,
  tradeCurrency: "PLN",
  claimedCurrency: "PLN",
  storedRate: 1,
  importConverted: false,
  ...o,
})

describe("pickBar", () => {
  it("uses the same day's close", () => {
    expect(pickBar(bar("2026-09-27", 727), "2026-09-27")).toEqual({ close: 727, carriedDays: 0 })
  })

  it("borrows the prior close for a weekend trade, and reports the gap", () => {
    // A Sunday trade has no bar of its own and is not thereby suspicious — but
    // the gap has to be visible, so a 7-day-old close is not silently compared.
    const bars = new Map([["2026-09-25", 100]])
    expect(pickBar(bars, "2026-09-27")).toEqual({ close: 100, carriedDays: 2 })
  })

  it("picks the NEAREST prior close, not the first one", () => {
    const bars = new Map([["2026-09-01", 10], ["2026-09-24", 90], ["2026-09-25", 95]])
    expect(pickBar(bars, "2026-09-27")).toEqual({ close: 95, carriedDays: 2 })
  })

  it("refuses to borrow a close older than the limit", () => {
    const bars = new Map([["2026-09-01", 100]])
    expect(pickBar(bars, "2026-09-27")).toBeNull()
    expect(MAX_CARRY_DAYS).toBe(7)
  })

  it("never borrows forward — a future close is not evidence", () => {
    expect(pickBar(bar("2026-09-28", 500), "2026-09-27")).toBeNull()
  })
})

describe("deviationPct", () => {
  it("is signed and relative to the bar", () => {
    expect(deviationPct(110, 100)).toBeCloseTo(0.1)
    expect(deviationPct(90, 100)).toBeCloseTo(-0.1)
    expect(deviationPct(100, 100)).toBe(0)
  })

  it("is NaN, not Infinity, when there is no usable bar", () => {
    expect(Number.isNaN(deviationPct(100, 0))).toBe(true)
    expect(Number.isNaN(deviationPct(100, Number.NaN))).toBe(true)
  })
})

describe("cross-currency trades (§72.10)", () => {
  const rates = new Map([["PLN>GBP", 0.1773]])

  it("converts a trade PAID in one currency into the bar's currency", () => {
    // The PROD case: a .L listing paid in PLN. 12.91 PLN x 0.1773 = £2.29 against
    // a £2.236 bar is a 2.3% move. Compared raw it read as +477%, which is how a
    // correct trade gets reported as a defect.
    const [v] = assessSymbol(
      [trade({ tradePrice: 12.91, barClose: 2.236369, tradeCurrency: "PLN", claimedCurrency: "GBP" })],
      rates,
    )
    expect(v.deviation).toBeCloseTo(0.023, 2)
    expect(v.normalisedPrice).toBeCloseTo(12.91 * 0.1773, 6)
    expect(v.conversionRate).toBe(0.1773)
  })

  it("prefers the trade-date rate over a generic pair rate", () => {
    const [v] = assessSymbol(
      [trade({ tradePrice: 100, barClose: 90, tradeCurrency: "USD", claimedCurrency: "CAD" })],
      new Map([
        ["USD>CAD", 1.5],
        ["USD>CAD>2026-09-27", 1.35],
      ]),
    )
    expect(v.conversionRate).toBe(1.35)
    expect(v.normalisedPrice).toBeCloseTo(135, 6)
  })

  it("does NOT fall back to 1:1 when the rate is unavailable — the trade is unchecked", () => {
    // Returning the unconverted number would recreate the exact false positive
    // the conversion exists to remove.
    const [v] = assessSymbol(
      [trade({ tradePrice: 12.91, barClose: 2.236369, tradeCurrency: "PLN", claimedCurrency: "GBP" })],
      new Map(),
    )
    expect(v.deviation).toBeNull()
  })

  it("§72.11: honours the rate the IMPORT applied, when it applied one", () => {
    // The user is right that we store it: all 1193 trades carry exchange_rate.
    // When the import recorded two different currencies, that rate is the
    // authority — it is what was actually paid, manual/custom included. The
    // derived rate below is deliberately wrong, so the result proves which was used.
    const [v] = assessSymbol(
      [trade({
        tradePrice: 12.91, barClose: 2.236369,
        tradeCurrency: "PLN", claimedCurrency: "GBP",
        storedRate: 0.1773, importConverted: true,
      })],
      new Map([["PLN>GBP", 0.25]]), // wrong on purpose
    )
    // 12.91 x 0.1773 = 2.289 → +2.3%. Had the derived 0.25 been used it would
    // have been 3.23 → +44%.
    expect(v.deviation).toBeCloseTo(0.023, 2)
  })

  it("§72.11: ignores a stored 1.0 when the import recorded ONE currency twice", () => {
    // CSN.L 2025-01-22: currency=PLN AND instrument_currency=PLN, so the stored
    // rate is 1.0 by construction and encodes the mis-recording. Preferring it
    // would compare 12.91 "GBP" to a £2.236 bar — the exact 477% being removed.
    const [v] = assessSymbol(
      [trade({
        tradePrice: 12.91, barClose: 2.236369,
        tradeCurrency: "PLN", claimedCurrency: "GBP",
        storedRate: 1.0, importConverted: false,
      })],
      new Map([["PLN>GBP", 0.1773]]),
    )
    expect(v.deviation).toBeCloseTo(0.023, 2)
  })

  it("leaves a same-currency trade untouched", () => {
    const [v] = assessSymbol(
      [trade({ tradePrice: 100, barClose: 101, tradeCurrency: "EUR", claimedCurrency: "EUR" })],
      new Map(),
    )
    expect(v.deviation).toBeCloseTo(-0.0099, 3)
  })
})

describe("normaliseToBarCurrency", () => {
  it("is a no-op when the currencies already agree", () => {
    expect(normaliseToBarCurrency(100, "EUR", "EUR", 5)).toEqual({ price: 100, converted: false })
  })
  it("refuses rather than degrading to 1:1 on a missing rate", () => {
    expect(normaliseToBarCurrency(100, "PLN", "GBP", null).price).toBeNaN()
    expect(normaliseToBarCurrency(100, "PLN", "GBP", 0).price).toBeNaN()
  })
  it("refuses when the bar currency is unknown", () => {
    expect(normaliseToBarCurrency(100, "PLN", null, 0.17).price).toBeNaN()
  })
})

describe("assessSymbol — remaining shapes", () => {
  it("flags a genuine mismatch in the SAME currency (the venue signature)", () => {
    // SRT3.DE shape: same currency on both sides, so no conversion applies and
    // the real 18.9% gap survives to be reported.
    const [v] = assessSymbol(
      [trade({ tradePrice: 379, barClose: 282.3, tradeCurrency: "EUR", claimedCurrency: "EUR" })],
      new Map(),
    )
    expect(Math.abs(v.deviation!)).toBeGreaterThan(0.1)
  })
})

describe("summarise", () => {
  it("counts, ranks and separates the unverifiable", () => {
    const r = summarise(
      "CRI.WA",
      assessSymbol([
        trade({ tradePrice: 194, barClose: 188, deviation: 0.0319 }),
        trade({ tradePrice: 379, barClose: 136, deviation: 1.7868 }),
      ]),
      "PLN",
      0.1,
    )
    expect(r.checked).toBe(2)
    expect(r.unreconciled).toBe(1) // only the 178% one clears a 10% tolerance
    expect(r.worstDeviation).toBeCloseTo(1.7868, 3)
    expect(r.unverifiable).toBe(false)
    expect(r.positionCurrency).toBe("PLN")
  })

  it("marks a symbol with no bars as unverifiable rather than clean", () => {
    // Silence here would read as "reconciled", which is the opposite of the truth.
    const r = summarise("OPTAAPL", assessSymbol([trade({ barClose: null, deviation: null })]), "USD", 0.1)
    expect(r.unverifiable).toBe(true)
    expect(r.unreconciled).toBe(0)
    expect(r.worstDeviation).toBe(0)
  })

  it("honours a caller tolerance", () => {
    const v = assessSymbol([trade({ tradePrice: 118, barClose: 100, deviation: 0.18 })])
    expect(summarise("X", v, "PLN", 0.1).unreconciled).toBe(1)
    expect(summarise("X", v, "PLN", 0.25).unreconciled).toBe(0)
  })
})

describe("resolveInstrumentsToken", () => {
  it("prefers the service token when the sweep provides it", () => {
    expect(resolveInstrumentsToken({ INSTRUMENTS_SERVICE_TOKEN: "svc" } as NodeJS.ProcessEnv)).toBe("svc")
  })

  it("falls back to the caller's JWT, which is what the admin job passes", () => {
    expect(resolveInstrumentsToken({ INSTRUMENTS_AUTH_TOKEN: "Bearer jwt" } as NodeJS.ProcessEnv)).toBe("Bearer jwt")
  })

  it("trims, because a padded token is a 401 that looks like an empty series", () => {
    expect(resolveInstrumentsToken({ INSTRUMENTS_SERVICE_TOKEN: "  svc  " } as NodeJS.ProcessEnv)).toBe("svc")
  })

  it("refuses rather than proceeding with no credential", () => {
    // Every bar read would be a 401 that looks like "no data", and an audit that
    // cannot check must never report clean.
    expect(() => resolveInstrumentsToken({} as NodeJS.ProcessEnv)).toThrow(/INSTRUMENTS_SERVICE_TOKEN/)
  })
})

describe("logAuditProgress", () => {
  it("writes visible progress in human-readable mode", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    logAuditProgress(false, "fetching 1/2: AAPL")
    expect(log).toHaveBeenCalledWith("[price-audit] progress: fetching 1/2: AAPL")
    log.mockRestore()
  })

  it("keeps JSON mode clean", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    logAuditProgress(true, "fetching 1/2: AAPL")
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})

describe("priceAuditBarsUrl", () => {
  it("uses the canonical endpoint and requested audit window", () => {
    expect(priceAuditBarsUrl("http://instruments/", "NVDA", "2022-01-01", "2026-10-07"))
      .toBe("http://instruments/api/instruments/NVDA/price-bars?from=2022-01-01&to=2026-10-07")
  })
})

/**
 * §72.8 — the credential decides which HEADER the token lands in, and a wrong
 * header is a 401 that is indistinguishable from "this symbol has no data".
 *
 * `instrumentsAuthHeaders` routes on the "Bearer " prefix: Bearer goes to
 * `Authorization`, anything else is sent as `X-Service-Token` and compared
 * against INSTRUMENTS_SERVICE_TOKEN. The admin job therefore has to hand the
 * token over WITH its prefix — sheets-sync strips it because its own client
 * re-prepends, and copying that pattern here silently sent a user JWT to
 * X-Service-Token. The first PROD run then reported "every trade reconciles"
 * over 219 symbols it had checked none of.
 *
 * These use the real header builder, not a stub, because the bug lived in the
 * space between "the token is correct" and "the header is correct".
 */
describe("credential → header routing (§72.8)", () => {
  it("a caller JWT sent WITH the prefix lands in Authorization", () => {
    const h = instrumentsAuthHeaders("Bearer eyJhbGciOi.payload.sig")
    expect(h["Authorization"]).toBe("Bearer eyJhbGciOi.payload.sig")
    expect(h["X-Service-Token"]).toBeUndefined()
  })

  it("a service token lands in X-Service-Token", () => {
    const h = instrumentsAuthHeaders("a".repeat(64))
    expect(h["X-Service-Token"]).toBe("a".repeat(64))
    expect(h["Authorization"]).toBeUndefined()
  })

  it("a JWT stripped of its prefix is misrouted — the exact PROD failure", () => {
    // This is what the job passed. The JWT is perfectly valid; the header is not.
    const h = instrumentsAuthHeaders("eyJhbGciOi.payload.sig")
    expect(h["Authorization"]).toBeUndefined()
    expect(h["X-Service-Token"]).toBe("eyJhbGciOi.payload.sig")
  })
})

describe("§72.18 — option premium legs are not share trades", () => {
  it("skips a SELL that shares a base with an EXPIRATION", () => {
    // Equate+/SAP.DE traded options in 2022: a SELL of 100 at 1.04-1.30 paired
    // with an EXPIRATION at 0 whose externalId is the SELL's plus "#e". Against
    // a share bar near 150 that read -99.3% and was reported as a price
    // mismatch, five times. The lot ledger closes both against a SHORT option
    // lot; there is no share trade to reconcile.
    const legIds = new Set(["opt-1", "opt-2"]) // built from EXPIRATION ids, "#e" stripped
    const isLeg = (t: { type?: string; externalId?: string | null }) =>
      t.type === "SELL" && !!t.externalId && legIds.has(t.externalId)

    expect(isLeg({ type: "SELL", externalId: "opt-1" })).toBe(true)
    expect(isLeg({ type: "SELL", externalId: "real-sell" })).toBe(false)
    expect(isLeg({ type: "BUY", externalId: "opt-1" })).toBe(false) // a BUY leg is a real purchase
  })

  it("only a SELL with the shared base is a leg", () => {
    // "opt-1" and "opt-1#e" are the pair; the EXPIRATION row is what puts the
    // base in the set, so a bare EXPIRATION must not make an unrelated SELL a leg.
    const legIds = new Set(["352caf673c34433e91a808f08f368cd2b75023f52fe221e67abbf88d0ebbc096"])
    expect(legIds.has("352caf673c34433e91a808f08f368cd2b75023f52fe221e67abbf88d0ebbc096#e")).toBe(false)
  })
})


/**
 * §74 — `price-audit` compares an order-priced fund trade against the wrong day's
 * bar.
 *
 * The broker's own detail for the flagged row says why, in its field names:
 *
 *     Data zlecenia:  07.04.2023   (Good Friday — the market was shut)
 *     Data wyceny:   13.04.2023
 *     Cena Jednostki Uczestnictwa z dnia wyceny: 382,05 PLN
 *
 * `pickBar` takes the exact day else the most recent PRIOR close, so it picked
 * 2023-04-06 = 339.47 and computed 382.05 / 339.47 = 1.1254 — the 1.126 that
 * §72.19 and §72.20 chased across nine ING Akcji categories before §72.23 kept
 * deferring the check. It was never a fund class, a share class or a provider
 * gap. The price is correct; row 604 of the sheet must not be edited.
 */
describe("§74 — order-priced fund trades", () => {
  // The real bars around the flagged trade, and the real executed prices.
  const INGAKC_BARS = new Map([
    ["2026-04-29", 396.8], ["2026-04-30", 397.1],
    ["2023-04-05", 337.9], ["2023-04-06", 339.47],
    // Good Friday 2023-04-07: no bar. The valuation date is 2023-04-13.
    ["2023-04-10", 340.2], ["2023-04-11", 344.32], ["2023-04-12", 345.0],
    ["2023-04-13", 382.05], ["2023-04-14", 380.1],
  ])

  it("74.1 — a FUND trade whose price matches a LATER bar is not a mismatch", () => {
    // The defect, as the audit behaves today: a ratio against the prior close.
    const oldWay = pickBar(INGAKC_BARS, "2023-04-07")
    expect(oldWay).toEqual({ close: 339.47, carriedDays: 1 })
    expect(deviationPct(382.05, oldWay!.close)).toBeCloseTo(0.1254, 3)
    expect(Math.abs(deviationPct(382.05, oldWay!.close))).toBeGreaterThan(0.1) // over tolerance

    // The rule: an order-priced trade is NOT deviation-judged, so the trade
    // reconciles. The bracketing bars are the evidence instead.
    const verdicts = assessSymbol([
      {
        portfolioName: "NN TFI PPO", symbol: "INGAKC.TFI", date: "2023-04-07",
        tradePrice: 382.05, barClose: null, carriedDays: 0, deviation: null,
        tradeCurrency: "PLN", claimedCurrency: "PLN", storedRate: 1,
        importConverted: false, assetType: "FUND", orderPriced: true,
        orderPricedPrior: pickOrderPricedBar(INGAKC_BARS, "2023-04-07").prior,
        orderPricedNext: pickOrderPricedBar(INGAKC_BARS, "2023-04-07").next,
      },
    ])
    expect(verdicts[0].deviation).toBeNull()
    const report = summarise("INGAKC.TFI", verdicts, "PLN", 0.1)
    expect(report.unreconciled).toBe(0)
    expect(report.orderPriced).toBe(1)
    // The evidence is the NEAREST bar each side — deliberately NOT the bar the
    // price happens to match. The audit says "here is the local range"; it does
    // not claim to know the valuation date, which is §74.5's open question.
    expect(verdicts[0].orderPricedPrior).toEqual({ date: "2023-04-06", close: 339.47, offsetDays: -1 })
    expect(verdicts[0].orderPricedNext).toEqual({ date: "2023-04-10", close: 340.2, offsetDays: 3 })
  })

  it("74.1 CONTROL — the same trade against a PRIOR bar is still judged, so the fix cannot be satisfied by widening a tolerance", () => {
    // If the rule were "widen every tolerance", this exchange-traded trade would
    // also stop being reported. It must not.
    const verdicts = assessSymbol([
      {
        portfolioName: "IKE Marek", symbol: "SAP.DE", date: "2023-04-07",
        tradePrice: 382.05, barClose: 339.47, carriedDays: 1, deviation: null,
        tradeCurrency: "PLN", claimedCurrency: "PLN", storedRate: 1,
        importConverted: false, assetType: "STOCK",
      },
    ])
    expect(Math.abs(verdicts[0].deviation!)).toBeGreaterThan(0.1)
    const report = summarise("SAP.DE", verdicts, "PLN", 0.1)
    expect(report.unreconciled).toBe(1)
    expect(report.orderPriced).toBe(0)
  })

  it("74.2 — an order-priced instrument is identified by asset_type, never by ticker shape", () => {
    expect(isOrderPriced({ assetType: "FUND" })).toBe(true)
    expect(isOrderPriced({ assetType: "fund" })).toBe(true)
    expect(isOrderPriced({ assetType: "STOCK" })).toBe(false)
    expect(isOrderPriced({ assetType: "BOND" })).toBe(false)
    // A FUND with a ticker that does not end in .TFI is still order-priced —
    // that is the point of keying on the class rather than the shape.
    expect(isOrderPriced({ assetType: "FUND" })).toBe(true)
    // And an unpopulated column must not be guessed from the symbol: a real
    // exchange-traded fund on a major exchange is priced on the trade date.
    expect(isOrderPriced({ assetType: null })).toBe(false)
    expect(isOrderPriced({ assetType: "" })).toBe(false)
    expect(isOrderPriced({})).toBe(false)
  })

  it("74.3 — the bracketing bars are found on BOTH sides, each with its signed offset", () => {
    const { prior, next } = pickOrderPricedBar(INGAKC_BARS, "2023-04-07")
    expect(prior).toEqual({ date: "2023-04-06", close: 339.47, offsetDays: -1 })
    expect(next).toEqual({ date: "2023-04-10", close: 340.2, offsetDays: 3 })
    // A trade on a bar's own day is still bracketed by its neighbours, so a
    // reader can see the local range either way.
    const mid = pickOrderPricedBar(INGAKC_BARS, "2023-04-11")
    expect(mid.prior).toEqual({ date: "2023-04-10", close: 340.2, offsetDays: -1 })
    expect(mid.next).toEqual({ date: "2023-04-12", close: 345, offsetDays: 1 })
  })

  it("74.3 — pickBar is UNCHANGED for an exchange-traded instrument", () => {
    // Carrying backward is right for an exchange holiday. The fix is a second
    // function, not a rewritten one.
    expect(pickBar(new Map([["2023-04-06", 339.47]]), "2023-04-07")).toEqual({
      close: 339.47,
      carriedDays: 1,
    })
    expect(pickBar(new Map([["2023-04-13", 382.05]]), "2023-04-07")).toBeNull()
  })

  it("74.4 — the window is an evidence radius, and it reaches the real 6-day gap", () => {
    // The broker's own example: order 2023-04-07, valuation 2023-04-13 = 6 days.
    expect(ORDER_PRICED_WINDOW_DAYS).toBeGreaterThanOrEqual(6)
    // Far short of "any bar in the year", so it cannot pair a trade with an
    // unrelated price.
    expect(ORDER_PRICED_WINDOW_DAYS).toBeLessThan(60)
    // Nothing outside the radius is returned as a bracket.
    const far = pickOrderPricedBar(new Map([["2023-06-01", 500]]), "2023-04-07")
    expect(far.prior).toBeNull()
    expect(far.next).toBeNull()
  })

  it("an order-priced trade is still COUNTED as checked — it is not a free pass", () => {
    // §71.6's lesson: dropping the evidence is worse than reporting it oddly.
    const verdicts = assessSymbol([
      {
        portfolioName: "NN TFI PPO", symbol: "INGAKC.TFI", date: "2023-04-07",
        tradePrice: 382.05, barClose: null, carriedDays: 0, deviation: null,
        tradeCurrency: "PLN", claimedCurrency: "PLN", storedRate: 1,
        importConverted: false, assetType: "FUND", orderPriced: true,
      },
    ])
    const report = summarise("INGAKC.TFI", verdicts, "PLN", 0.1)
    expect(report.checked).toBe(1)
    expect(report.orderPriced).toBe(1)
    expect(report.unreconciled).toBe(0)
    // and the trade is present in the report, not filtered out of it
    expect(report.trades).toHaveLength(1)
    expect(report.trades[0].tradePrice).toBe(382.05)
  })

  it("a MIXED symbol judges its exchange-traded trades and exempts only the fund ones", () => {
    const verdicts = assessSymbol([
      // the STOCK trade genuinely deviates, so it must be reported
      {
        portfolioName: "NN TFI PPO", symbol: "X", date: "2026-01-05",
        tradePrice: 150, barClose: 100, carriedDays: 0, deviation: null,
        tradeCurrency: "PLN", claimedCurrency: "PLN", storedRate: 1,
        importConverted: false, assetType: "STOCK",
      },
      // a 50%-off fund trade: the same number, and it is NOT a finding
      {
        portfolioName: "NN TFI PPO", symbol: "X", date: "2026-01-06",
        tradePrice: 200, barClose: 100, carriedDays: 0, deviation: null,
        tradeCurrency: "PLN", claimedCurrency: "PLN", storedRate: 1,
        importConverted: false, assetType: "FUND", orderPriced: true,
      },
    ])
    const report = summarise("X", verdicts, "PLN", 0.1)
    expect(report.checked).toBe(2)
    expect(report.orderPriced).toBe(1)
    expect(report.unreconciled).toBe(1) // the STOCK one (+50%) is still judged
    expect(verdicts.find((v) => v.date === "2026-01-06")!.deviation).toBeNull()
    expect(verdicts.find((v) => v.date === "2026-01-05")!.deviation).toBeCloseTo(0.5, 6)
  })
})
