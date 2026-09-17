import { Hono, type Context } from "hono"
import { and, desc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import {
  wallets,
  portfolios,
  walletTransactions,
  portfolioTransactions,
  positions,
  syncRuns,
} from "../db/schema.js"
import { preferredBaseCurrency } from "../services/preferences.js"
import { ISO_CURRENCY } from "./wallets.js"
import type { components } from "../generated/api-types.js"

type ImportWalletBootstrapResponse = components["schemas"]["ImportWalletBootstrapResponse"]
type ImportPortfolioBootstrapResponse = components["schemas"]["ImportPortfolioBootstrapResponse"]
type ImportTransactionsResponse = components["schemas"]["ImportTransactionsResponse"]
type SyncRun = components["schemas"]["SyncRun"]
type SyncRunsResponse = components["schemas"]["SyncRunsResponse"]
type SourceWipeResponse = components["schemas"]["SourceWipeResponse"]

const round2 = (n: number) => Math.round(n * 100) / 100
const round8 = (n: number) => Math.round(n * 1e8) / 1e8
const scale8 = (n: number) => n.toFixed(8)

/** Fees settled in the transaction currency from the importer-supplied fee. */
function settleImportFees(
  fees: number | null | undefined,
  feesType: string | null | undefined,
  notional: number,
): number {
  if (fees == null || fees === 0) return 0
  return feesType === "pct" ? round8((notional * fees) / 100) : round8(fees)
}

/** A row-level failure: aborts only that row's sub-transaction (§23.4). */
class ImportRowError extends Error {
  constructor(
    readonly code: string,
    readonly rowExternalId: string,
    message: string,
  ) {
    super(message)
  }
}

const ExternalSourceSchema = z.object({ externalSource: z.string().min(1) })

const ImportWalletSchema = z
  .object({
    name: z.string().min(1),
    currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
    baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
  })
  .strict()

export const ImportWalletBootstrapRequestSchema = ExternalSourceSchema.extend({
  wallets: z.array(ImportWalletSchema).min(1),
}).strict()

export const ImportPortfolioBootstrapRequestSchema = ExternalSourceSchema.extend({
  name: z.string().min(1),
  currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
}).strict()

const TX_TYPES = [
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER",
  "INVEST",
  "SELL",
  "DIVIDEND",
  "FEE",
  "INTEREST",
  "ADJUSTMENT",
] as const

const ImportWalletTxSchema = z
  .object({
    type: z.enum(TX_TYPES),
    amount: z.number(),
    currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
    description: z.string().nullable().optional(),
    transactionDate: z.string().nullable().optional(),
    status: z.string().optional(),
    paymentMethod: z.string().nullable().optional(),
    fees: z.number().nonnegative().nullable().optional(),
    feesType: z.enum(["fixed", "pct"]).nullable().optional(),
    taxes: z.number().nullable().optional(),
    reference: z.string().nullable().optional(),
    portfolioId: z.string().uuid().nullable().optional(),
    exchangeRate: z.number().positive().nullable().optional(),
    rateSource: z.enum(["automatic", "manual"]).nullable().optional(),
    feeCurrency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code").nullable().optional(),
    feeRateSource: z.enum(["automatic", "manual"]).nullable().optional(),
    feeExchangeRate: z.number().positive().nullable().optional(),
  })
  .strict()

const ImportPortfolioTxSchema = z
  .object({
    portfolioId: z.string().uuid(),
    type: z.enum(["BUY", "SELL", "DIVIDEND"]),
    instrumentSymbol: z.string().min(1),
    instrumentName: z.string().nullable().optional(),
    assetType: z.string().default("STOCK"),
    quantity: z.number().positive(),
    price: z.number().positive(),
    originalQuantity: z.number().positive().nullable().optional(),
    originalPrice: z.number().positive().nullable().optional(),
    currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
    fees: z.number().nonnegative().nullable().optional(),
    feesType: z.enum(["fixed", "pct"]).nullable().optional(),
    taxes: z.number().nullable().optional(),
    realizedGainLoss: z.number().nullable().optional(),
    executedAt: z.string().nullable().optional(),
    exchangeRate: z.number().positive().nullable().optional(),
    rateSource: z.enum(["automatic", "manual"]).nullable().optional(),
    feeCurrency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code").nullable().optional(),
    feeRateSource: z.enum(["automatic", "manual"]).nullable().optional(),
    feeExchangeRate: z.number().positive().nullable().optional(),
    // Options (plan §24.7): `direction: "SHORT"` marks a short-option OPEN
    // (e.g. a written covered call) — position-creating, regardless of type.
    direction: z.enum(["LONG", "SHORT"]).nullable().optional(),
    optionType: z.enum(["CALL", "PUT"]).nullable().optional(),
    contractSize: z.number().nullable().optional(),
  })
  .strict()

const ImportTransactionSchema = z
  .object({
    externalId: z.string().min(1),
    walletName: z.string().min(1),
    executedAt: z.string().min(1),
    walletTx: ImportWalletTxSchema,
    portfolioTx: ImportPortfolioTxSchema.optional(),
  })
  .strict()

export const ImportTransactionsRequestSchema = z
  .object({
    source: z
      .object({
        externalSource: z.string().min(1),
        spreadsheetId: z.string().min(1),
        sheet: z.string().min(1),
      })
      .strict(),
    transactions: z.array(ImportTransactionSchema).min(1).max(500),
  })
  .strict()

function validationError(c: Context, parsed: { error?: { issues?: { message?: string }[] } }) {
  return c.json({ error: "ValidationError", message: parsed.error?.issues?.[0]?.message }, 422)
}

/**
 * Restate the position ledger for an imported position-creating row
 * (§23.4, §24.7): weighted-avg cost basis against the open lot with the same
 * symbol, mirroring the interactive route's `upsertPositionOnBuy`. A `SHORT`
 * lot (short option) is a distinct position from the same-symbol underlying
 * equity lot (direction NULL/LONG).
 */
async function upsertImportPositionOnBuy(
  tx: DB,
  userId: string,
  portfolioId: string,
  body: {
    symbol: string
    instrumentName: string | null
    quantity: number
    price: number
    currency: string
    assetType: string
    feesSettled: number
    direction?: "LONG" | "SHORT" | null
    optionType?: "CALL" | "PUT" | null
    contractSize?: number | null
  },
) {
  const symbol = body.symbol.toUpperCase()
  const [existing] = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.portfolioId, portfolioId),
        eq(positions.symbol, symbol),
        eq(positions.isOpen, true),
        body.direction
          ? eq(positions.direction, body.direction)
          : sql`${positions.direction} is null or ${positions.direction} = 'LONG'`,
      ),
    )

  if (existing) {
    const oldQty = Number(existing.quantity)
    const oldCost = Number(existing.averageCostBasis)
    const newQty = oldQty + body.quantity
    const newAvgCost = round2((oldQty * oldCost + body.quantity * body.price) / newQty)

    const [updated] = await tx
      .update(positions)
      .set({
        quantity: String(newQty),
        averageCostBasis: String(newAvgCost),
        companyName: body.instrumentName ?? existing.companyName,
        instrumentCurrency: body.currency,
        assetType: body.assetType ?? existing.assetType,
        fees: String(Number(existing.fees ?? "0") + body.feesSettled),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, existing.id))
      .returning()
    return updated
  }

  const [created] = await tx
    .insert(positions)
    .values({
      userId,
      portfolioId,
      symbol,
      companyName: body.instrumentName,
      quantity: String(body.quantity),
      averageCostBasis: String(body.price),
      instrumentCurrency: body.currency,
      assetType: body.assetType,
      contractSize: body.contractSize != null ? String(body.contractSize) : null,
      direction: body.direction ?? null,
      optionType: body.optionType ?? null,
      sector: "Other",
      country: "Other",
      fees: String(body.feesSettled),
      isOpen: true,
      openedAt: new Date(),
    })
    .returning()
  return created
}

