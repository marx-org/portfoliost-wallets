import { afterEach, describe, expect, it, vi } from "vitest"
import { convertTransactionFee } from "./fee-fx.js"

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

  it("uses the independent manual fee rate with a non-PLN display base", async () => {
    const result = await convertTransactionFee("token", {
      amount: 3,
      feeCurrency: "GBP",
      feeRateSource: "manual",
      feeExchangeRate: 0.86, // GBP -> EUR
      transactionCurrency: "EUR",
      baseCurrency: "USD",
      transactionToBaseRate: 1.08, // EUR -> USD
      date: "2024-02-01",
    })

    expect(result).toEqual({
      ok: true,
      feeInTransactionCurrency: 2.58,
      convertedFees: 2.79,
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
      json: async () => ({ rate: 0.9, asOf: "2024-03-02" }),
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
    expect(automatic).toEqual({ ok: true, feeInTransactionCurrency: 9, convertedFees: 36 })
    expect(String(fetchSpy.mock.calls[0][0])).toContain("from=EUR&to=USD&date=2024-03-02")
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
