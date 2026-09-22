import { afterEach, describe, expect, it } from "vitest"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { createWalletRoutes } from "./wallets.js"
import { createMovementRoutes } from "./movements.js"
import { makeHarness } from "./test-utils.js"
import { wallets } from "../db/schema.js"
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono()
    .route("/api/wallets", createWalletRoutes(h.db))
    .route("/api/wallets", createMovementRoutes(h.db))
  const request = (path: string, init?: RequestInit) => app.request(path, init)
  const json = (path: string, body: unknown, method = "POST") =>
    request(path, {
      method,
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const mk = async (currency: string, name = currency) => {
    const res = await json("/api/wallets", { name, currency })
    return (await res.json()).id as string
  }
  return { ...h, request, json, mk }
}

function seedRates() {
  // plan §48.3 — the FX data moved to instruments; the stand-in serves the
  // same EUR-based demo closes (fees-and-custom-fx D32) over the internal route.
  mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3, GBP: 0.85 }, asOf: "2026-08-21" })
}

afterEach(() => unmockInstrumentsFx())

describe("deposits/withdrawals (§11.4)", () => {
  it("deposit echoes resolved defaults and updates balance; snapshot rate auto from fx_rates", async () => {
    const h = await boot()
    seedRates()
    const id = await h.mk("EUR")
    const res = await h.json(`/api/wallets/${id}/deposits`, { amount: 1000 })
    expect(res.status).toBe(201)
    const tx = await res.json()
    expect(tx.feeCurrency).toBe("EUR")
    expect(tx.rateSource).toBe("automatic")
    expect(tx.exchangeRate).toBeCloseTo(1.08, 6) // EUR -> USD display snapshot
    expect(tx.new_balance).toBe(1000)

    const list = await h.request("/api/wallets", { headers: h.headers })
    expect((await list.json())[0].balance).toBe(1000)
  })

  it("withdrawal pct fee materializes against the amount (D28)", async () => {
    const h = await boot()
    seedRates()
    const id = await h.mk("EUR")
    await h.json(`/api/wallets/${id}/deposits`, { amount: 1000 })
    const res = await h.json(`/api/wallets/${id}/withdrawals`, {
      amount: 100,
      fees: 2,
      fees_type: "pct",
    })
    expect(res.status).toBe(201)
    const tx = await res.json()
    expect(tx.fees_settled).toBeCloseTo(2, 8)
    expect(tx.remaining_balance).toBeCloseTo(898, 8)
  })

  it("foreign-currency fee settles into wallet ccy via fx_rates", async () => {
    const h = await boot()
    seedRates()
    const id = await h.mk("EUR")
    await h.json(`/api/wallets/${id}/deposits`, { amount: 1000 })
    const res = await h.json(`/api/wallets/${id}/withdrawals`, {
      amount: 10,
      fees: 10,
      fees_type: "fixed",
      feeCurrency: "USD",
    })
    const tx = await res.json()
    expect(tx.fees_settled).toBeCloseTo(10 / 1.08, 6) // 10 USD -> EUR
    expect(tx.remaining_balance).toBeCloseTo(1000 - 10 - 10 / 1.08, 6)
  })

  it("manual rates are echoed verbatim; invalid ones → 422", async () => {
    const h = await boot()
    seedRates()
    const id = await h.mk("USD")
    const okRes = await h.json(`/api/wallets/${id}/deposits`, {
      amount: 1,
      rateSource: "manual",
      exchangeRate: 4.5,
    })
    const okBody = await okRes.json()
    expect(okBody.rateSource).toBe("manual")
    expect(okBody.exchangeRate).toBeCloseTo(4.5, 8)

    const bad = await h.json(`/api/wallets/${id}/deposits`, {
      amount: 1,
      rateSource: "manual",
      exchangeRate: -2,
    })
    expect(bad.status).toBe(422)
  })

  it("overdraft → 422 insufficient funds; ledger untouched", async () => {
    const h = await boot()
    seedRates()
    const id = await h.mk("USD")
    const res = await h.json(`/api/wallets/${id}/withdrawals`, { amount: 5 })
    expect(res.status).toBe(422)
  })

  it("foreign resources → 404 even for movements (D24)", async () => {
    const h = await boot()
    const [foreign] = await h.db
      .insert(wallets)
      .values({ userId: "someone-else", name: "f", currency: "USD" })
      .returning()
    const res = await h.json(`/api/wallets/${foreign.id}/deposits`, { amount: 1 })
    expect(res.status).toBe(404)
  })
})

describe("transfers incl. cross-currency elastic legs (§11.4 / wallets D22)", () => {
  // each case seeds rates itself (cross-currency legs need them)
  it("same-currency transfer mirrors value on both linked legs", async () => {
    const h = await boot()
    seedRates()

    const a = await h.mk("USD", "A")
    const b = await h.mk("USD", "B")
    await h.json(`/api/wallets/${a}/deposits`, { amount: 100 })
    const res = await h.json(`/api/wallets/${a}/transfers`, {
      amount: 30,
      to_wallet_id: b,
    })
    expect(res.status).toBe(201)
    const out = await res.json()
    expect(out.new_balance).toBe(70)

    const destTxs = await h.request(`/api/wallets/${b}/transactions`, { headers: h.headers })
    void destTxs
    const [dest] = await h.db.select().from(wallets).where(eq(wallets.id, b))
    expect(Number(dest.balance)).toBe(30)
  })

  it("cross-currency: credits converted target, stores rate + targetAmount on both legs", async () => {
    const h = await boot()
    seedRates()
    const eur = await h.mk("EUR", "EUR main")
    const usd = await h.mk("USD", "USD side")
    await h.json(`/api/wallets/${eur}/deposits`, { amount: 43 })
    const res = await h.json(`/api/wallets/${eur}/transfers`, {
      amount: 43,
      to_wallet_id: usd,
    })
    expect(res.status).toBe(201)
    const out = await res.json()
    // 43 EUR -> USD at 1.08
    expect(out.targetAmount).toBeCloseTo(46.44, 6)
    expect(Number(out.transferFxRate)).toBeCloseTo(1.08, 6)

    const [dest] = await h.db.select().from(wallets).where(eq(wallets.id, usd))
    expect(Number(dest.balance)).toBeCloseTo(46.44, 6)
  })

  it("manual targetAmount wins over the computed conversion", async () => {
    const h = await boot()
    seedRates()
    const eur = await h.mk("EUR")
    const pln = await h.mk("PLN")
    await h.json(`/api/wallets/${eur}/deposits`, { amount: 20 })
    const res = await h.json(`/api/wallets/${eur}/transfers`, {
      amount: 20,
      to_wallet_id: pln,
      targetAmount: 99,
    })
    const out = await res.json()
    expect(Number(out.targetAmount)).toBe(99)
    const [dest] = await h.db.select().from(wallets).where(eq(wallets.id, pln))
    expect(Number(dest.balance)).toBe(99)
  })
})
