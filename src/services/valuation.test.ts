import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { createTestDb } from "../db/test-db.js"
import { makeHarness } from "../routes/test-utils.js"
import { createWalletRoutes } from "../routes/wallets.js"
import { fxRates, wallets } from "../db/schema.js"
import { snapshotRate, totalBalance } from "./valuation.js"

async function seedWorld() {
  const h = await makeHarness("valuer")
  await h.db.insert(fxRates).values([
    { rateDate: "2026-08-21", currency: "USD", rate: "1.0800000000" },
    { rateDate: "2026-08-21", currency: "EUR", rate: "1" },
    { rateDate: "2026-08-21", currency: "PLN", rate: "4.3000000000" },
  ])
  await h.db.insert(wallets).values([
    { userId: "valuer", name: "US cash", currency: "USD", balance: "100.00000000", availableBalance: "100.00000000" },
    { userId: "valuer", name: "EU savings", currency: "EUR", balance: "200.00000000", availableBalance: "200.00000000" },
  ])
  return h
}

describe("snapshotRate (D21)", () => {
  it("same-currency is 1 even without tables; manual wins verbatim", async () => {
    const { db } = await createTestDb()
    expect((await snapshotRate(db, "USD", "USD")).rate).toBe(1)
    const m = await snapshotRate(db, "EUR", "USD", 1.23)
    expect(m).toEqual({ rate: 1.23, source: "manual" })
  })

  it("auto resolves via latest table", async () => {
    const h = await seedWorld()
    const r = await snapshotRate(h.db, "EUR", "USD")
    expect(r.source).toBe("automatic")
    expect(r.rate).toBeCloseTo(1.08, 8)
  })
})

describe("totalBalance aggregation (§11.9)", () => {
  it("values every wallet in the requested base at latest rates with breakdown + weights", async () => {
    const h = await seedWorld()
    const app = new Hono().route("/api/wallets", createWalletRoutes(h.db))
    const res = await app.request("/api/wallets/total-balance?baseCurrency=USD", {
      headers: { "X-User-Id": "valuer", "X-User-Email": "v@t.dev" },
    })
    const body = await res.json()
    expect(body.baseCurrency).toBe("USD")
    // 100 USD + 200 EUR*1.08 = 316
    expect(body.totalBalance).toBeCloseTo(316, 2)
    expect(body.totalAvailableBalance).toBeCloseTo(316, 2)
    const eurRow = body.walletBreakdown.find((w: any) => w.currency === "EUR")
    expect(eurRow.convertedBalance).toBeCloseTo(216, 2)
    expect(eurRow.exchangeRate).toBeCloseTo(1.08, 6)
    const usdRow = body.walletBreakdown.find((w: any) => w.currency === "USD")
    expect(usdRow.exchangeRate).toBe(1)
    const weightSum = body.walletBreakdown.reduce((s: number, w: any) => s + w.weight, 0)
    expect(weightSum).toBeCloseTo(100, 0)
  })

  it("isolates users (D24)", async () => {
    const h = await seedWorld()
    const res = await totalBalance(h.db, "nobody")
    expect(res.walletBreakdown.length).toBe(0)
  })
})
