import { describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "./test-db.js"
import {
  walletsSchema, wallets, walletTransactions, syncRuns,
  portfoliosSchema, portfolios, positions, portfolioTransactions, shares, valueSnapshots,
} from "./schema.js"

describe("wallets schema (D17/D24)", () => {
  it("creates the dedicated pg schema via migrations", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`select nspname from pg_namespace where nspname = 'wallets'`)
    expect(rows.rows.length).toBe(1)
  })

  it("inserts a wallet with defaults and mandatory currency", async () => {
    const { db } = await createTestDb()
    const [w] = await db
      .insert(wallets)
      .values({ userId: "user-a", name: "Cash PLN", currency: "PLN" })
      .returning()
    expect(w.currency).toBe("PLN")
    expect(w.baseCurrency).toBe("USD")
    expect(Number(w.balance)).toBe(0)
    expect(w.isDefault).toBe(false)

    // currency is NOT NULL (D18: 422 handled at API level, DB enforces too)
    await expect(
      db.insert(wallets).values({ userId: "user-a", name: "bad", currency: null as never }),
    ).rejects.toThrow()
  })

  it("stores signed ledger rows with fx snapshot columns", async () => {
    const { db } = await createTestDb()
    const [w] = await db
      .insert(wallets)
      .values({ userId: "user-a", name: "W", currency: "USD" })
      .returning()

    const [tx] = await db
      .insert(walletTransactions)
      .values({
        userId: "user-a",
        walletId: w.id,
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
    expect(tx.feeRateSource).toBe("automatic") // column default
    expect(Number(tx.amount)).toBe(-43)
    expect(Number(tx.targetAmount)).toBeCloseTo(46.58, 6)
  })

  it("rejects unknown transaction types and fee types", async () => {
    const { db } = await createTestDb()
    const [w] = await db
      .insert(wallets)
      .values({ userId: "u", name: "W", currency: "USD" })
      .returning()
    await expect(
      db.insert(walletTransactions).values({
        userId: "u",
        walletId: w.id,
        type: "ROBBERY" as never,
        amount: "1",
        currency: "USD",
      }),
    ).rejects.toThrow()
    await expect(
      db.insert(walletTransactions).values({
        userId: "u",
        walletId: w.id,
        type: "DEPOSIT",
        amount: "1",
        currency: "USD",
        feesType: "percent" as never, // contract enum is fixed|pct (D28)
      }),
    ).rejects.toThrow()
  })

  it("enforces the unique reference index for idempotent pushes (D19)", async () => {
    const { db } = await createTestDb()
    const [w] = await db
      .insert(wallets)
      .values({ userId: "u", name: "W", currency: "USD" })
      .returning()
    const base = {
      userId: "u",
      walletId: w.id,
      type: "INVEST" as const,
      amount: "-100",
      currency: "USD",
      reference: "PORTFOLIO_BUY_AAPL.US_abc",
    }
    await db.insert(walletTransactions).values(base)
    await expect(db.insert(walletTransactions).values(base)).rejects.toThrow(/duplicate key|Failed query/u)
  })
})

describe("portfolios schema (§15, D54)", () => {
  it("creates the dedicated portfolios pg schema via migrations", async () => {
    const { db } = await createTestDb()
    const rows = await db.execute(sql`select nspname from pg_namespace where nspname = 'portfolios'`)
    expect(rows.rows.length).toBe(1)
  })

  it("inserts a portfolio with defaults and mandatory currency", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "Top10", currency: "USD" })
      .returning()
    expect(p.name).toBe("Top10")
    expect(p.currency).toBe("USD")
    expect(p.baseCurrency).toBe("USD")
    expect(p.strategy).toBe("GROWTH")
    expect(p.type).toBe("regular")
    expect(Number(p.totalInvested)).toBe(0)
    expect(p.isPublic).toBe(false)

    await expect(
      db.insert(portfolios).values({ userId: "user-a", name: "bad", currency: null as never }),
    ).rejects.toThrow()
  })

  it("inserts a position with FK to portfolio and CHECK constraints", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "P", currency: "USD" })
      .returning()
    const [pos] = await db
      .insert(positions)
      .values({
        userId: "user-a",
        portfolioId: p.id,
        symbol: "AAPL",
        assetType: "STOCK",
        quantity: "10",
        averageCostBasis: "150.00000000",
        instrumentCurrency: "USD",
      })
      .returning()
    expect(pos.symbol).toBe("AAPL")
    expect(Number(pos.quantity)).toBe(10)
    expect(pos.isOpen).toBe(true)

    // direction CHECK constraint
    await expect(
      db.insert(positions).values({
        userId: "user-a",
        portfolioId: p.id,
        symbol: "X",
        direction: "NEUTRAL" as never,
      }),
    ).rejects.toThrow()
  })

  it("inserts a portfolio transaction with CHECK constraints", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "P", currency: "USD" })
      .returning()
    const [pos] = await db
      .insert(positions)
      .values({
        userId: "user-a",
        portfolioId: p.id,
        symbol: "AAPL",
        quantity: "10",
        averageCostBasis: "150",
        instrumentCurrency: "USD",
      })
      .returning()
    const [tx] = await db
      .insert(portfolioTransactions)
      .values({
        userId: "user-a",
        portfolioId: p.id,
        positionId: pos.id,
        type: "BUY",
        instrumentSymbol: "AAPL",
        quantity: "10",
        price: "150.00000000",
        currency: "USD",
        totalAmount: "1500.00000000",
        rateSource: "automatic",
        feeRateSource: "automatic",
        taxes: "30.00000000",
        notes: "dividend remittance note",
      })
      .returning()
    expect(tx.type).toBe("BUY")
    expect(tx.rateSource).toBe("automatic")
    expect(Number(tx.totalAmount)).toBe(1500)
    expect(Number(tx.taxes)).toBe(30)
    expect(tx.notes).toBe("dividend remittance note")

    // type CHECK constraint
    await expect(
      db.insert(portfolioTransactions).values({
        userId: "user-a",
        portfolioId: p.id,
        type: "SWAP" as never,
        quantity: "1",
        price: "1",
        currency: "USD",
        totalAmount: "1",
      }),
    ).rejects.toThrow()
  })

  it("inserts a share with jsonb privacy_settings and enforces FK cascade", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "P", currency: "USD" })
      .returning()
    const [s] = await db
      .insert(shares)
      .values({
        userId: "user-a",
        portfolioId: p.id,
        displayName: "My portfolio",
        privacySettings: { benchmarks: "SPY", showReturns: true },
      })
      .returning()
    expect(s.displayName).toBe("My portfolio")
    expect(s.viewCount).toBe(0)
    expect((s.privacySettings as Record<string, unknown>).benchmarks).toBe("SPY")

    // privacy_settings is NOT NULL
    await expect(
      db.insert(shares).values({
        userId: "user-a",
        portfolioId: p.id,
        privacySettings: null as never,
      }),
    ).rejects.toThrow()
  })

  it("inserts a value snapshot with composite PK", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "P", currency: "USD" })
      .returning()
    const [snap] = await db
      .insert(valueSnapshots)
      .values({
        portfolioId: p.id,
        snapshotDate: "2026-08-01",
        value: "10000.00000000",
        invested: "9000.00000000",
        netFlow: "0",
      })
      .returning()
    expect(Number(snap.value)).toBe(10000)
    expect(Number(snap.netFlow)).toBe(0)

    // composite PK: duplicate (portfolioId, snapshotDate) fails
    await expect(
      db.insert(valueSnapshots).values({
        portfolioId: p.id,
        snapshotDate: "2026-08-01",
        value: "11000",
        invested: "9000",
      }),
    ).rejects.toThrow()
  })

  it("cascades delete from portfolio to positions, transactions, shares, snapshots", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "P", currency: "USD" })
      .returning()
    await db.insert(positions).values({
      userId: "user-a", portfolioId: p.id, symbol: "X",
    })
    await db.insert(portfolioTransactions).values({
      userId: "user-a", portfolioId: p.id, type: "BUY",
      quantity: "1", price: "1", currency: "USD", totalAmount: "1",
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
    expect((await db.select().from(shares).where(sql`${shares.portfolioId} = ${p.id}`)).length).toBe(0)
    expect((await db.select().from(valueSnapshots).where(sql`${valueSnapshots.portfolioId} = ${p.id}`)).length).toBe(0)
  })

  it("enforces user-scoped isolation via index (authorization at query level)", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "user-a", name: "A", currency: "USD" })
      .returning()
    await db.insert(positions).values({
      userId: "user-a", portfolioId: p.id, symbol: "AAPL",
    })

    // Query only user-a's positions
    const rows = await db
      .select()
      .from(positions)
      .where(sql`${positions.userId} = 'user-a'`)
    expect(rows.length).toBe(1)

    // Query user-b sees nothing (D24 pattern)
    const empty = await db
      .select()
      .from(positions)
      .where(sql`${positions.userId} = 'user-b'`)
    expect(empty.length).toBe(0)
  })
})

