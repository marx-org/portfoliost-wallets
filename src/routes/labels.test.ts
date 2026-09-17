import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { createLabelRoutes } from "./labels.js"
import { createPositionLabelRoutes } from "./position-labels.js"
import { createTransactionLabelRoutes } from "./transaction-labels.js"
import { createWalletTransactionLabelRoutes } from "./wallet-transaction-labels.js"
import { createPortfolioRoutes } from "./portfolios.js"
import { createCrossPortfolioTransactionsRoute } from "./portfolio-transactions.js"
import { createWalletRoutes } from "./wallets.js"
import { createMovementRoutes } from "./movements.js"
import { createHistoryRoutes } from "./history.js"
import { makeHarness, type Harness } from "./test-utils.js"

const BUY_BODY = {
  type: "BUY",
  symbol: "AAPL",
  instrumentName: "Apple Inc",
  quantity: 10,
  price: 150,
  currency: "USD",
  sector: "Technology",
  country: "US",
  assetType: "STOCK",
}

async function boot() {
  const h = await makeHarness()
  const a = new Hono()
  // mirror production mount order (src/index.ts)
  a.route("/api/wallets", createWalletRoutes(h.db))
  a.route("/api/wallets", createMovementRoutes(h.db))
  a.route("/api/wallets", createHistoryRoutes(h.db))
  a.route("/api/portfolios/transactions", createCrossPortfolioTransactionsRoute(h.db))
  a.route("/api/portfolios", createPortfolioRoutes(h.db))
  a.route("/api/labels", createLabelRoutes(h.db))
  a.route("/api/positions", createPositionLabelRoutes(h.db))
  a.route("/api/portfolios", createTransactionLabelRoutes(h.db))
  a.route("/api/wallets", createWalletTransactionLabelRoutes(h.db))
  return { ...h, app: a }
}

type Boot = Awaited<ReturnType<typeof boot>>

