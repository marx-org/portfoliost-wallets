/**
 * Plan §62.3 — portfolio-native cash routes.
 *
 * Replaces the deleted wallet cash routes. A portfolio owns its cash as a
 * per-currency ledger derived by replay (62.2 `cashLedger`); nothing is
 * stored as a balance. External rows live in `portfolio_cash_transactions`;
 * trade rows (BUY/SELL/DIVIDEND) are portfolio transactions and no longer
 * appear in the cash feed.
 */
import { Hono, type Context } from "hono"
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { POSITION_TX_TYPES, TRADE_CASH_TYPES } from "../transaction-types.js"
import { getDb as resolveDb, type DB } from "../db/index.js"
import {
  portfolios,
  portfolioCashTransactions,
  portfolioCashTransactionLabels,
  portfolioTransactions,
  labels,
} from "../db/schema.js"
import { cashBalances, cashBalanceSeries, toDateStr, tradeCashEffects } from "../services/cashLedger.js"
import { fxTo } from "../services/instruments-fx.js"
import { ISO_CURRENCY } from "../services/currency.js"
import {
  labelsForCashTransactions,
  labelFilterIds,
  attachLabelCondition,
  assertLabelsOwned,
  serializeLabel,
  setCashTransactionLabels,
} from "../services/labels.js"
import type { components } from "../generated/api-types.js"

type Label = components["schemas"]["Label"]
type PortfolioCash = components["schemas"]["PortfolioCash"]
type PortfolioCashHistory = components["schemas"]["PortfolioCashHistory"]
type CashTransaction = components["schemas"]["CashTransaction"]
type RecentCashTransaction = components["schemas"]["RecentCashTransaction"]

const scale8 = (n: number) => n.toFixed(8)
const round2 = (n: number) => Math.round(n * 100) / 100
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

const DISPLAY_LABELS: Record<string, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  TRANSFER: "Transfer",
}

const PERIOD_DAYS: Record<string, number | null> = {
  "1D": 1,
  "1W": 7,
  "1M": 31,
  "3M": 93,
  "6M": 186,
  "1Y": 366,
  ALL: null,
}

// ── Schemas (mirror 62.1 contract request shapes) ────────────────────────

const FeeFxFieldsSchema = z.object({
  exchangeRate: z.number().positive().nullable().optional(),
  rateSource: z.enum(["automatic", "manual"]).nullable().optional(),
  feeCurrency: z.string().regex(ISO_CURRENCY).nullable().optional(),
  feeRateSource: z.enum(["automatic", "manual"]).nullable().optional(),
  feeExchangeRate: z.number().positive().nullable().optional(),
})

const DepositCashSchema = FeeFxFieldsSchema.extend({
  amount: z.number(),
  currency: z.string().regex(ISO_CURRENCY).optional(),
  description: z.string().nullable().optional(),
  transactionDate: z.string().nullable().optional(),
  fees: z.number().nonnegative().nullable().optional(),
  feesType: z.enum(["fixed", "pct"]).nullable().optional(),
}).strict()

const WithdrawCashSchema = DepositCashSchema.extend({
  paymentMethod: z.string().nullable().optional(),
}).strict()

const TransferCashSchema = FeeFxFieldsSchema.extend({
  amount: z.number(),
  currency: z.string().regex(ISO_CURRENCY),
  description: z.string().nullable().optional(),
  transactionDate: z.string().nullable().optional(),
  toPortfolioId: z.string().uuid(),
  targetAmount: z.number().nullable().optional(),
  targetFxRate: z.number().positive().nullable().optional(),
  fees: z.number().nonnegative().nullable().optional(),
  feesType: z.enum(["fixed", "pct"]).nullable().optional(),
}).strict()

const CashPatchSchema = z
  .object({
    amount: z.number().optional(),
    currency: z.string().regex(ISO_CURRENCY).optional(),
    description: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    fees: z.number().nonnegative().nullable().optional(),
    feesType: z.enum(["fixed", "pct"]).nullable().optional(),
    feeCurrency: z.string().regex(ISO_CURRENCY).nullable().optional(),
    feeRateSource: z.enum(["automatic", "manual"]).nullable().optional(),
    feeExchangeRate: z.number().positive().nullable().optional(),
  })
  .strict()

const SetLabelsSchema = z.object({ labelIds: z.array(z.string().uuid()).max(100) })

// ── Helpers ───────────────────────────────────────────────────────────────