/**
 * Imported SELL (§23.4): reduce the open lot, close it when exhausted, and
 * compute realizedGainLoss exactly like the interactive `processSell`.
 */
async function processImportSell(
  tx: DB,
  userId: string,
  portfolioId: string,
  body: {
    symbol: string
    quantity: number
    price: number
    feesSettled: number
  },
): Promise<
  | { position: typeof positions.$inferSelect; realizedGainLoss: number }
  | { error: string; message?: string }
> {
  const symbol = body.symbol.toUpperCase()
  const [pos] = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.portfolioId, portfolioId),
        eq(positions.symbol, symbol),
        eq(positions.isOpen, true),
      ),
    )

  if (!pos) return { error: "no_open_position", message: `No open position for ${symbol}` }

  const oldQty = Number(pos.quantity)
  if (body.quantity > oldQty + 1e-9) {
    return {
      error: "insufficient_quantity",
      message: `Insufficient quantity for ${symbol}: have ${oldQty}, selling ${body.quantity}`,
    }
  }

  const avgCost = Number(pos.averageCostBasis)
  const realizedGainLoss = round2((body.price - avgCost) * body.quantity - body.feesSettled)
  const newQty = Math.round((oldQty - body.quantity) * 1e8) / 1e8

  const updateData: Record<string, unknown> = {
    quantity: String(newQty),
    fees: String(Number(pos.fees ?? "0") + body.feesSettled),
    updatedAt: new Date(),
  }
  if (newQty < 1e-9) {
    updateData.isOpen = false
    updateData.closedAt = new Date()
  }

  const [updated] = await tx
    .update(positions)
    .set(updateData)
    .where(eq(positions.id, pos.id))
    .returning()

  return { position: updated, realizedGainLoss }
}

