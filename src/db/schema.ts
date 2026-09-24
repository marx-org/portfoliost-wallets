import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { check } from "drizzle-orm/pg-core"

const TX_TYPES = ["DEPOSIT", "WITHDRAWAL", "TRANSFER"] as const

// D16/D24 — schema-per-module
// §62 — the wallets schema is kept for sync_runs only; cash moved to
// portfolios.portfolio_cash_transactions (derived-by-replay, no stored balances).
export const walletsSchema = pgSchema("wallets")

/**
 * Import sync-run tracking (import API). One row per (user, externalSource,
 * spreadsheetId, sheet) — the importer cursor + batch counters over the
 * /api/import surface.
 */
export const syncRuns = walletsSchema.table(
  "sync_runs",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    externalSource: text("external_source").notNull(),
    spreadsheetId: text("spreadsheet_id").notNull(),
    sheet: text("sheet").notNull(),
    lastRow: integer("last_row"),
    status: text("status").notNull().default("pending"), // pending|running|done|failed
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    insertedWtx: integer("inserted_wtx").notNull().default(0),
    insertedPtx: integer("inserted_ptx").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
  },
  (t) => [
    uniqueIndex("uq_sync_runs").on(t.userId, t.externalSource, t.spreadsheetId, t.sheet),
  ],
)

// ─────────────────────────────────────────────────────────────────────────────
// Portfolios schema (§15, D53–D54)
// ─────────────────────────────────────────────────────────────────────────────

export const portfoliosSchema = pgSchema("portfolios")

/**
 * Portfolio container (D54). base_currency is the display/valuation currency,
 * defaulted from user prefs at creation time (D21b). §62: `currency` and
 * `wallet_id` are dropped — a portfolio owns its cash natively (see
 * portfolio_cash_transactions); baseCurrency is the single portfolio currency.
 * `externalSource` tags portfolios created by an import source (NULL = manual).
 */
