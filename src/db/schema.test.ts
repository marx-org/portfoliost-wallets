import { describe, expect, it } from "vitest"
import { eq, sql } from "drizzle-orm"
import { createTestDb } from "./test-db.js"
import {
  walletsSchema, syncRuns,
  portfoliosSchema, portfolios, positions, positionPortfolios, portfolioTransactions,
  portfolioCashTransactions, portfolioCashTransactionLabels, shares, valueSnapshots,
  labels,
} from "./schema.js"
import { insertPosition } from "../routes/test-utils.js"
import { positionInPortfolio } from "./position-membership.js"
import {
  POSITION_TX_TYPES, TRADE_CASH_TYPES, TRANSFER_TX_TYPES, isTradeCashType,
} from "../transaction-types.js"
import { TransactionCreateSchema } from "../routes/portfolio-transactions.js"
import { ImportPortfolioTxSchema } from "../routes/import.js"

// Asserts a table and every one of its remaining columns carry a PostgreSQL
// comment, and that the table comment explains the table's purpose (matches a
// regex) rather than being a bare placeholder. `table` is a trusted constant.
async function expectDocumented(table: string, purpose: RegExp) {
  const { db } = await createTestDb()
  const t = await db.execute(
    sql`select obj_description(('portfolios.' || ${table})::regclass, 'pg_class') as c`,
  )
  const doc = String((t.rows[0] as any).c ?? "")
  expect(doc, `${table} table comment`).toBeTruthy()
  expect(doc).toMatch(purpose)
  const missing = await db.execute(sql`
    select column_name from information_schema.columns
    where table_schema = 'portfolios' and table_name = ${table}
      and col_description(('portfolios.' || ${table})::regclass, ordinal_position) is null
  `)
  expect(missing.rows, `${table} columns missing a comment`).toEqual([])
}