/** Recompute a portfolio's invested total from BUY rows (§23.4 final pass). */
async function recomputeImportPortfolioTotals(tx: DB, userId: string, portfolioId: string) {
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

function syncRunToContract(r: typeof syncRuns.$inferSelect): SyncRun {
  return {
    id: r.id,
    externalSource: r.externalSource,
    spreadsheetId: r.spreadsheetId,
    sheet: r.sheet,
    lastRow: r.lastRow ?? null,
    status: r.status as SyncRun["status"],
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    error: r.error ?? null,
    insertedWtx: r.insertedWtx,
    insertedPtx: r.insertedPtx,
    skipped: r.skipped,
  }
}

/**
 * Import bootstrap (§23.3). Idempotently ensures wallets/portfolios exist,
 * matched on the unique (userId, name) natural key. `external_source` is set
 * on INSERT only — re-bootstrapping an existing row never re-tags it, so the
 * wipe endpoint (23.5) only ever removes what this importer created.
 */
export function createImportRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)

  const getDbInstance = () => db ?? getDb()

  routes.post("/wallets/bootstrap", async (c) => {
    const parsed = ImportWalletBootstrapRequestSchema.safeParse(
      await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed)
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const forwardedHeaders: Record<string, string> = {}
    for (const k of ["authorization", "x-user-id", "x-user-email"]) {
      const v = c.req.header(k)
      if (v) forwardedHeaders[k] = v
    }
    const defaultBase = await preferredBaseCurrency(forwardedHeaders)

    const items: NonNullable<ImportWalletBootstrapResponse["wallets"]> = []
    for (const w of parsed.data.wallets) {
      const baseCurrency = (w.baseCurrency ?? defaultBase).toUpperCase()
      const [inserted] = await database
        .insert(wallets)
        .values({
          userId: identity.id,
          name: w.name,
          currency: w.currency.toUpperCase(),
          baseCurrency,
          externalSource: parsed.data.externalSource,
        })
        .onConflictDoNothing({ target: [wallets.userId, wallets.name] })
        .returning()

      const [row] = inserted
        ? [inserted]
        : await database
            .select()
            .from(wallets)
            .where(and(eq(wallets.userId, identity.id), eq(wallets.name, w.name)))
            .limit(1)

      items.push({
        id: row.id,
        name: row.name,
        currency: row.currency,
        baseCurrency: row.baseCurrency,
        created: Boolean(inserted),
      })
    }

    return c.json({ wallets: items } satisfies ImportWalletBootstrapResponse)
  })

  routes.post("/portfolios/bootstrap", async (c) => {
    const parsed = ImportPortfolioBootstrapRequestSchema.safeParse(
      await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed)
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const forwardedHeaders: Record<string, string> = {}
    for (const k of ["authorization", "x-user-id", "x-user-email"]) {
      const v = c.req.header(k)
      if (v) forwardedHeaders[k] = v
    }
    const defaultBase = await preferredBaseCurrency(forwardedHeaders)
    const baseCurrency = (parsed.data.baseCurrency ?? defaultBase).toUpperCase()

    const [inserted] = await database
      .insert(portfolios)
      .values({
        userId: identity.id,
        name: parsed.data.name,
        currency: parsed.data.currency.toUpperCase(),
        baseCurrency,
        externalSource: parsed.data.externalSource,
      })
      .onConflictDoNothing({ target: [portfolios.userId, portfolios.name] })
      .returning()

    const [row] = inserted
      ? [inserted]
      : await database
          .select()
          .from(portfolios)
          .where(and(eq(portfolios.userId, identity.id), eq(portfolios.name, parsed.data.name)))
          .limit(1)

    return c.json({
      id: row.id,
      name: row.name,
      currency: row.currency,
      baseCurrency: row.baseCurrency,
      created: Boolean(inserted),
    } satisfies ImportPortfolioBootstrapResponse)
  })

  routes.post("/transactions", async (c) => {
    const parsed = ImportTransactionsRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed)
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const { source, transactions } = parsed.data
    const errors: NonNullable<ImportTransactionsResponse["errors"]> = []
    const affectedWallets = new Set<string>()
    const affectedPortfolios = new Set<string>()
    let insertedWtx = 0
    let insertedPtx = 0
    let skipped = 0

    for (const row of transactions) {
      let outcome: { inserted: boolean } | null = null
      try {
        outcome = await database.transaction(async (tx) => {
          const wallet = await resolveWallet(tx, identity.id, row.walletName)
          if (!wallet) {
            throw new ImportRowError(
              "wallet_not_found",
              row.externalId,
              `Unknown wallet "${row.walletName}"`,
            )
          }

          const ptx = row.portfolioTx
          if (ptx) {
            const owned = await portfolioOwnedBy(tx, identity.id, ptx.portfolioId)
            if (!owned) {
              throw new ImportRowError(
                "portfolio_not_found",
                row.externalId,
                `Portfolio ${ptx.portfolioId} not found for user`,
              )
            }
          }

          const wt = row.walletTx
          const executedAt = new Date(row.executedAt)
          if (Number.isNaN(executedAt.getTime())) {
            throw new ImportRowError("invalid_executed_at", row.externalId, "executedAt is not a valid date")
          }

          const wtx = await insertImportWalletTx(tx, identity.id, wallet.id, {
            source,
            row,
            ptx,
          })

          if (!wtx.inserted) return { inserted: false }
          affectedWallets.add(wallet.id)

          if (ptx) {
            await insertImportPortfolioTx(tx, identity.id, wallet.id, {
              source,
              row,
              ptx,
              executedAt,
            })
            affectedPortfolios.add(ptx.portfolioId)
            insertedPtx++
          }

          return { inserted: true }
        })
      } catch (err) {
        errors.push(
          err instanceof ImportRowError
            ? { externalId: err.rowExternalId, error: err.code, message: err.message }
            : {
                externalId: row.externalId,
                error: "internal",
                message: err instanceof Error ? err.message : "Unexpected import error",
              },
        )
      }

      if (outcome?.inserted) insertedWtx++
      else if (outcome?.inserted === false) skipped++
    }

    await recalcWalletBalances(database, affectedWallets)
    for (const portfolioId of affectedPortfolios) {
      await recomputeImportPortfolioTotals(database, identity.id, portfolioId)
    }

    const status: SyncRun["status"] =
      insertedWtx === 0 && errors.length > 0 ? "failed" : "done"
    const now = new Date()
    const fallbackMessage = errors[0]?.message ?? "All rows failed"
    const [syncRunRow] = await database
      .insert(syncRuns)
      .values({
        userId: identity.id,
        externalSource: source.externalSource,
        spreadsheetId: source.spreadsheetId,
        sheet: source.sheet,
        status,
        startedAt: now,
        completedAt: now,
        error: status === "failed" ? fallbackMessage : null,
        insertedWtx,
        insertedPtx,
        skipped,
      })
      .onConflictDoUpdate({
        target: [syncRuns.userId, syncRuns.externalSource, syncRuns.spreadsheetId, syncRuns.sheet],
        set: {
          status,
          startedAt: now,
          completedAt: now,
          error: status === "failed" ? fallbackMessage : null,
          insertedWtx,
          insertedPtx,
          skipped,
        },
      })
      .returning()

    return c.json({
      inserted: insertedWtx,
      skipped,
      errors,
      syncRun: syncRunToContract(syncRunRow),
    } satisfies ImportTransactionsResponse)
  })


  // §23.5 — import source management
  // -------------------------------------------------------------------------
  // GET /import/sync-runs — list sync runs (filter by externalSource,
  // paginate with limit/offset), most recent first.
  routes.get("/sync-runs", async (c) => {
    const identity = c.get("userIdentity")
    if (!identity) return c.json({ message: "Unauthorized" }, 401)
    const database = getDbInstance()
    const query = c.req.query()
    const externalSource = query.externalSource || undefined
    const limit = Math.min(Math.max(Number(query.limit ?? 25), 1), 100)
    const offset = Math.max(Number(query.offset ?? 0), 0)
    const where = and(
      eq(syncRuns.userId, identity.id),
      externalSource ? eq(syncRuns.externalSource, externalSource) : undefined,
    )
    const [rows, [{ total }]] = await Promise.all([
      database
        .select()
        .from(syncRuns)
        .where(where)
        .orderBy(desc(syncRuns.id))
        .limit(limit)
        .offset(offset),
      database
        .select({ total: sql<number>`count(*)::int` })
        .from(syncRuns)
        .where(where),
    ])
    return c.json({
      items: rows.map(syncRunToContract),
      total,
    } satisfies SyncRunsResponse)
  })

  // DELETE /import/sync-runs/{id} — delete a single run (404 if not owned).
  routes.delete("/sync-runs/:id", async (c) => {
    const identity = c.get("userIdentity")
    if (!identity) return c.json({ message: "Unauthorized" }, 401)
    const database = getDbInstance()
    const id = Number(c.req.param("id"))
    const deleted = await database
      .delete(syncRuns)
      .where(and(eq(syncRuns.id, id), eq(syncRuns.userId, identity.id)))
      .returning({ id: syncRuns.id })
    if (deleted.length === 0) return c.json({ message: "Not found" }, 404)
    return c.body(null, 204)
  })

  // DELETE /import/source/{externalSource} — wipe all data tagged with this
  // external source for the authenticated user, in one transaction.
  routes.delete("/source/:externalSource", async (c) => {
    const identity = c.get("userIdentity")
    if (!identity) return c.json({ message: "Unauthorized" }, 401)
    const database = getDbInstance()
    const externalSource = c.req.param("externalSource")
    const deleted = await database.transaction(async (tx) => {
      const walletTransactionsRows = await tx
        .delete(walletTransactions)
        .where(
          and(
            eq(walletTransactions.externalSource, externalSource),
            eq(walletTransactions.userId, identity.id),
          ),
        )
        .returning({ id: walletTransactions.id })

      const portfoliosRows = await tx
        .delete(portfolios)
        .where(and(eq(portfolios.externalSource, externalSource), eq(portfolios.userId, identity.id)))
        .returning({ id: portfolios.id })

      const walletsRows = await tx
        .delete(wallets)
        .where(and(eq(wallets.externalSource, externalSource), eq(wallets.userId, identity.id)))
        .returning({ id: wallets.id })

      const syncRunsRows = await tx
        .delete(syncRuns)
        .where(and(eq(syncRuns.externalSource, externalSource), eq(syncRuns.userId, identity.id)))
        .returning({ id: syncRuns.id })

      return {
        walletTransactions: walletTransactionsRows.length,
        portfolios: portfoliosRows.length,
        wallets: walletsRows.length,
        syncRuns: syncRunsRows.length,
      }
    })
    return c.json({ deleted } satisfies SourceWipeResponse)
  })


  return routes
}