export const portfolios = portfoliosSchema.table(
  "portfolios",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    strategy: text("strategy").notNull().default("GROWTH"),
    type: text("type").notNull().default("regular"),
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("USD"),
    externalSource: text("external_source"),
    totalInvested: numeric("total_invested", { precision: 20, scale: 8 }).notNull().default("0"),
    currentValue: numeric("current_value", { precision: 20, scale: 8 }).notNull().default("0"),
    isPublic: boolean("is_public").notNull().default(false),
    isMarginEnabled: boolean("is_margin_enabled").notNull().default(false),
    marginRate: numeric("margin_rate", { precision: 9, scale: 4 }),
    maintenanceMarginRate: numeric("maintenance_margin_rate", { precision: 9, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_portfolios_user").on(t.userId),
    // natural key for import bootstrap idempotency (import API §23.3)
    uniqueIndex("uq_portfolios_user_name").on(t.userId, t.name),
  ],
)

/**
 * Portfolio-scoped cash transactions (plan §62). The portfolio owns its cash
 * as a per-currency ledger; balances are DERIVED by replay of portfolio
 * trade rows (BUY/SELL/DIVIDEND effects) + these external rows — nothing is
 * stored. Amounts are signed in the ROW's currency (DEPOSIT +, WITHDRAWAL −,
 * TRANSFER as sent). Cross-currency transfers store both legs plus
 * `transferFxRate` linked via `linkedTxId` (D22, portfolio-scoped).
 */
export const portfolioCashTransactions = portfoliosSchema.table(
  "portfolio_cash_transactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // denormalized owner (D24): direct authorization on every tx operation
    userId: text("user_id").notNull(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    type: text("type", { enum: TX_TYPES }).notNull(),
    amount: numeric("amount", { precision: 28, scale: 8 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: text("status").notNull().default("completed"),
    description: text("description"),
    transactionDate: date("transaction_date"),
    paymentMethod: text("payment_method"),
    fees: numeric("fees", { precision: 20, scale: 8 }),
    feesType: text("fees_type", { enum: ["fixed", "pct"] }),
    feeCurrency: char("fee_currency", { length: 3 }),
    toPortfolioId: uuid("to_portfolio_id").references(() => portfolios.id, { onDelete: "cascade" }),
    linkedTxId: uuid("linked_tx_id"),
    reference: text("reference"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }),
    rateSource: text("rate_source", { enum: ["automatic", "manual"] })
      .notNull()
      .default("automatic"),
    feeRateSource: text("fee_rate_source", { enum: ["automatic", "manual"] })
      .notNull()
      .default("automatic"),
    feeExchangeRate: numeric("fee_exchange_rate", { precision: 20, scale: 10 }),
    transferFxRate: numeric("transfer_fx_rate", { precision: 20, scale: 10 }),
    targetAmount: numeric("target_amount", { precision: 20, scale: 8 }),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_pctx_portfolio").on(t.portfolioId, t.transactionDate),
    index("idx_pctx_user_recent").on(t.userId, t.createdAt.desc()),
    uniqueIndex("uq_pctx_external").on(t.externalSource, t.externalId).where(sql`${t.externalId} is not null`),
    check("ck_pctx_type", sql`${t.type} in ('DEPOSIT','WITHDRAWAL','TRANSFER')`),
    check("ck_pctx_fees_type", sql`${t.feesType} in ('fixed','pct')`),
    check("ck_pctx_rate_source", sql`${t.rateSource} in ('automatic','manual')`),
    check("ck_pctx_fee_rate_source", sql`${t.feeRateSource} in ('automatic','manual')`),
    check("ck_pctx_amount_nonzero", sql`${t.amount} <> 0`),
  ],
)

/**
 * Position lots (D54). One row per AddPositionDialog submit; SELLs target a
 * specific position_id or fall back to FIFO. Moving-average cost basis
 * maintained in the same SQL transaction as every ledger write.
 */
export const positions = portfoliosSchema.table(
  "positions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    companyName: text("company_name"),
    assetType: text("asset_type").notNull().default("STOCK"),
    contractSize: numeric("contract_size", { precision: 20, scale: 8 }),
    direction: text("direction"),
    optionType: text("option_type"),
    strikePrice: numeric("strike_price", { precision: 20, scale: 8 }),
    expirationDate: date("expiration_date"),
    quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull().default("0"),
    averageCostBasis: numeric("average_cost_basis", { precision: 20, scale: 8 }).notNull().default("0"),
    instrumentCurrency: char("instrument_currency", { length: 3 }).notNull().default("USD"),
    purchaseCurrency: char("purchase_currency", { length: 3 }),
    sector: text("sector"),
    industry: text("industry"),
    country: text("country"),
    fees: numeric("fees", { precision: 20, scale: 8 }),
    feesType: text("fees_type", { enum: ["fixed", "pct"] }),
    feeCurrency: char("fee_currency", { length: 3 }),
    isOpen: boolean("is_open").notNull().default(true),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    currentPrice: numeric("current_price", { precision: 20, scale: 8 }),
    priceSource: text("price_source").notNull().default("manual"),
    priceAsOf: timestamp("price_as_of", { withTimezone: true }),
    marketValue: numeric("market_value", { precision: 20, scale: 8 }),
    unrealizedGainLoss: numeric("unrealized_gain_loss", { precision: 20, scale: 8 }),
    dayChange: numeric("day_change", { precision: 20, scale: 8 }),
    dayChangePercent: numeric("day_change_percent", { precision: 20, scale: 8 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_positions_portfolio").on(t.portfolioId),
    index("idx_positions_symbol").on(t.userId, t.symbol),
    check("ck_positions_direction", sql`${t.direction} in ('LONG','SHORT')`),
    check("ck_positions_option_type", sql`${t.optionType} in ('CALL','PUT')`),
    check("ck_positions_fees_type", sql`${t.feesType} in ('fixed','pct')`),
  ],
)

/**
 * Ledger-first portfolio transactions (D54/D56). Source of truth for position
 * quantities, cost basis, realized P/L, and (via cashLedger.tradeCashEffects)
 * the portfolio's cash history. Denormalized user_id for direct authorization
 * (D24).
 */
export const portfolioTransactions = portfoliosSchema.table(
  "transactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    positionId: uuid("position_id").references(() => positions.id),
    type: text("type").notNull(),
    instrumentSymbol: text("instrument_symbol"),
    instrumentName: text("instrument_name"),
    sector: text("sector"),
    industry: text("industry"),
    country: text("country"),
    quantity: numeric("quantity", { precision: 20, scale: 8 }).notNull().default("0"),
    price: numeric("price", { precision: 20, scale: 8 }).notNull().default("0"),
    originalQuantity: numeric("original_quantity", { precision: 20, scale: 8 }),
    originalPrice: numeric("original_price", { precision: 20, scale: 8 }),
    currency: char("currency", { length: 3 }).notNull(),
    instrumentCurrency: char("instrument_currency", { length: 3 }),
    assetType: text("asset_type").notNull().default("STOCK"),
    fees: numeric("fees", { precision: 20, scale: 8 }),
    feesType: text("fees_type", { enum: ["fixed", "pct"] }),
    feeCurrency: char("fee_currency", { length: 3 }),
    taxes: numeric("taxes", { precision: 20, scale: 8 }),
    notes: text("notes"),
    feesSettled: numeric("fees_settled", { precision: 20, scale: 8 }),
    totalAmount: numeric("total_amount", { precision: 20, scale: 8 }).notNull().default("0"),
    realizedGainLoss: numeric("realized_gain_loss", { precision: 20, scale: 8 }),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }),
    rateSource: text("rate_source").notNull().default("automatic"),
    feeRateSource: text("fee_rate_source").notNull().default("automatic"),
    feeExchangeRate: numeric("fee_exchange_rate", { precision: 20, scale: 10 }),
    convertedTotalAmount: numeric("converted_total_amount", { precision: 20, scale: 8 }),
    convertedPrice: numeric("converted_price", { precision: 20, scale: 8 }),
    convertedFees: numeric("converted_fees", { precision: 20, scale: 8 }),
    convertedRealizedGainLoss: numeric("converted_realized_gain_loss", { precision: 20, scale: 8 }),
    displayCurrency: char("display_currency", { length: 3 }),
    isGift: boolean("is_gift").notNull().default(false),
    synthesizedOpeningLot: boolean("synthesized_opening_lot").notNull().default(false),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_ptx_portfolio").on(t.portfolioId, t.executedAt.desc()),
    index("idx_ptx_user").on(t.userId, t.executedAt.desc()),
    index("idx_ptx_position").on(t.positionId),
    uniqueIndex("uq_ptx_external").on(t.externalSource, t.externalId).where(sql`${t.externalId} is not null`),
    check("ck_ptx_type", sql`${t.type} in ('BUY','SELL','DIVIDEND')`),
    check("ck_ptx_rate_source", sql`${t.rateSource} in ('automatic','manual')`),
    check("ck_ptx_fee_rate_source", sql`${t.feeRateSource} in ('automatic','manual')`),
    check("ck_ptx_fees_type", sql`${t.feesType} in ('fixed','pct')`),
  ],
)

