import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { createImportRoutes } from "./import.js"
import { makeHarness } from "./test-utils.js"
import { wallets, portfolios } from "../db/schema.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono().route("/api/import", createImportRoutes(h.db))
  return { ...h, app }
}

describe("POST /api/import/wallets/bootstrap (§23.3)", () => {
  it("creates wallets tagged with externalSource on first call (created=true)", async () => {
    const h = await boot()
    const res = await h.app.request("/api/import/wallets/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "google-sheets:transakcje",
        wallets: [
          { name: "IBKR", currency: "usd", baseCurrency: "pln" },
          { name: "IKE Marek", currency: "PLN" },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallets).toEqual([
      { id: expect.any(String), name: "IBKR", currency: "USD", baseCurrency: "PLN", created: true },
      { id: expect.any(String), name: "IKE Marek", currency: "PLN", baseCurrency: "USD", created: true },
    ])

    const rows = await h.db
      .select({ externalSource: wallets.externalSource, name: wallets.name })
      .from(wallets)
    expect(rows).toEqual([
      { externalSource: "google-sheets:transakcje", name: "IBKR" },
      { externalSource: "google-sheets:transakcje", name: "IKE Marek" },
    ])
  })

  it("second call returns same ids, created=false, and does not re-tag", async () => {
    const h = await boot()
    const call = () =>
      h.app.request("/api/import/wallets/bootstrap", {
        method: "POST",
        headers: { ...h.headers, "content-type": "application/json" },
        body: JSON.stringify({
          externalSource: "google-sheets:transakcje",
          wallets: [{ name: "IBKR", currency: "USD" }],
        }),
      })

    const first = await (await call()).json()
    expect(first.wallets[0].created).toBe(true)

    const second = await (await call()).json()
    expect(second.wallets[0]).toMatchObject({ id: first.wallets[0].id, created: false })
    expect(first.wallets[0].id).toBe(second.wallets[0].id)
  })

  it("never re-tags a pre-existing manual wallet with the same name", async () => {
    const h = await boot()
    await h.db.insert(wallets).values({ userId: "user-1", name: "IBKR", currency: "USD" })

    const res = await h.app.request("/api/import/wallets/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "google-sheets:transakcje",
        wallets: [{ name: "IBKR", currency: "USD" }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallets[0].created).toBe(false)

    const [tagged] = await h.db
      .select({ externalSource: wallets.externalSource })
      .from(wallets)
      .where(eq(wallets.name, "IBKR"))
    expect(tagged.externalSource).toBeNull()
  })

  it("unknown fields → 422", async () => {
    const h = await boot()
    const res = await h.app.request("/api/import/wallets/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "google-sheets:transakcje",
        wallets: [{ name: "IBKR", currency: "USD", surprise: true }],
      }),
    })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe("ValidationError")
  })
})

describe("POST /api/import/portfolios/bootstrap (§23.3)", () => {
  it("creates a portfolio tagged with externalSource; second call is idempotent", async () => {
    const h = await boot()
    const call = () =>
      h.app.request("/api/import/portfolios/bootstrap", {
        method: "POST",
        headers: { ...h.headers, "content-type": "application/json" },
        body: JSON.stringify({
          externalSource: "google-sheets:transakcje",
          name: "Transakcje",
          currency: "PLN",
          baseCurrency: "PLN",
        }),
      })

    const first = await (await call()).json()
    expect(first).toMatchObject({ name: "Transakcje", currency: "PLN", baseCurrency: "PLN", created: true })

    const second = await (await call()).json()
    expect(second).toMatchObject({ id: first.id, name: "Transakcje", created: false })

    const [row] = await h.db
      .select({ externalSource: portfolios.externalSource })
      .from(portfolios)
      .where(eq(portfolios.id, first.id))
    expect(row.externalSource).toBe("google-sheets:transakcje")
  })

  it("unknown fields → 422", async () => {
    const h = await boot()
    const res = await h.app.request("/api/import/portfolios/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "s",
        name: "P",
        currency: "PLN",
        bogus: 1,
      }),
    })
    expect(res.status).toBe(422)
  })
})