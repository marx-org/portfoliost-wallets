import { Hono } from "hono"
import { and, eq, or, sql } from "drizzle-orm"
import { z } from "zod"
import { effectiveDateToUtc } from "../services/splitFactors.js"
import { getDb, type DB } from "../db/index.js"
import { positions, portfolios, portfolioTransactions, splitEvents } from "../db/schema.js"
import { positionInPortfolio } from "../db/position-membership.js"
import type { components } from "../generated/api-types"

type ApplySplitResponse = components["schemas"]["ApplySplitResponse"]

const round2 = (n: number) => Math.round(n * 100) / 100
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

const QTY_EPS = 1e-6

const ApplySplitSchema = z.object({
  symbol: z.string().min(1).max(20),
  factor: z.number().finite().positive(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().min(1).max(80).default("admin"),
})

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
    const { factor, effectiveDate, source } = parsed.data
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
          .values({ symbol, factor: String(factor), effectiveDate, source })
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

  /**
   * §63.4 — the DERIVED cash balance per portfolio, as of a date.
   *
   * The Gotówka reconciliation is only worth anything if the two sides of the
   * comparison come from different places. It used to build both from the
   * user's own workbook — the sheet's `Gotówka` column replayed with the
   * sheet's own signed `cashFlow` column — so it checked the sheet against
   * itself, and a sheet with missing rows agrees with itself and is still
   * wrong. That is exactly the failure §63.4 was opened for.
   *
   * This endpoint is the derived side: `cashBalanceSeries` replays every
   * imported cash movement and trade funding effect, so it knows about flows
   * the sheet never recorded. It is a base-currency total per portfolio
   * because that is the only basis on which it can be compared to anything —
   * the sheet's columns are per-currency and the derived ledger is per-currency
   * too, and no single currency total is comparable across a multi-currency
   * account. (Measured in PROD 2026-10-01: IBKR's derived split is 8 currencies
   * with mixed signs, EUR +70,779 against USD −39,041, which nets to 24,255 PLN.
   * The per-currency balances are returned as well, so a caller can see the
   * netting instead of having to trust it.)
   *
   * `asOf` is required rather than defaulted: a reconciliation that silently
   * compared a sheet's last row against a balance as of *today* would report
   * the intervening days as a discrepancy. The Gotówka sheet's last row is
   * 2026-09-29 while the import runs on 2026-10-01, so that is a 1,200 PLN
   * error manufactured by the comparison itself.
   *
   * `strict` is on: a transport or auth failure must abort rather than
   * degrade every foreign-currency row 1:1 into a confident wrong number
   * (§63.10's rule, and the reason the FX layer has the flag at all).
   */
  routes.get("/cash-balances", async (c) => {
    const asOf = c.req.query("asOf")
    if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      return c.json({ message: "ValidationError", detail: "asOf=YYYY-MM-DD is required" }, 422)
    }
    const database = getDbInstance()
    try {
      const { cashBalanceSeries, cashBalances } = await import("../services/cashLedger.js")
      // §63.10 — this route has no user identity, so the FX layer needs the
      // shared service token. Passing `null` does not fall back to an
      // unauthenticated call: it makes instruments answer 401, which
      // `strict: true` turns into an abort. That is the correct outcome and it
      // is what happened on the first deploy of this route — the guard caught a
      // missing credential rather than degrading every foreign-currency row 1:1
      // into a confident wrong number.
      const { resolveServiceToken } = await import("../services/instruments-fx.js")
      const token = resolveServiceToken()
      const rows = await database.select().from(portfolios)
      const out = []
      for (const p of rows) {
        // The window's START is irrelevant to the answer and is the expensive
        // part (every day is a row), so ask for the single day asked for.
        const series = await cashBalanceSeries(database, token, p.id, asOf, asOf, p.baseCurrency, { strict: true })
        const perCurrency = await cashBalances(database, token, p.id, asOf)
        out.push({
          id: p.id,
          name: p.name,
          baseCurrency: p.baseCurrency,
          total: series.get(asOf) ?? 0,
          balances: [...perCurrency.entries()]
            .map(([currency, balance]) => ({ currency, balance: round2(balance) }))
            .sort((a, b) => a.currency.localeCompare(b.currency)),
        })
      }
      return c.json({ asOf, portfolios: out })
    } catch (err) {
      console.error("[internal] cash-balances", err)
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
        positionInPortfolio(portfolioId),
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
  const { capitalBasisInvested } = await import("../services/transferFlows.js")
  const [pf] = await tx
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
  if (!pf) throw new Error(`internal recompute: portfolio ${portfolioId} not found`)
  const totalInvested = await capitalBasisInvested(tx, null, portfolioId, pf.baseCurrency)

  await tx
    .update(portfolios)
    .set({ totalInvested: totalInvested.toFixed(8), updatedAt: new Date() })
    .where(eq(portfolios.id, portfolioId))
}
