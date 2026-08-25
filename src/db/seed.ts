import postgres from "postgres"

/**
 * Dev/E2E seed (testing-strategy: volatile DB, deterministic fixtures).
 * Mirrors the mock's wallet parity set: one USD cash wallet plus five cash
 * transactions whose ledger sum equals the seeded balance (1916.60).
 *
 * Idempotent: skips when any wallet exists (persistent environments /
 * re-entrant container starts).
 */
export const SEED_USER_ID = process.env.SEED_USER_ID ?? "00000000-0000-4000-8000-000000000001"
export const SEED_WALLET_ID = "1a1f2d68-686c-4f8b-ba34-a67846163275"

interface SeedTx {
  type: "DEPOSIT" | "WITHDRAWAL"
  amount: number
  daysAgo: number
  description: string
}

const SEED_TXS: SeedTx[] = [
  { type: "DEPOSIT", amount: 2500, daysAgo: 30, description: "Monthly transfer" },
  { type: "WITHDRAWAL", amount: 2883.4, daysAgo: 21, description: "Buy EUR bonds" },
  { type: "DEPOSIT", amount: 1500, daysAgo: 12, description: "Salary deposit" },
  { type: "DEPOSIT", amount: 2000, daysAgo: 6, description: "Cash dividend income" },
  { type: "WITHDRAWAL", amount: 1200, daysAgo: 2, description: "EUR transfer" },
]

export function seededBalance(): number {
  return Math.round(SEED_TXS.reduce((s, t) => s + (t.type === "DEPOSIT" ? t.amount : -t.amount), 0) * 100) / 100
}

export async function seed(dbUrl: string): Promise<boolean> {
  const sql = postgres(dbUrl, { max: 1 })
  try {
    const existing = await sql`select count(*)::int as count from wallets.wallets`
    if ((existing[0] as { count: number }).count > 0) {
      await sql.end()
      return false
    }

    // Offline-friendly FX bootstrap (fees-and-custom-fx D25 interim): a demo
    // close table so selectors/valuations work before the first real import.
    const rateCount = await sql`select count(*)::int as count from wallets.fx_rates`
    if ((rateCount[0] as { count: number }).count === 0) {
      const DEMO: Record<string, number> = {
        USD: 1.08, PLN: 4.3, GBP: 0.85, CHF: 0.93, JPY: 163.2, CZK: 24.9,
        SEK: 11.3, NOK: 11.8, DKK: 7.46, HUF: 393.0, CNY: 7.8, AUD: 1.65,
        CAD: 1.47, BGN: 1.96, BRL: 5.9, HKD: 8.43, IDR: 17300, ILS: 4.0,
        INR: 90.2, ISK: 148.7, KRW: 1470, MXN: 19.7, MYR: 5.05, NZD: 1.79,
        PHP: 62.4, RON: 4.97, SGD: 1.44, THB: 38.9, TRY: 36.8, ZAR: 19.6,
      }
      const today = new Date().toISOString().slice(0, 10)
      for (const [currency, rate] of Object.entries(DEMO)) {
        await sql`
          insert into wallets.fx_rates (rate_date, currency, rate, source)
          values (${today}, ${currency}, ${rate.toFixed(10)}, ${"demo"})
          on conflict (rate_date, currency) do nothing
        `
      }
    }

    await sql.begin(async (tx) => {
      await tx`
        insert into wallets.wallets (id, user_id, name, currency, base_currency, balance, available_balance)
        values (${SEED_WALLET_ID}, ${SEED_USER_ID}, ${"Portfel USD 1"}, ${"USD"}, ${"USD"},
                ${seededBalance().toFixed(8)}, ${seededBalance().toFixed(8)})
      `
      for (const t of SEED_TXS) {
        const when = new Date(Date.now() - t.daysAgo * 86_400_000)
        const dateOnly = when.toISOString().slice(0, 10)
        const signed = t.type === "DEPOSIT" ? t.amount : -t.amount
        await tx`
          insert into wallets.wallet_transactions
            (user_id, wallet_id, type, amount, currency, status, description,
             transaction_date, executed_at, created_at, updated_at)
          values
            (${SEED_USER_ID}, ${SEED_WALLET_ID}, ${t.type}, ${signed.toFixed(8)}, ${"USD"},
             ${"completed"}, ${t.description}, ${dateOnly}, ${when}, ${when}, ${when})
        `
      }
    })

    await sql.end()
    return true
  } catch (err) {
    await sql.end()
    throw err
  }
}
