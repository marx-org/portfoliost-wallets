import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { createWalletRoutes } from "./wallets.js"
import { createMovementRoutes } from "./movements.js"
import { createTransactionRoutes } from "./transactions.js"
import { makeHarness } from "./test-utils.js"
import { wallets, walletTransactions } from "../db/schema.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono()
    .route("/api/wallets/transactions", createTransactionRoutes(h.db))
    .route("/api/wallets", createMovementRoutes(h.db))
    .route("/api/wallets", createWalletRoutes(h.db))
  const request = (path: string, init?: RequestInit) => app.request(path, init)
  const json = (path: string, body: unknown, method = "POST") =>
    request(path, {
      method,
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const mk = async (currency = "USD") => {
    const res = await json("/api/wallets", { name: currency, currency })
    return (await res.json()).id as string
  }
  const walletOf = async (id: string) => {
    const [w] = await h.db.select().from(wallets).where(eq(wallets.id, id))
    return Number(w.balance)
  }
  return { ...h, request, json, mk, walletOf }
}

describe("transaction edit with ledger recomputation (§11.5)", () => {
  it("amount edit adjusts the wallet balance by the delta", async () => {
    const h = await boot()
    const w = await h.mk()
    const dep = await (await h.json(`/api/wallets/${w}/deposits`, { amount: 100 })).json()
    expect(await h.walletOf(w)).toBe(100)

    const res = await h.json(`/api/wallets/transactions/${dep.id}`, { amount: 250 }, "PATCH")
    expect(res.status).toBe(200)
    expect(await h.walletOf(w)).toBe(250)
  })

  it("type flip DEPOSIT → WITHDRAWAL flips the signed effect", async () => {
    const h = await boot()
    const w = await h.mk()
    const dep = await (await h.json(`/api/wallets/${w}/deposits`, { amount: 100 })).json()

    const res = await h.json(
      `/api/wallets/transactions/${dep.id}`,
      { type: "WITHDRAWAL" },
      "PATCH",
    )
    expect(res.status).toBe(200)
    expect(await h.walletOf(w)).toBe(-100)
  })

  it("fee change recomputes settled effect in balance", async () => {
    const h = await boot()
    const w = await h.mk()
    const dep = await (await h.json(`/api/wallets/${w}/deposits`, { amount: 100 })).json()
    const res = await h.json(
      `/api/wallets/transactions/${dep.id}`,
      { fees: 10 },
      "PATCH",
    )
    expect(res.status).toBe(200)
    // deposit effect = amount − settled fee
    expect(await h.walletOf(w)).toBe(90)
  })

  it("INVEST rows are immutable (D23 #6) → 422", async () => {
    const h = await boot()
    const w = await h.mk()
    const [tx] = await h.db
      .insert(walletTransactions)
      .values({ userId: "user-1", walletId: w, type: "INVEST", amount: "-50", currency: "USD" })
      .returning()
    const res = await h.json(`/api/wallets/transactions/${tx.id}`, { amount: 10 }, "PATCH")
    expect(res.status).toBe(422)
  })

  it("foreign transactions → 404 (D24)", async () => {
    const h = await boot()
    const w = await h.mk()
    const [tx] = await h.db
      .insert(walletTransactions)
      .values({
        userId: "someone-else",
        walletId: w,
        type: "DEPOSIT",
        amount: "5",
        currency: "USD",
      })
      .returning()
    const res = await h.json(`/api/wallets/transactions/${tx.id}`, { amount: 9 }, "PATCH")
    expect(res.status).toBe(404)
  })
})

describe("transaction delete reverses effects (§11.5)", () => {
  it("deleting a withdrawal restores the balance; row is gone", async () => {
    const h = await boot()
    const w = await h.mk()
    await h.json(`/api/wallets/${w}/deposits`, { amount: 80 })
    const wd = await (await h.json(`/api/wallets/${w}/withdrawals`, { amount: 30 })).json()
    expect(await h.walletOf(w)).toBe(50)

    const res = await h.request(`/api/wallets/transactions/${wd.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(204)
    expect(await h.walletOf(w)).toBe(80)

    const list = await h.request(`/api/wallets/${w}/transactions?page=1&limit=50`, {
      headers: h.headers,
    })
    void list
    const rows = await h.db.select().from(walletTransactions).where(eq(walletTransactions.walletId, w))
    expect(rows.length).toBe(1) // only the deposit remains
  })

  it("deleting one transfer leg removes the pair and restores BOTH wallets", async () => {
    const h = await boot()
    const a = await h.mk()
    const b = await h.mk()
    await h.json(`/api/wallets/${a}/deposits`, { amount: 60 })
    const xfer = await (await h.json(`/api/wallets/${a}/transfers`, { amount: 25, to_wallet_id: b })).json()

    expect(await h.walletOf(a)).toBe(35)
    expect(await h.walletOf(b)).toBe(25)

    const res = await h.request(`/api/wallets/transactions/${xfer.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(204)
    expect(await h.walletOf(a)).toBe(60)
    expect(await h.walletOf(b)).toBe(0)
    const rows = await h.db.select().from(walletTransactions)
    expect(rows.length).toBe(1) // only the deposit
  })
})