async function label(h: Boot, name: string, color?: string) {
  const res = await h.app.request("/api/labels", {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify(color ? { name, color } : { name }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; name: string; color: string }
}

async function portfolio(h: Boot, name = "P") {
  const res = await h.app.request("/api/portfolios", {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify({ name, currency: "USD" }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function buy(h: Boot, portfolioId: string, symbol = "AAPL") {
  const res = await h.app.request(`/api/portfolios/${portfolioId}/transactions`, {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify({ ...BUY_BODY, symbol }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { id: string; positionId: string | null }
  return { txId: body.id, positionId: body.positionId! }
}

async function wallet(h: Boot, currency = "USD", name = currency) {
  const res = await h.app.request("/api/wallets", {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify({ name, currency }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function deposit(h: Boot, walletId: string, amount = 100) {
  const res = await h.app.request(`/api/wallets/${walletId}/deposits`, {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify({ amount }),
  })
  expect(res.status).toBe(201)
  return (await res.json()).id as string
}

function setLabels(path: string, labelIds: string[]) {
  return (h: Boot) =>
    h.app.request(path, {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ labelIds }),
    })
}

describe("labels CRUD (D65, D66 palette, D24 scoping)", () => {
  it("POST auto-assigns the next unused palette color", async () => {
    const h = await boot()
    const a = await label(h, "Alpha")
    const b = await label(h, "Beta")
    expect(a.color).toBe("#64748b")
    expect(b.color).toBe("#ef4444")
  })

  it("POST honors an explicit color", async () => {
    const h = await boot()
    const a = await label(h, "Star", "#123456")
    expect(a.color).toBe("#123456")
  })

  it("POST rejects empty name and malformed hex (422)", async () => {
    const h = await boot()
    for (const body of [{ name: "  " }, { name: "x", color: "red" }, { name: "x", color: "#12" }]) {
      const res = await h.app.request("/api/labels", {
        method: "POST",
        headers: { ...h.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(422)
    }
  })

  it("POST duplicate name → 409", async () => {
    const h = await boot()
    await label(h, "Same")
    const res = await h.app.request("/api/labels", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Same" }),
    })
    expect(res.status).toBe(409)
  })

  it("GET returns labels sorted alphabetically", async () => {
    const h = await boot()
    await label(h, "Zulu")
    await label(h, "Alpha")
    await label(h, "Mike")
    const res = await h.app.request("/api/labels", { headers: h.headers })
    const body = (await res.json()) as { name: string }[]
    expect(body.map((l) => l.name)).toEqual(["Alpha", "Mike", "Zulu"])
  })

  it("PATCH renames/recolors; duplicate → 409; foreign → 404", async () => {
    const h = await boot()
    const a = await label(h, "A")
    await label(h, "B")
    const ok = await h.app.request(`/api/labels/${a.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "A2", color: "#abcdef" }),
    })
    expect(ok.status).toBe(200)
    const renamed = (await ok.json()) as { name: string; color: string }
    expect(renamed.name).toBe("A2")
    expect(renamed.color).toBe("#abcdef")

    const dup = await h.app.request(`/api/labels/${a.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "B" }),
    })
    expect(dup.status).toBe(409)

    const intruder = await makeHarness("intruder")
    const stranger = await h.app.request(`/api/labels/${a.id}`, {
      method: "PATCH",
      headers: { ...intruder.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    })
    expect(stranger.status).toBe(404)
  })

  it("DELETE removes label and its join rows (cascade); foreign → 404", async () => {
    const h = await boot()
    const l = await label(h, "Cascade")
    const w = await wallet(h)
    const txId = await deposit(h, w.id)
    await setLabels(`/api/wallets/${w.id}/transactions/${txId}/labels`, [l.id])(h)

    const res = await h.app.request(`/api/labels/${l.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(204)
    const list = await (await h.app.request("/api/labels", { headers: h.headers })).json()
    expect(list).toEqual([])

    // join rows gone → wallet history shows no labels
    const hist = await (
      await h.app.request(`/api/wallets/${w.id}/transactions`, { headers: h.headers })
    ).json()
    expect(hist.items[0].labels).toEqual([])

    const stranger = await h.app.request(`/api/labels/${l.id}`, {
      method: "DELETE",
      headers: (await makeHarness("intruder")).headers,
    })
    expect(stranger.status).toBe(404)
  })

  it("palette wraps by modulo after all 10 colors are used", async () => {
    const h = await boot()
    const made: string[] = []
    for (let i = 0; i < 10; i++) made.push((await label(h, `L${i}`)).color)
    expect(new Set(made).size).toBe(10)
    const eleventh = await label(h, "L11")
    expect(eleventh.color).toBe("#64748b")
  })
})

describe("set-labels on positions (replace semantics)", () => {
  it("assigns and returns labels sorted; they appear in the positions listing", async () => {
    const h = await boot()
    const z = await label(h, "Zulu")
    const a = await label(h, "Alpha")
    const p = await portfolio(h)
    const { positionId } = await buy(h, p.id)

    const res = await setLabels(`/api/positions/${positionId}/labels`, [z.id, a.id])(h)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string }[]
    expect(body.map((l) => l.name)).toEqual(["Alpha", "Zulu"])

    const list = await (await h.app.request(`/api/portfolios/${p.id}/positions`, { headers: h.headers })).json()
    const apple = list.find((x: any) => x.symbol === "AAPL")
    expect(apple.labels.map((l: any) => l.name)).toEqual(["Alpha", "Zulu"])
  })

  it("empty set clears previous labels (replace semantics)", async () => {
    const h = await boot()
    const l = await label(h, "Temp")
    const p = await portfolio(h)
    const { positionId } = await buy(h, p.id)
    await setLabels(`/api/positions/${positionId}/labels`, [l.id])(h)

    const res = await setLabels(`/api/positions/${positionId}/labels`, [])(h)
    expect(res.status).toBe(200)
    const list = await (await h.app.request(`/api/portfolios/${p.id}/positions`, { headers: h.headers })).json()
    expect(list.find((x: any) => x.id === positionId).labels).toEqual([])
  })

  it("foreign position → 404; foreign label → 404", async () => {
    const h = await boot()
    const p = await portfolio(h)
    const { positionId } = await buy(h, p.id)
    const stranger = await makeHarness("intruder")
    const foreignPos = await h.app.request(`/api/positions/${positionId}/labels`, {
      method: "POST",
      headers: stranger.headers,
      body: JSON.stringify({ labelIds: [] }),
    })
    expect(foreignPos.status).toBe(404)

    const badLabel = await setLabels(`/api/positions/${positionId}/labels`, [
      "123e4567-e89b-12d3-a456-426614174001",
    ])(h)
    expect(badLabel.status).toBe(404)
  })
})

describe("set-labels on portfolio transactions", () => {
  it("assigns labels and they appear in the tx listing", async () => {
    const h = await boot()
    const l = await label(h, "TaxLot")
    const p = await portfolio(h)
    const { txId } = await buy(h, p.id)
    const res = await setLabels(`/api/portfolios/${p.id}/transactions/${txId}/labels`, [l.id])(h)
    expect(res.status).toBe(200)

    const list = await (
      await h.app.request(`/api/portfolios/${p.id}/transactions?limit=50`, { headers: h.headers })
    ).json()
    const row = list.items.find((x: any) => x.id === txId)
    expect(row.labels.map((x: any) => x.name)).toEqual(["TaxLot"])
  })

  it("replace semantics: second set replaces, not appends", async () => {
    const h = await boot()
    const l1 = await label(h, "One")
    const l2 = await label(h, "Two")
    const p = await portfolio(h)
    const { txId } = await buy(h, p.id)
    await setLabels(`/api/portfolios/${p.id}/transactions/${txId}/labels`, [l1.id])(h)
    const res = await setLabels(`/api/portfolios/${p.id}/transactions/${txId}/labels`, [l2.id])(h)
    expect(res.status).toBe(200)
    const list = await (
      await h.app.request(`/api/portfolios/${p.id}/transactions?limit=50`, { headers: h.headers })
    ).json()
    const row = list.items.find((x: any) => x.id === txId)
    expect(row.labels.map((x: any) => x.name)).toEqual(["Two"])
  })

  it("foreign tx → 404", async () => {
    const h = await boot()
    const res = await h.app.request(
      "/api/portfolios/00000000-0000-0000-0000-000000000000/transactions/00000000-0000-0000-0000-000000000000/labels",
      { method: "POST", headers: { ...h.headers, "content-type": "application/json" }, body: JSON.stringify({ labelIds: [] }) },
    )
    expect(res.status).toBe(404)
  })
})

describe("set-labels on wallet transactions", () => {
  it("assigns labels; they appear in wallet history and recent-transactions", async () => {
    const h = await boot()
    const l = await label(h, "Salary")
    const w = await wallet(h)
    const txId = await deposit(h, w.id, 120)
    const res = await setLabels(`/api/wallets/${w.id}/transactions/${txId}/labels`, [l.id])(h)
    expect(res.status).toBe(200)

    const hist = await (
      await h.app.request(`/api/wallets/${w.id}/transactions`, { headers: h.headers })
    ).json()
    expect(hist.items[0].labels.map((x: any) => x.name)).toEqual(["Salary"])

    const recent = await (
      await h.app.request("/api/wallets/recent-transactions?limit=50", { headers: h.headers })
    ).json()
    expect(recent.data[0].labels.map((x: any) => x.name)).toEqual(["Salary"])
  })

  it("foreign wallet tx → 404", async () => {
    const h = await boot()
    const res = await h.app.request(
      "/api/wallets/00000000-0000-0000-0000-000000000000/transactions/00000000-0000-0000-0000-000000000000/labels",
      { method: "POST", headers: { ...h.headers, "content-type": "application/json" }, body: JSON.stringify({ labelIds: [] }) },
    )
    expect(res.status).toBe(404)
  })
})

describe("?labels= AND filter (D67)", () => {
  it("positions: entity must carry ALL requested labels", async () => {
    const h = await boot()
    const a = await label(h, "Growth")
    const b = await label(h, "US")
    const p = await portfolio(h)
    const p1 = (await buy(h, p.id, "AAPL")).positionId
    await setLabels(`/api/positions/${p1}/labels`, [a.id, b.id])(h)
    await setLabels(`/api/positions/${(await buy(h, p.id, "MSFT")).positionId}/labels`, [b.id])(h)
    await buy(h, p.id, "TSLA") // no labels

    const all = await (await h.app.request(`/api/portfolios/${p.id}/positions`, { headers: h.headers })).json()
    expect(all).toHaveLength(3)
    const both = await (
      await h.app.request(`/api/portfolios/${p.id}/positions?labels=${a.id},${b.id}`, { headers: h.headers })
    ).json()
    expect(both).toHaveLength(1)
    expect(both[0].symbol).toBe("AAPL")
    const one = await (
      await h.app.request(`/api/portfolios/${p.id}/positions?labels=${b.id}`, { headers: h.headers })
    ).json()
    expect(one).toHaveLength(2)
  })

  it("portfolio transactions: AND filter with count", async () => {
    const h = await boot()
    const a = await label(h, "TaxLot")
    const b = await label(h, "Batch")
    const p = await portfolio(h)
    const t1 = (await buy(h, p.id, "AAPL")).txId
    await setLabels(`/api/portfolios/${p.id}/transactions/${t1}/labels`, [a.id])(h)

    const before = await (
      await h.app.request(`/api/portfolios/${p.id}/transactions?limit=50`, { headers: h.headers })
    ).json()
    expect(before.total).toBe(1)

    // no matches → 0 rows
    const none = await (
      await h.app.request(`/api/portfolios/${p.id}/transactions?labels=${a.id},${b.id}`, { headers: h.headers })
    ).json()
    expect(none.total).toBe(0)
    expect(none.items).toEqual([])

    // cross-portfolio feed behaves the same
    const cross = await (
      await h.app.request(`/api/portfolios/transactions?labels=${a.id}&limit=50`, { headers: h.headers })
    ).json()
    expect(cross.total).toBe(1)
    expect(cross.items[0].labels[0].name).toBe("TaxLot")
  })

  it("wallet transactions: wallet-scoped + recent feed", async () => {
    const h = await boot()
    const a = await label(h, "Biz")
    const b = await label(h, "Home")
    const w1 = await wallet(h, "USD", "USD W1")
    const w2 = await wallet(h, "USD", "USD W2")
    const d1 = await deposit(h, w1.id, 100)
    const d2 = await deposit(h, w2.id, 50)
    await setLabels(`/api/wallets/${w1.id}/transactions/${d1}/labels`, [a.id, b.id])(h)
    await setLabels(`/api/wallets/${w2.id}/transactions/${d2}/labels`, [b.id])(h)

    const scoped = await (
      await h.app.request(`/api/wallets/${w1.id}/transactions?labels=${a.id}`, { headers: h.headers })
    ).json()
    expect(scoped.total).toBe(1)
    expect(scoped.items[0].id).toBe(d1)

    const all = await (
      await h.app.request(`/api/wallets/recent-transactions?labels=${a.id},${b.id}`, { headers: h.headers })
    ).json()
    expect(all.data).toHaveLength(1)
    expect(all.data[0].id).toBe(d1)
  })
})