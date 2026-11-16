import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import {
  chartPositionDaily,
  labels,
  portfolios,
  positions,
  positionLabels,
  positionPortfolios,
  stockChartCategories,
} from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { allocationByStockCategory, allocationByAssetType, costAndValueByLabel } from "./allocation.js"

let db: DB

async function addPortfolio(name: string) {
  const [row] = await db
    .insert(portfolios)
    .values({ userId: "user-1", name, baseCurrency: "USD" })
    .returning({ id: portfolios.id })
  return row.id
}

async function addPosition(
  portfolioId: string,
  symbol: string,
  opts: { assetType?: string; instrumentCurrency?: string } = {},
) {
  const [pos] = await db
    .insert(positions)
    .values({
      userId: "user-1",
      symbol,
      assetType: opts.assetType ?? "STOCK",
      instrumentCurrency: opts.instrumentCurrency ?? "USD",
    })
    .returning({ id: positions.id })
  await db.insert(positionPortfolios).values({ positionId: pos.id, portfolioId })
  return pos.id
}

async function addFact(portfolioId: string, positionId: string, day: string, value: string, generation = 1) {
  await db.insert(chartPositionDaily).values({ generation, portfolioId, positionId, day, value, quantity: "1" })
}

async function addFactBasis(
  portfolioId: string,
  positionId: string,
  day: string,
  value: string,
  remainingBasis: string,
  generation = 1,
) {
  await db.insert(chartPositionDaily).values({
    generation,
    portfolioId,
    positionId,
    day,
    value,
    remainingBasis,
    quantity: "1",
  })
}

async function addLabel(name: string) {
  const [row] = await db
    .insert(labels)
    .values({ userId: "user-1", name, color: "#112233" })
    .returning({ id: labels.id })
  return row.id
}

async function labelPosition(positionId: string, labelId: string) {
  await db.insert(positionLabels).values({ positionId, labelId })
}

async function assign(symbol: string, category: string, instrumentCurrency = "USD", userId = "user-1") {
  await db.insert(stockChartCategories).values({ userId, symbol, category, instrumentCurrency })
}

const pub = (portfolioId: string, generation = 1) => ({ portfolioId, generation })

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("allocationByStockCategory", () => {
  it("weights the categories by market value, not by stock count", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const msft = await addPosition(pf, "MSFT")
    await assign("AAPL", "balanced")
    await assign("MSFT", "high_yield")
    await addFact(pf, aapl, "2026-01-02", "90")
    await addFact(pf, msft, "2026-01-02", "10")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf)])
    expect(out.total).toBe(100)
    expect(out.slices).toEqual([
      { key: "balanced", value: 90 },
      { key: "high_yield", value: 10 },
    ])
  })

  it("puts an unassigned stock in not_classified instead of dropping it", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const nvda = await addPosition(pf, "NVDA")
    await assign("AAPL", "balanced")
    await addFact(pf, aapl, "2026-01-02", "90")
    await addFact(pf, nvda, "2026-01-02", "10")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf)])
    expect(out.slices).toEqual([
      { key: "balanced", value: 90 },
      { key: "not_classified", value: 10 },
    ])
  })

  it("excludes bonds and derivatives from the category denominator and never lets an option inherit the equity's category", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const bond = await addPosition(pf, "BND", { assetType: "BOND" })
    const option = await addPosition(pf, "AAPL", { assetType: "OPTION" })
    await assign("AAPL", "balanced")
    await addFact(pf, aapl, "2026-01-02", "90")
    await addFact(pf, bond, "2026-01-02", "1000")
    await addFact(pf, option, "2026-01-02", "50")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf)])
    expect(out.total).toBe(90)
    expect(out.slices).toEqual([{ key: "balanced", value: 90 }])
  })

  it("sums the same stock held in two accounts once per attributed holding", async () => {
    const pf1 = await addPortfolio("A")
    const pf2 = await addPortfolio("B")
    const aapl1 = await addPosition(pf1, "AAPL")
    const aapl2 = await addPosition(pf2, "AAPL")
    await assign("AAPL", "high_growth")
    await addFact(pf1, aapl1, "2026-01-02", "40")
    await addFact(pf2, aapl2, "2026-01-02", "40")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf1), pub(pf2)])
    expect(out.total).toBe(80)
    expect(out.slices).toEqual([{ key: "high_growth", value: 80 }])
  })

  it("uses only the latest published day", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    await assign("AAPL", "balanced")
    await addFact(pf, aapl, "2026-01-01", "100")
    await addFact(pf, aapl, "2026-01-02", "120")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf)])
    expect(out.total).toBe(120)
  })

  it("returns nothing for an empty scope", async () => {
    const out = await allocationByStockCategory(db, "user-1", [])
    expect(out).toEqual({ slices: [], total: 0 })
  })
})

