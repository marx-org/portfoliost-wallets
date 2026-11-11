import { afterEach, describe, expect, it, vi } from "vitest"
import { convertTransactionFee, resolveFeeFx } from "./fee-fx.js"

const originalInstrumentsUrl = process.env.INSTRUMENTS_URL

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalInstrumentsUrl === undefined) delete process.env.INSTRUMENTS_URL
  else process.env.INSTRUMENTS_URL = originalInstrumentsUrl
})

describe("convertTransactionFee", () => {
  it("converts a base-currency fee to trade currency by dividing by the principal rate", async () => {
    const result = await convertTransactionFee("token", {
      amount: 19,
      feeCurrency: "PLN",
      feeRateSource: "manual",
      // sheets-sync supplies this identity because the fee is already in PLN;
      // it is not a valid PLN -> USD conversion rate.
      feeExchangeRate: 1,
      transactionCurrency: "USD",
      baseCurrency: "PLN",
      transactionToBaseRate: 4.7975,
      date: "2024-01-15",
    })

    expect(result).toEqual({
      ok: true,
      feeInTransactionCurrency: 3.96039604,
      convertedFees: 19,
    })
  })

  it("converts a third-currency fee by its own rate to the base, not through the trade", async () => {
    // Production row 233 verbatim: a 1.25 USD commission on a EUR SAP.DE sale in
    // a PLN-base portfolio. 4.44 is the USD->PLN quote of 2022-06-20 (sheet col
    // 32 "Kurs waluty opłaty"), 4.67 is EUR->PLN. Reading 4.44 as USD per EUR
    // booked 5.55 EUR of fee instead of 1.1884 EUR.
    const result = await convertTransactionFee("token", {
      amount: 1.25,
      feeCurrency: "USD",
      feeRateSource: "manual",
      feeExchangeRate: 4.44, // USD -> PLN
      transactionCurrency: "EUR",
      baseCurrency: "PLN",
      transactionToBaseRate: 4.67, // EUR -> PLN
      date: "2022-06-20",
    })

    expect(result).toEqual({
      ok: true,
      feeInTransactionCurrency: 1.18843683,
      convertedFees: 5.55,
    })
  })

  it("uses the independent manual fee rate with a non-PLN display base", async () => {
    const result = await convertTransactionFee("token", {
      amount: 3,
      feeCurrency: "GBP",
      feeRateSource: "manual",
      feeExchangeRate: 1.3, // GBP -> USD (the base)
      transactionCurrency: "EUR",
      baseCurrency: "USD",
      transactionToBaseRate: 1.08, // EUR -> USD
      date: "2024-02-01",
    })

    expect(result).toEqual({
      ok: true,
      feeInTransactionCurrency: 3.61111111,
      convertedFees: 3.9,
    })
  })

  it("keeps percentage fees in transaction currency regardless of feeCurrency", async () => {
    const result = await convertTransactionFee(null, {
      amount: 5, // already materialized from the transaction notional
      feesType: "pct",
      feeCurrency: "PLN",
      feeRateSource: "manual",
      feeExchangeRate: 1,
      transactionCurrency: "USD",
      baseCurrency: "PLN",
      transactionToBaseRate: 4.8,
      date: "2024-02-01",
    })

    expect(result).toEqual({
      ok: true,
      feeInTransactionCurrency: 5,
      convertedFees: 24,
    })
  })

  it("keeps same-currency fees at 1:1 and automatic third-currency fees event-date resolved", async () => {
    const sameCurrency = await convertTransactionFee(null, {
      amount: 4,
      feeCurrency: "EUR",
      feeRateSource: "manual",
      feeExchangeRate: 99,
      transactionCurrency: "EUR",
      baseCurrency: "USD",
      transactionToBaseRate: 1.1,
      date: "2024-03-02",
    })
    expect(sameCurrency).toEqual({ ok: true, feeInTransactionCurrency: 4, convertedFees: 4.4 })

    process.env.INSTRUMENTS_URL = "http://instruments.test"
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rate: 4.3, asOf: "2024-03-02" }),
    })
    vi.stubGlobal("fetch", fetchSpy)
    const automatic = await convertTransactionFee("Bearer token", {
      amount: 10,
      feeCurrency: "EUR",
      feeRateSource: "automatic",
      transactionCurrency: "USD",
      baseCurrency: "PLN",
      transactionToBaseRate: 4,
      date: "2024-03-02",
    })
    // The automatic lookup is fee -> base, the same axis the manual rate uses;
    // the transaction currency is reached by dividing by the trade's own rate.
    expect(automatic).toEqual({ ok: true, feeInTransactionCurrency: 10.75, convertedFees: 43 })
    expect(String(fetchSpy.mock.calls[0][0])).toContain("from=EUR&to=PLN&date=2024-03-02")
  })

  it("rejects a manual third-currency fee without a positive fee rate", async () => {
    const result = await convertTransactionFee(null, {
      amount: 10,
      feeCurrency: "EUR",
      feeRateSource: "manual",
      feeExchangeRate: null,
      transactionCurrency: "USD",
      baseCurrency: "PLN",
      transactionToBaseRate: 4,
      date: "2024-03-02",
    })
    expect(result).toMatchObject({ ok: false, message: "feeExchangeRate must be a positive number when feeRateSource is manual" })
  })
})