async function loadPortfolio(db: DB, id: string, userId: string) {
  const [row] = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, id), eq(portfolios.userId, userId)))
  return row
}

/** Per-currency balance → PortfolioCash, base total via fxTo(base). */
async function buildPortfolioCash(
  db: DB,
  authToken: string,
  portfolio: { id: string; baseCurrency: string },
): Promise<PortfolioCash> {
  const base = portfolio.baseCurrency.toUpperCase()
  const balances = await cashBalances(db, authToken, portfolio.id)
  const toBase = await fxTo(authToken, base)
  const items: PortfolioCash["balances"] = []
  let total = 0
  for (const [ccy, bal] of [...balances.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    total += await toBase(ccy, bal)
    items.push({ currency: ccy, balance: round8(bal) })
  }
  return { baseCurrency: base, balances: items, total: round2(total) }
}

/**
 * balanceAfter per external row: running window sum of the row's own-currency
 * balance (trade effects + external effects ordered by transactionDate,
 * createdAt). No storage — recomputed per request from the ledger.
 */
async function balanceAfterByRow(
  db: DB,
  portfolioId: string,
): Promise<Map<string, number>> {
  interface Event {
    day: string
    createdAt: Date
    deltas: Map<string, number>
    extId: string | null
    extCcy: string | null
  }
  const events: Event[] = []

  const trades = await db
    .select({
      type: portfolioTransactions.type,
      totalAmount: portfolioTransactions.totalAmount,
      feesSettled: portfolioTransactions.feesSettled,
      currency: portfolioTransactions.currency,
      feeCurrency: portfolioTransactions.feeCurrency,
      executedAt: portfolioTransactions.executedAt,
      createdAt: portfolioTransactions.createdAt,
    })
    .from(portfolioTransactions)
    .where(and(eq(portfolioTransactions.portfolioId, portfolioId), inArray(portfolioTransactions.type, TRADE_CASH_TYPES)))

  for (const t of trades) {
    events.push({
      day: toDateStr(t.executedAt) ?? "1970-01-01",
      createdAt: t.createdAt,
      deltas: tradeCashEffects(t),
      extId: null,
      extCcy: null,
    })
  }

  const exts = await db
    .select({
      id: portfolioCashTransactions.id,
      amount: portfolioCashTransactions.amount,
      currency: portfolioCashTransactions.currency,
      transactionDate: portfolioCashTransactions.transactionDate,
      createdAt: portfolioCashTransactions.createdAt,
    })
    .from(portfolioCashTransactions)
    .where(eq(portfolioCashTransactions.portfolioId, portfolioId))

  for (const r of exts) {
    const ccy = (r.currency ?? "").toUpperCase()
    events.push({
      day: toDateStr(r.transactionDate) ?? "1970-01-01",
      createdAt: r.createdAt,
      deltas: new Map([[ccy, Number(r.amount ?? 0)]]),
      extId: r.id,
      extCcy: ccy,
    })
  }

  events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.createdAt.getTime() - b.createdAt.getTime()))

  const running = new Map<string, number>()
  const out = new Map<string, number>()
  for (const ev of events) {
    for (const [ccy, d] of ev.deltas) running.set(ccy, (running.get(ccy) ?? 0) + d)
    if (ev.extId && ev.extCcy) out.set(ev.extId, round8(running.get(ev.extCcy) ?? 0))
  }
  return out
}

function serializeCash(
  r: typeof portfolioCashTransactions.$inferSelect,
  opts: { labels: Label[]; portfolioName?: string | null; balanceAfter?: number | null },
): CashTransaction {
  return {
    id: r.id,
    portfolioId: r.portfolioId,
    type: r.type,
    amount: Number(r.amount),
    currency: r.currency,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    description: r.description,
    transactionDate: r.transactionDate,
    paymentMethod: r.paymentMethod,
    fees: r.fees != null ? Number(r.fees) : null,
    feesType: r.feesType,
    feeCurrency: r.feeCurrency,
    exchangeRate: r.exchangeRate != null ? Number(r.exchangeRate) : null,
    rateSource: r.rateSource,
    feeRateSource: r.feeRateSource,
    feeExchangeRate: r.feeExchangeRate != null ? Number(r.feeExchangeRate) : null,
    toPortfolioId: r.toPortfolioId,
    balanceAfter: opts.balanceAfter ?? null,
    portfolioName: opts.portfolioName ?? null,
    externalSource: r.externalSource,
    externalId: r.externalId,
    labels: opts.labels,
  } satisfies CashTransaction
}

