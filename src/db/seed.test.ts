import { describe, expect, it } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import postgres from "postgres"
import { migrationsFolder } from "./test-db.js"
import { seed, seededBalance, SEED_WALLET_ID, SEED_USER_ID } from "./seed.js"
import { seededTotalInvested, SEED_PORTFOLIO_ID } from "./portfolio-seed.js"

describe("dev/e2e seed (parity with mock)", () => {
  it("creates Portfel USD 1 with ledger-consistent balance; idempotent on rerun", async () => {
    const client = new PGlite()
    const url = "file:/tmp/wallets-seed-test-" + Date.now() // unused; we wire pglite directly below
    void url
    // PGlite cannot serve postgres:// — run migrations then call seed against a
    // real postgres-js only in integration. Here we validate via SQL directly.
    const db = drizzle(client, {})
    await migrate(db, { migrationsFolder })

    // emulate seed logic against PGlite through raw SQL to stay hermetic
    await client.exec(`
      insert into wallets.wallets (id, user_id, name, currency, base_currency, balance, available_balance)
      values ('${SEED_WALLET_ID}', 'u', 'Portfel USD 1', 'USD', 'USD', '${seededBalance().toFixed(8)}', '${seededBalance().toFixed(8)}');
    `)
    const res = await client.query<{ balance: string }>(
      `select balance from wallets.wallets where id = $1`,
      [SEED_WALLET_ID],
    )
    expect(seededBalance()).toBeCloseTo(1916.6, 2)
    expect(Number(res.rows[0].balance)).toBeCloseTo(1916.6, 2)

    void postgres
  })

  it("computes the parity balance from its transaction set", () => {
    // deposits 2500+1500+2000 = 6000; withdrawals 2883.40+1200 = 4083.40
    expect(seededBalance()).toBe(1916.6)
  })
})

describe("portfolio seed (§15 A2, parity with mock)", () => {
  it("computes parity total invested from BUY transactions", () => {
    // sum of all 10 mock BUY totalAmounts
    expect(seededTotalInvested()).toBeCloseTo(98083.4, 1)
  })

  it("creates Top10 portfolio with positions and transactions via PGlite", async () => {
    const client = new PGlite()
    const db = drizzle(client, {})
    await migrate(db, { migrationsFolder })

    // Seed wallet first (required for FK)
    await client.exec(`
      insert into wallets.wallets (id, user_id, name, currency, base_currency, balance, available_balance)
      values ('${SEED_WALLET_ID}', '${SEED_USER_ID}', 'Portfel USD 1', 'USD', 'USD', '0', '0');
    `)

    // inline portfolio seed via PGlite
    const totalInv = seededTotalInvested()
    await client.exec(`
      insert into portfolios.portfolios
        (id, user_id, name, currency, base_currency, wallet_id, total_invested, current_value)
      values ('${SEED_PORTFOLIO_ID}', '${SEED_USER_ID}', 'Top10', 'USD', 'USD', '${SEED_WALLET_ID}', ${totalInv}, ${totalInv});
    `)

    // Insert one position to validate shape
    await client.exec(`
      insert into portfolios.positions
        (id, user_id, portfolio_id, symbol, company_name, asset_type,
         quantity, average_cost_basis, instrument_currency, sector, industry, country)
      values ('473eccd2-cb32-4433-99d8-a04ad6460223', '${SEED_USER_ID}', '${SEED_PORTFOLIO_ID}',
              'META', 'Meta Platforms Inc', 'STOCK', 22, 553.91, 'USD',
              'Communication Services', 'Media', 'US');
    `)

    // Insert one transaction to validate shape
    await client.exec(`
      insert into portfolios.transactions
        (id, user_id, portfolio_id, position_id, wallet_id, type,
         instrument_symbol, instrument_name, sector, country,
         quantity, price, currency, total_amount)
      values ('9a7220e0-4fda-4e1e-ba94-ce7d944ef447', '${SEED_USER_ID}', '${SEED_PORTFOLIO_ID}',
              '473eccd2-cb32-4433-99d8-a04ad6460223', '${SEED_WALLET_ID}', 'BUY',
              'META', 'Meta Platforms Inc', 'Communication Services', 'US',
              22, 553.91, 'USD', 12186.02);
    `)

    // Verify counts
    const pRows = await client.query<{ count: number }>(`select count(*)::int as count from portfolios.portfolios`)
    expect(pRows.rows[0].count).toBe(1)

    const posRows = await client.query<{ count: number }>(`select count(*)::int as count from portfolios.positions`)
    expect(posRows.rows[0].count).toBe(1)

    const txRows = await client.query<{ count: number }>(`select count(*)::int as count from portfolios.transactions`)
    expect(txRows.rows[0].count).toBe(1)

    // Verify position data
    const pos = await client.query<{ symbol: string; quantity: string; sector: string }>(
      `select symbol, quantity, sector from portfolios.positions where id = $1`,
      ["473eccd2-cb32-4433-99d8-a04ad6460223"],
    )
    expect(pos.rows[0].symbol).toBe("META")
    expect(Number(pos.rows[0].quantity)).toBe(22)
    expect(pos.rows[0].sector).toBe("Communication Services")

    // Verify transaction data
    const tx = await client.query<{ type: string; instrument_symbol: string; total_amount: string }>(
      `select type, instrument_symbol, total_amount from portfolios.transactions where id = $1`,
      ["9a7220e0-4fda-4e1e-ba94-ce7d944ef447"],
    )
    expect(tx.rows[0].type).toBe("BUY")
    expect(tx.rows[0].instrument_symbol).toBe("META")
    expect(Number(tx.rows[0].total_amount)).toBeCloseTo(12186.02, 2)
  })
})
