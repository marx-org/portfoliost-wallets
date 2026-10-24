import { Hono, type Context } from "hono"
import { and, asc, count as drizzleCount, desc, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import {
  portfolios,
  positions,
  positionPortfolios,
  portfolioTransactions,
  shares,
  valueSnapshots,
  labels,
} from "../db/schema.js"
import { positionInPortfolio, transactionInPortfolio } from "../db/position-membership.js"
import { preferredBaseCurrency } from "../services/preferences.js"
import { dominantPriceSource, oldestPriceAsOf, splitPortfolioValue } from "../services/valuation.js"
import { getPortfolioNews } from "../services/portfolioNews.js"
import { getPortfolioCalendar } from "../services/portfolioCalendar.js"
import { getGapSymbols, buildBenchmarkSeries, forcePortfolioRecalc, hasBackfillableHistory, recalcPortfolioSeries } from "../services/backfill.js"
import { enqueueBackfill } from "../services/backfill-runner.js"
import { cashBalances, dailyExternalFlows, externalCashInvested } from "../services/cashLedger.js"
import { debugEnabled, debugLog } from "../services/debug.js"
import { buildPortfolioCash } from "./portfolio-cash.js"
import {
  annualizedReturn,
  annualizedReturnWithheldReason,
  computeRiskMetrics,
} from "../services/riskMetrics.js"
import { buildDailyReturns, buildMonthlyReturns } from "../services/returnColumns.js"
import { resolveRates, fxTo } from "../services/instruments-fx.js"
import { sumSnapshotsByDateForwardFilled, buildMergedPerformance } from "../services/mergedAnalytics.js"
import {
  createTransactionRoutes,
  openPositionsValueByPortfolio,
  positionWire,
} from "./portfolio-transactions.js"
import { labelsForPositions } from "../services/labels.js"
import type { components } from "../generated/api-types.js"

type Portfolio = components["schemas"]["Portfolio"]
type PortfolioTotalMetrics = components["schemas"]["PortfolioTotalMetrics"]
type HeldStocks = components["schemas"]["HeldStocks"]
type PortfolioSummaryMetrics = components["schemas"]["PortfolioSummaryMetrics"]

const ISO_CURRENCY = /^[A-Za-z]{3}$/

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Request schemas ────────────────────────────────────────────────────

export const CreatePortfolioSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
  isPublic: z.boolean().optional(),
  // §87.5 — UI-only; see the schema.ts note. Never read by the import.
  cashLegOnTrade: z.boolean().optional(),
  isMarginEnabled: z.boolean().optional(),
  isVirtual: z.boolean().optional(),
  labelId: z.string().uuid().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.isVirtual && !value.labelId) {
    ctx.addIssue({ code: "custom", path: ["labelId"], message: "A virtual portfolio requires a label" })
  }
})

export const UpdatePortfolioSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
  isPublic: z.boolean().optional(),
  // §87.5 — UI-only; see the schema.ts note. Never read by the import.
  cashLegOnTrade: z.boolean().optional(),
  isMarginEnabled: z.boolean().optional(),
  labelId: z.string().uuid().nullable().optional(),
})

// ── Serializers ────────────────────────────────────────────────────────

function serializePortfolio(p: typeof portfolios.$inferSelect) {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    description: p.description,
    baseCurrency: p.baseCurrency,
    // §41/S3 — the wire field is `capitalBasis`; the DB column keeps its
    // name. Read from the column, reported under the question it answers.
    capitalBasis: Number(p.totalInvested),
    currentValue: Number(p.currentValue),
    isPublic: p.isPublic,
    isVirtual: p.isVirtual,
    labelId: p.labelId,
    // §87.5 — the SPA reads this to pre-tick the form's cash checkbox.
    cashLegOnTrade: p.cashLegOnTrade,
    isMarginEnabled: p.isMarginEnabled,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function computeMetrics(db: DB, portfolioId: string) {
  const [posCounts] = await db
    .select({
      total: drizzleCount(),
      open: sql<number>`count(*) filter (where ${positions.isOpen} = true)::int`,
    })
    .from(positions)
    .where(positionInPortfolio(portfolioId))

  const [txSums] = await db
    .select({
      realizedGainLoss: sql<string>`coalesce(sum(${portfolioTransactions.realizedGainLoss}) filter (where ${portfolioTransactions.type} = 'SELL'), 0)`,
      income: sql<string>`coalesce(sum(${portfolioTransactions.totalAmount}) filter (where ${portfolioTransactions.type} = 'DIVIDEND'), 0)`,
    })
    .from(portfolioTransactions)
    .where(transactionInPortfolio(portfolioId))

  const realized = Number(txSums?.realizedGainLoss ?? 0)
  const income = Number(txSums?.income ?? 0)
  const positionCount = posCounts?.total ?? 0
  const openPositions = posCounts?.open ?? 0

  return {
    positionCount,
    openPositions,
    closedPositions: positionCount - openPositions,
    realizedGainLoss: realized,
    unrealizedGainLoss: 0, // will be enriched by quote adapter in Phase E
    capitalBasis: 0, // pulled from portfolio row
    income,
    returnBasis: 0,
    totalReturn: 0,
    totalReturnAmount: 0,
    dayChange: 0,
    dayChangeAmount: 0,
    dayChangeDate: null as string | null,
    asOf: new Date().toISOString(),
    capitalBasisReturnPercent: 0,
    capitalBasisReturnAmount: 0,
    capitalBasisSource: "externalFlows",
    capitalBasisSuppressedReason: null,
    capitalBasisReturnBasisKind: "inception",
  }
}

// ── Analytics helpers ───────────────────────────────────────────────────

/** Returns the ISO date cutoff for a timeframe query, or null for ALL/unknown. */
export function timeframeCutoff(timeframe: string, now = new Date()): string | null {
  const months: Record<string, number> = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24 }
  const days: Record<string, number> = { "1W": 7 }
  const upper = timeframe.toUpperCase()
  const m = months[upper]
  if (m) {
    const d = new Date(now)
    d.setUTCMonth(d.getUTCMonth() - m)
    return d.toISOString().slice(0, 10)
  }
  const d = days[upper]
  if (d) {
    const dt = new Date(now)
    dt.setUTCDate(dt.getUTCDate() - d)
    return dt.toISOString().slice(0, 10)
  }
  return null
}

// ---------------------------------------------------------------------------
// §83.2 — buildMonthlyReturns moved to services/returnColumns.ts, so `/merged`
// derives months from the SAME month-boundary rule as this route.
// ---------------------------------------------------------------------------

// ── Routes ─────────────────────────────────────────────────────────────

/**
 * §83.2 — the per-portfolio gap-symbol claims, unioned for `/merged`.
 *
 * A union, deliberately, not a re-derivation: each portfolio's list is written
 * by its own last backfill pass (§72.30's `gapSymbols` = the stored history is a
 * partial sum, `heldGapSymbols` = today's value is short), and re-deriving the
 * union would be a fourth definition of the same claim. Null — not `[]` — when
 * no portfolio reports one, which is §72.30's "no confirmed gap" rather than an
 * assertion that none exists.
 */
async function aggregateGapSymbols(
  db: DB,
  portfolioIds: string[],
): Promise<{ gapSymbols: string[] | null; heldGapSymbols: string[] | null }> {
  const perPortfolio = await Promise.all(portfolioIds.map((id) => getGapSymbols(db, id)))
  const union = (pick: (g: Awaited<ReturnType<typeof getGapSymbols>>) => string[] | null) => {
    const all = new Set<string>()
    let sawClaim = false
    for (const g of perPortfolio) {
      const list = pick(g)
      if (!list) continue
      sawClaim = true
      for (const s of list) all.add(s)
    }
    return sawClaim && all.size > 0 ? [...all].sort() : null
  }
  return {
    gapSymbols: union((g) => g.gapSymbols),
    heldGapSymbols: union((g) => g.heldGapSymbols),
  }
}

