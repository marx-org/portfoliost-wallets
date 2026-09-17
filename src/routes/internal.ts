import { Hono } from "hono"
import { and, eq, or, sql } from "drizzle-orm"
import { z } from "zod"
import { getDb, type DB } from "../db/index.js"
import { positions, portfolios, portfolioTransactions, splitEvents } from "../db/schema.js"
import type { components } from "../generated/api-types"

type ApplySplitResponse = components["schemas"]["ApplySplitResponse"]

const round2 = (n: number) => Math.round(n * 100) / 100
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

const QTY_EPS = 1e-6

const ApplySplitSchema = z.object({
  symbol: z.string().min(1).max(20),
  factor: z.number().finite().positive(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

function effectiveDateToUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`)
}

export function createInternalRoutes(db?: DB) {
  const routes = new Hono()
  const getDbInstance = () => db ?? getDb()

  // §23.6 — internal split application (no JWT; never exposed through the gateway).
  // `factor` is the quantity multiplier (a 2:1 split → factor 2). Transactions
  // executed before an event's effective date are restated from their frozen
  // originals, so re-applying any event is a no-op.
  routes.post("/apply-split", async (c) => {
    const parsed = ApplySplitSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ message: "ValidationError", detail: parsed.error.issues[0]?.message }, 422)
    }
    const { factor, effectiveDate } = parsed.data
    const symbol = parsed.data.symbol.toUpperCase()
    const [yy, mm, dd] = effectiveDate.split("-").map(Number)
    const effectiveAt = new Date(Date.UTC(yy, mm - 1, dd))
    if (
      effectiveAt.getUTCFullYear() !== yy ||
      effectiveAt.getUTCMonth() !== mm - 1 ||
      effectiveAt.getUTCDate() !== dd
    ) {
      return c.json({ message: "ValidationError", detail: "invalid effectiveDate" }, 422)
    }

    const database = getDbInstance()

    try {
      const result = await database.transaction(async (tx) => {
        await tx
          .insert(splitEvents)
          .values({ symbol, factor: String(factor), effectiveDate })
          .onConflictDoNothing({ target: [splitEvents.symbol, splitEvents.effectiveDate] })

        const rows = await tx
          .select()
          .from(portfolioTransactions)
          .where(
            and(
              eq(portfolioTransactions.instrumentSymbol, symbol),
              sql`${portfolioTransactions.originalQuantity} is not null`,
            ),
          )
          .for("update")

        const events = (
          await tx
            .select()
            .from(splitEvents)
            .where(eq(splitEvents.symbol, symbol))
            .orderBy(splitEvents.effectiveDate)
        ).map((e) => ({
          factor: Number(e.factor),
          effectiveAt: effectiveDateToUtc(e.effectiveDate),
        }))

        // Cumulative quantity factor for a trade executed at a given time:
        // product of the factors of all events taking effect after that time.
        const cumFor = (executedAt: Date) =>
          events.reduce((acc, ev) => (executedAt < ev.effectiveAt ? acc * ev.factor : acc), 1)
        const allFactor = events.reduce((acc, ev) => acc * ev.factor, 1)

        let updatedTransactions = 0
        const affected = new Map<string, Set<string>>()

        for (const row of rows) {
          const cum = cumFor(new Date(row.executedAt))
          if (Math.abs(cum - 1) < 1e-12) continue
          const newQty = round8(Number(row.originalQuantity) * cum)
          const newPrice = round8(Number(row.originalPrice) / cum)
          if (Math.abs(Number(row.quantity) - newQty) < QTY_EPS && Math.abs(Number(row.price) - newPrice) < QTY_EPS) {
            continue
          }
          await tx
            .update(portfolioTransactions)
            .set({ quantity: String(newQty), price: String(newPrice), updatedAt: new Date() })
            .where(eq(portfolioTransactions.id, row.id))
          updatedTransactions++

          const key = `${row.userId}|${row.portfolioId}`
          if (!affected.has(key)) affected.set(key, new Set())
          affected.get(key)!.add(row.positionId ?? "")
        }

        for (const [key, positionIds] of affected) {
          const [userId, portfolioId] = key.split("|")
          await restatePositions(tx, userId, portfolioId, symbol, positionIds, cumFor, allFactor)
          await recomputeTotals(tx, userId, portfolioId)
        }

        return { updatedTransactions, affectedPortfolios: affected.size }
      })

      return c.json(result satisfies ApplySplitResponse)
    } catch (err) {
      console.error("[internal] apply-split", err)
      return c.json({ message: "Internal error" }, 500)
    }
  })

  return routes
}

async function restatePositions(
  tx: DB,
  userId: string,
  portfolioId: string,
  symbol: string,
  positionIds: Set<string>,
  cumFor: (executedAt: Date) => number,
  allFactor: number,
) {
  const candidateIds = new Set<string>()
  for (const id of positionIds) if (id) candidateIds.add(id)

  const openRows = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.portfolioId, portfolioId),
        eq(positions.symbol, symbol),
      ),
    )
  for (const p of openRows) candidateIds.add(p.id)
  if (candidateIds.size === 0) return

  for (const posId of candidateIds) {
    // Rows without a positionId back-link (imported/manual SELLs resolved by
    // symbol fallback) still belong to this portfolio+symbol's lot.
    const posRows = await tx
      .select()
      .from(portfolioTransactions)
      .where(
        or(
          eq(portfolioTransactions.positionId, posId),
          and(
            sql`${portfolioTransactions.positionId} is null`,
            eq(portfolioTransactions.portfolioId, portfolioId),
            eq(portfolioTransactions.instrumentSymbol, symbol),
          ),
        ),
      )
      .orderBy(portfolioTransactions.executedAt, portfolioTransactions.id)
    if (posRows.length === 0) continue

    let qty = 0
    let avg = 0
    let applies = false
    for (const r of posRows) {
      let q = Number(r.quantity)
      let p = Number(r.price)
      if (r.originalQuantity != null && r.originalPrice != null) {
        const cum = cumFor(new Date(r.executedAt))
        if (Math.abs(cum - 1) > 1e-12) applies = true
        q = round8(Number(r.originalQuantity) * cum)
        p = round8(Number(r.originalPrice) / cum)
      }
      if (r.type === "BUY") {
        const before = qty
        qty = round8(qty + q)
        if (qty > QTY_EPS) avg = before <= QTY_EPS ? p : round2((before * avg + q * p) / qty)
      } else if (r.type === "SELL") {
        qty = round8(qty - q)
      }
    }
    if (Math.abs(qty) < QTY_EPS) qty = 0
    if (!applies) continue

    const [pos] = await tx.select().from(positions).where(eq(positions.id, posId))
    if (!pos) continue
    if (
      Math.abs(Number(pos.quantity) - qty) < QTY_EPS &&
      Math.abs(Number(pos.averageCostBasis) - avg) < QTY_EPS
    ) {
      continue
    }

    const newQty = qty
    const newAvg = avg
    const set: Record<string, unknown> = { quantity: String(newQty), averageCostBasis: String(newAvg), updatedAt: new Date() }

    if (pos.currentPrice != null) {
      const newPrice = round8(Number(pos.currentPrice) / allFactor)
      set.currentPrice = String(newPrice)
      set.marketValue = String(round2(newPrice * newQty))
      set.unrealizedGainLoss = String(round2((newPrice - newAvg) * newQty))
      if (pos.dayChange != null) set.dayChange = String(round8(Number(pos.dayChange) / allFactor))
    }

    await tx.update(positions).set(set).where(eq(positions.id, posId))
  }
}

async function recomputeTotals(tx: DB, userId: string, portfolioId: string) {
  const { portfolios } = await import("../db/schema.js")
  const [agg] = await tx
    .select({
      totalInvested: sql<string>`COALESCE(SUM(CASE WHEN ${portfolioTransactions.type} = 'BUY' THEN ${portfolioTransactions.totalAmount} ELSE 0 END), 0)::text`,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.userId, userId),
        eq(portfolioTransactions.portfolioId, portfolioId),
      ),
    )

  await tx
    .update(portfolios)
    .set({ totalInvested: agg.totalInvested, updatedAt: new Date() })
    .where(eq(portfolios.id, portfolioId))
}
