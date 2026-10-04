import { describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "./test-db.js"
import {
  walletsSchema, syncRuns,
  portfoliosSchema, portfolios, positions, portfolioTransactions,
  portfolioCashTransactions, portfolioCashTransactionLabels, shares, valueSnapshots,
  labels,
} from "./schema.js"
import {
  POSITION_TX_TYPES, TRADE_CASH_TYPES, TRANSFER_TX_TYPES, isTradeCashType,
} from "../transaction-types.js"
import { TransactionCreateSchema } from "../routes/portfolio-transactions.js"
import { ImportPortfolioTxSchema } from "../routes/import.js"

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
    expect(p.strategy).toBe("GROWTH")
    expect(p.type).toBe("regular")
    expect(Number(p.totalInvested)).toBe(0)
    expect(p.isPublic).toBe(false)
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

  it("cascades delete from portfolio to positions, transactions, cash txs, shares, snapshots", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "P", baseCurrency: "USD" })
      .returning()
    await db.insert(positions).values({
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

    expect((await db.select().from(positions).where(sql`${positions.portfolioId} = ${p.id}`)).length).toBe(0)
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
    await db.insert(positions).values({
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
