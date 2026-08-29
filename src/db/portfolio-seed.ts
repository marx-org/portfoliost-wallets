import postgres from "postgres"
import { SEED_USER_ID, SEED_WALLET_ID } from "./seed.js"

/**
 * Dev/E2E portfolio seed (testing-strategy: volatile DB, deterministic fixtures).
 * Mirrors the mock's Top10 parity set: one USD portfolio with 10 BUY
 * transactions and corresponding positions.
 *
 * Idempotent: skips when any portfolio exists (persistent environments /
 * re-entrant container starts). Only runs when SEED_PORTFOLIOS is not "false"
 * (prod CMD sets SEED_PORTFOLIOS=false to skip).
 */

export const SEED_PORTFOLIO_ID = "3cb589d8-f92d-428f-aeab-9ee5d4b9cef2"

// Mirrors the mock's single seeded share for "Top10" (mocks/shared/data/raw/portfolios_shares.json)
// so the settings "shared portfolios" screen and the public share link stay in parity.
export const SEED_SHARE_ID = "bff18fe0-bbb9-475f-b636-b3bd68a57d08"

const SEED_SHARE_PRIVACY = JSON.stringify({
  benchmarks: ["SPY"],
  showValues: true,
  displayName: "",
  showHoldings: true,
  showPositions: true,
  positionsToHide: [],
  showMonthlyReturns: true,
  showAssetAllocation: true,
  showPerformanceChart: true,
  showPositionAllocation: true,
  showSectorDistribution: true,
  showTransactionHistory: true,
  showGeographicBreakdown: true,
  showIndustryDistribution: true,
  performanceChartReturnType: "twr",
})

interface SeedPosition {
  id: string
  symbol: string
  companyName: string
  quantity: number
  averageCostBasis: number
  sector: string
  industry: string
  country: string
}

interface SeedTx {
  id: string
  positionId: string
  instrumentSymbol: string
  instrumentName: string
  quantity: number
  price: number
  totalAmount: number
  sector: string
  country: string
}

const SEED_POSITIONS: SeedPosition[] = [
  { id: "473eccd2-cb32-4433-99d8-a04ad6460223", symbol: "META", companyName: "Meta Platforms Inc", quantity: 22, averageCostBasis: 553.91, sector: "Communication Services", industry: "Media", country: "US" },
  { id: "d5e732d3-cdbf-46e6-b3da-fa044a8071a3", symbol: "CART", companyName: "Maplebear Inc", quantity: 239, averageCostBasis: 43.305, sector: "Consumer Discretionary", industry: "Retail", country: "US" },
  { id: "6f5c0b6c-f8d3-4274-b2e3-3c97cd18abb4", symbol: "MSFT", companyName: "Microsoft Corp", quantity: 32, averageCostBasis: 461.91, sector: "Technology", industry: "Technology", country: "US" },
  { id: "a2547fe3-e56a-4ef5-9dfd-af5d453952da", symbol: "NVDA", companyName: "NVIDIA Corp", quantity: 64, averageCostBasis: 198.95, sector: "Technology", industry: "Semiconductors", country: "US" },
  { id: "e89fcd87-b81a-448c-8690-86f36ac9ee70", symbol: "PLTR", companyName: "Palantir Technologies Inc", quantity: 72, averageCostBasis: 122.74, sector: "Technology", industry: "Technology", country: "US" },
  { id: "28ef1a40-2ec6-4870-a8de-ec44a92380de", symbol: "INTU", companyName: "Intuit Inc", quantity: 30, averageCostBasis: 314.605, sector: "Technology", industry: "Technology", country: "US" },
  { id: "bbcfde5c-0bef-499c-9b54-261da4c6a1a6", symbol: "LRCX", companyName: "Lam Research Corp", quantity: 25, averageCostBasis: 292.13, sector: "Technology", industry: "Semiconductors", country: "US" },
  { id: "10cf0cb8-92a3-4624-bede-f2e6d482fd50", symbol: "AMAT", companyName: "Applied Materials Inc", quantity: 15, averageCostBasis: 505.965, sector: "Technology", industry: "Semiconductors", country: "US" },
  { id: "1a56570c-6bce-45bf-96b8-15e5e70ff7a4", symbol: "ORCL", companyName: "Oracle Corp", quantity: 56, averageCostBasis: 129.13, sector: "Technology", industry: "Technology", country: "US" },
  { id: "89d5af01-b423-44cd-a890-1e42d4f46065", symbol: "KLAC", companyName: "KLA Corp", quantity: 42, averageCostBasis: 181.765, sector: "Technology", industry: "Semiconductors", country: "US" },
]