describe("import API migration (provenance + split columns)", () => {
  it("creates all provenance objects — sync_runs + external_source/external_id/original columns", async () => {
    const { db } = await createTestDb()

    const names = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'wallets' and table_name = 'sync_runs'`,
    )
    expect(names.rows.length).toBe(1)

    const cols = (table: string, schema: string) =>
      db.execute(
        sql`select column_name from information_schema.columns where table_schema = ${schema} and table_name = ${table}`,
      ).then((r) => r.rows.map((row: any) => row.column_name))

    expect(await cols("wallets", "wallets")).toContain("external_source")
    expect(await cols("portfolios", "portfolios")).toContain("external_source")
    expect(await cols("wallet_transactions", "wallets")).toContain("external_source")
    expect(await cols("wallet_transactions", "wallets")).toContain("external_id")
    expect(await cols("transactions", "portfolios")).toContain("external_source")
    expect(await cols("transactions", "portfolios")).toContain("external_id")
    expect(await cols("transactions", "portfolios")).toContain("original_quantity")
    expect(await cols("transactions", "portfolios")).toContain("original_price")
    expect(await cols("transactions", "portfolios")).toContain("notes")
  })

  it("partial unique index rejects duplicate external_id but allows NULL duplicates", async () => {
    const { db } = await createTestDb()
    const [w] = await db
      .insert(wallets)
      .values({ userId: "u", name: "W", currency: "USD", externalSource: "src" })
      .returning()

    const base = {
      userId: "u",
      walletId: w.id,
      type: "INVEST" as const,
      amount: "-100",
      currency: "USD",
      externalSource: "google-sheets:transakcje",
      externalId: "sha-1",
    }
    await db.insert(walletTransactions).values(base)

    // duplicate (external_source, external_id) is rejected
    await expect(db.insert(walletTransactions).values(base)).rejects.toThrow(/duplicate key|Failed query/u)

    // same source, different external_id is fine, and NULL external_id duplicates are allowed
    await db.insert(walletTransactions).values({ ...base, externalId: "sha-2" })
    await db.insert(walletTransactions).values({ ...base, externalId: null })
    await db.insert(walletTransactions).values({ ...base, externalId: null })
  })

  it("original_quantity and original_price are independent of quantity/price (no constraint)", async () => {
    const { db } = await createTestDb()
    const [p] = await db
      .insert(portfolios)
      .values({ userId: "u", name: "P", currency: "USD", externalSource: "src" })
      .returning()

    const [tx] = await db
      .insert(portfolioTransactions)
      .values({
        userId: "u",
        portfolioId: p.id,
        type: "BUY",
        instrumentSymbol: "AMZN",
        quantity: "0.42000000",
        price: "160.00000000",
        originalQuantity: "0.02100000",
        originalPrice: "3200.00000000",
        currency: "USD",
        totalAmount: "67.20000000",
        externalSource: "google-sheets:transakcje",
        externalId: "px-1",
      })
      .returning()
    expect(Number(tx.originalQuantity)).toBe(0.021)
    expect(Number(tx.originalPrice)).toBe(3200)

    await expect(
      db.insert(portfolioTransactions).values({
        userId: "u",
        portfolioId: p.id,
        type: "BUY",
        instrumentSymbol: "AMZN",
        quantity: "1",
        price: "1",
        originalQuantity: "2",
        originalPrice: "3",
        currency: "USD",
        totalAmount: "1",
        externalSource: "google-sheets:transakcje",
        externalId: "px-2",
      }),
    ).resolves.toBeDefined()
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

  it("relaxed amount check allows split markers (ADJUSTMENT with amount 0)", async () => {
    const { db } = await createTestDb()
    const [w] = await db
      .insert(wallets)
      .values({ userId: "u", name: "W", currency: "PLN" })
      .returning()

    const [split] = await db
      .insert(walletTransactions)
      .values({
        userId: "u",
        walletId: w.id,
        type: "ADJUSTMENT",
        amount: "0",
        currency: "PLN",
      })
      .returning()
    expect(split.type).toBe("ADJUSTMENT")

    // non-ADJUSTMENT rows still require a non-zero amount
    await expect(
      db.insert(walletTransactions).values({
        userId: "u",
        walletId: w.id,
        type: "DEPOSIT",
        amount: "0",
        currency: "PLN",
      }),
    ).rejects.toThrow()
  })
})
