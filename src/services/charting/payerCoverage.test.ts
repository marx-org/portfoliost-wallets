import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import {
  chartEventFacts,
  labels,
  portfolios,
  positionLabels,
  positions,
} from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { monthlyPayerCoverage } from "./payerCoverage.js"

let db: DB

const pub = (portfolioId: string, generation = 1) => ({ portfolioId, generation })

async function addPortfolio(name: string, userId = "user-1") {
  const [row] = await db.insert(portfolios).values({ userId, name }).returning({ id: portfolios.id })
  return row.id
}

async function addPosition(
  portfolioId: string,
  symbol: string,
  opts: { instrumentCurrency?: string; isOpen?: boolean } = {},
) {
  const [row] = await db
    .insert(positions)
    .values({
      userId: "user-1",
      symbol,
      assetType: "STOCK",
      instrumentCurrency: opts.instrumentCurrency ?? "USD",
      isOpen: opts.isOpen ?? true,
    })
    .returning({ id: positions.id })
  return row.id
}

async function addDividend(
  portfolioId: string,
  positionId: string,
  eventDate: string,
  amount = "10",
  generation = 1,
) {
  await db.insert(chartEventFacts).values({
    generation,
    portfolioId,
    positionId,
    eventDate,
    receiptKind: "dividend",
    amountBase: amount,
    amountOriginal: amount,
    originalCurrency: "USD",
  })
}

async function addLabel(name: string) {
  const [row] = await db
    .insert(labels)
    .values({ userId: "user-1", name, color: "#112233" })
    .returning({ id: labels.id })
  return row.id
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("monthlyPayerCoverage", () => {
  it("counts distinct payers per month, not dividend rows", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const msft = await addPosition(pf, "MSFT")
    // AAPL pays twice in June; MSFT once. June has two distinct payers.
    await addDividend(pf, aapl, "2024-06-05")
    await addDividend(pf, aapl, "2024-06-20")
    await addDividend(pf, msft, "2024-06-15")
    // A different month with one payer.
    await addDividend(pf, msft, "2024-07-01")

    const out = await monthlyPayerCoverage(db, "user-1", [pub(pf)])
    const june = out.find((m) => m.year === 2024 && m.month === 6)
    const july = out.find((m) => m.year === 2024 && m.month === 7)
    expect(june?.count).toBe(2)
    expect(july?.count).toBe(1)
  })

  it("lists the payer tickers for each month", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const msft = await addPosition(pf, "MSFT")
    await addDividend(pf, aapl, "2024-06-05")
    await addDividend(pf, msft, "2024-06-15")

    const out = await monthlyPayerCoverage(db, "user-1", [pub(pf)])
    const june = out.find((m) => m.year === 2024 && m.month === 6)
    expect(june?.count).toBe(2)
    expect(june?.symbols).toEqual(["AAPL", "MSFT"])
  })

  it("counts the same stock held in two accounts once per month", async () => {
    const pf1 = await addPortfolio("A")
    const pf2 = await addPortfolio("B")
    const aapl1 = await addPosition(pf1, "AAPL")
    const aapl2 = await addPosition(pf2, "AAPL")
    await addDividend(pf1, aapl1, "2024-06-05")
    await addDividend(pf2, aapl2, "2024-06-15")

    const out = await monthlyPayerCoverage(db, "user-1", [pub(pf1), pub(pf2)])
    const june = out.find((m) => m.year === 2024 && m.month === 6)
    expect(june?.count).toBe(1)
  })

  it("excludes a stock sold before the as-of date despite past dividends", async () => {
    const pf = await addPortfolio("A")
    const sold = await addPosition(pf, "OLD", { isOpen: false })
    const held = await addPosition(pf, "HELD")
    await addDividend(pf, sold, "2024-06-05")
    await addDividend(pf, held, "2024-06-15")

    const out = await monthlyPayerCoverage(db, "user-1", [pub(pf)])
    const june = out.find((m) => m.year === 2024 && m.month === 6)
    expect(june?.count).toBe(1)
  })

  it("returns all twelve months per year and marks the current year partial", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    await addDividend(pf, aapl, "2024-03-10")

    const out = await monthlyPayerCoverage(db, "user-1", [pub(pf)])
    expect(out).toHaveLength(12)
    expect(out.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(out.find((m) => m.month === 3)?.count).toBe(1)
    expect(out.find((m) => m.month === 4)?.count).toBe(0)

    const now = new Date()
    const current = out.find((m) => m.year === now.getUTCFullYear() && m.month === now.getUTCMonth() + 1)
    if (current) expect(current.partial).toBe(true)
  })

  it("narrows to positions carrying any selected label (OR)", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const msft = await addPosition(pf, "MSFT")
    const core = await addLabel("Core")
    await db.insert(positionLabels).values({ positionId: aapl, labelId: core })
    await addDividend(pf, aapl, "2024-06-05")
    await addDividend(pf, msft, "2024-06-15")

    const out = await monthlyPayerCoverage(db, "user-1", [pub(pf)], { labelIds: [core] })
    const june = out.find((m) => m.year === 2024 && m.month === 6)
    expect(june?.count).toBe(1)
  })

  it("returns nothing for an empty scope", async () => {
    expect(await monthlyPayerCoverage(db, "user-1", [])).toEqual([])
  })
})