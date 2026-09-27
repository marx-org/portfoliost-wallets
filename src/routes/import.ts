import { Hono, type Context } from "hono"
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { externalCashInvested } from "../services/cashLedger.js"
import {
  portfolios,
  portfolioCashTransactions,
  portfolioCashTransactionLabels,
  portfolioTransactions,
  positions,
  syncRuns,
  valueSnapshots,
  shares,
  portfolioBackfillMetadata,
  labels,
  positionLabels,
  transactionLabels,
} from "../db/schema.js"
import { preferredBaseCurrency } from "../services/preferences.js"
import { nextPaletteColor } from "./labels.js"
import { ISO_CURRENCY } from "../services/currency.js"
import type { components } from "../generated/api-types.js"

type ImportPortfolioBootstrapResponse = components["schemas"]["ImportPortfolioBootstrapResponse"]
type ImportLabelBootstrapResponse = components["schemas"]["ImportLabelBootstrapResponse"]
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

export const ImportPortfolioBootstrapRequestSchema = ExternalSourceSchema.extend({
  name: z.string().min(1),
  currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
}).strict()

export const ImportLabelBootstrapRequestSchema = ExternalSourceSchema.extend({
  labels: z.array(z.string().trim().min(1).max(40)).min(1).max(200),
}).strict()

const CASH_TX_TYPES = ["DEPOSIT", "WITHDRAWAL", "TRANSFER"] as const

const ImportPortfolioCashTxSchema = z
  .object({
    type: z.enum(CASH_TX_TYPES),
    amount: z.number(),
    currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
    description: z.string().nullable().optional(),
    transactionDate: z.string().nullable().optional(),
    status: z.string().optional(),
    paymentMethod: z.string().nullable().optional(),
    fees: z.number().nonnegative().nullable().optional(),
    feesType: z.enum(["fixed", "pct"]).nullable().optional(),
    reference: z.string().nullable().optional(),
    toPortfolioName: z.string().nullable().optional(),
    targetAmount: z.number().nullable().optional(),
    labels: z.array(z.string().min(1).max(40)).max(20).optional(),
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
    type: z.enum(["BUY", "SELL", "DIVIDEND", "EXPIRATION"]),
    instrumentSymbol: z.string().min(1),
    instrumentName: z.string().nullable().optional(),
    assetType: z.string().default("STOCK"),
    quantity: z.number().positive(),
    price: z.number().nonnegative(),
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
    // For `type: "EXPIRATION"` it is required and CLOSES the short-option lot
    // at zero value (zero cash effect).
    direction: z.enum(["LONG", "SHORT"]).nullable().optional(),
    optionType: z.enum(["CALL", "PUT"]).nullable().optional(),
    contractSize: z.number().nullable().optional(),
    // Position-enrichment fields (plan §28.5): from the Podsumowanie catalog or
    // the venue's exchange_reference. `country` is the ISO-2 code; see
    // positions.sector/industry/country.
    sector: z.string().nullable().optional(),
    industry: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    countryCode: z.string().nullable().optional(),
    // Sheet-derived labels (plan §55): names, resolved server-side per user.
    positionLabels: z.array(z.string().min(1).max(40)).max(20).optional(),
    transactionLabels: z.array(z.string().min(1).max(40)).max(20).optional(),
  })
  .strict()