describe("wallets schema (sync_runs only, §62)", () => {
  it("keeps the dedicated pg schema via migrations (sync_runs home)", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`select nspname from pg_namespace where nspname = 'wallets'`)
    expect(rows.rows.length).toBe(1)
    const names = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'wallets'`,
    )
    expect(names.rows.map((r: any) => r.table_name)).toContain("sync_runs")
    // §62: the wallet tables are gone
    expect(names.rows.map((r: any) => r.table_name)).not.toContain("wallets")
    expect(names.rows.map((r: any) => r.table_name)).not.toContain("wallet_transactions")
  })

  it("sync_runs enforces the (user, source, spreadsheetId, sheet) unique key", async () => {
    const { db } = await createTestDb()
    const run = {
      userId: "u",
      externalSource: "google-sheets:transakcje",
      spreadsheetId: "1id",
      sheet: "Transakcje",
    }
    await db.insert(syncRuns).values(run)
    await expect(db.insert(syncRuns).values(run)).rejects.toThrow(/duplicate key|Failed query/u)
  })

  it("documents sync_runs with a table comment (obj_description)", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(
      sql`select obj_description('wallets.sync_runs'::regclass) as description`,
    )
    const description = String((rows.rows[0] as any).description ?? "")
    // the comment must explain the purpose, not just be non-empty
    expect(description).toMatch(/import/i)
    expect(description).toMatch(/cash-transaction count/i)
    expect(description).toMatch(/portfolio trade-transaction count/i)
    expect(description).toMatch(/skipped/i)
    expect(description).toMatch(/lifecycle status/i)
  })
})

describe("portfolios cash schema (§62)", () => {
  it("inserts a portfolio with defaults (baseCurrency only)", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "Top10", baseCurrency: "USD" })
      .returning()
    expect(p.name).toBe("Top10")
    expect(p.baseCurrency).toBe("USD")
    expect(Number(p.totalInvested)).toBe(0)
    expect(p.isPublic).toBe(false)
  })

  it("documents portfolios: table + every remaining column comment", async () => {
    const { db } = await createTestDb()
    const table = await db.execute(
      sql`select obj_description('portfolios.portfolios'::regclass) as d`,
    )
    expect(String((table.rows[0] as any).d)).toMatch(/portfolio container/i)

    const cols = await db.execute(sql`
      select a.attname, col_description('portfolios.portfolios'::regclass, a.attnum) as d
      from pg_attribute a
      where a.attrelid = 'portfolios.portfolios'::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `)
    const described = cols.rows.map((r: any) => String(r.d) ?? "")
    // every remaining column carries a meaningful (non-empty) description
    expect(described.length).toBeGreaterThan(0)
    for (const d of described) expect(d.length).toBeGreaterThan(0)
  })

  it("dropped strategy/type/margin columns are gone", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'portfolios'
    `)
    const names = rows.rows.map((r: any) => r.column_name)
    expect(names).not.toContain("strategy")
    expect(names).not.toContain("type")
    expect(names).not.toContain("margin_rate")
    expect(names).not.toContain("maintenance_margin_rate")
  })

  it("documents portfolio_cash_transactions: table + every remaining column comment", async () => {
    const { db } = await createTestDb()
    const table = await db.execute(
      sql`select obj_description('portfolios.portfolio_cash_transactions'::regclass) as d`,
    )
    expect(String((table.rows[0] as any).d)).toMatch(/cash ledger/i)

    const cols = await db.execute(sql`
      select a.attname, col_description('portfolios.portfolio_cash_transactions'::regclass, a.attnum) as d
      from pg_attribute a
      where a.attrelid = 'portfolios.portfolio_cash_transactions'::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum
    `)
    const described = cols.rows.map((r: any) => String(r.d) ?? "")
    // every remaining column carries a meaningful (non-empty) description
    expect(described.length).toBeGreaterThan(0)
    for (const d of described) expect(d.length).toBeGreaterThan(0)
  })

  it("dropped cash-ledger status/payment_method columns are gone", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'portfolio_cash_transactions'
    `)
    const names = rows.rows.map((r: any) => r.column_name)
    expect(names).not.toContain("status")
    expect(names).not.toContain("payment_method")
  })

  it("inserts a portfolio cash transaction with fx columns", async () => {
    const { db } = await createTestDb()
    const [p] = await db.insert(portfolios).values({ userId: "u", name: "P", baseCurrency: "USD" }).returning()
    const [tx] = await db
      .insert(portfolioCashTransactions)
      .values({
        userId: "u",
        portfolioId: p.id,
        type: "TRANSFER",
        amount: "-43.00000000",
        currency: "EUR",
        fees: "2.5",
        feesType: "fixed",
        feeCurrency: "USD",
        rateSource: "manual",
        exchangeRate: "1.0810000000",
        feeRateSource: "automatic",
        transferFxRate: "1.0834000000",
        targetAmount: "46.58000000",
      })
      .returning()
    expect(tx.rateSource).toBe("manual")
    expect(tx.feeRateSource).toBe("automatic")
    expect(Number(tx.amount)).toBe(-43)
    expect(Number(tx.targetAmount)).toBeCloseTo(46.58, 6)
  })

  it("rejects unknown transaction types and fee types", async () => {
    const { db } = await createTestDb()
    const [p] = await db.insert(portfolios).values({ userId: "u", name: "P", baseCurrency: "USD" }).returning()
    await expect(
      db.insert(portfolioCashTransactions).values({
        userId: "u",
        portfolioId: p.id,
        type: "ROBBERY" as never,
        amount: "1",
        currency: "USD",
      }),
    ).rejects.toThrow()
    await expect(
      db.insert(portfolioCashTransactions).values({
        userId: "u",
        portfolioId: p.id,
        type: "DEPOSIT",
        amount: "1",
        currency: "USD",
        feesType: "percent" as never,
      }),
    ).rejects.toThrow()
  })

  it("requires a non-zero amount", async () => {
    const { db } = await createTestDb()
    const [p] = await db.insert(portfolios).values({ userId: "u", name: "P", baseCurrency: "USD" }).returning()
    await expect(
      db.insert(portfolioCashTransactions).values({
        userId: "u",
        portfolioId: p.id,
        type: "DEPOSIT",
        amount: "0",
        currency: "PLN",
      }),
    ).rejects.toThrow()
  })

  it("partial unique index rejects duplicate external_id but allows NULL duplicates", async () => {
    const { db } = await createTestDb()
    const [p] = await db.insert(portfolios).values({ userId: "u", name: "P", baseCurrency: "USD", externalSource: "src" }).returning()
    const base = {
      userId: "u",
      portfolioId: p.id,
      type: "DEPOSIT" as const,
      amount: "-100",
      currency: "USD",
      externalSource: "google-sheets:transakcje",
      externalId: "sha-1",
    }
    await db.insert(portfolioCashTransactions).values(base)
    await expect(db.insert(portfolioCashTransactions).values(base)).rejects.toThrow(/duplicate key|Failed query/u)
    await db.insert(portfolioCashTransactions).values({ ...base, externalId: "sha-2" })
    await db.insert(portfolioCashTransactions).values({ ...base, externalId: null })
    await db.insert(portfolioCashTransactions).values({ ...base, externalId: null })
  })

  it("cascades labels when a cash transaction is deleted", async () => {
    const { db } = await createTestDb()
    const [p] = await db.insert(portfolios).values({ userId: "u", name: "P", baseCurrency: "USD" }).returning()
    const [label] = await db
      .insert(labels)
      .values({ userId: "u", name: "L", color: "#000000" })
      .returning()
    const [tx] = await db
      .insert(portfolioCashTransactions)
      .values({ userId: "u", portfolioId: p.id, type: "DEPOSIT", amount: "10", currency: "USD" })
      .returning()
    await db.insert(portfolioCashTransactionLabels).values({ cashTransactionId: tx.id, labelId: label.id })

    await db.delete(portfolioCashTransactions).where(sql`${portfolioCashTransactions.id} = ${tx.id}`)

    const rows = await db.select().from(portfolioCashTransactionLabels)
    expect(rows.length).toBe(0)
  })
})

describe("portfolios schema (§15, D54)", () => {
  it("creates the dedicated portfolios pg schema via migrations", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`select nspname from pg_namespace where nspname = 'portfolios'`)
    expect(rows.rows.length).toBe(1)
  })

  it("cascades delete from portfolio to transactions, cash txs, shares, snapshots; positions keep rows but lose membership", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "P", baseCurrency: "USD" })
      .returning()
    await insertPosition(db, {
      userId: "user-a", portfolioId: p.id, symbol: "X",
    })
    await db.insert(portfolioTransactions).values({
      userId: "user-a", portfolioId: p.id, type: "BUY",
      quantity: "1", price: "1", currency: "USD", totalAmount: "1",
    })
    await db.insert(portfolioCashTransactions).values({
      userId: "user-a", portfolioId: p.id, type: "DEPOSIT",
      amount: "10", currency: "USD",
    })
    await db.insert(shares).values({
      userId: "user-a", portfolioId: p.id,
      privacySettings: {},
    })
    await db.insert(valueSnapshots).values({
      portfolioId: p.id, snapshotDate: "2026-01-01",
      value: "0", invested: "0",
    })

    await db.delete(portfolios).where(sql`${portfolios.id} = ${p.id}`)

    // #115 — ownership is the `position_portfolios` row: it cascades with the
    // portfolio, while the normalized position row itself survives (the delete
    // route removes now-orphaned positions at the application layer).
    expect((await db.select().from(positionPortfolios).where(eq(positionPortfolios.portfolioId, p.id))).length).toBe(0)
    expect((await db.select().from(positions).where(eq(positions.userId, "user-a"))).length).toBe(1)
    expect((await db.select().from(portfolioTransactions).where(sql`${portfolioTransactions.portfolioId} = ${p.id}`)).length).toBe(0)
    expect((await db.select().from(portfolioCashTransactions).where(sql`${portfolioCashTransactions.portfolioId} = ${p.id}`)).length).toBe(0)
    expect((await db.select().from(shares).where(sql`${shares.portfolioId} = ${p.id}`)).length).toBe(0)
    expect((await db.select().from(valueSnapshots).where(sql`${valueSnapshots.portfolioId} = ${p.id}`)).length).toBe(0)
  })

  it("enforces user-scoped isolation via index (authorization at query level)", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "A", baseCurrency: "USD" })
      .returning()
    await insertPosition(db, {
      userId: "user-a", portfolioId: p.id, symbol: "AAPL",
    })
    const rows = await db.select().from(positions).where(sql`${positions.userId} = 'user-a'`)
    expect(rows.length).toBe(1)
    const empty = await db.select().from(positions).where(sql`${positions.userId} = 'user-b'`)
    expect(empty.length).toBe(0)
  })
})

describe("the transaction type set cannot drift from the SQL check", () => {
  // The set was once declared in five places and the declarations disagreed:
  // EXPIRATION reached the import route and the database but never the
  // interactive create route, which then rejected a type the importer accepted.
  // That was found by reading code, not by a failing test. Reading the live
  // constraint out of Postgres and comparing it to the exported array is what
  // turns the next omission into a build failure.

  async function constraintValues(name: string): Promise<string[]> {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`
      select pg_get_constraintdef(oid) as def
      from pg_constraint
      where conname = ${name}
    `)
    expect(rows.rows.length).toBe(1)
    const def = String((rows.rows[0] as any).def)
    // Postgres rewrites the definition on read: it may render
    // `type in ('BUY'::text, ...)` or `type = ANY (ARRAY['BUY'::text, ...])`
    // depending on how the predicate was written. Pulling the quoted literals
    // is stable across both, and these checks quote nothing else.
    const values = [...def.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(values.length, `could not read the value list out of ${def}`).toBeGreaterThan(0)
    return values
  }

  it("ck_ptx_type declares exactly POSITION_TX_TYPES, in order", async () => {
    expect(await constraintValues("ck_ptx_type")).toEqual([...POSITION_TX_TYPES])
  })

  it("every Zod route enum is the full set, so no route rejects a valid type", async () => {
    // The specific regression: portfolio-transactions.ts offered
    // BUY/SELL/DIVIDEND while the import offered those plus EXPIRATION.
    const base = {
      symbol: "AAPL", quantity: 1, price: 1, currency: "USD",
    }
    for (const value of POSITION_TX_TYPES) {
      expect(
        TransactionCreateSchema.safeParse({ ...base, type: value }).success,
        `the interactive create route rejects ${value}`,
      ).toBe(true)
    }
    expect(TransactionCreateSchema.safeParse({ ...base, type: "NONSENSE" }).success).toBe(false)

    const importBase = {
      portfolioId: "8d1f1a3e-0000-4000-8000-000000000000",
      instrumentSymbol: "AAPL", quantity: 1, price: 1, currency: "USD",
    }
    for (const value of POSITION_TX_TYPES) {
      const parsed = ImportPortfolioTxSchema.safeParse({ ...importBase, type: value })
      // TRANSFER_OUT additionally requires toPortfolioName; asserted separately
      // in import.test.ts against the resolved portfolio name.
      expect(parsed.success || value === "TRANSFER_OUT", `the import route rejects ${value}`).toBe(true)
    }
    expect(ImportPortfolioTxSchema.safeParse({ ...importBase, type: "NONSENSE" }).success).toBe(false)
  })

  it("a transfer is not in TRADE_CASH_TYPES — stock changing custody is not a payment", () => {
    for (const value of TRANSFER_TX_TYPES) {
      expect(isTradeCashType(value)).toBe(false)
    }
    // EXPIRATION closes a position for nothing, so it is absent too. It was
    // added to the check constraint and the import enum while the ledger's
    // cash-effect list stayed a separate hand-written literal.
    expect(isTradeCashType("EXPIRATION")).toBe(false)
    expect([...TRADE_CASH_TYPES]).toEqual(["BUY", "SELL", "DIVIDEND"])
  })
})

describe("positions many-to-many membership (#115)", () => {
  it("drops the single-owner column and the position-level fee columns", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'positions'
    `)
    const names = rows.rows.map((r: any) => r.column_name)
    expect(names).not.toContain("portfolio_id")
    expect(names).not.toContain("fees")
    expect(names).not.toContain("fees_type")
    expect(names).not.toContain("fee_currency")
    for (const kept of [
      "contract_size", "is_open", "opened_at", "closed_at",
      "market_value", "day_change", "day_change_percent",
    ]) {
      expect(names, `${kept} must survive the normalization`).toContain(kept)
    }
  })

  it("drops the position fee-type check constraint with its columns", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`select conname from pg_constraint where conname = 'ck_positions_fees_type'`)
    expect(rows.rows.length).toBe(0)
  })

  it("creates position_portfolios with a composite key and cascade FKs", async () => {
    const { db } = await createTestDb()
    const cols = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'position_portfolios'
      order by column_name
    `)
    expect(cols.rows.map((r: any) => r.column_name)).toEqual(["portfolio_id", "position_id"])
    const pk = await db.execute(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'position_portfolios_position_id_portfolio_id_pk'
    `)
    expect(pk.rows.length).toBe(1)
    const fks = await db.execute(sql`
      select conname from pg_constraint
      where conrelid = 'portfolios.position_portfolios'::regclass and contype = 'f'
    `)
    expect(fks.rows.map((r: any) => r.conname).sort()).toEqual([
      "position_portfolios_portfolio_id_portfolios_id_fk",
      "position_portfolios_position_id_positions_id_fk",
    ])
  })

  it("lets one position belong to two portfolios and be read from both", async () => {
    const { db } = await createTestDb()
    const [a] = await db.insert(portfolios).values({ userId: "u", name: "A", baseCurrency: "USD" }).returning()
    const [b] = await db.insert(portfolios).values({ userId: "u", name: "B", baseCurrency: "USD" }).returning()
    const [pos] = await db.insert(positions).values({ userId: "u", symbol: "AAPL" }).returning()
    await db.insert(positionPortfolios).values([
      { positionId: pos.id, portfolioId: a.id },
      { positionId: pos.id, portfolioId: b.id },
    ])
    const inA = await db.select().from(positions).where(positionInPortfolio(a.id))
    const inB = await db.select().from(positions).where(positionInPortfolio(b.id))
    expect(inA.map((p) => p.id)).toEqual([pos.id])
    expect(inB.map((p) => p.id)).toEqual([pos.id])
  })

  it("documents the positions table and every one of its columns", async () => {
    const { db } = await createTestDb()
    const table = await db.execute(sql`select obj_description('portfolios.positions'::regclass, 'pg_class') as c`)
    expect((table.rows[0] as any).c).toBeTruthy()
    const missing = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'positions'
        and col_description('portfolios.positions'::regclass, ordinal_position) is null
    `)
    expect(missing.rows).toEqual([])
  })

  it("documents the position_portfolios table and both of its columns", async () => {
    const { db } = await createTestDb()
    const table = await db.execute(sql`select obj_description('portfolios.position_portfolios'::regclass, 'pg_class') as c`)
    expect((table.rows[0] as any).c).toBeTruthy()
    const missing = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'position_portfolios'
        and col_description('portfolios.position_portfolios'::regclass, ordinal_position) is null
    `)
    expect(missing.rows).toEqual([])
  })
})

