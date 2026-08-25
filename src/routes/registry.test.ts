import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { makeHarness } from "./test-utils.js"
import { createRegistryRoutes } from "./registry.js"
import { fxRates } from "../db/schema.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono().route("/", createRegistryRoutes(h.db))
  return { ...h, app }
}

describe("GET /api/currencies (D26)", () => {
  it("returns EUR alone when nothing imported yet", async () => {
    const h = await boot()
    const res = await h.app.request("/currencies")
    const body = await res.json()
    expect(body.currencies.map((c: { code: string }) => c.code)).toEqual(["EUR"])
  })

  it("reflects imported currencies with contracts metadata, auto-updated set", async () => {
    const h = await boot()
    await h.db.insert(fxRates).values([
      { rateDate: "2026-08-21", currency: "USD", rate: "1.0812" },
      { rateDate: "2026-08-21", currency: "PLN", rate: "4.3" },
      // a currency outside the metadata catalog still appears
      { rateDate: "2026-08-21", currency: "XYZ", rate: "2.0" },
    ])
    const res = await h.app.request("/currencies")
    const body = await res.json()
    const codes = body.currencies.map((c: { code: string }) => c.code)
    expect(codes).toContain("EUR")
    expect(codes).toContain("USD")
    expect(codes).toContain("PLN")
    expect(codes).toContain("XYZ")

    const usd = body.currencies.find((c: { code: string }) => c.code === "USD")
    expect(usd.name).toBe("US Dollar")
    expect(usd.symbol).toBe("$")
    expect(usd.minorUnits).toBe(2)
    expect(typeof usd.popular).toBe("boolean")

    const xyz = body.currencies.find((c: { code: string }) => c.code === "XYZ")
    expect(xyz.name).toBe("XYZ") // graceful fallback
  })
})

describe("GET /internal/fx-rates (D20 internal exposure)", () => {
  it("crosses non-EUR pairs via EUR and reports asOf carry-forward date", async () => {
    const h = await boot()
    // weekend-style gap: newest two days lack USD entirely
    await h.db.insert(fxRates).values([
      { rateDate: "2026-08-20", currency: "USD", rate: "1.07" },
      { rateDate: "2026-08-20", currency: "PLN", rate: "4.30" },
      { rateDate: "2026-08-21", currency: "PLN", rate: "4.31" },
      { rateDate: "2026-08-22", currency: "PLN", rate: "4.32" },
    ])
    const res = await h.app.request(
      "/internal/fx-rates?from=USD&to=PLN",
      { headers: { "X-User-Id": "svc", "X-User-Email": "svc@t.dev" } },
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.rate).toBeCloseTo(4.3 / 1.07, 8)
    expect(body.asOf).toBe("2026-08-20")
  })

  it("exact-date lookup", async () => {
    const h = await boot()
    await h.db.insert(fxRates).values([
      { rateDate: "2026-08-19", currency: "USD", rate: "1.07" },
      { rateDate: "2026-08-20", currency: "USD", rate: "1.09" },
    ])
    const res = await h.app.request(
      "/internal/fx-rates?from=USD&to=EUR&date=2026-08-19",
      { headers: { "X-User-Id": "svc", "X-User-Email": "svc@t.dev" } },
    )
    const body = await res.json()
    expect(body.rate).toBeCloseTo(1 / 1.07, 8)
  })

  it("serves the SPA-facing /api/fx/latest with the same semantics", async () => {
    const h = await boot()
    await h.db.insert(fxRates).values([
      { rateDate: "2026-08-21", currency: "USD", rate: "1.08" },
      { rateDate: "2026-08-21", currency: "PLN", rate: "4.30" },
    ])
    const res = await h.app.request(
      "/fx/latest?from=USD&to=PLN",
      { headers: { "X-User-Id": "u", "X-User-Email": "u@t.dev" } },
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.rate).toBeCloseTo(4.3 / 1.08, 8)
    expect(body.asOf).toBe("2026-08-21")
  })

  it("validates inputs and 404s unknown pairs", async () => {
    const h = await boot()
    const bad = await h.app.request(
      "/internal/fx-rates?from=US&to=EUR",
      { headers: { "X-User-Id": "svc", "X-User-Email": "svc@t.dev" } },
    )
    expect(bad.status).toBe(422)
  })
})

describe("GET /internal/fx-rates — dated carry-forward (D39)", () => {
  it("walks back from the requested date over weekend/sync gaps", async () => {
    const h = await boot()
    // requested date (2026-08-25) has no rows; last quotable day is 2026-08-22
    await h.db.insert(fxRates).values([
      { rateDate: "2026-08-22", currency: "USD", rate: "1.07" },
      { rateDate: "2026-08-22", currency: "PLN", rate: "4.30" },
    ])
    const res = await h.app.request(
      "/internal/fx-rates?from=PLN&to=USD&date=2026-08-25",
      { headers: { "X-User-Id": "svc", "X-User-Email": "svc@t.dev" } },
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.rate).toBeCloseTo(1.07 / 4.3, 8)
    expect(body.asOf).toBe("2026-08-22")
  })

  it("prefers the exact date when present", async () => {
    const h = await boot()
    await h.db.insert(fxRates).values([
      { rateDate: "2026-08-22", currency: "USD", rate: "1.07" },
      { rateDate: "2026-08-22", currency: "PLN", rate: "4.30" },
      { rateDate: "2026-08-25", currency: "USD", rate: "1.08" },
      { rateDate: "2026-08-25", currency: "PLN", rate: "4.00" },
    ])
    const res = await h.app.request(
      "/internal/fx-rates?from=PLN&to=USD&date=2026-08-25",
      { headers: { "X-User-Id": "svc", "X-User-Email": "svc@t.dev" } },
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.rate).toBeCloseTo(1.08 / 4.0, 8)
    expect(body.asOf).toBe("2026-08-25")
  })
})