const ImportTransactionSchema = z
  .object({
    externalId: z.string().min(1),
    portfolioName: z.string().min(1),
    executedAt: z.string().min(1),
    cashTx: ImportPortfolioCashTxSchema.optional(),
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
    sector?: string | null
    industry?: string | null
    country?: string | null
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
        sector: body.sector ?? existing.sector,
        industry: body.industry ?? existing.industry,
        country: body.country ?? existing.country,
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
      sector: body.sector ?? "Other",
      industry: body.industry ?? "Other",
      country: body.country ?? "Other",
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
    /** Close the lot with this direction (undefined = default NULL/LONG lot). */
    direction?: "LONG" | "SHORT" | null
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
        body.direction != null
          ? eq(positions.direction, body.direction)
          : sql`${positions.direction} is null or ${positions.direction} = 'LONG'`,
      ),
    )

  if (!pos) return { error: "no_open_position", message: `No open position for ${symbol}` }

  const oldQty = Number(pos.quantity)
  // Display-precision drift: sheet quantities are rounded to 6 decimals per
  // row, so the sum of rounded buys can differ from the rounded sell by ~1e-6
  // relative. Within that band, clamp the sell to the held amount (the row is
  // the user's own full-position exit); beyond it, the row is inconsistent.
  const driftTol = Math.max(1e-9, oldQty * 1e-6)
  if (body.quantity > oldQty + driftTol) {
    return {
      error: "insufficient_quantity",
      message: `Insufficient quantity for ${symbol}: have ${oldQty}, selling ${body.quantity}`,
    }
  }
  const sellQty = Math.min(body.quantity, oldQty)

  const avgCost = Number(pos.averageCostBasis)
  const realizedGainLoss = round2((body.price - avgCost) * sellQty - body.feesSettled)
  const newQty = Math.round((oldQty - sellQty) * 1e8) / 1e8

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

/** Recompute a portfolio's invested total from its external cash flows
 * (§23.4 final pass; 2026-09-27 — net external flow = deposits − withdrawals
 * ± transfer legs, NOT BUY-row cost basis: a fully-invested portfolio has ~0
 * cash balance but a large invested total). */