describe("#116 — transactions derive display currency and metadata elsewhere", () => {
  it("drops the six denormalised columns from transactions", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'transactions'
    `)
    const names = rows.rows.map((r: any) => r.column_name)
    for (const gone of ["sector", "industry", "country", "display_currency", "is_gift", "synthesized_opening_lot"]) {
      expect(names).not.toContain(gone)
    }
    // The columns that still carry first-class data must remain.
    for (const kept of [
      "transfer_group_id", "quantity", "original_quantity", "price",
      "converted_total_amount", "converted_price", "exchange_rate",
    ]) {
      expect(names).toContain(kept)
    }
  })

  it("documents the transactions table and every remaining column", async () => {
    const { db } = await createTestDb()
    const table = await db.execute(sql`select obj_description('portfolios.transactions'::regclass, 'pg_class') as c`)
    const doc = String((table.rows[0] as any).c ?? "")
    // The table comment must explain the move away from denormalised metadata.
    expect(table.rows[0].c ?? null).toBeTruthy()
    expect(table.rows[0].c).toMatch(/position|base currency/i)
    const missing = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'transactions'
        and col_description('portfolios.transactions'::regclass, ordinal_position) is null
    `)
    expect(missing.rows).toEqual([])
  })
})

describe("#117 — split_events documentation", () => {
  it("documents the split_events table and every one of its columns", async () => {
    const { db } = await createTestDb()
    const table = await db.execute(sql`select obj_description('portfolios.split_events'::regclass, 'pg_class') as c`)
    const doc = String((table.rows[0] as any).c ?? "")
    expect(doc).toBeTruthy()
    // The comment must explain what the ledger is for, not just be non-empty.
    expect(doc).toMatch(/split/i)
    expect(doc).toMatch(/quantity/i)
    const missing = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'split_events'
        and col_description('portfolios.split_events'::regclass, ordinal_position) is null
    `)
    expect(missing.rows).toEqual([])
  })
})

describe("#118 — shares documentation", () => {
  it("documents the shares table and every one of its columns", async () => {
    const { db } = await createTestDb()
    const table = await db.execute(sql`select obj_description('portfolios.shares'::regclass, 'pg_class') as c`)
    const doc = String((table.rows[0] as any).c ?? "")
    expect(doc).toBeTruthy()
    // The comment must explain what the table is for, not just be non-empty.
    expect(doc).toMatch(/share/i)
    const missing = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'shares'
        and col_description('portfolios.shares'::regclass, ordinal_position) is null
    `)
    expect(missing.rows).toEqual([])
  })
})

describe("#119 — value_snapshots documentation", () => {
  it("documents the value_snapshots table and every one of its columns", async () => {
    const { db } = await createTestDb()
    const table = await db.execute(sql`select obj_description('portfolios.value_snapshots'::regclass, 'pg_class') as c`)
    const doc = String((table.rows[0] as any).c ?? "")
    expect(doc).toBeTruthy()
    // The comment must explain what the table is for, not just be non-empty.
    expect(doc).toMatch(/snapshot/i)
    const missing = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'portfolios' and table_name = 'value_snapshots'
        and col_description('portfolios.value_snapshots'::regclass, ordinal_position) is null
    `)
    expect(missing.rows).toEqual([])
  })
})

describe("#120 — portfolio_backfill_metadata documentation", () => {
  it("documents the table and every one of its columns", async () => {
    await expectDocumented("portfolio_backfill_metadata", /backfill/i)
  })
})
