import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { makeHarness } from "./test-utils.js"
import { createAdminRoutes } from "./admin.js"
import { fxRates } from "../db/schema.js"

async function boot() {
  const h = await makeHarness("admin-1")
  const app = new Hono().route("/", createAdminRoutes(h.db))
  return { ...h, app }
}

async function seedRates(db: import("../db/index.js").DB) {
  await db.insert(fxRates).values([
    { rateDate: "2024-01-02", currency: "USD", rate: "1.0952" },
    { rateDate: "2024-01-02", currency: "PLN", rate: "4.34" },
    { rateDate: "2024-01-03", currency: "USD", rate: "1.0971" },
    { rateDate: "2024-01-03", currency: "PLN", rate: "4.35" },
  ])
}

describe("GET /admin/fx-rates (D47)", () => {
  it("requires portfoliost_admin group (403 otherwise)", async () => {
    const h = await boot()
    // default X-User-Groups from the harness resolves to portfoliost_admin;
    // override to a non-admin group via a direct identity header
    const res = await h.app.request("/fx-rates", {
      headers: { "X-User-Id": "admin-1", "X-User-Email": "admin-1@test.dev", "X-User-Groups": "users" },
    })
    expect(res.status).toBe(403)
  })

  it("lists EUR-based rows with contract shape", async () => {
    const h = await boot()
    await seedRates(h.db)
    const res = await h.app.request("/fx-rates", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(4)
    expect(body.items[0]).toEqual({ date: expect.any(String), baseCurrency: "EUR", quoteCurrency: expect.any(String), rate: expect.any(Number) })
    expect(body.pagination).toEqual({ total: 4, page: 1, per_page: 50, total_pages: 1 })
  })

  it("quote_currency filters server-side with correct pagination", async () => {
    const h = await boot()
    await seedRates(h.db)
    const res = await h.app.request("/fx-rates?quote_currency=USD", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(body.items.every((i: { quoteCurrency: string }) => i.quoteCurrency === "USD")).toBe(true)
    expect(body.pagination.total).toBe(2)
    expect(body.pagination.total_pages).toBe(1)
  })

  it("quote_currency is case-insensitive", async () => {
    const h = await boot()
    await seedRates(h.db)
    const res = await h.app.request("/fx-rates?quote_currency=pln", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(body.items[0].quoteCurrency).toBe("PLN")
  })

  it("date_from / date_to bound the range independently", async () => {
    const h = await boot()
    await seedRates(h.db)
    const fromOnly = await h.app.request("/fx-rates?date_from=2024-01-03", { headers: h.headers })
    const fromBody = await fromOnly.json()
    expect(fromBody.items).toHaveLength(2)
    expect(fromBody.items.every((i: { date: string }) => i.date === "2024-01-03")).toBe(true)

    const toOnly = await h.app.request("/fx-rates?date_to=2024-01-02", { headers: h.headers })
    const toBody = await toOnly.json()
    expect(toBody.items).toHaveLength(2)
    expect(toBody.items.every((i: { date: string }) => i.date === "2024-01-02")).toBe(true)
  })

  it("base_currency: EUR matches everything, any other base matches nothing", async () => {
    const h = await boot()
    await seedRates(h.db)
    const eur = await h.app.request("/fx-rates?base_currency=EUR", { headers: h.headers })
    expect((await eur.json()).items).toHaveLength(4)
    const usd = await h.app.request("/fx-rates?base_currency=USD", { headers: h.headers })
    const usdBody = await usd.json()
    expect(usdBody.items).toHaveLength(0)
    expect(usdBody.pagination.total).toBe(0)
  })
})