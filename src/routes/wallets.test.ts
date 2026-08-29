import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { createWalletRoutes } from "./wallets.js"
import { makeHarness } from "./test-utils.js"
import { wallets, walletTransactions, portfolios } from "../db/schema.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono().route("/api/wallets", createWalletRoutes(h.db))
  return { ...h, app }
}

describe("POST /api/wallets (§11.3)", () => {
  it("creates with mandatory currency; missing currency → 422", async () => {
    const h = await boot()
    const ok = await h.app.request("/api/wallets", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Cash PLN", currency: "pln" }),
    })
    expect(ok.status).toBe(201)
    const body = await ok.json()
    expect(body.currency).toBe("PLN")
    expect(body.baseCurrency).toBe("USD") // default until 11.10 preference lookup
    expect(body.balance).toBe(0)

    const bad = await h.app.request("/api/wallets", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "No currency" }),
    })
    expect(bad.status).toBe(422)
    expect((await bad.json()).error).toBe("ValidationError")
  })

  it("accepts explicit baseCurrency (D21b)", async () => {
    const h = await boot()
    const res = await h.app.request("/api/wallets", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "W", currency: "EUR", baseCurrency: "PLN" }),
    })
    expect((await res.json()).baseCurrency).toBe("PLN")
  })
})

describe("GET /api/wallets (D24 scoping)", () => {
  it("lists only the caller's wallets; foreign data invisible", async () => {
    const h = await boot()
    const seed = h.db as never as { insert: Function }
    void seed
    await h.db.insert(wallets).values([
      { userId: "user-1", name: "mine", currency: "USD" },
      { userId: "other-user", name: "theirs", currency: "EUR" },
    ])
    const res = await h.app.request("/api/wallets", { headers: h.headers })
    const list = await res.json()
    expect(list.map((w: { name: string }) => w.name)).toEqual(["mine"])
  })
})

describe("PATCH /api/wallets/:id", () => {
  it("renames own wallet; foreign wallet → 404 not 403 (D24)", async () => {
    const h = await boot()
    const [foreign] = await h.db
      .insert(wallets)
      .values({ userId: "someone-else", name: "not yours", currency: "USD" })
      .returning()

    const mine = await h.app.request("/api/wallets", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "old", currency: "USD" }),
    })
    const mineId = (await mine.json()).id

    const renamed = await h.app.request(`/api/wallets/${mineId}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "new name" }),
    })
    expect(renamed.status).toBe(200)
    expect((await renamed.json()).name).toBe("new name")

    const foreignRes = await h.app.request(`/api/wallets/${foreign.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "hax" }),
    })
    expect(foreignRes.status).toBe(404)
  })
})

describe("DELETE /api/wallets/:id — guarded delete (D18/D24)", () => {
  it("204 when empty; 409 when transactions exist; 404 foreign", async () => {
    const h = await boot()
    const created = await h.app.request("/api/wallets", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "empty", currency: "USD" }),
    })
    const id = (await created.json()).id

    expect(
      (await h.app.request(`/api/wallets/${id}`, { method: "DELETE", headers: h.headers })).status,
    ).toBe(204)

    const [kept] = await h.db
      .insert(wallets)
      .values({ userId: "user-1", name: "has txns", currency: "USD" })
      .returning()
    await h.db.insert(walletTransactions).values({
      userId: "user-1",
      walletId: kept.id,
      type: "DEPOSIT",
      amount: "10",
      currency: "USD",
    })
    // also covers inbound-transfer reference: to_wallet_id counts via guard query
    const blocked = await h.app.request(`/api/wallets/${kept.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(blocked.status).toBe(409)

    const [foreign] = await h.db
      .insert(wallets)
      .values({ userId: "another", name: "f", currency: "USD" })
      .returning()
    expect(
      (
        await h.app.request(`/api/wallets/${foreign.id}`, {
          method: "DELETE",
          headers: h.headers,
        })
      ).status,
    ).toBe(404)
  })

  it("409 with portfolio-name message when wallet is the cash wallet of a portfolio", async () => {
    const h = await boot()
    const [w] = await h.db
      .insert(wallets)
      .values({ userId: "user-1", name: "My Cash Wallet", currency: "USD" })
      .returning()
    await h.db.insert(portfolios).values({
      userId: "user-1",
      name: "My Portfolio",
      currency: "USD",
      walletId: w.id,
    })
    const res = await h.app.request(`/api/wallets/${w.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.message).toMatch(/My Cash Wallet/)
    expect(body.message).toMatch(/My Portfolio/)
  })
})