async function resolveWallet(tx: DB, userId: string, name: string) {
  const [wallet] = await tx
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.name, name)))
    .limit(1)
  return wallet
}

async function portfolioOwnedBy(tx: DB, userId: string, portfolioId: string) {
  const [portfolio] = await tx
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1)
  return Boolean(portfolio)
}

async function insertImportWalletTx(
  tx: DB,
  userId: string,
  walletId: string,
  input: {
    source: { externalSource: string }
    row: z.infer<typeof ImportTransactionSchema>
    ptx?: z.infer<typeof ImportPortfolioTxSchema>
  },
) {
  const { source, row, ptx } = input
  const wt = row.walletTx
  const [inserted] = await tx
    .insert(walletTransactions)
    .values({
      userId,
      walletId,
      type: wt.type,
      amount: scale8(wt.amount),
      currency: wt.currency.toUpperCase(),
      status: wt.status ?? "completed",
      description: wt.description ?? null,
      transactionDate: wt.transactionDate ?? null,
      executedAt: new Date(row.executedAt),
      paymentMethod: wt.paymentMethod ?? null,
      fees: wt.fees != null ? scale8(wt.fees) : null,
      feesType: wt.feesType ?? null,
      feeCurrency: wt.feeCurrency?.toUpperCase() ?? null,
      taxes: wt.taxes != null ? scale8(wt.taxes) : null,
      reference: wt.reference ?? null,
      portfolioId: ptx ? ptx.portfolioId : wt.portfolioId ?? null,
      exchangeRate: wt.exchangeRate != null ? String(wt.exchangeRate) : null,
      rateSource: wt.rateSource ?? "automatic",
      feeRateSource: wt.feeRateSource ?? "automatic",
      feeExchangeRate: wt.feeExchangeRate != null ? String(wt.feeExchangeRate) : null,
      externalSource: source.externalSource,
      externalId: row.externalId,
    })
    .onConflictDoNothing()
    .returning()
  return { inserted: Boolean(inserted) }
}