/**
 * Durable split event ledger (§23.6). `factor` is the QUANTITY multiplier
 * (2 for a 2:1 split); the instruments split_adjustments table holds price
 * multipliers and is wiped by stooq imports, so it cannot serve as this
 * history. Restatement of pre-split transactions derives from the frozen
 * original_quantity/original_price × product of applicable events, which
 * keeps apply-split idempotent.
 */
export const splitEvents = portfoliosSchema.table(
  "split_events",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    factor: numeric("factor", { precision: 20, scale: 8 }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    source: text("source").notNull().default("admin"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_split_events").on(t.symbol, t.effectiveDate)],
)

/**
 * Public share links (D54). 10-active limit enforced at write time (D59);
 * delete is unconditional. privacy_settings jsonb controls position projection
 * for the auth-exempt public route.
 */
export const shares = portfoliosSchema.table(
  "shares",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull().default(""),
    viewCount: integer("view_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    privacySettings: jsonb("privacy_settings").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_shares_portfolio").on(t.portfolioId)],
)

/**
 * EOD value snapshots (D54/D61). Analytics source of truth; append-only
 * reference data recomputable by rebuild for one portfolio. Recomputing
 * history = truncate + rebuild (same philosophy as balance-history D21).
 */
export const valueSnapshots = portfoliosSchema.table(
  "value_snapshots",
  {
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    snapshotDate: date("snapshot_date").notNull(),
    value: numeric("value", { precision: 20, scale: 8 }).notNull(),
    invested: numeric("invested", { precision: 20, scale: 8 }).notNull(),
    netFlow: numeric("net_flow", { precision: 20, scale: 8 }).notNull().default("0"),
    // §53.2 — widened from numeric(20,8): an XIRR that "converges" to a
    // garbage rate produced cumulative_mwr ≈ 1e12 → 'numeric field overflow'.
    // (The §53.1 solver guard makes this a belt-and-braces bound.)
    cumulativeTwr: numeric("cumulative_twr", { precision: 28, scale: 8 }),
    cumulativeMwr: numeric("cumulative_mwr", { precision: 28, scale: 8 }),
    cumulativeSimple: numeric("cumulative_simple", { precision: 28, scale: 8 }),
  },
  (t) => [
    primaryKey({ columns: [t.portfolioId, t.snapshotDate] }),
    index("idx_snapshots_portfolio_date").on(t.portfolioId, t.snapshotDate),
  ],
)

/**
 * Tracks the historical backfill status per portfolio (H6). A single row per
 * portfolio; upserted when backfill starts/completes/fails.
 */
export const portfolioBackfillMetadata = portfoliosSchema.table(
  "portfolio_backfill_metadata",
  {
    portfolioId: uuid("portfolio_id")
      .primaryKey()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // 'pending'|'complete'|'failed'
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
  },
)

/**
 * User-created labels (D65). `color` is a hex "#rrggbb" from the shared
 * 10-colour palette; auto-assigned via palette cycling when omitted at
 * creation. Name is unique per user.
 */
export const labels = portfoliosSchema.table(
  "labels",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_labels_user_name").on(t.userId, t.name),
    index("idx_labels_user").on(t.userId),
  ],
)

/** Many-to-many: label -> position (D65). */
export const positionLabels = portfoliosSchema.table(
  "position_labels",
  {
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.positionId, t.labelId] }),
    index("idx_position_labels_label").on(t.labelId),
  ],
)

/** Many-to-many: label -> portfolio transaction (D65). */
export const transactionLabels = portfoliosSchema.table(
  "transaction_labels",
  {
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => portfolioTransactions.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.labelId] }),
    index("idx_transaction_labels_label").on(t.labelId),
  ],
)

/** Many-to-many: label -> portfolio cash transaction (§62, D65). */
export const portfolioCashTransactionLabels = portfoliosSchema.table(
  "portfolio_cash_transaction_labels",
  {
    cashTransactionId: uuid("cash_transaction_id")
      .notNull()
      .references(() => portfolioCashTransactions.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.cashTransactionId, t.labelId] }),
    index("idx_cash_transaction_labels_label").on(t.labelId),
  ],
)