async function recomputeImportPortfolioTotals(tx: DB, authToken: string | null, userId: string, portfolioId: string) {
  const [pf] = await tx
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
  if (!pf) throw new Error(`import: portfolio ${portfolioId} not found`)
  const totalInvested = await externalCashInvested(tx, authToken, portfolioId, pf.baseCurrency)

  await tx
    .update(portfolios)
    .set({ totalInvested: totalInvested.toFixed(8), updatedAt: new Date() })
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
    insertedCashTx: r.insertedWtx,
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
    // §66.4 — best-effort: a users-auth blip must not abort a sheets import
    // (the same choice as portfolio creation). The sheet always states each
    // portfolio's own currency, so this is only a fallback for new portfolios.
    const defaultBase = await preferredBaseCurrency(forwardedHeaders, undefined, { strict: false })
    const baseCurrency = (parsed.data.baseCurrency ?? defaultBase).toUpperCase()

    const [inserted] = await database
      .insert(portfolios)
      .values({
        userId: identity.id,
        name: parsed.data.name,
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
      // §62: portfolio.currency is dropped; the contract still exposes a
      // single-currency field — report the (sole) base currency.
      currency: row.baseCurrency,
      baseCurrency: row.baseCurrency,
      created: Boolean(inserted),
    } satisfies ImportPortfolioBootstrapResponse)
  })

  // §55.1 — label bootstrap: idempotent ensure-by-name per user.
  routes.post("/labels/bootstrap", async (c) => {
    const parsed = ImportLabelBootstrapRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed)
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const items: NonNullable<ImportLabelBootstrapResponse["labels"]> = []
    for (const name of parsed.data.labels) {
      const [inserted] = await database
        .insert(labels)
        .values({
          userId: identity.id,
          name,
          color: await nextPaletteColor(database, identity.id),
        })
        .onConflictDoNothing({ target: [labels.userId, labels.name] })
        .returning()

      const [row] = inserted
        ? [inserted]
        : await database
            .select()
            .from(labels)
            .where(and(eq(labels.userId, identity.id), eq(labels.name, name)))
            .limit(1)

      items.push({ name: row.name, id: row.id, created: Boolean(inserted) })
    }

    return c.json({ labels: items } satisfies ImportLabelBootstrapResponse)
  })

  routes.post("/transactions", async (c) => {
    const parsed = ImportTransactionsRequestSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed)
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const { source, transactions } = parsed.data
    const errors: NonNullable<ImportTransactionsResponse["errors"]> = []
    const affectedPortfolios = new Set<string>()
    let insertedCashTx = 0
    let insertedPtx = 0
    let inserted = 0
    let skipped = 0

    for (const row of transactions) {
      let outcome: { inserted: boolean } | null = null
      try {
        outcome = await database.transaction(async (tx) => {
          // The row's source portfolio: the ptx's id, or resolved by name via
          // uq_portfolios_user_name (bootstrapped earlier in the batch run).
          const ptx = row.portfolioTx
          const portfolio = ptx
            ? await portfolioOwnedById(tx, identity.id, ptx.portfolioId)
            : await resolvePortfolioByName(tx, identity.id, row.portfolioName)
          if (!portfolio) {
            throw new ImportRowError(
              "portfolio_not_found",
              row.externalId,
              `Unknown portfolio "${ptx ? ptx.portfolioId : row.portfolioName}"`,
            )
          }

          affectedPortfolios.add(portfolio.id)

          // Idempotency: a re-submitted row's ptx externalId already present
          // → skip (the old design deduped on the wallet leg's unique externalId;
          // pure-trade rows have no cash leg, so dedup on the ptx instead).
          if (ptx) {
            const [dupPtx] = await tx
              .select({ id: portfolioTransactions.id })
              .from(portfolioTransactions)
              .where(
                and(
                  eq(portfolioTransactions.externalSource, source.externalSource),
                  eq(portfolioTransactions.externalId, row.externalId),
                ),
              )
              .limit(1)
            if (dupPtx) return { inserted: false }
          }

          // AU=0 rows carry no cashTx (pure trade): skip the cash leg.
          if (row.cashTx) {
            const ct = await insertImportPortfolioCashTx(tx, identity.id, portfolio.id, {
              source,
              row,
            })
            if (!ct.inserted) return { inserted: false }
          }

          if (ptx) {
            await insertImportPortfolioTx(tx, identity.id, {
              source,
              row,
              ptx,
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

      if (outcome?.inserted) {
        inserted++
        // count only rows that actually carried a cash leg (pure trades → 0)
        if (row.cashTx) insertedCashTx++
      } else if (outcome?.inserted === false) skipped++
    }

    for (const portfolioId of affectedPortfolios) {
      await recomputeImportPortfolioTotals(database, c.req.header("Authorization") ?? null, identity.id, portfolioId)
    }

    const status: SyncRun["status"] =
      inserted === 0 && insertedPtx === 0 && errors.length > 0 ? "failed" : "done"
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
        insertedWtx: insertedCashTx,
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
          insertedWtx: insertedCashTx,
          insertedPtx,
          skipped,
        },
      })
      .returning()

    return c.json({
      inserted,
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
  // external source for the authenticated user, in one transaction. Derived
  // data (positions, portfolio transactions, value snapshots, shares, backfill
  // metadata) is deleted explicitly so the wipe leaves the DB clean; cash
  // transactions are deleted by source tag (their labels cascade).
  // split_events is global and never touched.
  routes.delete("/source/:externalSource", async (c) => {
    const identity = c.get("userIdentity")
    if (!identity) return c.json({ message: "Unauthorized" }, 401)
    const database = getDbInstance()
    const externalSource = c.req.param("externalSource")
    const deleted = await database.transaction(async (tx) => {
      const sourcePortfolios = await tx
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.externalSource, externalSource), eq(portfolios.userId, identity.id)))
      const sourcePortfolioIds = sourcePortfolios.map((row) => row.id)

      // Derived data scoped to source portfolios. ptx before positions (the
      // ptx→position FK is NO ACTION). Empty id lists → inArray renders false.
      const portfolioTransactionsRows = await tx
        .delete(portfolioTransactions)
        .where(
          and(
            inArray(portfolioTransactions.portfolioId, sourcePortfolioIds),
            eq(portfolioTransactions.userId, identity.id),
          ),
        )
        .returning({ id: portfolioTransactions.id })
      const positionsRows = await tx
        .delete(positions)
        .where(and(inArray(positions.portfolioId, sourcePortfolioIds), eq(positions.userId, identity.id)))
        .returning({ id: positions.id })
      const valueSnapshotsRows = await tx
        .delete(valueSnapshots)
        .where(inArray(valueSnapshots.portfolioId, sourcePortfolioIds))
        .returning({ portfolioId: valueSnapshots.portfolioId })
      const sharesRows = await tx
        .delete(shares)
        .where(and(inArray(shares.portfolioId, sourcePortfolioIds), eq(shares.userId, identity.id)))
        .returning({ id: shares.id })
      const portfolioBackfillMetadataRows = await tx
        .delete(portfolioBackfillMetadata)
        .where(inArray(portfolioBackfillMetadata.portfolioId, sourcePortfolioIds))
        .returning({ portfolioId: portfolioBackfillMetadata.portfolioId })

      // Portfolio cash transactions tagged with this source (both transfer
      // legs carry the tag; labels cascade via the FK).
      const cashTransactionsRows = await tx
        .delete(portfolioCashTransactions)
        .where(
          and(eq(portfolioCashTransactions.externalSource, externalSource), eq(portfolioCashTransactions.userId, identity.id)),
        )
        .returning({ id: portfolioCashTransactions.id })

      const portfoliosRows = await tx
        .delete(portfolios)
        .where(and(eq(portfolios.externalSource, externalSource), eq(portfolios.userId, identity.id)))
        .returning({ id: portfolios.id })

      const syncRunsRows = await tx
        .delete(syncRuns)
        .where(and(eq(syncRuns.externalSource, externalSource), eq(syncRuns.userId, identity.id)))
        .returning({ id: syncRuns.id })

      return {
        cashTransactions: cashTransactionsRows.length,
        portfolios: portfoliosRows.length,
        syncRuns: syncRunsRows.length,
        positions: positionsRows.length,
        portfolioTransactions: portfolioTransactionsRows.length,
        valueSnapshots: valueSnapshotsRows.length,
        shares: sharesRows.length,
        portfolioBackfillMetadata: portfolioBackfillMetadataRows.length,
      }
    })
    return c.json({ deleted } satisfies SourceWipeResponse)
  })


  return routes
}

async function resolvePortfolioByName(tx: DB, userId: string, name: string) {
  const [portfolio] = await tx
    .select({ id: portfolios.id, baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(and(eq(portfolios.userId, userId), eq(portfolios.name, name)))
    .limit(1)
  return portfolio
}

async function portfolioOwnedById(tx: DB, userId: string, portfolioId: string) {
  const [portfolio] = await tx
    .select({ id: portfolios.id, baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
    .limit(1)
  return portfolio
}

/**
 * Imported portfolio cash leg (§62, plan 62.5). The stored amount is the
 * row's SIGNED own-currency effect: DEPOSIT +|amount|, WITHDRAWAL −|amount|
 * (sign clamp, §58.3), TRANSFER as sent. A TRANSFER resolves
 * `toPortfolioName` (must exist, ≠ source) and inserts the paired
 * counterpart leg with `linkedTxId` both ways (`#t` externalId suffix for
 * the server-created credit leg); `targetAmount` is server-computed
 * (same-ccy = −amount, cross = amount × exchangeRate). `labels` names are
 * bootstrapped + attached (unknown name → row error).
 */
async function insertImportPortfolioCashTx(
  tx: DB,
  userId: string,
  portfolioId: string,
  input: {
    source: { externalSource: string }
    row: z.infer<typeof ImportTransactionSchema>
  },
): Promise<{ inserted: boolean }> {
  const { source, row } = input
  const c = row.cashTx
  if (!c) return { inserted: false }
  const ccy = c.currency.toUpperCase()

  // sign clamp (§58.3): the importer may send the sheet's signed value. A
  // TRANSFER is a debit out of the source — stored negated (magnitude kept
  // positive) so the paired legs match the interactive route (§62.3): the
  // source leg is negative, the destination leg positive.
  const amount =
    c.type === "DEPOSIT"
      ? Math.abs(c.amount)
      : c.type === "WITHDRAWAL"
        ? -Math.abs(c.amount)
        : -Math.abs(c.amount)

  // labels → ids (unknown name → row error, §58.3)
  const labelIds = await resolveImportLabelIds(tx, userId, c.labels ?? [], row.externalId)

  const baseRow = {
    userId,
    type: c.type,
    currency: ccy,
    status: c.status ?? "completed",
    description: c.description ?? null,
    transactionDate: c.transactionDate ?? null,
    paymentMethod: c.paymentMethod ?? null,
    fees: c.fees != null ? scale8(c.fees) : null,
    feesType: c.feesType ?? null,
    feeCurrency: c.feeCurrency?.toUpperCase() ?? null,
    exchangeRate: c.exchangeRate != null ? String(c.exchangeRate) : null,
    rateSource: c.rateSource ?? "automatic",
    feeRateSource: c.feeRateSource ?? "automatic",
    feeExchangeRate: c.feeExchangeRate != null ? String(c.feeExchangeRate) : null,
    reference: c.reference ?? null,
    externalSource: source.externalSource,
  }

  if (c.type !== "TRANSFER") {
    const [inserted] = await tx
      .insert(portfolioCashTransactions)
      .values({
        ...baseRow,
        portfolioId,
        amount: scale8(amount),
        externalId: row.externalId,
      })
      .onConflictDoNothing()
      .returning()
    if (inserted && labelIds.size > 0) {
      await tx
        .insert(portfolioCashTransactionLabels)
        .values(
          [...labelIds.values()].map((labelId) => ({ cashTransactionId: inserted.id, labelId })),
        )
    }
    return { inserted: Boolean(inserted) }
  }

  // TRANSFER — resolve the target portfolio (must exist, ≠ source)
  const toName = (c.toPortfolioName ?? "").trim()
  if (!toName) {
    throw new ImportRowError(
      "transfer_target_missing",
      row.externalId,
      "TRANSFER requires toPortfolioName",
    )
  }
  const to = await resolvePortfolioByName(tx, userId, toName)
  if (!to) {
    throw new ImportRowError(
      "transfer_target_not_found",
      row.externalId,
      `Unknown transfer target "${toName}"`,
    )
  }
  if (to.id === portfolioId) {
    throw new ImportRowError(
      "transfer_to_self",
      row.externalId,
      "Transfer target must differ from the source portfolio",
    )
  }

  // server-computed target leg: same-ccy = |amount|, cross = |amount| × rate.
  // Both legs store the row currency (§62); the credit leg is positive.
  const rate = c.exchangeRate ?? 1
  const targetAmount =
    c.targetAmount != null ? c.targetAmount : Math.abs(amount) * (rate === 1 ? 1 : rate)
  // The server-created credit leg states where the money CAME from, so both
  // legs show the transfer direction in the cash tables (mirrors the
  // interactive route, §62 follow-up).
  const [fromRow] = await tx
    .select({ name: portfolios.name })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
  const fromName = fromRow?.name ?? ""
  const creditDesc = c.description
    ? `${c.description} (from ${fromName})`
    : `from ${fromName}`

  const [debit] = await tx
    .insert(portfolioCashTransactions)
    .values({
      ...baseRow,
      portfolioId,
      toPortfolioId: to.id,
      amount: scale8(amount),
      transferFxRate: rate !== 1 ? String(rate) : null,
      targetAmount: scale8(targetAmount),
      externalId: row.externalId,
    })
    .onConflictDoNothing()
    .returning()

  // idempotency: the debit leg already exists (re-import) → skip the pair
  // (the caller counts this row as skipped)
  if (!debit) return { inserted: false }

  const [credit] = await tx
    .insert(portfolioCashTransactions)
    .values({
      ...baseRow,
      description: creditDesc ?? null,
      portfolioId: to.id,
      toPortfolioId: portfolioId,
      amount: scale8(targetAmount),
      transferFxRate: rate !== 1 ? String(rate) : null,
      targetAmount: scale8(amount),
      reference: c.reference ? `${c.reference} (→ ${toName})` : `→ ${toName}`,
      externalId: `${row.externalId}#t`,
      linkedTxId: debit.id,
    })
    .onConflictDoNothing()
    .returning()

  if (credit) {
    // link both ways (§62.3)
    await tx
      .update(portfolioCashTransactions)
      .set({ linkedTxId: credit.id })
      .where(eq(portfolioCashTransactions.id, debit.id))
  }
  if (debit && labelIds.size > 0) {
    await tx
      .insert(portfolioCashTransactionLabels)
      .values([...labelIds.values()].map((labelId) => ({ cashTransactionId: debit.id, labelId })))
  }
  return { inserted: Boolean(debit && credit) }
}

async function insertImportPortfolioTx(
  tx: DB,
  userId: string,
  input: {
    source: { externalSource: string }
    row: z.infer<typeof ImportTransactionSchema>
    ptx: z.infer<typeof ImportPortfolioTxSchema>
  },
) {
  const { source, row, ptx } = input
  const executedAt = ptx.executedAt ? new Date(ptx.executedAt) : new Date(row.executedAt)
  const symbol = ptx.instrumentSymbol.toUpperCase()
  const txCcy = ptx.currency.toUpperCase()
  const notional = ptx.quantity * ptx.price
  const feesSettled = settleImportFees(ptx.fees, ptx.feesType, notional)
  const rate = ptx.exchangeRate ?? 1

  // EXPIRATION closes an expired (unexercised) option lot at zero value — it
  // must carry zero price and zero fees (the premium was booked on the SELL
  // that opened the short lot; nothing moves on expiry).
  if (ptx.type === "EXPIRATION" && (ptx.price !== 0 || (ptx.fees ?? 0) !== 0)) {
    throw new ImportRowError(
      "expiration_must_be_zero_value",
      row.externalId,
      `EXPIRATION requires price 0 and no fees (got price ${ptx.price}, fees ${ptx.fees ?? 0})`,
    )
  }

  // §49 convention (interactive route): a DIVIDEND's totalAmount is the NET
  // (gross − withholding tax); the wallet leg keeps whatever the importer
  // sent (the sheet's actual cash). taxes > gross is contradictory → row error.
  const taxes = ptx.taxes != null ? ptx.taxes : null
  if (ptx.type === "DIVIDEND" && taxes != null && taxes > notional) {
    throw new ImportRowError(
      "dividend_taxes_exceed_gross",
      row.externalId,
      `taxes ${taxes} exceed gross ${notional}`,)
  }
  const totalAmount =
    ptx.type === "DIVIDEND" && taxes != null ? round2(notional - taxes) : round2(notional)

  // §55.1: sheet-derived label names → this user's label ids; any unknown
  // name (one the bootstrap didn't create) fails the row loudly.
  const labelNames = [...new Set([...(ptx.positionLabels ?? []), ...(ptx.transactionLabels ?? [])])]
  const labelIds = await resolveImportLabelIds(tx, userId, labelNames, row.externalId)
  const positionLabelIds = (ptx.positionLabels ?? []).map((n) => labelIds.get(n)!)
  const transactionLabelIds = (ptx.transactionLabels ?? []).map((n) => labelIds.get(n)!)

  let positionId: string | null = null
  let realizedGainLoss: number | null = ptx.realizedGainLoss ?? null

  // A SHORT row opens (or adds to) a short option position — position-
  // creating, no realized P/L — whether it arrives as type BUY or SELL
  // (written covered calls come in as SELL + direction SHORT, plan §24.7).
  // EXPIRATION is a CLOSE, not an open — it must fall through to the sell
  // branch (even though it carries direction SHORT).
  const isShortOpen = ptx.direction === "SHORT" && ptx.type !== "EXPIRATION"
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
      sector: ptx.sector ?? null,
      industry: ptx.industry ?? null,
      country: ptx.country ?? null,
    })
    positionId = position.id
  } else if (ptx.type === "SELL" || ptx.type === "EXPIRATION") {
    const res = await processImportSell(tx, userId, ptx.portfolioId, {
      symbol,
      quantity: ptx.quantity,
      price: ptx.type === "EXPIRATION" ? 0 : ptx.price,
      feesSettled: ptx.type === "EXPIRATION" ? 0 : feesSettled,
      // SELL rows that reach this branch are always default-lot closes (a
      // SHORT-direction SELL is an open, handled above) — so the default
      // NULL/LONG lot filter. EXPIRATION closes the SHORT option lot.
      direction: ptx.type === "EXPIRATION" ? "SHORT" : undefined,
    })
    if ("error" in res) {
      throw new ImportRowError(
        res.error,
        row.externalId,
        res.message ?? (ptx.type === "EXPIRATION" ? "Cannot expire option" : "Cannot sell"),
      )
    }
    positionId = res.position.id
    realizedGainLoss = res.realizedGainLoss
  } else if (ptx.type === "DIVIDEND" && positionLabelIds.length > 0) {
    // DIVIDEND rows don't touch the position ledger; look up the open lot
    // only when position labels need a home. No open lot (e.g. a dividend on
    // an already-closed position) → position labels are skipped, the row
    // still imports (transaction labels apply regardless).
    const [pos] = await tx
      .select({ id: positions.id })
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          eq(positions.portfolioId, ptx.portfolioId),
          eq(positions.symbol, symbol),
          eq(positions.isOpen, true),
        ),
      )
    positionId = pos?.id ?? null
  }

  const [inserted] = await tx
    .insert(portfolioTransactions)
    .values({
      userId,
      portfolioId: ptx.portfolioId,
      positionId,
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
      totalAmount: String(totalAmount),
      realizedGainLoss: realizedGainLoss != null ? String(realizedGainLoss) : null,
      exchangeRate: String(rate),
      rateSource: ptx.rateSource ?? "automatic",
      feeRateSource: ptx.feeRateSource ?? "automatic",
      feeExchangeRate: ptx.feeExchangeRate != null ? String(ptx.feeExchangeRate) : null,
      convertedTotalAmount: String(round2(totalAmount * rate)),
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

  // §55.1: additive label joins — set the entity's join rows to the
  // requested id set within the row transaction. Wipe (§23.5) deletes the
  // entities and the FK cascade cleans the joins, so replace semantics are
  // idempotent across re-imports.
  if (positionId && positionLabelIds.length > 0) {
    await tx.delete(positionLabels).where(eq(positionLabels.positionId, positionId))
    await tx
      .insert(positionLabels)
      .values(positionLabelIds.map((labelId) => ({ positionId, labelId })))
  }
  if (transactionLabelIds.length > 0 && inserted) {
    await tx
      .delete(transactionLabels)
      .where(eq(transactionLabels.transactionId, inserted.id))
    await tx
      .insert(transactionLabels)
      .values(transactionLabelIds.map((labelId) => ({ transactionId: inserted.id, labelId })))
  }

  return inserted
}

/** §55.1: label names → ids for this user; unknown name → row error. */
async function resolveImportLabelIds(
  tx: DB,
  userId: string,
  names: string[],
  rowExternalId: string,
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map()
  const rows = await tx
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(and(eq(labels.userId, userId), inArray(labels.name, names)))
  const byName = new Map(rows.map((r) => [r.name, r.id]))
  const missing = names.filter((n) => !byName.has(n))
  if (missing.length > 0) {
    throw new ImportRowError(
      "label_not_found",
      rowExternalId,
      `Label(s) not found for user: ${missing.join(", ")}`,
    )
  }
  return byName
}

