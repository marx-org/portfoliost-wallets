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

// D16/D24 — schema-per-module
export const walletsSchema = pgSchema("wallets")

/**
 * Cash wallet (D17). `currency` is the settlement denomination and mandatory;
 * `baseCurrency` is the display/valuation currency defaulted from user prefs
 * at creation time (D21b). Balances are denormalized ledger-maintained values.
 * `externalSource` tags wallets created by an import source (NULL = manual).
 */
export const wallets = walletsSchema.table(
  "wallets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("USD"),
    externalSource: text("external_source"),
    balance: numeric("balance", { precision: 20, scale: 8 }).notNull().default("0"),
    availableBalance: numeric("available_balance", { precision: 20, scale: 8 })
      .notNull()
      .default("0"),
    reserved: numeric("reserved", { precision: 20, scale: 8 }).notNull().default("0"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_wallets_user").on(t.userId)],
)

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

/**
 * Signed cash ledger (D17): the source of truth for balances. Amounts are in
 * the WALLET's currency; inflows positive, outflows negative. FX snapshots
 * (`exchangeRate`/`rateSource`, fee equivalents) follow fees-and-custom-fx
 * D28/D29; cross-currency transfers store both legs plus `transferFxRate`
 * linked via `linkedTxId` (D22).
 */
export const walletTransactions = walletsSchema.table(
  "wallet_transactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // denormalized owner (D24): direct authorization on every tx operation
    userId: text("user_id").notNull(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id),
    type: text("type", { enum: TX_TYPES }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 8 }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: text("status").notNull().default("completed"),
    description: text("description"),
    transactionDate: date("transaction_date"),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
    paymentMethod: text("payment_method"),
    fees: numeric("fees", { precision: 20, scale: 8 }),
    feesType: text("fees_type", { enum: ["fixed", "pct"] }),
    feeCurrency: char("fee_currency", { length: 3 }),
    taxes: numeric("taxes", { precision: 20, scale: 8 }),
    toWalletId: uuid("to_wallet_id").references(() => wallets.id),
    linkedTxId: uuid("linked_tx_id"),
    reference: text("reference"),
    portfolioId: uuid("portfolio_id"),
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
    index("idx_wtx_wallet").on(t.walletId, t.executedAt.desc()),
    index("idx_wtx_user_recent").on(t.userId, t.executedAt.desc()),
    uniqueIndex("uq_wtx_reference").on(t.reference).where(sql`reference is not null`),
    uniqueIndex("uq_wtx_external").on(t.externalSource, t.externalId).where(sql`${t.externalId} is not null`),
    // DB-level guards (D17): extensible via new migrations, not enum churn
    check(
      "ck_wtx_type",
      sql`${t.type} in ('DEPOSIT','WITHDRAWAL','TRANSFER','INVEST','SELL','DIVIDEND','FEE','INTEREST','ADJUSTMENT')`,
    ),
    check("ck_wtx_fees_type", sql`${t.feesType} in ('fixed','pct')`),
    check("ck_wtx_rate_source", sql`${t.rateSource} in ('automatic','manual')`),
    check("ck_wtx_fee_rate_source", sql`${t.feeRateSource} in ('automatic','manual')`),
    check("ck_wtx_amount_nonzero", sql`${t.amount} <> 0 or ${t.type} = 'ADJUSTMENT'`),
  ],
)

/**
 * Global EUR-based daily closes (D20/D25). NOT user-scoped — shared reference
 * data. Availability of distinct currencies here IS the supported-currency
 * registry served publicly as GET /api/currencies (D26).
 */
export const fxRates = walletsSchema.table(
  "fx_rates",
  {
    rateDate: date("rate_date").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    source: text("source").notNull().default("ecb"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rateDate, t.currency] })],
)

/** Singleton bookkeeping row for the daily import job (D20). */
export const fxSyncState = walletsSchema.table("fx_sync_state", {
  id: integer("id").primaryKey().default(1),
  lastRateDate: date("last_rate_date"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"),
})

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
 * Portfolio container (D54). Currency is mandatory (422 when missing, D17
 * wallets precedent). base_currency is the display/valuation currency,
 * defaulted from user prefs at creation time (D21b). wallet_id links to the
 * wallets module for cash-movement integration (D57). `externalSource` tags
 * portfolios created by an import source (NULL = manual).
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
    currency: char("currency", { length: 3 }).notNull(),
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("USD"),
    externalSource: text("external_source"),
    walletId: uuid("wallet_id").references(() => wallets.id),
    totalInvested: numeric("total_invested", { precision: 20, scale: 8 }).notNull().default("0"),
    currentValue: numeric("current_value", { precision: 20, scale: 8 }).notNull().default("0"),
    isPublic: boolean("is_public").notNull().default(false),
    isMarginEnabled: boolean("is_margin_enabled").notNull().default(false),
    marginRate: numeric("margin_rate", { precision: 9, scale: 4 }),
    maintenanceMarginRate: numeric("maintenance_margin_rate", { precision: 9, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_portfolios_user").on(t.userId)],
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
    walletId: uuid("wallet_id").references(() => wallets.id),
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
 * quantities, cost basis, and realized P/L. Denormalized user_id for direct
 * authorization (D24). Wallet integration columns for paired cash rows (D57).
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
    walletId: uuid("wallet_id").references(() => wallets.id),
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
    cumulativeTwr: numeric("cumulative_twr", { precision: 20, scale: 8 }),
    cumulativeMwr: numeric("cumulative_mwr", { precision: 20, scale: 8 }),
    cumulativeSimple: numeric("cumulative_simple", { precision: 20, scale: 8 }),
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

/** Many-to-many: label -> wallet transaction (D65). */
export const walletTransactionLabels = portfoliosSchema.table(
  "wallet_transaction_labels",
  {
    walletTransactionId: uuid("wallet_transaction_id")
      .notNull()
      .references(() => walletTransactions.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.walletTransactionId, t.labelId] }),
    index("idx_wallet_transaction_labels_label").on(t.labelId),
  ],
)