describe("costAndValueByLabel", () => {
  const all = { allLabels: true, labelIds: [] }

  it("reports remaining cost basis and market value per label", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const core = await addLabel("Core")
    await labelPosition(aapl, core)
    await addFactBasis(pf, aapl, "2026-01-02", "150", "100")

    const out = await costAndValueByLabel(db, "user-1", [pub(pf)], all)
    expect(out.groups).toEqual([{ key: core, label: "Core", costBasis: 100, value: 150 }])
  })

  it("counts a two-label holding in each group without treating the groups as a partition", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const core = await addLabel("Core")
    const growth = await addLabel("Growth")
    await labelPosition(aapl, core)
    await labelPosition(aapl, growth)
    await addFactBasis(pf, aapl, "2026-01-02", "150", "100")

    const out = await costAndValueByLabel(db, "user-1", [pub(pf)], all)
    const byLabel = Object.fromEntries(out.groups.map((g) => [g.label, g]))
    expect(byLabel.Core).toEqual({ key: core, label: "Core", costBasis: 100, value: 150 })
    expect(byLabel.Growth).toEqual({ key: growth, label: "Growth", costBasis: 100, value: 150 })
    // Summing the groups (300) is NOT the scope total (150).
    const groupValue = out.groups.reduce((s, g) => s + g.value, 0)
    expect(groupValue).toBe(300)
  })

  it("shows an unlabelled bucket only for All, not when labels are selected", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const msft = await addPosition(pf, "MSFT")
    const core = await addLabel("Core")
    await labelPosition(aapl, core)
    await addFactBasis(pf, aapl, "2026-01-02", "150", "100")
    await addFactBasis(pf, msft, "2026-01-02", "50", "40")

    const allOut = await costAndValueByLabel(db, "user-1", [pub(pf)], all)
    const labels = allOut.groups.map((g) => g.label)
    expect(labels).toEqual(["Core", "Unlabelled"])
    const unlabelled = allOut.groups.find((g) => g.key === "__unlabelled__")
    expect(unlabelled).toEqual({ key: "__unlabelled__", label: "Unlabelled", costBasis: 40, value: 50 })

    const selected = await costAndValueByLabel(db, "user-1", [pub(pf)], { allLabels: false, labelIds: [core] })
    expect(selected.groups.map((g) => g.label)).toEqual(["Core"])
  })

  it("intersects accounts with any selected label and never multiplies a position by its labels", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const core = await addLabel("Core")
    const growth = await addLabel("Growth")
    await labelPosition(aapl, core)
    await labelPosition(aapl, growth)
    await addFactBasis(pf, aapl, "2026-01-02", "150", "100")

    const out = await costAndValueByLabel(db, "user-1", [pub(pf)], { allLabels: false, labelIds: [core, growth] })
    expect(out.groups.map((g) => g.label).sort()).toEqual(["Core", "Growth"])
    for (const g of out.groups) expect(g.value).toBe(150)
  })

  it("reduces the remaining basis after a partial sale using the fact, not deposits", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const core = await addLabel("Core")
    await labelPosition(aapl, core)
    // Value 150 on 100 basis before the sale; the fact after the sale carries the
    // reduced remaining basis and the reduced value.
    await addFactBasis(pf, aapl, "2026-01-02", "150", "100")
    await addFactBasis(pf, aapl, "2026-01-03", "90", "60")

    const out = await costAndValueByLabel(db, "user-1", [pub(pf)], all)
    expect(out.groups).toEqual([{ key: core, label: "Core", costBasis: 60, value: 90 }])
  })

  it("keeps a foreign-currency holding's basis and value in the same fact currency", async () => {
    const pf = await addPortfolio("A")
    const position = await addPosition(pf, "SNT", { instrumentCurrency: "PLN" })
    const core = await addLabel("Core")
    await labelPosition(position, core)
    // Facts are stored in the account base after conversion; both numbers come
    // from the same row, so they are never one currency each.
    await addFactBasis(pf, position, "2026-01-02", "150", "100")

    const out = await costAndValueByLabel(db, "user-1", [pub(pf)], all)
    expect(out.groups[0]).toMatchObject({ costBasis: 100, value: 150 })
  })

  it("uses only the latest published day", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const core = await addLabel("Core")
    await labelPosition(aapl, core)
    await addFactBasis(pf, aapl, "2026-01-01", "100", "80")
    await addFactBasis(pf, aapl, "2026-01-02", "120", "90")

    const out = await costAndValueByLabel(db, "user-1", [pub(pf)], all)
    expect(out.groups[0]).toMatchObject({ costBasis: 90, value: 120 })
  })

  it("returns nothing for an empty scope", async () => {
    const out = await costAndValueByLabel(db, "user-1", [], all)
    expect(out).toEqual({ groups: [] })
  })
})

