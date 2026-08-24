import { Hono, type Context } from "hono"
import { and, desc, eq, gte, inArray } from "drizzle-orm"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { wallets, walletTransactions } from "../db/schema.js"

const LABELS: Record<string, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  TRANSFER: "Transfer",
  INVEST: "Investment",
  SELL: "Sell",
  DIVIDEND: "Dividend",
  FEE: "Fee",
  INTEREST: "Interest",
  ADJUSTMENT: "Adjustment",
}

const NEGATIVE_TYPES = new Set(["WITHDRAWAL", "INVEST", "FEE"])

function paginate(c: Context) {
  const page = Math.max(1, Number(String(c.req.query("page") ?? "1")))
  const limit = Math.min(100, Math.max(1, Number(String(c.req.query("limit") ?? "10"))))
  return { page, limit }
}

function pageResponse<T>(items: T[], total: number, page: number, limit: number) {
  return {
    items,
    data: items,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasNext: page * limit < total,
    hasPrevious: page > 1,
  }
}

function dayKey(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d
  return dt.toISOString().slice(0, 10)
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

export function createHistoryRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)
  const getDbInstance = () => db ?? getDb()

  // wallet-scoped ledger
  routes.get("/:id/transactions", async (c: Context) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const { page, limit } = paginate(c)
    const walletId = c.req.param("id") as string

    const [owned] = await database
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.id, walletId), eq(wallets.userId, identity.id)))
    if (!owned) return c.json({ error: "NotFound", message: "Wallet not found" }, 404)

    const all = await database
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, walletId))
      .orderBy(desc(walletTransactions.executedAt))
    const start = (page - 1) * limit
    const items = all.slice(start, start + limit).map(serialize)
    return c.json(pageResponse(items, all.length, page, limit))
  })

  // across the user's wallets
  routes.get("/", async (c: Context) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const { page, limit } = paginate(c)
    const typeFilter = c.req.query("type") ? String(c.req.query("type")).toUpperCase() : undefined

    const conditions = [eq(walletTransactions.userId, identity.id)]
    if (typeFilter && typeFilter !== "ALL") {
      const types = typeFilter.split(",")
      conditions.push(inArray(walletTransactions.type, types as never))
    }
    const all = await database
      .select()
      .from(walletTransactions)
      .where(and(...conditions))
      .orderBy(desc(walletTransactions.executedAt))
    const start = (page - 1) * limit
    const items = all.slice(start, start + limit).map(serialize)
    return c.json(pageResponse(items, all.length, page, limit))
  })

  // unified recent feed (D19 read model): cash activity + trade-derived rows
  routes.get("/recent-transactions", async (c: Context) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const { page, limit } = paginate(c)

    const all = await database
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, identity.id))
      .orderBy(desc(walletTransactions.executedAt))

    const walletNames = new Map(
      (await database.select().from(wallets).where(eq(wallets.userId, identity.id))).map((w) => [
        w.id,
        w.name,
      ]),
    )

    const mapped = all.map((t) => {
      const magnitude = t.type === "TRANSFER" ? Number(t.targetAmount ?? Math.abs(Number(t.amount))) : Math.abs(Number(t.amount))
      const signed = NEGATIVE_TYPES.has(t.type) || Number(t.amount) < 0 ? -magnitude : magnitude
      return {
        id: t.id,
        walletId: t.walletId,
        walletName: walletNames.get(t.walletId) ?? null,
        type: t.type,
        displayLabel: LABELS[t.type] ?? t.type,
        amount: signed.toFixed(8),
        currency: t.currency,
        exchangeRate: t.exchangeRate != null ? Number(t.exchangeRate) : null,
        reference: t.reference,
        date: (t.transactionDate as string | null) ?? t.executedAt.toISOString(),
        description: t.description,
        createdAt: t.createdAt.toISOString(),
        portfolioId: t.portfolioId,
        fees: t.fees != null ? Number(t.fees) : null,
        taxes: t.taxes != null ? Number(t.taxes) : null,
        feesType: t.feesType,
        feeCurrency: t.feeCurrency,
        rateSource: t.rateSource,
        feeRateSource: t.feeRateSource,
        feeExchangeRate: t.feeExchangeRate != null ? Number(t.feeExchangeRate) : null,
        toWalletId: t.toWalletId,
        isInternalTransfer: t.type === "TRANSFER" && !t.reference,
      }
    })

    const start = (page - 1) * limit
    return c.json({
      ...pageResponse(mapped.slice(start, start + limit), mapped.length, page, limit),
      meta: { total: mapped.length, page, limit, totalPages: Math.max(1, Math.ceil(mapped.length / limit)) },
    })
  })

  // deterministic reconstruction from the ledger (wallets D21): opening 0 +
  // cumulative signed effects per day; converted output arrives in §11.9.
  routes.get("/:id/balance-history", async (c: Context) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const walletId = c.req.param("id") as string
    const period = c.req.query("period") ?? "ALL"

    const [owned] = await database
      .select()
      .from(wallets)
      .where(and(eq(wallets.id, walletId), eq(wallets.userId, identity.id)))
    if (!owned) return c.json({ error: "NotFound", message: "Wallet not found" }, 404)

    const rows = await database
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, walletId))
      .orderBy(walletTransactions.executedAt)

    // signed effect in wallet currency (mirrors transactions.ts rowEffect)
    const effectOf = (t: typeof walletTransactions.$inferSelect): number => {
      const amt = Number(t.amount)
      const rawFee = Number(t.fees ?? 0)
      const effectiveFee =
        rawFee > 0 ? (t.feesType === "pct" ? (Math.abs(amt) * rawFee) / 100 : rawFee) : 0
      switch (t.type) {
        case "DEPOSIT":
        case "SELL":
        case "DIVIDEND":
        case "INTEREST":
          return amt - effectiveFee
        case "WITHDRAWAL":
        case "FEE":
          return -(Math.abs(amt) + effectiveFee)
        default:
          return amt
      }
    }

    const byDay = new Map<string, number>()
    for (const t of rows) {
      const key = dayKey((t.transactionDate as string | null) ?? t.executedAt)
      byDay.set(key, (byDay.get(key) ?? 0) + effectOf(t))
    }

    let running = 0
    const series: { date: string; balance: number; change: number; percentChange: number | null; high: number; low: number }[] = []
    for (const [date, change] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const prev = running
      running = Math.round((running + change) * 1e8) / 1e8
      series.push({
        date: `${date}T00:00:00.000Z`,
        balance: running,
        change: Math.round(change * 1e8) / 1e8,
        percentChange: prev !== 0 ? Math.round(((running - prev) / Math.abs(prev)) * 1e4) / 100 : null,
        high: Math.max(prev, running),
        low: Math.min(prev, running),
      })
    }

    const days = PERIOD_DAYS[period] ?? null
    const filtered =
      days == null
        ? series
        : series.filter((p) => Date.now() - Date.parse(p.date) <= days * 86_400_000 || series.indexOf(p) === 0)

    const balances = filtered.map((p) => p.balance)
    const first = balances[0] ?? 0
    const last = balances[balances.length - 1] ?? 0
    return c.json({
      data: filtered,
      meta: {
        period,
        resolution: "day",
        high: balances.length ? Math.max(...balances) : 0,
        low: balances.length ? Math.min(...balances) : 0,
        average: balances.length ? Math.round((balances.reduce((a, b) => a + b, 0) / balances.length) * 100) / 100 : 0,
        startDate: filtered[0]?.date ?? new Date().toISOString(),
        endDate: filtered[filtered.length - 1]?.date ?? new Date().toISOString(),
        change: Math.round((last - first) * 100) / 100,
        percentChange: first !== 0 ? Math.round(((last - first) / Math.abs(first)) * 1e4) / 100 : null,
      },
    })
  })

  return routes
}

function serialize(t: typeof walletTransactions.$inferSelect) {
  return {
    id: t.id,
    walletId: t.walletId,
    type: t.type,
    amount: Number(t.amount),
    currency: t.currency,
    status: t.status,
    description: t.description,
    transaction_date: t.transactionDate,
    executedAt: t.executedAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    payment_method: t.paymentMethod,
    fees: t.fees != null ? Number(t.fees) : null,
    fees_type: t.feesType,
    feeCurrency: t.feeCurrency,
    rateSource: t.rateSource,
    feeExchangeRate: t.feeExchangeRate != null ? Number(t.feeExchangeRate) : null,
    to_wallet_id: t.toWalletId,
  }
}