export function createPortfolioRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)

  const getDbInstance = () => db ?? getDb()

  // GET /api/portfolios — list with metrics
  routes.get("/", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const rows = await database
      .select()
      .from(portfolios)
      .where(sql`${portfolios.userId} = ${identity.id}`)
      .orderBy(sql`${portfolios.createdAt} DESC`)

    const result = await Promise.all(
      rows.map(async (p) => {
        const metrics = await computeMetrics(database, p.id)
        let currentValue = Number(p.currentValue)
        if (p.isVirtual) {
          const virtualPositions = await database
            .select()
            .from(positions)
            .where(and(eq(positions.userId, identity.id), positionInPortfolio(p.id), eq(positions.isOpen, true)))
          const toBase = await fxTo(c.req.header("Authorization") ?? "", p.baseCurrency, new Map(), { strict: true })
          currentValue = (await splitPortfolioValue(toBase, virtualPositions, new Map())).totalValue
        }
        metrics.capitalBasis = Number(p.totalInvested)
        metrics.totalReturn =
          currentValue > 0 && metrics.capitalBasis > 0
            ? ((currentValue - metrics.capitalBasis) / metrics.capitalBasis) * 100
            : 0
        metrics.totalReturnAmount = currentValue - metrics.capitalBasis
        metrics.returnBasis = metrics.capitalBasis

        return {
           ...serializePortfolio(p),
           currentValue,
          metrics,
          positionCount: metrics.positionCount,
          performance: {
            returnPercentage: metrics.totalReturn,
            totalGainLoss: metrics.totalReturnAmount,
            dailyChange: 0,
            dailyChangePercentage: 0,
          },
           ...(p.isVirtual ? {} : { cash: await buildPortfolioCash(database, c.req.header("Authorization") ?? "", p) }),
        }
      }),
    )

    return c.json(result)
  })

  // GET /api/portfolios/light — lightweight selector payload
  routes.get("/light", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const rows = await database
      .select()
      .from(portfolios)
      .where(eq(portfolios.userId, identity.id))
      .orderBy(sql`${portfolios.createdAt} DESC`)

    const result = await Promise.all(
      rows.map(async (p) => {
        const [cnt] = await database
          .select({ count: drizzleCount() })
          .from(positions)
          .where(positionInPortfolio(p.id))

        return {
          ...serializePortfolio(p),
          positionCount: cnt?.count ?? 0,
        }
      }),
    )

    return c.json(result)
  })

  // ── G1: GET /total-metrics — aggregate metrics across all portfolios ─

  routes.get("/total-metrics", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const portfolioRows = await database
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.userId, identity.id), eq(portfolios.isVirtual, false)))

    // plan §48.6e B5 — each portfolio's value/invested is denominated in its
    // own base_currency (each position in its instrument currency). Convert to
    // the aggregate base BEFORE summing — never add foreign-currency values raw.
    //
    // §66.4 — that base used to be the literal "USD", hardcoded here while
    // `preferredBaseCurrency` sat imported and unused in this file. The response
    // then *reported* `baseCurrency: "USD"` while the cards rendered raw
    // per-portfolio base amounts, which is why the headline and the card sum
    // could not reconcile (§63.3). Use the user's declared preference instead,
    // and fail loudly rather than degrade 1:1 on a valuation aggregate.
    const aggregateBase = await resolveAggregateBase(c, portfolioRows)
    if (!aggregateBase) {
      // no honest aggregate base -> no converted totals
      return c.json({ baseCurrency: null, totalValue: null, totalInvested: null, portfolioBreakdown: [] })
    }
    const toBase = await fxTo(c.req.header("Authorization") ?? "", aggregateBase, new Map(), { strict: true })

    // §68 — the per-portfolio cash balances, collected here so the cash card below
    // reuses the SAME ledger replay the split used instead of replaying it again.
    const cashByPortfolio = new Map<string, Map<string, number>>()
    // §41/S3 — one entry per portfolio, summed after the map so no shared counter
    // is written across an await.
    const externalByPortfolio: number[] = []
    // Compute actual totals from positions + transactions rather than
    // stale denormalized columns.
    const portfolioBreakdown = await Promise.all(
      portfolioRows.map(async (p) => {
        const totalInvested =
          Number(p.totalInvested || 0) * (await toBase(p.baseCurrency))

        // Sum market values from open positions (each in its instrument ccy)
        const posRows = await database
          .select({
            marketValue: positions.marketValue,
            quantity: positions.quantity,
            averageCostBasis: positions.averageCostBasis,
            instrumentCurrency: positions.instrumentCurrency,
            // §70.2 — provenance, so a value can be shown as stale rather than
            // asserted as current.
            priceAsOf: positions.priceAsOf,
            priceSource: positions.priceSource,
          })
          .from(positions)
          .where(and(positionInPortfolio(p.id), eq(positions.isOpen, true)))

        // §68 — the same split the recalc path and /summary-metrics compute. This
        // loop previously summed positions ONLY, which is precisely why the
        // headline missed the cash balance by exactly the cash balance (§63.3),
        // and it did so while /summary-metrics already included cash.
        const cashBal = p.isVirtual
          ? new Map<string, number>()
          : await cashBalances(database, c.req.header("Authorization") ?? "", p.id)
        cashByPortfolio.set(p.id, cashBal)
        // §41/S3 — collected per portfolio rather than accumulated in place: the
        // rows are built by Promise.all, so `+=` across an await is a race. Summed
        // once below, which also saves a second round of FX lookups over every row.
        externalByPortfolio.push(
           await externalCashInvested(
            database, c.req.header("Authorization") ?? "", p.id, p.baseCurrency ?? aggregateBase,
          ),
        )
        const split = await splitPortfolioValue(toBase, posRows, cashBal)
        // RECALC_DEBUG — the LIVE path's composition. Reads against
        // `cash-balances` and `cash-balance-series` for the same portfolio: this
        // is the line that shows which cash figure produced which total, so a
        // live-vs-snapshot divergence is a one-line diff instead of a rebuild.
        if (debugEnabled()) {
          debugLog(
            `total-metrics pf=${p.id} name=${p.name} base=${p.baseCurrency} positions=${posRows.length} ` +
            `INSTRUMENTS=${split.instrumentsValue.toFixed(2)} CASH=${split.cashValue.toFixed(2)} ` +
            `TOTAL=${split.totalValue.toFixed(2)} invested=${totalInvested.toFixed(2)} unpriced=${split.unpricedPositions}`,
          )
        }
        if (split.unpricedPositions > 0) {
          // §70 — loud on purpose. Before this, an unpriced position silently
          // contributed its COST and the total looked plausible. The count is
          // the signal that `positions.market_value` is not being maintained:
          // nothing in the scheduled pipeline writes that column (only opening a
          // portfolio refreshes quotes), so after any re-import every position
          // is unpriced until someone visits it.
          console.warn(
            `[total-metrics] ${p.name}: ${split.unpricedPositions} open position(s) have no market value ` +
            `(market_value IS NULL) and are EXCLUDED from the total — not valued at cost. ` +
            `Run a quote refresh for this portfolio.`,
          )
        }

        const gainLoss = split.totalValue - totalInvested
        const returnPct = totalInvested > 0 ? (gainLoss / totalInvested) * 100 : 0
        return {
          id: p.id,
          name: p.name,
          // Round each component FIRST, then total the ROUNDED parts. Rounding
          // the raw sum instead leaves totalValue up to a cent away from
          // instrumentsValue + cashValue in the response — PROD showed IKE Marek
          // at 27,684.94 + 239.45 = 27,924.39 against a reported 27,924.38. The
          // contract promises they are equal, so the response has to make that
          // true, not merely be near it.
          instrumentsValue: Math.round(split.instrumentsValue * 100) / 100,
          cashValue: Math.round(split.cashValue * 100) / 100,
          totalValue: 0,
          capitalBasis: Math.round(totalInvested * 100) / 100,
          returnPercentage: Math.round(returnPct * 100) / 100,
          weight: 0, // filled in after totals computed
          unpricedPositions: split.unpricedPositions,
          // OLDEST price among the positions we DID value — the stalest input
          // decides whether this row can be trusted, not the freshest.
          priceAsOf: oldestPriceAsOf(posRows),
          priceSource: dominantPriceSource(posRows),
        }
      }),
    )

    // Each row's parts are rounded to the cent, so the row total is now exact
    // rather than a rounding of the raw sum (see the comment on the row literal).
    for (const row of portfolioBreakdown) {
      row.totalValue = Math.round((row.instrumentsValue + row.cashValue) * 100) / 100
    }

    // §68 — the aggregate is the sum of the parts, so the headline and the cards
    // cannot disagree: totalValue IS instrumentsValue + cashValue by definition.
    const totalInstruments = portfolioBreakdown.reduce((s, p) => s + p.instrumentsValue, 0)
    const totalCashValue = portfolioBreakdown.reduce((s, p) => s + p.cashValue, 0)
    const totalValue = Math.round((totalInstruments + totalCashValue) * 100) / 100
    const externalContributions = externalByPortfolio.reduce((s, v) => s + v, 0)
    const totalInvested = portfolioBreakdown.reduce((s, p) => s + p.capitalBasis, 0)
    const totalGainLoss = totalValue - totalInvested
    const returnPercentage = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0
    // back-fill weights now that totalValue is known
    for (const p of portfolioBreakdown) {
      p.weight = totalValue > 0 ? Math.round((p.totalValue / totalValue) * 10000) / 100 : 0
    }

    // §62 — aggregate cash across all portfolios (per-currency Σ, base-converted)
    const cashByCcy = new Map<string, number>()
    for (const bal of cashByPortfolio.values()) {
      for (const [ccy, amt] of bal) cashByCcy.set(ccy, (cashByCcy.get(ccy) ?? 0) + amt)
    }
    const cashConverted = new Map<string, number>()
    for (const [ccy, balance] of cashByCcy) cashConverted.set(ccy, balance * (await toBase(ccy)))
    // §68 — the aggregate cash is the Σ of the same per-portfolio splits above,
    // so the card and the tile read the same number by construction.
    const totalCash = totalCashValue
    // §70.5 — weights are shares of GROSS exposure, not of the signed net.
    //
    // `converted / net` is only meaningful while the net is comfortably away
    // from zero, and it stops being meaningful exactly when it matters: IBKR
    // holds +64,898 EUR against −45,434 USD, so the net nearly cancels and each
    // share explodes (PROD showed +648% and −398%, weights that cannot sum to
    // 100% because several of them are negative). The signed BALANCE is kept
    // exactly as it was — the user confirms the mixed signs are real, from
    // currency conversions IBKR performs but never registers in the sheet — so
    // direction is still reported. The weight instead answers the question a
    // reader actually has: how much of this account's cash sits in this currency.
    // That is well defined whatever the signs do, and always sums to 100%.
    const grossCash = [...cashConverted.values()].reduce((s, v) => s + Math.abs(v), 0)
    const cashBreakdown = [...cashByCcy.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([currency, balance]) => ({
        currency,
        balance: Math.round(balance * 1e8) / 1e8,
        weight:
          grossCash > 0
            ? Math.round((Math.abs(cashConverted.get(currency)!) / grossCash) * 10000) / 100
            : 0,
      }))

    return c.json({
      // §68 — instruments + cash. `totalValue` CHANGED meaning: it used to be
      // positions-only here while /summary-metrics already included cash.
      instrumentsValue: Math.round(totalInstruments * 100) / 100,
      cashValue: totalCash,
      totalValue,
      // §70.2 — the aggregate is only as fresh as its stalest portfolio, so the
      // headline reports the OLDEST priceAsOf across rows, never the newest.
      unpricedPositions: portfolioBreakdown.reduce((s, p) => s + (p.unpricedPositions ?? 0), 0),
      priceAsOf: portfolioBreakdown
        .map((p) => p.priceAsOf)
        .filter((v): v is string => !!v)
        .sort()[0] ?? null,
      // 'quote' rather than null when nothing fell back: the contract documents
      // this field as 'quote' | 'fallback', and null here would read as "unknown
      // provenance" when in fact every position was priced live.
      priceSource: portfolioBreakdown.some((p) => p.priceSource === "fallback")
        ? "fallback"
        : portfolioBreakdown.some((p) => p.priceSource === "quote")
          ? "quote"
          : null,
      capitalBasis: totalInvested,
      externalContributions: Math.round(externalContributions * 100) / 100,
      totalGainLoss,
      returnPercentage,
      // §66.4 left this hardcoded as "USD" while line ~274 computed a real
      // `aggregateBase` and converted into it. Invisible only while the
      // preference was unset, because the sanctioned default happens to BE
      // "USD" — and §67.1's write-through is exactly what makes the user's
      // chosen base arrive here, at which point reporting USD while every number
      // was PLN would have mislabelled the whole dashboard. Report what we
      // converted into.
      baseCurrency: aggregateBase,
      portfolioBreakdown,
      // §41/S3 — all six were named `externalCapital*` while reporting the CAPITAL
      // BASIS, which includes in-kind transfers. Renamed to say so. Note these are
      // the basis's return, not externalContributions' — the aggregate's basis is
      // the sum across portfolios, so the two are not interchangeable.
      capitalBasisReturnPercent: returnPercentage,
      capitalBasisReturnAmount: totalGainLoss,
      capitalBasisSource: "none",
      capitalBasisSuppressedReason: null,
      capitalBasisReturnBasisKind: "inception",
      cashBreakdown,
    } satisfies PortfolioTotalMetrics)
  })

  // ── G1: GET /held-stocks — aggregated open position view ─────────────

