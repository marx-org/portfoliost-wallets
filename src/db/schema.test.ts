import { describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "./test-db.js"
import { walletsSchema, wallets, walletTransactions, fxRates, fxSyncState } from "./schema.js"

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

  it("fx tables hold global EUR-based rates and sync bookkeeping", async () => {
    const { db } = await createTestDb()
    await db.insert(fxRates).values({ rateDate: "2026-08-21", currency: "USD", rate: "1.0812", source: "ecb" })
    await expect(
      db.insert(fxRates).values({ rateDate: "2026-08-21", currency: "USD", rate: "9" }),
    ).rejects.toThrow() // pk(rate_date, currency)

    const [state] = await db.insert(fxSyncState).values({ lastStatus: "ok" }).returning()
    expect(state.id).toBe(1)
  })
})