function serializeRecent(
  r: typeof portfolioCashTransactions.$inferSelect,
  opts: { portfolioName?: string | null; labels: Label[] },
): RecentCashTransaction {
  return {
    id: r.id,
    portfolioId: r.portfolioId,
    portfolioName: opts.portfolioName ?? null,
    type: r.type,
    displayLabel: DISPLAY_LABELS[r.type] ?? r.type,
    amount: Number(r.amount).toFixed(8),
    currency: r.currency,
    exchangeRate: r.exchangeRate != null ? Number(r.exchangeRate) : null,
    reference: r.reference,
    date: r.transactionDate ?? r.createdAt.toISOString().slice(0, 10),
    description: r.description,
    createdAt: r.createdAt.toISOString(),
    toPortfolioId: r.toPortfolioId,
    fees: r.fees != null ? Number(r.fees) : null,
    taxes: null,
    isInternalTransfer: r.type === "TRANSFER",
    feeCurrency: r.feeCurrency,
    rateSource: r.rateSource,
    feeRateSource: r.feeRateSource,
    feeExchangeRate: r.feeExchangeRate != null ? Number(r.feeExchangeRate) : null,
    labels: opts.labels,
  } satisfies RecentCashTransaction
}

function cashLabelCondition(database: DB, conditions: SQL[], raw: string | undefined): void {
  const ids = labelFilterIds(raw)
  if (ids.length > 0) {
    attachLabelCondition(
      conditions as (SQL | undefined)[],
      portfolioCashTransactions.id,
      portfolioCashTransactionLabels.cashTransactionId,
      portfolioCashTransactionLabels.labelId,
      portfolioCashTransactionLabels,
      database,
      ids,
    )
  }
}

/** Base FX fields as stored from a request (fees are metadata; the balance
 *  replay uses `amount` only). */
function fxFields(body: Record<string, unknown>, txCcy: string) {
  return {
    exchangeRate: body.exchangeRate != null ? String(body.exchangeRate) : null,
    rateSource: (body.rateSource as "automatic" | "manual" | null) ?? "automatic",
    feeCurrency: body.feeCurrency ? (body.feeCurrency as string).toUpperCase() : txCcy,
    feeRateSource: (body.feeRateSource as "automatic" | "manual" | null) ?? "automatic",
    feeExchangeRate: body.feeExchangeRate != null ? String(body.feeExchangeRate) : null,
    fees: body.fees != null ? scale8(body.fees as number) : null,
    feesType: (body.feesType as "fixed" | "pct" | null) ?? null,
  }
}