/**
 * §68.4 — the ONE aggregate base for the dashboard.
 *
 * Two routes report amounts the SPA then converts, and they must agree on the
 * currency those amounts are in: /total-metrics and /merged. They did not.
 * /merged hardcoded "USD" as its conversion target in two places while the SPA
 * took the merged source to be `total-metrics.baseCurrency` — so the chart was
 * only ever right because /total-metrics ALSO hardcoded "USD", and the two
 * hardcodes cancelled out.
 *
 * §68.3 fixed /total-metrics to report the real aggregate base, which is exactly
 * what would have silently broken the chart: real numbers, wrong source currency.
 * The two have to move together, which is why this is a shared resolver rather
 * than a second correct value.
 *
 * The ladder is §66.4's: declared preference, else the user's own most common
 * portfolio base, else null — and the caller reports nulls rather than guessing.
 */
async function resolveAggregateBase(
  c: Context,
  portfolioRows: { baseCurrency: string }[],
): Promise<string | null> {
  try {
    return await preferredBaseCurrency(Object.fromEntries(c.req.raw.headers))
  } catch (e) {
    const tally = new Map<string, number>()
    for (const p of portfolioRows) tally.set(p.baseCurrency, (tally.get(p.baseCurrency) ?? 0) + 1)
    console.warn(
      "[aggregate-base] base-currency preference unreadable:",
      e instanceof Error ? e.message : e,
    )
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
}

  routes.get("/held-stocks", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const posRows = await database
      .select()
      .from(positions)
      .where(
        and(
          sql`${positions.userId} = ${identity.id}`,
          eq(positions.isOpen, true),
        ),
      )

    const bySymbol = new Map<string, {
      symbol: string
      companyName: string
      quantity: number
      totalCostBasis: number
      marketValue: number
      assetType: string
      instrumentCurrency: string
    }>()

    for (const p of posRows) {
      const existing = bySymbol.get(p.symbol)
      const qty = Number(p.quantity)
      const costBasis = Number(p.averageCostBasis) * qty
      const mktVal = p.marketValue != null ? Number(p.marketValue) : costBasis
      if (existing) {
        existing.quantity += qty
        existing.totalCostBasis += costBasis
        existing.marketValue += mktVal
      } else {
        bySymbol.set(p.symbol, {
          symbol: p.symbol,
          companyName: p.companyName || p.symbol,
          quantity: qty,
          totalCostBasis: costBasis,
          marketValue: mktVal,
          assetType: p.assetType || "STOCK",
          instrumentCurrency: p.instrumentCurrency,
        })
      }
    }

    const stocks = [...bySymbol.values()]
      .map((s) => ({
        symbol: s.symbol,
        name: s.companyName,
        logo: null as string | null,
        currentPrice: s.quantity > 0 ? Math.round((s.marketValue / s.quantity) * 100) / 100 : 0,
        changePercent: 0,
        assetType: s.assetType,
        totalQuantity: s.quantity,
        totalValue: Math.round(s.marketValue * 100) / 100,
      }))
      .sort((a, b) => b.totalValue - a.totalValue)

    return c.json({ stocks, totalCount: stocks.length } satisfies HeldStocks)
  })

  // ── G3: Shares CRUD ──────────────────────────────────────────────────
  // Must be before /:id routes so Hono matches as static path.

  routes.get("/shares", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const rows = await database
      .select()
      .from(shares)
      .where(sql`${shares.userId} = ${identity.id}`)
      .orderBy(sql`${shares.createdAt} DESC`)

    const enriched = await Promise.all(
      rows.map(async (s) => {
        const [p] = await database
          .select({ name: portfolios.name })
          .from(portfolios)
          .where(eq(portfolios.id, s.portfolioId))
        return {
          ...s,
          portfolioName: p?.name ?? "",
        }
      }),
    )

    return c.json(enriched)
  })

  routes.post("/shares", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const body = await c.req.json().catch(() => ({}))
    const { portfolioId, displayName = "" } = body

    if (!portfolioId) {
      return c.json({ error: "ValidationError", message: "portfolioId is required" }, 422)
    }

    const [portfolio] = await database
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, identity.id)))

    if (!portfolio) {
      return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)
    }

    const [cnt] = await database
      .select({ count: drizzleCount() })
      .from(shares)
      .where(eq(shares.userId, identity.id))

    if (cnt && cnt.count >= 10) {
      return c.json({ error: "LimitReached", message: "You can have up to 10 active shares" }, 422)
    }

    const defaultPrivacy = {
      benchmarks: ["SPY"],
      showValues: true,
      displayName,
      showHoldings: true,
      showPositions: true,
      positionsToHide: [],
      showMonthlyReturns: true,
      showAssetAllocation: true,
      showPerformanceChart: true,
      showPositionAllocation: true,
      showSectorDistribution: true,
      showTransactionHistory: true,
    }

    const [created] = await database
      .insert(shares)
      .values({
        userId: identity.id,
        portfolioId,
        displayName,
        privacySettings: defaultPrivacy,
      })
      .returning()

    return c.json({
      ...created,
      portfolioName: portfolio.name,
      privacySettings: defaultPrivacy,
    }, 201)
  })

  routes.delete("/shares/:shareId", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const shareId = c.req.param("shareId") as string

    const [share] = await database
      .select()
      .from(shares)
      .where(and(eq(shares.id, shareId), eq(shares.userId, identity.id)))

    if (!share) {
      return c.json({ error: "NotFound", message: "Share not found" }, 404)
    }

    await database.delete(shares).where(eq(shares.id, shareId))
    return c.body(null, 204)
  })

  // POST /api/portfolios — create
  routes.post("/", async (c) => {
    const parsed = CreatePortfolioSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }

    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const isVirtual = parsed.data.isVirtual ?? false
    if (isVirtual) {
      const [label] = await database
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.id, parsed.data.labelId!), eq(labels.userId, identity.id)))
      if (!label) return c.json({ error: "ValidationError", message: "Label not found" }, 422)
    }

    // D21b: explicit baseCurrency wins; otherwise from user prefs
    const forwardedHeaders: Record<string, string> = {}
    for (const k of ["authorization", "x-user-id", "x-user-email"]) {
      const v = c.req.header(k)
      if (v) forwardedHeaders[k] = v
    }
    const defaultBase =
      // creation stays best-effort (§66.4): a preference-service blip must not
      // block creating a portfolio, and the client may pass the base explicitly
      parsed.data.baseCurrency ?? (await preferredBaseCurrency(forwardedHeaders, undefined, { strict: false }))

    try {
      const [created] = await database
        .insert(portfolios)
        .values({
          userId: identity.id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          baseCurrency: defaultBase.toUpperCase(),
          isPublic: parsed.data.isPublic ?? false,
          // UI-only preference. Import policy belongs to sheets-sync and is
          // carried explicitly by the import payload, never inferred here.
          cashLegOnTrade: isVirtual ? false : parsed.data.cashLegOnTrade ?? false,
          isMarginEnabled: parsed.data.isMarginEnabled ?? false,
          isVirtual,
          labelId: isVirtual ? parsed.data.labelId! : null,
        })
        .returning()
      return c.json(serializePortfolio(created) satisfies Portfolio, 201)
    } catch (err) {
      // uq_portfolios_user_name (import bootstrap natural key) — duplicate name
      if ((err as { cause?: { code?: string } }).cause?.code === "23505") {
        return c.json(
          { error: "Conflict", message: `A portfolio named "${parsed.data.name}" already exists` },
          409,
        )
      }
      throw err
    }
  })

  // GET /api/portfolios/positions — every position across every portfolio of
  // the identity, open or closed, with one row per portfolio membership and
  // its portfolio context.
  //
  // NOT `/held-stocks`: that aggregates BY SYMBOL across portfolios, drops P/L
  // entirely and hardcodes `changePercent: 0`. The cumulative Performance tab
  // needs the opposite — rows that say which portfolio they came from and how
  // much they are worth, because one ticker can be held in two portfolios with
  // very different results.
  //
  // Registered ABOVE "/:id" so "positions" is not parsed as a portfolio id —
  // the same reason `/merged` sits where it does.
  routes.get("/positions", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    // §76.1 — a read prices nothing: no refreshQuotes here, same as
    // GET /:id/positions.
    const rows = await database
      .select({ position: positions, portfolioId: positionPortfolios.portfolioId, portfolioName: portfolios.name, baseCurrency: portfolios.baseCurrency })
      .from(positions)
      .innerJoin(positionPortfolios, eq(positionPortfolios.positionId, positions.id))
      .innerJoin(portfolios, eq(portfolios.id, positionPortfolios.portfolioId))
      .where(eq(positions.userId, identity.id))
      // The performers cards sort on P/L; ordering here means the SPA does not
      // have to, and the response is already in display order.
      .orderBy(sql`${positions.unrealizedGainLoss} DESC NULLS LAST`)

    const totalsByPortfolio = await openPositionsValueByPortfolio(database, identity.id)
    // One rate table per DISTINCT portfolio base among these rows — `resolveRates`
    // resolves INTO a single target, and a position belongs to exactly one
    // portfolio, so a row must be converted at its own portfolio's rate or its
    // `converted*` fields answer a question nobody asked.
    const bases = [...new Set(rows.map((r) => (r.baseCurrency ?? "USD").toUpperCase()))]
    const authToken = c.req.header("Authorization") ?? ""
    const fxByBase = new Map<string, Map<string, number | null>>()
    for (const base of bases) {
      fxByBase.set(
        base,
        await resolveRates(
          authToken,
          base,
          rows.filter((r) => (r.baseCurrency ?? "USD").toUpperCase() === base).map((r) => r.position.instrumentCurrency),
        ),
      )
    }
    const labelMap = await labelsForPositions(
      database,
      rows.map((r) => r.position.id),
    )

    const wire = rows.map((r) => {
      const base = (r.baseCurrency ?? "USD").toUpperCase()
      return {
        ...positionWire(
          r.position,
          { id: r.portfolioId, baseCurrency: r.baseCurrency },
          totalsByPortfolio.get(r.portfolioId) ?? 0,
          // §83.5 — converted at the OWNING portfolio's base, so a row here is
          // the same number its per-portfolio tab shows. The performers cards
          // print the P/L in `instrumentCurrency` regardless; converting the whole
          // account into one currency here would put `displayCurrency` in
          // conflict with the portfolio the row belongs to.
          fxByBase.get(base) ?? new Map<string, number | null>(),
          labelMap.get(r.position.id) ?? [],
        ),
        portfolioName: r.portfolioName,
      }
    })

    return c.json({ positions: wire })
  })

  // GET /api/portfolios/merged — combined all-portfolios performance (§46,
  // §41 follow-up 1). Sums every portfolio's value_snapshots into the SAME
  // aggregate base /total-metrics reports (was hardcoded "USD" — §68.4).
  //
  // The series ALREADY includes cash: value_snapshots.value is written by
  // snapshotPortfolioValue as instruments + cash, so this chart's value line is
  // the whole account and needs no separate cash line to agree with the tile.
  // Registered ABOVE "/:id" so "merged" is not parsed as a portfolio id.
  routes.get("/merged", async (c) => {
    const identity = c.get("userIdentity")
    const timeframe = c.req.query("timeframe") || "ALL"
    // §83.3 — `benchmarks[]` is already declared on `PortfolioAnalytics`
    // (openapi.yaml:1545); this route used to ignore the param entirely. The
    // selection is per-request store state, not a DB column, so there is no
    // schema to add and nothing to persist.
    const benchmarkCalcType = c.req.query("benchmarkCalcType") || "timeWeighted"
    const benchmarkParam = c.req.query("benchmarks")
    const benchmarkSymbols = benchmarkParam
      ? benchmarkParam.split(",").map((s) => s.trim()).filter(Boolean)
      : []
    const database = getDbInstance()

    const portfolioRows = await database
      .select({ id: portfolios.id, baseCurrency: portfolios.baseCurrency, isVirtual: portfolios.isVirtual })
      .from(portfolios)
      .where(sql`${portfolios.userId} = ${identity.id}`)

    // §72.7 — a READ, kept deliberately: the dashboard must be able to say a
    // portfolio is mid-rebuild. What was removed is the `runBackfill` this used
    // to fire here (see below) — reporting pending state is fine, mutating from
    // a GET is not. Portfolios whose trades all start today can never produce
    // snapshots — they are complete, not pending (§48.4).
    const pendingIds: string[] = []
    for (const p of portfolioRows) {
      const [{ n }] = await database
        .select({ n: drizzleCount() })
        .from(valueSnapshots)
        .where(eq(valueSnapshots.portfolioId, p.id))
      if (n < 2 && (await hasBackfillableHistory(database, p.id))) pendingIds.push(p.id)
    }
    // §72.7 — this used to fire a backfill from a GET, and it also used to
    // RETURN AN EMPTY SERIES when anything was pending: one brand-new portfolio
    // erased every other portfolio's history from a view whose entire purpose is
    // the cumulative total. §83.2 reports the flag and the partial sum together —
    // reporting that a portfolio is mid-rebuild is a read, mutating from a GET is
    // not, and neither requires hiding what the other nine portfolios have.
    //
    // Nothing needs this to seed a new portfolio: POST /:id/positions calls
    // notifyTransactionsChanged, which enqueues the full recalc. What is lost by
    // not firing here is read-side self-healing for a portfolio whose history is
    // empty for some other reason — that now takes an explicit POST /:id/recompute,
    // which is the right place for a rebuild to be asked for.

    const cutoff = timeframeCutoff(timeframe)
    const rows = await database
      .select({
        portfolioId: valueSnapshots.portfolioId,
        baseCurrency: portfolios.baseCurrency,
        snapshotDate: valueSnapshots.snapshotDate,
        value: valueSnapshots.value,
        invested: valueSnapshots.invested,
        // §83.2 — the aggregate's return columns are only as honest as the flow
        // they are computed from. Without `net_flow` there is no TWR on
        // `/merged` at all (see mergedAnalytics.ts).
        netFlow: valueSnapshots.netFlow,
        // §83.2 — the §78.5 / §72.31 honesty amounts. They are what arm
        // PortfolioPerformanceChart's "this curve is a partial sum" chip, which
        // would otherwise be silently disarmed on the one screen where a wrong
        // total is most expensive.
        unpricedValue: valueSnapshots.unpricedValue,
        carriedValue: valueSnapshots.carriedValue,
      })
      .from(valueSnapshots)
      .innerJoin(portfolios, eq(valueSnapshots.portfolioId, portfolios.id))
      .where(
        cutoff
          ? and(
              sql`${portfolios.userId} = ${identity.id}`,
              sql`${valueSnapshots.snapshotDate} >= ${cutoff}`,
            )
          : sql`${portfolios.userId} = ${identity.id}`,
      )
      .orderBy(asc(valueSnapshots.snapshotDate))

    // §68.4 — was hardcoded "USD" in two places. See resolveAggregateBase: this
    // has to be the same base /total-metrics reports, or the SPA converts the
    // chart out of a currency the numbers are not in.
    const aggregateBase = await resolveAggregateBase(c, portfolioRows)
    const mergedBase = aggregateBase ?? "USD"
    if (!aggregateBase) {
      console.warn("[merged] no honest aggregate base; USD for the series only, dashboard reports nulls")
    }
    const rateMap = await resolveRates(
      c.req.header("Authorization") ?? "",
      mergedBase,
      rows.map((r) => r.baseCurrency),
    )
    const series = sumSnapshotsByDateForwardFilled(
      rows.map((r) => ({
        portfolioId: r.portfolioId,
        baseCurrency: r.baseCurrency,
        snapshotDate: r.snapshotDate,
        value: Number(r.value),
        invested: Number(r.invested),
        netFlow: Number(r.netFlow ?? 0),
        // `null` propagates as "not measured" — see mergedAnalytics.ts addWithheld.
        unpricedValue: r.unpricedValue === null ? null : Number(r.unpricedValue),
        carriedValue: r.carriedValue === null ? null : Number(r.carriedValue),
      })),
      (from) => rateMap.get(from.toUpperCase()) ?? null,
      mergedBase,
    )

    const gap = await aggregateGapSymbols(database, portfolioRows.map((p) => p.id))

    // §83.3 — the aggregate benchmark overlay: the same builder, the aggregate
    // base, and the SAME aggregate money the user actually put in.
    //
    //   flows          = Σ external flows across ALL of the user's portfolios
    //   seedInvested   = the aggregate `invested` at the window start
    //
    // Both legs of a transfer between two of the user's own portfolios are
    // external-only-excluded per portfolio (§62.4/D50), so neither reaches this
    // map and moving money between your own portfolios cannot perturb the
    // benchmark — the case a second, hand-rolled flow reader gets wrong.
    //
    // Its per-day rate is deliberately NOT the same constant spot rate the value
    // series is converted at: a benchmark must pay for the flows on the day they
    // happened, while the value series is a constant-currency restatement (§68.4).
    // Do not "unify" them.
    let benchmarks: NonNullable<components["schemas"]["PortfolioAnalytics"]["benchmarks"]> = []
    const firstPoint = series[0]
    const lastPoint = series[series.length - 1]
    if (benchmarkSymbols.length > 0 && firstPoint && lastPoint) {
      const authToken = c.req.header("Authorization") ?? ""
      const flows = await dailyExternalFlows(
        database,
        authToken,
        portfolioRows.map((p) => p.id),
        firstPoint.date,
        lastPoint.date,
        mergedBase,
      )
      const calcType = (["moneyWeighted", "timeWeighted", "simple"] as const).includes(
        benchmarkCalcType as "moneyWeighted" | "timeWeighted" | "simple",
      )
        ? (benchmarkCalcType as "moneyWeighted" | "timeWeighted" | "simple")
        : "timeWeighted"
      const built = await Promise.all(
        benchmarkSymbols.map((sym) =>
          buildBenchmarkSeries(sym, firstPoint.date, lastPoint.date, authToken, sym, {
            db: database,
            baseCurrency: mergedBase,
            flows,
            seedInvested: firstPoint.invested,
            calcType,
          }),
        ),
      )
      // Unknown tickers are dropped, exactly as `/:id/analytics` does.
      benchmarks = built
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => ({ symbol: s.symbol, name: s.name, timeSeries: s.timeSeries, returnPercent: s.returnPercent, volatility: s.volatility }))
    }

    return c.json({
      timeframe,
      backfillStatus: pendingIds.length > 0 ? "pending" : "complete",
      // §83.2 — the union of the per-portfolio claims, NOT a re-derivation: the
      // chart's message needs a count to sit beside the withheld amount, and the
      // honest aggregate of "which of my positions have no price" is "all of
      // them, across every portfolio". `getGapSymbols` is a one-row read per
      // portfolio, so this is cheap. Null (not []) when no portfolio reports a
      // gap, which is §72.30's "no confirmed gap" rather than "none exist".
      gapSymbols: gap.gapSymbols,
      heldGapSymbols: gap.heldGapSymbols,
      performance: buildMergedPerformance(series),
      benchmarks,
    } satisfies components["schemas"]["PortfolioAnalytics"])
  })

  // GET /api/portfolios/:id — detail with metrics
  routes.get("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")

    const [p] = await database
      .select()
      .from(portfolios)
      .where(and(sql`${portfolios.id} = ${id}`, sql`${portfolios.userId} = ${identity.id}`))

    if (!p) {
      return c.json({ error: "NotFound", message: "portfolio not found" }, 404)
    }

    const metrics = await computeMetrics(database, p.id)
    metrics.capitalBasis = Number(p.totalInvested)
    metrics.totalReturn =
      Number(p.currentValue) > 0 && metrics.capitalBasis > 0
        ? ((Number(p.currentValue) - metrics.capitalBasis) / metrics.capitalBasis) * 100
        : 0
    metrics.totalReturnAmount = Number(p.currentValue) - metrics.capitalBasis
    metrics.returnBasis = metrics.capitalBasis

    // D58 used to `await refreshQuotes(...)` here, so every portfolio open paid
    // two instruments calls per open position (quote + profile) inside the
    // request. That is the read path: it made browsing a portfolio cost a
    // network round trip per holding, on a page the user may open repeatedly,
    // to move a number by a few percent.
    //
    // Prices now come from the writers, and the route reports what they last
    // stored: the 13:00/17:20 scheduled syncs, and every rebuild (§72.6, which
    // prices at the end of a recalc — so a wipe-and-reimport leaves the portfolio
    // fully priced instead of 99 unpriced positions). `priceAsOf` and
    // `priceSource` already travel with each position, so a figure that has not
    // moved since yesterday says so rather than pretending otherwise — which is
    // §70's rule applied to freshness: label it, do not fabricate it.
    //
    // The summaries below are built entirely from stored columns, so nothing
    // here depends on a refresh having just run.
    //
    // §76.1 — D58 removed the refresh from THIS module, but portfolio-open reads
    // its holdings through the *transactions* module (`GET /:id/positions`,
    // `GET /:id/allocation`, `GET /:id/positions/cfd-hints` in
    // routes/portfolio-transactions.ts), where the call survived. So the removal
    // above fixed a route the SPA does not use for that data. §76.1 completes
    // D58 there; the comment here stood true while the write lived two files
    // away. If you are looking for where positions stop being re-priced on a
    // read, it is those three handlers, not this one.

    // Fetch position summaries
    const posRows = await database
      .select()
      .from(positions)
      .where(positionInPortfolio(id))

    const posSummaries = posRows.map((pos) => ({
      id: pos.id,
      portfolioId: id,
      symbol: pos.symbol,
      companyName: pos.companyName,
      assetType: pos.assetType,
      quantity: Number(pos.quantity),
      averageCostBasis: Number(pos.averageCostBasis),
      totalCostBasis: Number(pos.quantity) * Number(pos.averageCostBasis),
      currentPrice: pos.currentPrice != null ? Number(pos.currentPrice) : null,
      marketValue: pos.marketValue != null ? Number(pos.marketValue) : null,
      unrealizedGainLoss: pos.unrealizedGainLoss != null ? Number(pos.unrealizedGainLoss) : null,
      percentageChange:
        pos.currentPrice != null && Number(pos.averageCostBasis) > 0
          ? ((Number(pos.currentPrice) - Number(pos.averageCostBasis)) / Number(pos.averageCostBasis)) * 100
          : null,
      percentOfPortfolio:
        pos.marketValue != null && Number(p.currentValue) > 0
          ? (Number(pos.marketValue) / Number(p.currentValue)) * 100
          : null,
      dayChange: pos.dayChange != null ? Number(pos.dayChange) : null,
      dayChangePercent: pos.dayChangePercent != null ? Number(pos.dayChangePercent) : null,
      sector: pos.sector,
      industry: pos.industry,
      country: pos.country,
      purchaseCurrency: pos.purchaseCurrency,
      instrumentCurrency: pos.instrumentCurrency,
      isOpen: pos.isOpen,
      openedAt: pos.openedAt.toISOString(),
      closedAt: pos.closedAt?.toISOString() ?? null,
    }))

    return c.json({
      ...serializePortfolio(p),
      metrics,
      positions: posSummaries,
      positionCount: posSummaries.length,
      ...(p.isVirtual ? {} : { cash: await buildPortfolioCash(database, c.req.header("Authorization") ?? "", p) }),
    })
  })

  // PATCH /api/portfolios/:id — update settings
  routes.patch("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")

    const parsed = UpdatePortfolioSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }

    const [existing] = await database
      .select()
      .from(portfolios)
      .where(and(sql`${portfolios.id} = ${id}`, sql`${portfolios.userId} = ${identity.id}`))

    if (!existing) {
      return c.json({ error: "NotFound", message: "portfolio not found" }, 404)
    }

    const data = parsed.data
    const updates: Record<string, unknown> = { updatedAt: new Date() }
    if (data.name !== undefined) updates.name = data.name
    if (data.description !== undefined) updates.description = data.description
    if (data.baseCurrency !== undefined) updates.baseCurrency = data.baseCurrency.toUpperCase()
    if (data.isPublic !== undefined) updates.isPublic = data.isPublic
    if (data.cashLegOnTrade !== undefined) {
      if (existing.isVirtual && data.cashLegOnTrade) {
        return c.json({ error: "ValidationError", message: "Virtual portfolios cannot use cash legs" }, 422)
      }
      updates.cashLegOnTrade = data.cashLegOnTrade
    }
    if (data.isMarginEnabled !== undefined) updates.isMarginEnabled = data.isMarginEnabled
    if (data.labelId !== undefined) {
      if (!existing.isVirtual) {
        return c.json({ error: "ValidationError", message: "Only virtual portfolios can have a label" }, 422)
      }
      if (!data.labelId) return c.json({ error: "ValidationError", message: "A virtual portfolio requires a label" }, 422)
      const [label] = await database
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.id, data.labelId), eq(labels.userId, identity.id)))
      if (!label) return c.json({ error: "ValidationError", message: "Label not found" }, 422)
      updates.labelId = data.labelId
    }

    const [updated] = await database
      .update(portfolios)
      .set(updates)
      .where(sql`${portfolios.id} = ${id}`)
      .returning()

    return c.json(serializePortfolio(updated) satisfies Portfolio)
  })

  // DELETE /api/portfolios/:id — guarded (D59): 409 while tx or open positions exist
  routes.delete("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")

    const [existing] = await database
      .select()
      .from(portfolios)
      .where(and(sql`${portfolios.id} = ${id}`, sql`${portfolios.userId} = ${identity.id}`))

    if (!existing) {
      return c.json({ error: "NotFound", message: "portfolio not found" }, 404)
    }

    if (!existing.isVirtual) {
      // D59: guarded delete — 409 while transactions or open positions exist.
      const [txCount] = await database
        .select({ count: drizzleCount() })
        .from(portfolioTransactions)
        .where(sql`${portfolioTransactions.portfolioId} = ${id}`)
      if (txCount && txCount.count > 0) {
        return c.json({ error: "Conflict", message: "portfolio has transactions" }, 409)
      }

      const [posCount] = await database
        .select({ count: drizzleCount() })
        .from(positions)
        .where(and(positionInPortfolio(id), eq(positions.isOpen, true)))
      if (posCount && posCount.count > 0) {
        return c.json({ error: "Conflict", message: "portfolio has open positions" }, 409)
      }
    }

    // #115 — deleting the portfolio drops its memberships via the join-table FK
    // cascade. A position left with no membership was owned only by this
    // portfolio, so it is removed too: the pre-m2m schema deleted positions with
    // their portfolio, and that cleanup must not silently start leaking orphan
    // rows once ownership became many-to-many.
    await database.transaction(async (tx) => {
      const members = await tx
        .select({ id: positionPortfolios.positionId })
        .from(positionPortfolios)
        .where(eq(positionPortfolios.portfolioId, id))
      const memberIds = members.map((m) => m.id)
      await tx.delete(portfolios).where(sql`${portfolios.id} = ${id}`)
      if (memberIds.length > 0) {
        const surviving = await tx
          .select({ id: positionPortfolios.positionId })
          .from(positionPortfolios)
          .where(inArray(positionPortfolios.positionId, memberIds))
        const alive = new Set(surviving.map((s) => s.id))
        const orphanIds = memberIds.filter((pid) => !alive.has(pid))
        if (orphanIds.length > 0) {
          await tx
            .delete(positions)
            .where(and(inArray(positions.id, orphanIds), eq(positions.userId, identity.id)))
        }
      }
    })
    return c.body(null, 204)
  })

  // Mount transaction + position routes (Phase C)
  routes.route("/", createTransactionRoutes(getDbInstance()))

  // ── G2: GET /:id/summary-metrics — per-portfolio computed metrics ────

  routes.get("/:id/summary-metrics", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const portfolioId = c.req.param("id") as string

    const [portfolio] = await database
      .select()
      .from(portfolios)
      .where(and(sql`${portfolios.id} = ${portfolioId}`, sql`${portfolios.userId} = ${identity.id}`))

    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const posRows = await database
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.userId, identity.id),
          positionInPortfolio(portfolioId),
          eq(positions.isOpen, true),
        ),
      )

    const cashBal = portfolio.isVirtual
      ? new Map<string, number>()
      : await cashBalances(database, c.req.header("Authorization") ?? "", portfolioId)
    const sumToBase = await fxTo(c.req.header("Authorization") ?? "", portfolio.baseCurrency, new Map(), { strict: true })
    // §68 — this route used to `reduce` marketValue straight into positionValue
    // with NO per-position FX conversion, while the very same response declared
    // `currency: portfolio.baseCurrency` and the contract said every amount on it
    // was denominated in that currency. For a portfolio whose positions are all
    // in one currency the two coincide, which is why it was never noticed; on a
    // multi-currency portfolio the declared currency was a lie. One shared split,
    // each position converted out of its own currency at its own rate.
    const { instrumentsValue: positionValue, cashValue: cashTotal, totalValue, unpricedPositions } =
      await splitPortfolioValue(
        (ccy) => sumToBase(ccy, 1),
        posRows,
        cashBal,
      )
    if (unpricedPositions > 0) {
      console.warn(
        `[summary-metrics] ${portfolioId}: ${unpricedPositions} open position(s) have no market value ` +
        `(market_value IS NULL) and are EXCLUDED from totalValue — not valued at cost.`,
      )
    }
    const pricedRows = posRows.filter((r) => r.marketValue != null)
    const totalCostBasis = posRows.reduce(
      (s, p) => s + Number(p.quantity) * Number(p.averageCostBasis),
      0,
    )
    const unrealizedPnl = posRows.reduce(
      (s, p) => s + (p.unrealizedGainLoss != null ? Number(p.unrealizedGainLoss) : 0),
      0,
    )
    const unrealizedPnlPercent = totalCostBasis > 0 ? (unrealizedPnl / totalCostBasis) * 100 : 0
    const dayChange = posRows.reduce(
      (s, p) => s + (p.dayChange != null ? Number(p.dayChange) : 0),
      0,
    )
    const dayChangePercent = totalValue > 0 ? (dayChange / totalValue) * 100 : 0

    // Realized PnL from SELL transactions
    const sellTxs = await database
      .select()
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.userId, identity.id),
          transactionInPortfolio(portfolioId),
          eq(portfolioTransactions.type, "SELL"),
        ),
      )
    const realizedPnl = sellTxs.reduce(
      (s, t) => s + (t.realizedGainLoss != null ? Number(t.realizedGainLoss) : 0),
      0,
    )

    // Dividend income
    const [divRow] = await database
      .select({
        income: sql<string>`coalesce(sum(${portfolioTransactions.totalAmount}) filter (where ${portfolioTransactions.type} = 'DIVIDEND'), 0)`,
      })
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.userId, identity.id),
          transactionInPortfolio(portfolioId),
        ),
      )
    const cumulativeDividends = Number(divRow?.income ?? 0)

    const totalInvested = Number(portfolio.totalInvested ?? 0)
    // §41/S3 — the card reports BOTH quantities. `capitalBasis` (below) includes
    // in-kind transfers at cost; this does not, and the two answer different
    // questions. It was never reported before, which is how the pair got confused.
    const externalContributions = portfolio.isVirtual
      ? 0
      : await externalCashInvested(
          database, c.req.header("Authorization") ?? "", portfolioId, portfolio.baseCurrency,
        )
    const simpleReturnPercent = totalInvested > 0
      ? Math.round(((totalValue - totalInvested) / totalInvested * 100) * 100) / 100
      : 0

    return c.json({
      // §66.3 — every amount below is denominated in the portfolio's base
      // currency; the contract now requires saying so, because the SPA was
      // guessing (and rendering PLN with a $).
      currency: portfolio.baseCurrency,
      // §68 — positionValue is the instruments component; cashValue is new and
      // makes the split explicit so a card can render both without a second call.
      totalValue: Math.round(totalValue * 100) / 100,
      cashValue: Math.round(cashTotal * 100) / 100,
      // §70.2 — provenance, so the card can say how old this value is.
      unpricedPositions,
      priceAsOf: oldestPriceAsOf(pricedRows),
      priceSource: dominantPriceSource(pricedRows),
      capitalBasis: Math.round(totalInvested * 100) / 100,
      // §41/S3 — the genuinely-external figure, reported separately for the first
      // time. It is a different question from capitalBasis and no field answered it
      // before; conflating the two is what got ADJUSTMENT into trouble (§89.5).
      externalContributions: Math.round(externalContributions * 100) / 100,
      costBasis: Math.round(totalCostBasis * 100) / 100,
      positionValue: Math.round(positionValue * 100) / 100,
      simpleReturnPercent,
      investmentReturnPercent: simpleReturnPercent,
      currencyImpactPercent: 0,
      unrealizedGainLoss: Math.round(unrealizedPnl * 100) / 100,
      realizedGain: Math.round(realizedPnl * 100) / 100,
      cumulativeDividends: Math.round(cumulativeDividends * 100) / 100,
      totalDividends: Math.round(cumulativeDividends * 100) / 100,
      dayChangeAmount: Math.round(dayChange * 100) / 100,
      dayChangePercent: Math.round(dayChangePercent * 100) / 100,
      dayChangeDate: new Date().toISOString(),
      weight: 0,
      positionCount: posRows.length,
    } satisfies components["schemas"]["PortfolioSummaryMetrics"] & { weight: number; positionCount: number })
  })

  routes.post("/:id/recompute", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const database = getDbInstance()

    // Verify portfolio belongs to user
    const [pf] = await database
      .select({ id: portfolios.id, isVirtual: portfolios.isVirtual })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)
    // Two modes (2026-09-27) over one shared core (computeSnapshotBatch):
    // default = FULL delete+rebuild (manual recompute after data fixes — no
    // stale rows can survive); ?mode=upsert = ADDITIVE (upsert computed days,
    // never delete) — what the scheduled refresh job uses, so a mid-day pass
    // that fails can't erase a day it didn't recomputed.
    //
    // §76.5 — the additive mode used to call `runBackfillRecent`, which was
    // WRONG for a user-facing "refresh now" and §76.5's check caught it: pressing
    // the button issued the POST, the UI went through its states, and nothing in
    // the database moved. `runBackfillRecent` re-values the series from prices
    // ALREADY STORED on the positions — it never calls instruments. So the button
    // re-derived yesterday's numbers and called it fresh. The force mode it
    // replaced happened to fetch quotes (its tail runs `refreshQuotesUnlocked`),
    // so moving the control to upsert silently removed the pricing it had.
    //
    // `recalcPortfolioSeries` is the same additive pass WITH the pricing tail —
    // the one the mutation queue uses since §76.3 — so "refresh now" prices and
    // then re-values, which is precisely what `snapshots-sync` does for the fleet
    // (refreshQuotes, then the additive backfill). It must be called INSIDE
    // `enqueueBackfill` because it takes the abort signal and does not enqueue
    // itself; nesting an enqueue behind the pass awaiting it would self-deadlock
    // (the reason `refreshQuotesUnlocked` exists as a separate export).
    if (c.req.query("mode") === "upsert") {
      const token = c.req.header("Authorization") ?? ""
      void enqueueBackfill(id, (signal) => recalcPortfolioSeries(database, id, token, new Date(), signal)).catch(
        () => undefined,
      )
    } else {
      void forcePortfolioRecalc(database, id, c.req.header("Authorization") ?? "").catch(() => undefined)
    }
    return c.json({ backfillStatus: "pending" } satisfies components["schemas"]["BackfillRecomputeResponse"])
  })

  routes.get("/:id/analytics", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const timeframe = c.req.query("timeframe") || "1Y"
    const benchmarkCalcType = c.req.query("benchmarkCalcType") || "timeWeighted"
    const benchmarkParam = c.req.query("benchmarks")
    const benchmarkSymbols = benchmarkParam
      ? benchmarkParam.split(",").map((s) => s.trim()).filter(Boolean)
      : []
    const database = getDbInstance()

    // Verify portfolio belongs to user
    const [pf] = await database
      .select({ id: portfolios.id, baseCurrency: portfolios.baseCurrency, isVirtual: portfolios.isVirtual })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound" }, 404)

    const [virtualSnapshotCount] = await database
      .select({ count: drizzleCount() })
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, id))
    if (pf.isVirtual && virtualSnapshotCount.count < 2) {
      const posRows = await database
        .select()
        .from(positions)
        .where(and(eq(positions.userId, identity.id), positionInPortfolio(id), eq(positions.isOpen, true)))
      const toBase = await fxTo(c.req.header("Authorization") ?? "", pf.baseCurrency, new Map(), { strict: true })
      const value = await splitPortfolioValue(toBase, posRows, new Map())
      const [firstTransaction] = await database
        .select({ date: sql<string>`min(${portfolioTransactions.executedAt})` })
        .from(portfolioTransactions)
        .where(and(eq(portfolioTransactions.userId, identity.id), transactionInPortfolio(id)))
      const now = new Date()
      const endDate = now.toISOString()
      const firstDate = firstTransaction?.date ? new Date(firstTransaction.date) : new Date(now.getTime() - 86_400_000)
      const startDate = firstDate < now ? firstDate.toISOString() : new Date(now.getTime() - 86_400_000).toISOString()
      const currentValue = Math.round(value.totalValue * 100) / 100
      return c.json({
        timeframe,
        backfillStatus: "complete",
        gapSymbols: null,
        heldGapSymbols: null,
        fxCoverageHoles: null,
        performance: {
          timeSeries: [{ date: startDate, value: currentValue }, { date: endDate, value: currentValue }],
          totalValue: currentValue,
          capitalBasis: 0,
          totalReturn: currentValue,
          totalReturnPercent: 0,
          monthlyReturns: [],
          timeWeightedReturn: null,
          moneyWeightedReturn: null,
          simpleReturnPercent: null,
          annualizedReturn: null,
          annualizedReturnWithheldReason: "insufficient_history",
        },
        benchmarks: [],
      })
    }

    // Check how many snapshot rows exist
    const [{ n }] = await database
      .select({ n: drizzleCount() })
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, id))

    if (n < 2 && (await hasBackfillableHistory(database, id))) {
      // §72.7 — this fired a backfill from a GET too; removed for the same reason
      // as the dashboard, and with the same consequence. `enqueueBackfill` keys
      // its queue by portfolioId and REPLACES a queued pass's run function, so
      // opening a portfolio's CHART mid-rebuild would downgrade the import's
      // `recalcPortfolioHistory` (which ends with a pricing pass, §72.6) to a
      // plain `runBackfill` (which does not) — the exact shape that left 51
      // positions unpriced on 2026-09-28. Fixing only the dashboard was not
      // enough: this route is a GET too, and it is the one a user hits when they
      // click into a portfolio while the rebuild is still running.
      //
      // The pending DETECTION stays — reporting "still rebuilding" is a read, and
      // the chart needs it to render an empty state rather than a wrong series.
      // A portfolio whose history is genuinely empty is repaired by
      // POST /:id/recompute, which is where asking for a rebuild belongs.
      return c.json({
        timeframe,
        backfillStatus: "pending",
        performance: { timeSeries: [], totalValue: 0, capitalBasis: 0, totalReturn: 0, totalReturnPercent: 0, monthlyReturns: [] },
        benchmarks: [],
      })
    }

    // Filter by timeframe
    const cutoff = timeframeCutoff(timeframe)
    const rows = await database
      .select({
        snapshotDate: valueSnapshots.snapshotDate,
        value: valueSnapshots.value,
        invested: valueSnapshots.invested,
        // §78.5 / §72.31 — the two withheld amounts, read back so the chart can
        // attribute a step to a specific day.
        unpricedValue: valueSnapshots.unpricedValue,
        carriedValue: valueSnapshots.carriedValue,
        cumulativeTwr: valueSnapshots.cumulativeTwr,
        cumulativeMwr: valueSnapshots.cumulativeMwr,
        cumulativeSimple: valueSnapshots.cumulativeSimple,
      })
      .from(valueSnapshots)
      .where(cutoff
        ? and(eq(valueSnapshots.portfolioId, id), sql`${valueSnapshots.snapshotDate} >= ${cutoff}`)
        : eq(valueSnapshots.portfolioId, id))
      .orderBy(asc(valueSnapshots.snapshotDate))

    const timeSeries = rows.map((r) => ({
      date: r.snapshotDate,
      value: Number(r.value),
      // Cumulative net money-in (same currency as value) — the "invested"
      // line the performance chart overlays (value − invested = profit).
      invested: Number(r.invested),
      // §78.5 — how much of `value` is NOT here. Absent rather than 0 on a
      // pre-migration row: `unpriced_value` defaults to 0, so a row written
      // before the column existed reads as "nothing withheld", which is the
      // opposite of true for the portfolios that most need it. `undefined`
      // lets the UI say "unknown" instead of "complete".
      unpricedValue: r.unpricedValue === null ? undefined : Number(r.unpricedValue),
      // §72.31 — same treatment: absent means "not measured", and both columns
      // default to 0, so coercing would claim "nothing withheld" on a
      // pre-migration row.
      carriedValue: r.carriedValue === null ? undefined : Number(r.carriedValue),
      cumulativeTwr: r.cumulativeTwr !== null ? Number(r.cumulativeTwr) : undefined,
      cumulativeMwr: r.cumulativeMwr !== null ? Number(r.cumulativeMwr) : undefined,
      cumulativeSimple: r.cumulativeSimple !== null ? Number(r.cumulativeSimple) : undefined,
    }))
    const lastRow = rows[rows.length - 1]
    const firstRow = rows[0]
    const totalValue = Number(lastRow?.value ?? 0)
    const capitalBasis = Number(lastRow?.invested ?? 0)
    const totalReturn = totalValue - capitalBasis
    const totalReturnPercent = capitalBasis > 0 ? (totalReturn / capitalBasis) * 100 : 0

    // Monthly returns: month-over-month growth of the flow-adjusted TWR index
    const monthlyReturns = buildMonthlyReturns(rows.map((r) => ({ date: r.snapshotDate, cumulativeTwr: r.cumulativeTwr === null ? null : Number(r.cumulativeTwr) })))

    // §82.1 — TWR p.a. for the Performance tab's tile, read off the SAME stored
    // flow-neutral index the month-over-month bars above are built from. §81.2
    // owns both the annualisation arithmetic and the withholding predicate, so
    // this route only calls them; a third annualiser here would be a third
    // answer to one question, and the Risk tab and this tile would be free to
    // disagree about the same window.
    //
    // Rows with no `cumulative_twr` are dropped, not coerced: a 0 in the index
    // is a −100% day, not a gap.
    const twrPoints = rows.flatMap((r) =>
      r.cumulativeTwr === null ? [] : [{ date: r.snapshotDate, index: Number(r.cumulativeTwr) }],
    )
    const twrIndex = twrPoints.map((p) => p.index)
    const twrDates = twrPoints.map((p) => p.date)
    const annualizedReturnWithheld = annualizedReturnWithheldReason(twrIndex, twrDates)
    // A PERCENT, matching every sibling in `performance.*` (totalReturnPercent,
    // moneyWeightedReturn and timeWeightedReturn are all percents). `/risk-metrics`
    // returns a FRACTION under the same contract field name — a unit split this
    // section accepted deliberately, recorded here because a consumer reading both
    // routes renders one of them 100× out.
    const annualizedReturnPercent =
      annualizedReturnWithheld === null
        ? Math.round(annualizedReturn(twrIndex, twrDates) * 10000) / 100
        : null

    // Benchmarks: mirror the portfolio's cash flows into each requested ticker
    // (D50) — BUYs invest cash in the benchmark, SELLs release it, seed = the
    // portfolio's invested capital at the window start. Unknown tickers dropped.
    let benchmarks: Array<NonNullable<components["schemas"]["PortfolioAnalytics"]["benchmarks"]>[number]> = []
    if (benchmarkSymbols.length > 0 && firstRow && lastRow) {
      const from = firstRow.snapshotDate
      const to = lastRow.snapshotDate
      const baseCurrency = pf.baseCurrency
      const flows = await dailyExternalFlows(database, c.req.header("Authorization") ?? "", id, from, to, baseCurrency)
      const seedInvested = Number(firstRow.invested ?? 0)
      const calcType = (["moneyWeighted", "timeWeighted", "simple"] as const).includes(
        benchmarkCalcType as "moneyWeighted" | "timeWeighted" | "simple",
      )
        ? (benchmarkCalcType as "moneyWeighted" | "timeWeighted" | "simple")
        : "timeWeighted"
      const authToken = c.req.header("Authorization") ?? ""
      const series = await Promise.all(
        benchmarkSymbols.map((sym) =>
          buildBenchmarkSeries(sym, from, to, authToken, sym, {
            db: database,
            portfolioId: id,
            baseCurrency,
            flows,
            seedInvested,
            calcType,
          }),
        ),
      )
      benchmarks = series
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => ({ symbol: s.symbol, name: s.name, timeSeries: s.timeSeries, returnPercent: s.returnPercent, volatility: s.volatility }))
    }

    // §63.8 — held positions the latest backfill pass had no price bar for.
    // §72.30 — the two are different claims and both are returned: `gapSymbols`
    // says the stored HISTORY is a partial sum, `heldGapSymbols` says the value
    // in front of the user right now is short. Conflating them produced a banner
    // that reported 7 missing positions on a portfolio whose current value was
    // complete (all 7 were closed positions).
    const { gapSymbols, heldGapSymbols, fxCoverageHoles } = await getGapSymbols(database, id)

    return c.json({
      timeframe,
      backfillStatus: "complete",
      gapSymbols,
      heldGapSymbols,
      // §72.21 — a THIRD claim, and the only one about steps in the middle of the
      // series rather than at its ends. `gapSymbols` catches a prefix hole (reads as
      // "no history"); `heldGapSymbols` catches "today is short". Neither can see a
      // symbol that is priced every day except a few, which is the shape §72.17 took
      // and the one that renders as a fake return.
      fxCoverageHoles,
      performance: {
        timeSeries,
        totalValue,
        capitalBasis,
        totalReturn,
        totalReturnPercent,
        monthlyReturns,
        // Scalar return values derived from the last pre-computed cumulative index point
        timeWeightedReturn: timeSeries.length > 0 && timeSeries[timeSeries.length - 1].cumulativeTwr !== undefined
          ? Math.round(((timeSeries[timeSeries.length - 1].cumulativeTwr! - 100)) * 100) / 100
          : null,
        moneyWeightedReturn: timeSeries.length > 0 && timeSeries[timeSeries.length - 1].cumulativeMwr !== undefined
          ? Math.round(((timeSeries[timeSeries.length - 1].cumulativeMwr! - 100)) * 100) / 100
          : null,
        simpleReturnPercent: timeSeries.length > 0 && timeSeries[timeSeries.length - 1].cumulativeSimple !== undefined
          ? Math.round(((timeSeries[timeSeries.length - 1].cumulativeSimple! - 100)) * 100) / 100
          : null,
        // §82.1 — declared in the contract since D86 but never returned here, so
        // the SPA had nothing to render a TWR p.a. tile from.
        annualizedReturn: annualizedReturnPercent,
        annualizedReturnWithheldReason: annualizedReturnWithheld,
      },
      benchmarks,
    })
  })

  routes.get("/:id/dividends", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")

    const [pf] = await database
      .select({ id: portfolios.id, isVirtual: portfolios.isVirtual })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    // §49.3: aggregate the portfolio's REAL DIVIDEND transactions (gross =
    // quantity × price, amount = net = gross − taxes), newest first. Country
    // for the ticker comes from the joined position (#116), not the row.
    const rows = await database
      .select({ tx: portfolioTransactions, country: positions.country })
      .from(portfolioTransactions)
      .leftJoin(positions, eq(portfolioTransactions.positionId, positions.id))
      .where(
        and(
          eq(portfolioTransactions.portfolioId, id),
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.type, "DIVIDEND"),
        ),
      )
      .orderBy(desc(portfolioTransactions.executedAt))

    const items = rows.map(({ tx: r, country }) => {
      const quantity = Number(r.quantity)
      const gross = round2(quantity * Number(r.price))
      const taxes = r.taxes != null ? Number(r.taxes) : null
      const amount = Math.round((gross - (taxes ?? 0)) * 1e8) / 1e8
      const exchangeRate = r.exchangeRate != null ? Number(r.exchangeRate) : null
      return {
        symbol: r.instrumentSymbol,
        instrumentName: r.instrumentName,
        // §61.3 — the dividend feeds the shared identity block (TickerBadge).
        // Country comes from the joined position; null, never guessed.
        assetType: r.assetType ?? null,
        country: country ?? null,
        date: r.executedAt?.toISOString?.() ?? r.executedAt,
        quantity,
        gross,
        taxes,
        amount,
        currency: r.currency,
        exchangeRate,
        convertedAmount: exchangeRate != null ? round2(amount * exchangeRate) : null,
        notes: r.notes ?? null,
      }
    })

    const count = items.length
    const totalDividends = round2(items.reduce((s, it) => s + (it.convertedAmount ?? it.amount), 0))

    return c.json({ totalDividends, count, items })
  })

  routes.get("/:id/calendar", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const holdings = await getPortfolioCalendar(
      getDbInstance(),
      id,
      identity.id,
      c.req.header("Authorization") ?? "",
    )
    return c.json({ holdings } satisfies components["schemas"]["CalendarData"])
  })

  routes.get("/:id/news", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const limitParam = Number(c.req.query("limit"))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 100) : 50
    const out = await getPortfolioNews(
      getDbInstance(),
      id,
      identity.id,
      c.req.header("Authorization") ?? "",
      limit,
    )
    return c.json(out satisfies components["schemas"]["NewsArticleList"])
  })

  routes.get("/:id/compare", (c) => {
    return c.json({ portfolios: [], timeframe: "1Y" })
  })

  routes.get("/:id/risk-metrics", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const timeframe = c.req.query("timeframe") || "1Y"
    const database = getDbInstance()

    // Verify ownership
    const [pf] = await database
      .select({ id: portfolios.id, isVirtual: portfolios.isVirtual })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound" }, 404)
    const [virtualSnapshotCount] = await database
      .select({ count: drizzleCount() })
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, id))
    if (pf.isVirtual && virtualSnapshotCount.count < 2) {
      return c.json({
        sharpeRatio: 0,
        sortinoRatio: 0,
        calmarRatio: 0,
        volatility: 0,
        maxDrawdown: 0,
        winRate: 0,
        periodReturnPercent: 0,
        annualizedReturn: null,
        annualizedReturnWithheldReason: "insufficient_history",
        moneyWeightedReturn: null,
        moneyWeightedReturnWithheldReason: "insufficient_history",
      } satisfies components["schemas"]["PortfolioRiskMetrics"])
    }

    // Fetch snapshot series filtered by timeframe
    const cutoff = timeframeCutoff(timeframe)
    const rows = await database
      .select({
        snapshotDate: valueSnapshots.snapshotDate,
        value: valueSnapshots.value,
        netFlow: valueSnapshots.netFlow,
        cumulativeTwr: valueSnapshots.cumulativeTwr,
        cumulativeMwr: valueSnapshots.cumulativeMwr,
      })
      .from(valueSnapshots)
      .where(
        cutoff
          ? and(eq(valueSnapshots.portfolioId, id), sql`${valueSnapshots.snapshotDate} >= ${cutoff}`)
          : eq(valueSnapshots.portfolioId, id),
      )
      .orderBy(asc(valueSnapshots.snapshotDate))

    const values = rows.map((r) => Number(r.value))
    const flows = rows.map((r) => Number(r.netFlow))
    const dates = rows.map((r) => r.snapshotDate)

    // §81.1 — risk metrics must be flow-neutral: a deposit moves `value` with
    // no market move behind it, and deriving returns from `value` booked every
    // cash flow as a return.
    const returns = buildDailyReturns(values, flows)

    // Use pre-computed MWR index as the money-weighted return scalar (last point − 100)
    const lastMwr = rows.length > 0 ? rows[rows.length - 1].cumulativeMwr : null
    const mwrPercent = lastMwr !== null ? Math.round((Number(lastMwr) - 100) * 100) / 100 : null

    const metrics = computeRiskMetrics(returns, dates)

    return c.json({
      sharpeRatio: metrics.sharpeRatio,
      sortinoRatio: metrics.sortinoRatio,
      calmarRatio: metrics.calmarRatio,
      volatility: metrics.volatility,
      maxDrawdown: metrics.maxDrawdown,
      winRate: metrics.winRate,
      periodReturnPercent: metrics.periodReturnPercent,
      annualizedReturn: metrics.annualizedReturn,
      annualizedReturnWithheldReason: metrics.annualizedReturnWithheldReason,
      moneyWeightedReturn: mwrPercent,
      moneyWeightedReturnWithheldReason: null,
    } satisfies components["schemas"]["PortfolioRiskMetrics"])
  })

  return routes
}

// ── G3: Public share view (auth-exempt) ──────────────────────────────────
// Exported separately to mount without auth middleware.

export function createPublicShareRoutes(db?: DB) {
  const routes = new Hono()

  routes.get("/:shareId", async (c) => {
    const database = db ?? getDb()
    const shareId = c.req.param("shareId") as string

    const [share] = await database!
      .select()
      .from(shares)
      .where(eq(shares.id, shareId))

    if (!share) {
      return c.json({ error: "NotFound", message: "Share not found" }, 404)
    }

    // Increment view count
    await database!
      .update(shares)
      .set({ viewCount: sql`${shares.viewCount} + 1`, updatedAt: new Date() })
      .where(eq(shares.id, shareId))

    const [portfolio] = await database!
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, share.portfolioId))

    if (!portfolio) {
      return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)
    }

    const privacy = share.privacySettings as Record<string, unknown>

    return c.json({
      shareId: share.id,
      displayName: share.displayName || portfolio.name,
      privacySettings: privacy,
      portfolio: {
        name: portfolio.name,
        description: portfolio.description,
        currency: portfolio.baseCurrency,
      },
    })
  })

  return routes
}