async function insertImportPortfolioTx(
  tx: DB,
  userId: string,
  walletId: string,
  input: {
    source: { externalSource: string }
    row: z.infer<typeof ImportTransactionSchema>
    ptx: z.infer<typeof ImportPortfolioTxSchema>
    executedAt: Date
  },
) {
  const { source, row, ptx, executedAt } = input
  const symbol = ptx.instrumentSymbol.toUpperCase()
  const txCcy = ptx.currency.toUpperCase()
  const notional = ptx.quantity * ptx.price
  const feesSettled = settleImportFees(ptx.fees, ptx.feesType, notional)
  const rate = ptx.exchangeRate ?? 1

  let positionId: string | null = null
  let realizedGainLoss: number | null = ptx.realizedGainLoss ?? null

  // A SHORT row opens (or adds to) a short option position — position-
  // creating, no realized P/L — whether it arrives as type BUY or SELL
  // (written covered calls come in as SELL + direction SHORT, plan §24.7).
  const isShortOpen = ptx.direction === "SHORT"
  if (ptx.type === "BUY" || isShortOpen) {
    const position = await upsertImportPositionOnBuy(tx, userId, ptx.portfolioId, {
      symbol,
      instrumentName: ptx.instrumentName ?? null,
      quantity: ptx.quantity,
      price: ptx.price,
      currency: txCcy,
      assetType: ptx.assetType,
      feesSettled,
      direction: ptx.direction ?? null,
      optionType: ptx.optionType ?? null,
      contractSize: ptx.contractSize ?? null,
    })
    positionId = position.id
  } else if (ptx.type === "SELL") {
    const res = await processImportSell(tx, userId, ptx.portfolioId, {
      symbol,
      quantity: ptx.quantity,
      price: ptx.price,
      feesSettled,
    })
    if ("error" in res) {
      throw new ImportRowError(res.error, row.externalId, res.message ?? "Cannot sell")
    }
    positionId = res.position.id
    realizedGainLoss = res.realizedGainLoss
  }

  const [inserted] = await tx
    .insert(portfolioTransactions)
    .values({
      userId,
      portfolioId: ptx.portfolioId,
      positionId,
      walletId,
      type: ptx.type,
      instrumentSymbol: symbol,
      instrumentName: ptx.instrumentName ?? null,
      quantity: scale8(ptx.quantity),
      price: scale8(ptx.price),
      // Default originals to the restated values (mirrors the interactive route
      // invariant), so §23.6 apply-split can restate rows from frozen originals.
      originalQuantity: scale8(ptx.originalQuantity ?? ptx.quantity),
      originalPrice: scale8(ptx.originalPrice ?? ptx.price),
      currency: txCcy,
      instrumentCurrency: txCcy,
      assetType: ptx.assetType,
      fees: ptx.fees != null ? scale8(ptx.fees) : null,
      feesType: ptx.feesType ?? null,
      feeCurrency: ptx.feeCurrency?.toUpperCase() ?? null,
      taxes: ptx.taxes != null ? scale8(ptx.taxes) : null,
      feesSettled: scale8(feesSettled),
      totalAmount: String(round2(notional)),
      realizedGainLoss: realizedGainLoss != null ? String(realizedGainLoss) : null,
      exchangeRate: String(rate),
      rateSource: ptx.rateSource ?? "automatic",
      feeRateSource: ptx.feeRateSource ?? "automatic",
      feeExchangeRate: ptx.feeExchangeRate != null ? String(ptx.feeExchangeRate) : null,
      convertedTotalAmount: String(round2(notional * rate)),
      convertedPrice: String(round2(ptx.price * rate)),
      convertedFees: String(round2(feesSettled * rate)),
      convertedRealizedGainLoss:
        realizedGainLoss != null ? String(round2(realizedGainLoss * rate)) : null,
      displayCurrency: "USD",
      isGift: false,
      synthesizedOpeningLot: false,
      externalSource: source.externalSource,
      externalId: row.externalId,
      executedAt,
    })
    .returning()

  return inserted
}

/**
 * Ledger-first balances (D17): recompute each affected wallet as the exact
 * signed SUM(amount) over its rows (§23.4, after the batch).
 */
async function recalcWalletBalances(database: DB, ids: Set<string>) {
  for (const walletId of ids) {
    const [agg] = await database
      .select({
        total: sql<string>`COALESCE(SUM(${walletTransactions.amount}), 0)::text`,
      })
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, walletId))

    await database
      .update(wallets)
      .set({
        balance: agg.total,
        availableBalance: agg.total,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, walletId))
  }
}