describe("allocationByAssetType", () => {
  it("splits value by canonical asset type, largest first", async () => {
    const pf = await addPortfolio("A")
    const stock = await addPosition(pf, "AAPL", { assetType: "STOCK" })
    const bond = await addPosition(pf, "BND", { assetType: "BOND" })
    await addFact(pf, stock, "2026-01-02", "80")
    await addFact(pf, bond, "2026-01-02", "20")

    const out = await allocationByAssetType(db, [pub(pf)])
    expect(out.total).toBe(100)
    expect(out.slices).toEqual([
      { key: "STOCK", value: 80 },
      { key: "BOND", value: 20 },
    ])
  })

  it("keeps ETF/fund and an unknown type separate, and never drops unknown", async () => {
    const pf = await addPortfolio("A")
    const stock = await addPosition(pf, "AAPL", { assetType: "STOCK" })
    const etf = await addPosition(pf, "ETF", { assetType: "FUND" })
    const mystery = await addPosition(pf, "???", { assetType: "MYSTERY" })
    await addFact(pf, stock, "2026-01-02", "50")
    await addFact(pf, etf, "2026-01-02", "30")
    await addFact(pf, mystery, "2026-01-02", "20")

    const out = await allocationByAssetType(db, [pub(pf)])
    expect(out.slices).toEqual([
      { key: "STOCK", value: 50 },
      { key: "FUND", value: 30 },
      { key: "MYSTERY", value: 20 },
    ])
  })

  it("sums the same symbol held in two accounts once per attributed holding", async () => {
    const pf1 = await addPortfolio("A")
    const pf2 = await addPortfolio("B")
    const aapl1 = await addPosition(pf1, "AAPL", { assetType: "STOCK" })
    const aapl2 = await addPosition(pf2, "AAPL", { assetType: "STOCK" })
    await addFact(pf1, aapl1, "2026-01-02", "40")
    await addFact(pf2, aapl2, "2026-01-02", "40")

    const out = await allocationByAssetType(db, [pub(pf1), pub(pf2)])
    expect(out.slices).toEqual([{ key: "STOCK", value: 80 }])
  })

  it("uses only the latest published day", async () => {
    const pf = await addPortfolio("A")
    const stock = await addPosition(pf, "AAPL", { assetType: "STOCK" })
    await addFact(pf, stock, "2026-01-01", "100")
    await addFact(pf, stock, "2026-01-02", "120")

    const out = await allocationByAssetType(db, [pub(pf)])
    expect(out.total).toBe(120)
  })

  it("returns nothing for an empty scope", async () => {
    const out = await allocationByAssetType(db, [])
    expect(out).toEqual({ slices: [], total: 0 })
  })
})