export function createPortfolioCashRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)
  const getDb = () => db ?? resolveDb()
  const auth = (c: Context) => c.req.header("Authorization") ?? ""

  // GET /:id/cash — PortfolioCash
  routes.get("/:id/cash", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()
    const portfolio = await loadPortfolio(database, c.req.param("id"), identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)
    return c.json(await buildPortfolioCash(database, auth(c), portfolio))
  })

  // GET /:id/cash/balance-history — PortfolioCashHistory
  routes.get("/:id/cash/balance-history", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()
    const portfolio = await loadPortfolio(database, c.req.param("id"), identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)
    const base = portfolio.baseCurrency.toUpperCase()
    const period = c.req.query("period") ?? "ALL"
    const resolution = c.req.query("resolution") ?? "day"

    const today = new Date()
    const to = today.toISOString().slice(0, 10)
    const days = PERIOD_DAYS[period] ?? null

    // window start: N days back, or the earliest ledger event (ALL)
    let from: string
    if (days != null) {
      from = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10)
    } else {
      const [minTrade] = await database
        .select({ d: sql<string>`min(${portfolioTransactions.executedAt})` })
        .from(portfolioTransactions)
        .where(eq(portfolioTransactions.portfolioId, portfolio.id))
      const [minCash] = await database
        .select({ d: sql<string>`min(${portfolioCashTransactions.transactionDate})` })
        .from(portfolioCashTransactions)
        .where(eq(portfolioCashTransactions.portfolioId, portfolio.id))
      const candidates = [minTrade?.d, minCash?.d].filter(Boolean) as string[]
      from = candidates.length ? candidates.sort()[0].slice(0, 10) : to
    }

    const series = await cashBalanceSeries(database, auth(c), portfolio.id, from, to, base)
    // emit only days where the base-cash total changed (collapse flat stretches)
    const entries = [...series.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const data: PortfolioCashHistory["data"] = []
    let prev: number | null = null
    for (const [day, bal] of entries) {
      if (prev !== null && Math.abs(bal - prev) < 1e-9) continue
      const change = prev === null ? bal : bal - prev
      data.push({
        date: `${day}T00:00:00.000Z`,
        balance: round8(bal),
        change: round8(change),
        percentChange: prev !== null && prev !== 0 ? round2((change / Math.abs(prev)) * 100) : null,
        high: Math.max(prev ?? bal, bal),
        low: Math.min(prev ?? bal, bal),
      })
      prev = bal
    }

    const balances = data.map((p) => p.balance)
    const first = balances[0] ?? 0
    const last = balances[balances.length - 1] ?? 0
    return c.json({
      data,
      meta: {
        period,
        resolution,
        high: balances.length ? Math.max(...balances) : 0,
        low: balances.length ? Math.min(...balances) : 0,
        average: balances.length ? round2(balances.reduce((a, b) => a + b, 0) / balances.length) : 0,
        startDate: data[0]?.date ?? today.toISOString(),
        endDate: data[data.length - 1]?.date ?? today.toISOString(),
        change: round2(last - first),
        percentChange: first !== 0 ? round2(((last - first) / Math.abs(first)) * 100) : null,
      },
    } satisfies PortfolioCashHistory)
  })

  // GET /:id/cash/transactions — PageResponse (external rows only)
  routes.get("/:id/cash/transactions", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()
    const portfolioId = c.req.param("id")
    const [owned] = await database
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, identity.id)))
    if (!owned) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 10))
    const offset = (page - 1) * limit

    const conditions: SQL[] = [eq(portfolioCashTransactions.portfolioId, portfolioId)]
    cashLabelCondition(database, conditions, c.req.query("labels"))

    const [countRow] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(portfolioCashTransactions)
      .where(and(...conditions))
    const total = countRow?.count ?? 0

    const rows = await database
      .select()
      .from(portfolioCashTransactions)
      .where(and(...conditions))
      .orderBy(desc(portfolioCashTransactions.transactionDate), desc(portfolioCashTransactions.createdAt))
      .limit(limit)
      .offset(offset)

    const labelMap = await labelsForCashTransactions(database, rows.map((r) => r.id))
    const balMap = await balanceAfterByRow(database, portfolioId)
    const items = rows.map((r) =>
      serializeCash(r, { labels: labelMap.get(r.id) ?? [], balanceAfter: balMap.get(r.id) ?? null }),
    )
    return c.json({
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    })
  })

  // POST /:id/cash/deposits | withdrawals
  async function movement(c: Context, kind: "DEPOSIT" | "WITHDRAWAL") {
    const parsed = (kind === "DEPOSIT" ? DepositCashSchema : WithdrawCashSchema).safeParse(
      await c.req.json().catch(() => ({})),
    )
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const identity = c.get("userIdentity")
    const database = getDb()
    const portfolio = await loadPortfolio(database, c.req.param("id") ?? "", identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const body = parsed.data
    const ccy = (body.currency ?? portfolio.baseCurrency).toUpperCase()
    const amount = kind === "DEPOSIT" ? Math.abs(body.amount) : -Math.abs(body.amount)
    const baseRow = fxFields(body as Record<string, unknown>, ccy)

    const [inserted] = await database
      .insert(portfolioCashTransactions)
      .values({
        userId: identity.id,
        portfolioId: portfolio.id,
        type: kind,
        amount: scale8(amount),
        currency: ccy,
        description: body.description ?? null,
        transactionDate: body.transactionDate ?? null,
        paymentMethod: (body as { paymentMethod?: string | null }).paymentMethod ?? null,
        ...baseRow,
      })
      .returning()

    return c.json(serializeCash(inserted, { labels: [] }), 201)
  }
  routes.post("/:id/cash/deposits", (c) => movement(c, "DEPOSIT"))
  routes.post("/:id/cash/withdrawals", (c) => movement(c, "WITHDRAWAL"))

  // POST /:id/cash/transfers
  routes.post("/:id/cash/transfers", async (c) => {
    const parsed = TransferCashSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const identity = c.get("userIdentity")
    const database = getDb()
    const body = parsed.data
    const from = await loadPortfolio(database, c.req.param("id"), identity.id)
    if (!from) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)
    if (from.id === body.toPortfolioId) {
      return c.json({ error: "BadRequest", message: "Transfer target must differ from the source portfolio" }, 400)
    }
    const [to] = await database
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.id, body.toPortfolioId), eq(portfolios.userId, identity.id)))
    if (!to) return c.json({ error: "NotFound", message: "Transfer target not found" }, 404)

    const ccy = body.currency.toUpperCase()
    const toCcy = (to.baseCurrency ?? ccy).toUpperCase()
    // The request `amount` is a positive magnitude (like deposit/withdraw);
    // the debit leg is stored negated, the credit leg always positive.
    const debitAmount = -Math.abs(body.amount)
    const rate = toCcy === ccy ? 1 : (body.targetFxRate ?? 1)
    const targetAmount = body.targetAmount != null ? body.targetAmount : Math.abs(body.amount) * rate
    // Both legs of the pair show the transfer direction in the cash tables:
    // the debit leg "… (→ Target)", the server-created credit leg "… (from Source)".
    const debitDesc = body.description
      ? `${body.description} (→ ${to.name})`
      : `→ ${to.name}`
    const ref = debitDesc
    const creditDesc = body.description
      ? `${body.description} (from ${from.name})`
      : `from ${from.name}`

    const baseRow = fxFields(body as Record<string, unknown>, ccy)
    const debit = await database.transaction(async (tx) => {
      const [d] = await tx
        .insert(portfolioCashTransactions)
        .values({
          userId: identity.id,
          portfolioId: from.id,
          toPortfolioId: to.id,
          type: "TRANSFER",
          amount: scale8(debitAmount),
          currency: ccy,
          description: debitDesc ?? null,
          transactionDate: body.transactionDate ?? null,
          reference: debitDesc ?? null,
          transferFxRate: rate !== 1 ? String(rate) : null,
          targetAmount: scale8(targetAmount),
          ...baseRow,
        })
        .returning()
      const [cr] = await tx
        .insert(portfolioCashTransactions)
        .values({
          userId: identity.id,
          portfolioId: to.id,
          toPortfolioId: from.id,
          type: "TRANSFER",
          amount: scale8(targetAmount),
          currency: ccy,
          description: creditDesc ?? null,
          transactionDate: body.transactionDate ?? null,
          reference: ref,
          transferFxRate: rate !== 1 ? String(rate) : null,
          targetAmount: scale8(debitAmount),
          linkedTxId: d.id,
          ...baseRow,
        })
        .returning()
      // link both ways (§62.3)
      await tx
        .update(portfolioCashTransactions)
        .set({ linkedTxId: cr.id })
        .where(eq(portfolioCashTransactions.id, d.id))
      return d
    })
    return c.json(serializeCash(debit, { labels: [] }), 201)
  })

  // GET /cash/recent-transactions — cross-portfolio feed (external rows only)
  routes.get("/cash/recent-transactions", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()
    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 10))
    const offset = (page - 1) * limit
    const sortOrder = (c.req.query("sortOrder") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc"
    const sortFn = sortOrder === "asc" ? asc : desc

    const conditions: SQL[] = [eq(portfolioCashTransactions.userId, identity.id)]
    cashLabelCondition(database, conditions, c.req.query("labels"))

    const [countRow] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(portfolioCashTransactions)
      .where(and(...conditions))
    const total = countRow?.count ?? 0

    const rows = await database
      .select({ tx: portfolioCashTransactions, portfolioName: portfolios.name })
      .from(portfolioCashTransactions)
      .leftJoin(portfolios, eq(portfolioCashTransactions.portfolioId, portfolios.id))
      .where(and(...conditions))
      .orderBy(sortFn(portfolioCashTransactions.transactionDate), sortFn(portfolioCashTransactions.createdAt))
      .limit(limit)
      .offset(offset)

    const labelMap = await labelsForCashTransactions(database, rows.map((r) => r.tx.id))
    const data = rows.map((r) =>
      serializeRecent(r.tx, { portfolioName: r.portfolioName ?? null, labels: labelMap.get(r.tx.id) ?? [] }),
    )
    return c.json({ data, meta: { total } })
  })

  // shared ownership check for tx-scoped routes
  async function ownTx(database: DB, txId: string, userId: string) {
    const [r] = await database
      .select()
      .from(portfolioCashTransactions)
      .where(and(eq(portfolioCashTransactions.id, txId), eq(portfolioCashTransactions.userId, userId)))
    return r
  }

  // PATCH /cash/transactions/:txId
  routes.patch("/cash/transactions/:txId", async (c) => {
    const parsed = CashPatchSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const identity = c.get("userIdentity")
    const database = getDb()
    const txId = c.req.param("txId")
    const existing = await ownTx(database, txId, identity.id)
    if (!existing) return c.json({ error: "NotFound", message: "Cash transaction not found" }, 404)

    const b = parsed.data
    if (b.amount != null && b.amount === 0) {
      return c.json({ error: "ValidationError", message: "amount must be non-zero (delete the row instead)" }, 422)
    }
    const updates: Partial<typeof portfolioCashTransactions.$inferInsert> = { updatedAt: new Date() }
    if (b.amount != null && b.amount !== 0) {
      // Re-apply the §58.3 sign clamp (the modal ships magnitudes).
      let amount = b.amount
      if (existing.type === "DEPOSIT") amount = Math.abs(amount)
      if (existing.type === "WITHDRAWAL") amount = -Math.abs(amount)
      updates.amount = scale8(amount)
    }
    if (b.currency != null && existing.type !== "TRANSFER") {
      // Transfers keep their currency (the paired leg is denominated in it).
      updates.currency = b.currency.toUpperCase()
      // A currency change orphans the fee leg — reset the fee to the new
      // currency at rate 1 (same convention as the create paths).
      if (existing.feeCurrency && existing.feeCurrency !== b.currency.toUpperCase()) {
        updates.feeCurrency = b.currency.toUpperCase()
      }
    }
    if (b.fees != null) updates.fees = b.fees > 0 ? scale8(b.fees) : null
    if (b.feesType != null) updates.feesType = b.feesType
    // Default the fee leg to the row currency (like the create paths) when
    // fees are set but no fee currency sent — without touching rows that
    // carry no fees at all.
    if (existing.type !== "TRANSFER" && b.fees != null && b.fees > 0 && b.feeCurrency == null) {
      updates.feeCurrency = (b.currency ?? existing.currency).toUpperCase()
    }
    if (b.feeCurrency != null && existing.type !== "TRANSFER") updates.feeCurrency = b.feeCurrency.toUpperCase()
    if (b.feeRateSource != null) updates.feeRateSource = b.feeRateSource
    if (b.feeExchangeRate != null) updates.feeExchangeRate = String(b.feeExchangeRate)
    if (b.description != null) updates.description = b.description
    if (b.date != null) updates.transactionDate = b.date
    await database.update(portfolioCashTransactions).set(updates).where(eq(portfolioCashTransactions.id, txId))

    const [row] = await database.select().from(portfolioCashTransactions).where(eq(portfolioCashTransactions.id, txId))
    const [pf] = await database
      .select({ name: portfolios.name })
      .from(portfolios)
      .where(eq(portfolios.id, row.portfolioId))
    const labelMap = await labelsForCashTransactions(database, [row.id])
    return c.json(serializeRecent(row, { portfolioName: pf?.name ?? null, labels: labelMap.get(row.id) ?? [] }))
  })

  // DELETE /cash/transactions/:txId
  routes.delete("/cash/transactions/:txId", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()
    const txId = c.req.param("txId")
    const existing = await ownTx(database, txId, identity.id)
    if (!existing) return c.json({ error: "NotFound", message: "Cash transaction not found" }, 404)
    await database.delete(portfolioCashTransactions).where(eq(portfolioCashTransactions.id, txId))
    return c.body(null, 204)
  })

  // POST /cash/transactions/:txId/labels
  routes.post("/cash/transactions/:txId/labels", async (c) => {
    const parsed = SetLabelsSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const identity = c.get("userIdentity")
    const database = getDb()
    const txId = c.req.param("txId")
    const existing = await ownTx(database, txId, identity.id)
    if (!existing) return c.json({ error: "NotFound", message: "Cash transaction not found" }, 404)
    if (!(await assertLabelsOwned(database, identity.id, parsed.data.labelIds))) {
      return c.json({ error: "NotFound", message: "One or more labels not found" }, 404)
    }
    await setCashTransactionLabels(database, txId, parsed.data.labelIds)
    const rows = parsed.data.labelIds.length
      ? await database.select().from(labels).where(inArray(labels.id, parsed.data.labelIds))
      : []
    return c.json(rows.map(serializeLabel).sort((a, b) => a.name.localeCompare(b.name)) satisfies Label[])
  })

  return routes
}

// Re-exported for portfolios.ts cash summaries.
export { buildPortfolioCash }
