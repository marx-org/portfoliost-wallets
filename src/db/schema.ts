import {
  boolean,
  char,
  date,
  index,
  integer,
  numeric,
  pgSchema,
  primaryKey,
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
 */
export const wallets = walletsSchema.table(
  "wallets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("USD"),
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
    toWalletId: uuid("to_wallet_id").references((): any => walletTransactions.id),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_wtx_wallet").on(t.walletId, t.executedAt.desc()),
    index("idx_wtx_user_recent").on(t.userId, t.executedAt.desc()),
    uniqueIndex("uq_wtx_reference").on(t.reference).where(sql`reference is not null`),
    // DB-level guards (D17): extensible via new migrations, not enum churn
    check(
      "ck_wtx_type",
      sql`${t.type} in ('DEPOSIT','WITHDRAWAL','TRANSFER','INVEST','SELL','DIVIDEND','FEE','INTEREST','ADJUSTMENT')`,
    ),
    check("ck_wtx_fees_type", sql`${t.feesType} in ('fixed','pct')`),
    check("ck_wtx_rate_source", sql`${t.rateSource} in ('automatic','manual')`),
    check("ck_wtx_fee_rate_source", sql`${t.feeRateSource} in ('automatic','manual')`),
    check("ck_wtx_amount_nonzero", sql`${t.amount} <> 0`),
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