const SEED_TRANSACTIONS: SeedTx[] = [
  { id: "9a7220e0-4fda-4e1e-ba94-ce7d944ef447", positionId: "473eccd2-cb32-4433-99d8-a04ad6460223", instrumentSymbol: "META", instrumentName: "Meta Platforms Inc", quantity: 22, price: 553.91, totalAmount: 12186.02, sector: "Communication Services", country: "US" },
  { id: "6cc47a79-9924-49eb-9656-3d3d0f15d184", positionId: "d5e732d3-cdbf-46e6-b3da-fa044a8071a3", instrumentSymbol: "CART", instrumentName: "Maplebear Inc", quantity: 239, price: 43.305, totalAmount: 10349.895, sector: "Consumer Discretionary", country: "US" },
  { id: "6eb309da-c3f7-4b40-a3f8-9dd8f0e9335d", positionId: "6f5c0b6c-f8d3-4274-b2e3-3c97cd18abb4", instrumentSymbol: "MSFT", instrumentName: "Microsoft Corp", quantity: 32, price: 461.91, totalAmount: 14781.12, sector: "Technology", country: "US" },
  { id: "29d3487e-54d9-4ede-8268-3210f67cf9dc", positionId: "a2547fe3-e56a-4ef5-9dfd-af5d453952da", instrumentSymbol: "NVDA", instrumentName: "NVIDIA Corp", quantity: 64, price: 198.95, totalAmount: 12732.8, sector: "Technology", country: "US" },
  { id: "c34b04e5-5e1a-403b-bfb6-38633b34a547", positionId: "e89fcd87-b81a-448c-8690-86f36ac9ee70", instrumentSymbol: "PLTR", instrumentName: "Palantir Technologies Inc", quantity: 72, price: 122.74, totalAmount: 8837.28, sector: "Technology", country: "US" },
  { id: "5ad1db1f-74f8-4592-b0ab-8af317be383b", positionId: "28ef1a40-2ec6-4870-a8de-ec44a92380de", instrumentSymbol: "INTU", instrumentName: "Intuit Inc", quantity: 30, price: 314.605, totalAmount: 9438.15, sector: "Technology", country: "US" },
  { id: "412ea88e-186d-40e7-a7e5-f44ccf3608f4", positionId: "bbcfde5c-0bef-499c-9b54-261da4c6a1a6", instrumentSymbol: "LRCX", instrumentName: "Lam Research Corp", quantity: 25, price: 292.13, totalAmount: 7303.25, sector: "Technology", country: "US" },
  { id: "a7036197-c023-4604-b37b-6720241fb61d", positionId: "10cf0cb8-92a3-4624-bede-f2e6d482fd50", instrumentSymbol: "AMAT", instrumentName: "Applied Materials Inc", quantity: 15, price: 505.965, totalAmount: 7589.475, sector: "Technology", country: "US" },
  { id: "2335ab42-b5b6-4b26-9a4b-eb1cb52ce9a8", positionId: "1a56570c-6bce-45bf-96b8-15e5e70ff7a4", instrumentSymbol: "ORCL", instrumentName: "Oracle Corp", quantity: 56, price: 129.13, totalAmount: 7231.28, sector: "Technology", country: "US" },
  { id: "7c442c12-3799-48f3-ae7d-5d23d6731a36", positionId: "89d5af01-b423-44cd-a890-1e42d4f46065", instrumentSymbol: "KLAC", instrumentName: "KLA Corp", quantity: 42, price: 181.765, totalAmount: 7634.13, sector: "Technology", country: "US" },
]

/** Parity total invested (sum of all BUY totalAmounts). */
export function seededTotalInvested(): number {
  return Math.round(SEED_TRANSACTIONS.reduce((s, t) => s + t.totalAmount, 0) * 100) / 100
}

