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
import { POSITION_TX_TYPES } from "../transaction-types.js"
import { check } from "drizzle-orm/pg-core"

const TX_TYPES = ["DEPOSIT", "WITHDRAWAL", "TRANSFER"] as const

// Inlined, not parameterised: a CHECK constraint cannot contain bind
// parameters, so `sql.join` would emit `$1, $2, ...` and Postgres rejects it
// with "there is no parameter $1". These are compile-time constants from a
// `as const` array, never user input, so raw interpolation is safe here.
const positionTxTypeIn = sql.raw(POSITION_TX_TYPES.map((v) => `'${v}'`).join(","))

// D16/D24 — schema-per-module
// §62 — the wallets schema is kept for sync_runs only; cash moved to
// portfolios.portfolio_cash_transactions (derived-by-replay, no stored balances).
export const walletsSchema = pgSchema("wallets")

/**
 * Import sync-run tracking (import API). One row per (user, externalSource,
 * spreadsheetId, sheet) — the importer cursor + batch counters over the
 * /api/import surface.
 *
 * Records each user's external spreadsheet import: the source, the
 * spreadsheet/sheet identity, the import progress (`lastRow`), the lifecycle
 * `status` (pending|running|done|failed), the start/completion timestamps, the
 * `error` text when a run failed, and the per-run counters — how many portfolio
 * cash transactions (`insertedCashTransactions`), how many portfolio trade
 * transactions (`insertedPtx`), and how many rows were skipped (`skipped`).
 *
 * This table has NO `description` data column: the purpose lives in the table
 * comment (obj_description), not in a column.
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
    insertedCashTransactions: integer("inserted_cash_transactions").notNull().default(0),
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
 * Portfolio container (D54) — the unit a user organizes holdings around.
 *
 * Ownership: one row per (userId, name) — the `uq_portfolios_user_name` natural
 * key doubles as the import bootstrap's idempotency key (§23.3). A portfolio
 * owns its cash natively (§62: `currency`/`wallet_id` dropped); the per-currency
 * ledger lives in portfolio_cash_transactions.
 *
 * base_currency is the display/valuation currency (D21b), defaulted from user
 * prefs at creation; total_invested (the capital BASIS) and current_value are
 * both denominated in base_currency. is_public toggles the public share
 * projection; is_margin_enabled suppresses the negative-cash warning in the cash
 * UI. external_source tags portfolios created by an import (NULL = manual).
 *
 * The strategy, type, and numeric margin-rate columns were dropped (#113): no
 * strategy selection, portfolio type, or numeric margin calculation is served.
 */
export const portfolios = portfoliosSchema.table(
  "portfolios",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    // free-text blurb shown on the portfolio card/detail; NULL for most.
    description: text("description"),
    // display + valuation currency (D21b); total_invested/current_value are in it.
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("USD"),
    // tags portfolios created by an import source (NULL = manual); see import §23.3.
    externalSource: text("external_source"),
    // capital BASIS in base_currency: net external contributions + in-kind cost.
    totalInvested: numeric("total_invested", { precision: 20, scale: 8 }).notNull().default("0"),
    // live market valuation in base_currency (instruments + cash).
    currentValue: numeric("current_value", { precision: 20, scale: 8 }).notNull().default("0"),
    // toggles the auth-exempt public share projection.
    isPublic: boolean("is_public").notNull().default(false),
    /**
     * §87.5 — UI-only. Pre-ticks the transaction form's "also create a cash
     * transaction" box so it reflects what will actually happen.
     *
     * It does NOT govern the sheet import: that path uses its own hardcoded kontо
     * list in portfoliost-sheets-sync (`ALWAYS_CASH_LEG`), and an imported AU=0
     * trade on a portfolio with this flag ON still imports with no cash row. Two
     * independent mechanisms on purpose — the spreadsheet's col 47 keeps its
     * meaning for every account the list does not govern.
     *
     * Default `false` so no existing account changes behaviour on deploy.
     */
    cashLegOnTrade: boolean("cash_leg_on_trade").notNull().default(false),
    // the flag PortfolioCashTab.vue uses to suppress the negative-cash warning;
    // margin accounts are expected to run a negative cash balance.
    isMarginEnabled: boolean("is_margin_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // bumped on every portfolio mutation (name/currency/flags).
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_portfolios_user").on(t.userId),
    // natural key for import bootstrap idempotency (import API §23.3)
    uniqueIndex("uq_portfolios_user_name").on(t.userId, t.name),
  ],
)