describe("resolveFeeFx (interactive trades)", () => {
  it("keeps the fee native in its own currency and derives base and transaction denominations", async () => {
    const result = await resolveFeeFx(null, {
      fees: 19,
      feesType: "fixed",
      feeCurrency: "PLN",
      feeRateSource: "manual",
      feeExchangeRate: 1,
      rateSource: "manual",
      exchangeRate: 4.7975,
    }, "USD", { notional: 1000, displayCcy: "PLN" })

    expect(result).toEqual({
      ok: true,
      fields: {
        feeCurrency: "PLN",
        feesType: "fixed",
        rateSource: "manual",
        exchangeRate: 4.7975,
        feeRateSource: "manual",
        feeExchangeRate: null, // already in the base: no rate needed
        transferFxRate: null,
        targetAmount: null,
      },
      feesSettled: 19,
      feeInBase: 19,
      feeInTransaction: 3.96039604,
    })
  })

  it("a third-currency fee converts by its rate to the base, not to the trade", async () => {
    const result = await resolveFeeFx(null, {
      fees: 1.25,
      feesType: "fixed",
      feeCurrency: "USD",
      feeRateSource: "manual",
      feeExchangeRate: 4.44, // USD -> PLN, the sheet's "Kurs waluty opłaty"
      rateSource: "manual",
      exchangeRate: 4.67, // EUR -> PLN
    }, "EUR", { notional: 2214.75, displayCcy: "PLN" })

    expect(result).toMatchObject({ ok: true, feesSettled: 1.25, feeInBase: 5.55, feeInTransaction: 1.18843683 })
  })

  it("materialises a percentage fee in the transaction currency (D28)", async () => {
    const result = await resolveFeeFx(null, {
      fees: 1,
      feesType: "pct",
      feeCurrency: "PLN",
      feeRateSource: "manual",
      feeExchangeRate: 1,
      rateSource: "manual",
      exchangeRate: 4.8,
    }, "USD", { notional: 1000, displayCcy: "PLN" })

    expect(result).toMatchObject({ ok: true, feesSettled: 10, feeInBase: 48, feeInTransaction: 10 })
    expect(result.ok && result.fields.feeCurrency).toBe("USD")
  })

  it("leaves a same-currency fee untouched", async () => {
    const result = await resolveFeeFx(null, {
      fees: 4,
      feesType: "fixed",
      feeCurrency: "EUR",
      rateSource: "manual",
      exchangeRate: 1.1,
    }, "EUR", { notional: 100, displayCcy: "USD" })

    expect(result).toMatchObject({ ok: true, feesSettled: 4, feeInBase: 4.4, feeInTransaction: 4 })
  })
})