export async function seedPortfolios(dbUrl: string): Promise<boolean> {
  const sql = postgres(dbUrl, { max: 1 })
  try {
    const existing = await sql`select count(*)::int as count from portfolios.portfolios`
    if ((existing[0] as { count: number }).count > 0) {
      await sql.end()
      return false
    }

    const totalInvested = seededTotalInvested()
    const createdAt = "2026-08-01T10:14:16.111Z"
    const updatedAt = "2026-08-02T08:57:38.461Z"
    const txExecutedAt = "2026-08-02T00:00:00.000Z"
    const posOpenedAt = "2026-08-02T00:00:00.000Z"

    await sql.begin(async (tx) => {
      // Portfolio
      await tx`
        insert into portfolios.portfolios
          (id, user_id, name, description, strategy, type, currency, base_currency,
           wallet_id, total_invested, current_value, is_public, is_margin_enabled,
           margin_rate, maintenance_margin_rate, created_at, updated_at)
        values
          (${SEED_PORTFOLIO_ID}, ${SEED_USER_ID}, ${"Top10"},
           ${"Top10 big US stocks with best ghrowth potential, rebalanced monthly"},
           ${"GROWTH"}, ${"regular"}, ${"USD"}, ${"USD"}, ${SEED_WALLET_ID},
           ${totalInvested.toFixed(8)}, ${totalInvested.toFixed(8)},
           false, false, ${"0.5000"}, ${"0.2500"}, ${createdAt}, ${updatedAt})
      `

      // Shared link (parity with the mock's seeded share for Top10)
      await tx`
        insert into portfolios.shares
          (id, user_id, portfolio_id, display_name, view_count, expires_at,
           privacy_settings, created_at, updated_at)
        values
          (${SEED_SHARE_ID}, ${SEED_USER_ID}, ${SEED_PORTFOLIO_ID}, ${""}, ${0}, ${null},
           ${SEED_SHARE_PRIVACY}::jsonb, ${createdAt}, ${updatedAt})
      `

      // Positions
      for (const pos of SEED_POSITIONS) {
        const totalCost = (pos.quantity * pos.averageCostBasis).toFixed(8)
        await tx`
          insert into portfolios.positions
            (id, user_id, portfolio_id, symbol, company_name, asset_type,
             quantity, average_cost_basis, instrument_currency, purchase_currency,
             sector, industry, country, is_open, opened_at, created_at, updated_at)
          values
            (${pos.id}, ${SEED_USER_ID}, ${SEED_PORTFOLIO_ID}, ${pos.symbol},
             ${pos.companyName}, ${"STOCK"},
             ${pos.quantity.toFixed(8)}, ${pos.averageCostBasis.toFixed(8)},
             ${"USD"}, ${"USD"}, ${pos.sector}, ${pos.industry}, ${pos.country},
             true, ${posOpenedAt}, ${createdAt}, ${updatedAt})
        `
        void totalCost // used in position field only
      }

      // Transactions (all BUYs)
      for (const txRow of SEED_TRANSACTIONS) {
        await tx`
          insert into portfolios.transactions
            (id, user_id, portfolio_id, position_id, wallet_id, type,
             instrument_symbol, instrument_name, sector, country,
             quantity, price, currency, instrument_currency, asset_type,
             fees, total_amount, exchange_rate, rate_source, fee_rate_source,
             is_gift, synthesized_opening_lot, executed_at, created_at, updated_at)
          values
            (${txRow.id}, ${SEED_USER_ID}, ${SEED_PORTFOLIO_ID}, ${txRow.positionId},
             ${SEED_WALLET_ID}, ${"BUY"}, ${txRow.instrumentSymbol}, ${txRow.instrumentName},
             ${txRow.sector}, ${txRow.country},
             ${txRow.quantity.toFixed(8)}, ${txRow.price.toFixed(8)}, ${"USD"}, ${"USD"}, ${"STOCK"},
             ${"0"}, ${txRow.totalAmount.toFixed(8)}, ${"1"}, ${"automatic"}, ${"automatic"},
             false, false, ${txExecutedAt}, ${createdAt}, ${updatedAt})
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