/**
 * Portfolio-owned cash ledger (plan §62) — the external cash rows for one
 * portfolio: deposits, withdrawals and transfers. The portfolio owns its cash
 * as a per-currency ledger and its balances are DERIVED by replay of these rows
 * plus the portfolio trade rows (BUY/SELL/DIVIDEND cash effects); no balance is
 * stored. Amounts are signed in the ROW's currency (DEPOSIT +, WITHDRAWAL −,
 * TRANSFER as sent). Cross-currency transfers store both legs linked via
 * `linkedTxId` plus `transferFxRate` (D22, portfolio-scoped).
 *
 * Provenance: `externalSource` + `externalId` tag imported rows and are the
 * import idempotency key; `reference` correlates a row to its source
 * transaction / import row (or, for a manual transfer, a human-readable
 * transfer reference). Manually created rows leave the external fields NULL.
 */
export const portfolioCashTransactions = portfoliosSchema.table(
  "portfolio_cash_transactions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // denormalized owner (D24): direct authorization on every tx operation
    userId: text("user_id").notNull(),
    // owning portfolio; deleting the portfolio cascades to its ledger rows
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    // cash event kind: DEPOSIT | WITHDRAWAL | TRANSFER
    type: text("type", { enum: TX_TYPES }).notNull(),
    // signed in the row's own currency: DEPOSIT +, WITHDRAWAL −, TRANSFER as sent
    amount: numeric("amount", { precision: 28, scale: 8 }).notNull(),
    // the row's own currency (ISO-4217), independent of the portfolio base
    currency: char("currency", { length: 3 }).notNull(),
    // free-text note shown on the cash row
    description: text("description"),
    // user-facing date of the cash event (nullable for "today" rows)
    transactionDate: date("transaction_date"),
    // fee amount, denominated in fee_currency
    fees: numeric("fees", { precision: 20, scale: 8 }),
    // how the fee was expressed: a fixed amount or a percentage of the principal
    feesType: text("fees_type", { enum: ["fixed", "pct"] }),
    // currency the fee was paid in (ISO-4217); null when there is no fee
    feeCurrency: char("fee_currency", { length: 3 }),
    // TRANSFER destination portfolio (null for non-transfer rows)
    toPortfolioId: uuid("to_portfolio_id").references(() => portfolios.id, { onDelete: "cascade" }),
    // the paired cash leg for a cross-currency transfer (D22); null otherwise
    linkedTxId: uuid("linked_tx_id"),
    /**
     * §87.2 — the TRADE this cash leg belongs to (a `#d` deposit funding a buy, a
     * `#w` withdrawal taking out sell proceeds). Nullable on purpose: AU=0 trades
     * and hand-written `Wpłata`/`Wypłata` have no trade and stay NULL.
     *
     * The key is on the cash row, NOT on the trade, so both deletes work with no
     * application logic: `ON DELETE CASCADE` takes the cash leg when the trade
     * goes, and deleting the cash row leaves the trade alone because the link
     * *was* the row. Distinct from {@link linkedTxId}, which is the cash↔cash
     * transfer pair (D22).
     */
    linkedTradeId: uuid("linked_trade_id").references(() => portfolioTransactions.id, {
      onDelete: "cascade",
    }),
    // source-row correlation: for imported rows the base source transaction /
    // import-row id; for a manual transfer a human-readable transfer reference
    reference: text("reference"),
    // FX rate applied to the row currency against the portfolio base
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }),
    // whether exchangeRate came from the FX service or was set by hand
    rateSource: text("rate_source", { enum: ["automatic", "manual"] })
      .notNull()
      .default("automatic"),
    // whether feeExchangeRate came from the FX service or was set by hand
    feeRateSource: text("fee_rate_source", { enum: ["automatic", "manual"] })
      .notNull()
      .default("automatic"),
    // FX rate applied to the fee currency against the portfolio base
    feeExchangeRate: numeric("fee_exchange_rate", { precision: 20, scale: 10 }),
    // cross-currency transfer rate between the two legs (D22)
    transferFxRate: numeric("transfer_fx_rate", { precision: 20, scale: 10 }),
    // D22 elastic target leg: the destination-side amount, server-computed when omitted
    targetAmount: numeric("target_amount", { precision: 20, scale: 8 }),
    // import provenance tag for imported rows (NULL = created manually)
    externalSource: text("external_source"),
    // importer-supplied dedup key; unique per externalSource (idempotency)
    externalId: text("external_id"),
    // row creation timestamp
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // bumped on every ledger-row mutation
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_pctx_portfolio").on(t.portfolioId, t.transactionDate),
    index("idx_pctx_user_recent").on(t.userId, t.createdAt.desc()),
    index("portfolio_cash_transactions_linked_trade_id_idx").on(t.linkedTradeId),
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
    // In-kind transfer bookkeeping. A transfer is several rows — one per source
    // lot drawn FIFO — so `linked_transfer_id` pairs a TRANSFER_OUT with its
    // derived TRANSFER_IN while `transfer_group_id` ties the whole transfer
    // together and makes it one atomic unit.
    linkedTransferId: uuid("linked_transfer_id"),
    transferGroupId: uuid("transfer_group_id"),
    // The BUY a TRANSFER_OUT drew its quantity and price from. No FK and no
    // cascade on purpose: deleting a source BUY must not silently delete a
    // transfer that already moved real stock between brokers.
    sourceTransactionId: uuid("source_transaction_id"),
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
    index("idx_ptx_transfer_group").on(t.transferGroupId),
    uniqueIndex("uq_ptx_external").on(t.externalSource, t.externalId).where(sql`${t.externalId} is not null`),
    check("ck_ptx_type", sql`${t.type} in (${positionTxTypeIn})`),
    check(
      "ck_ptx_transfer_out_source",
      sql`${t.type} <> 'TRANSFER_OUT' or ${t.sourceTransactionId} is not null`,
    ),
    check(
      "ck_ptx_transfer_in_linked",
      sql`${t.type} <> 'TRANSFER_IN' or ${t.linkedTransferId} is not null`,
    ),
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
    // §78.5 — base-currency COST of positions held on this day that have no
    // price. `value` already excludes them, so this is the only place the
    // withheld amount exists. default 0 rather than nullable: a row written
    // before this column existed had no unpriced positions recorded, and reading
    // that as "worth 0 unpriced" would be the opposite of true for exactly the
    // portfolios that need it — so existing rows are backfilled by the next
    // recompute, and readers should treat a pre-migration row as unknown.
    unpricedValue: numeric("unpriced_value", { precision: 20, scale: 8 }).notNull().default("0"),
    // §72.31 — cost of positions priced from a CARRIED-FORWARD close on a day
    // the market was open. Separate from `unpriced_value` because carry-forward
    // means the grid HAS a price, so `unpriced_value` is structurally blind to it:
    // PROD reported Crypto with `gapSymbols: ["BTC-USD"]`, 24 counted coverage
    // days, and `unpriced_value` of 0 on all 1,690 days.
    //
    // Closures are excluded, so this is not ~29% of every series the way raw
    // carry-forward would be.
    carriedValue: numeric("carried_value", { precision: 20, scale: 8 }).notNull().default("0"),
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
    // §63.8 — symbols the latest backfill pass held (qty > 0 on the window's
    // last day) but had NO price bar for → the stored value is a *partial*
    // sum (silently under-reported). null/absent = every held symbol priced.
    //
    // §72.30 — WINDOW-WIDE, not last-day. It is the report for the *history*:
    // a symbol held in 2022 with no bar then, and sold since, still belongs in
    // it. That is why it is NOT the field a UI uses to say "the value you are
    // looking at is short" — see `heldGapSymbols`.
    gapSymbols: text("gap_symbols").array(),
    // §72.30 — the subset of `gapSymbols` still held on the window's last day.
    // Non-empty means the LATEST stored point is itself a partial sum.
    //
    // Split out because the two claims were one field and PROD showed the cost:
    // the SPA rendered "Value excludes 7 positions without price history" for
    // IKE Beata on 2026-10-01, whose 7 flagged symbols were all CLOSED. The
    // current value was complete. A warning that is wrong about the number in
    // front of the user is worse than no warning, because it is believed.
    heldGapSymbols: text("held_gap_symbols").array(),
    // §72.21 — symbol → number of held days on which the price series came back
    // with NO bar. jsonb rather than a second text[] because the useful part is
    // the COUNT, not the membership: a symbol in both this and `gapSymbols` means
    // something different by each, and "N days" is what a UI can state.
    //
    // jsonb, not text[] of "SYM:12": the dates behind these counts can run to
    // thousands over a wide window and are not what this reports.
    //
    // null/absent = no symbol had a hole. Deliberately NOT nullable-to-empty, for
    // the same reason as `gapSymbols`: consumers need to tell "no holes" from
    // "not measured yet" — a row written before this column existed has null while
    // the backfill has certainly run.
    fxCoverageHoles: jsonb("fx_coverage_holes").$type<Record<string, number>>(),
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
