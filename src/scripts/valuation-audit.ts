/**
 * §71 — valuation audit: report positions whose stored metadata contradicts the
 * evidence already in the database.
 *
 * CRI.WA carried `instrument_currency = 'CAD'` for months while both of its BUY
 * transactions said `PLN`. Nothing failed: the value was multiplied by 2.7131,
 * the aggregate still looked plausible, and the stored snapshots (built from
 * pre-converted price bars) disagreed with the live figure by 18% without
 * either side raising. The contradiction was sitting in two columns of the same
 * table, and nothing read both.
 *
 * Two checks, both read-only:
 *
 *   1. CURRENCY — does a position's currency match the currency on its own
 *      transactions? The import writes both from the same source row, so a
 *      disagreement means something later overwrote one of them.
 *   2. RECONCILIATION — does the live valuation of a portfolio match the stored
 *      snapshot for the same day? This is the invariant the UI depends on and
 *      the one the currency bug violated. It does NOT try to name the offending
 *      currency from the size of the gap: a portfolio total is a sum, so one
 *      mislabelled position out of thirteen moves it by a fraction of an FX
 *      rate, not by the rate itself. A ratio heuristic would look authoritative
 *      and essentially never fire. Check 1 is the per-position detector, and it
 *      is the one that actually found this.
 *
 * Run:  node dist/scripts/valuation-audit.js [--tolerance 0.02] [--json]
 * Exit:  0 clean · 1 findings · 2 could not run (never reports "clean" on error)
 */
import { and, eq, sql } from "drizzle-orm"
import { getDb, closeDb } from "../db/index.js"
import { portfolios, portfolioTransactions, portfolioCashTransactions, positions, valueSnapshots } from "../db/schema.js"
import { resolveServiceToken, fxTo } from "../services/instruments-fx.js"
import { splitPortfolioValue } from "../services/valuation.js"
import { cashBalances } from "../services/cashLedger.js"

/** A live/stored divergence above this fraction of the stored value is reported. */
const DEFAULT_TOLERANCE = 0.02
export interface CurrencyFinding {
  kind: "currency-mismatch"
  portfolioId: string
  portfolioName: string
  symbol: string
  storedCurrency: string
  transactionCurrencies: string[]
}

export interface ReconciliationFinding {
  kind: "reconciliation-gap"
  portfolioId: string
  portfolioName: string
  snapshotDate: string
  storedValue: number
  liveValue: number
  delta: number
  deltaPct: number
}

export type Finding = CurrencyFinding | ReconciliationFinding | UnfundedFinding

export interface UnfundedFinding {
  kind: "unfunded-portfolio"
  portfolioId: string
  portfolioName: string
  tradeCount: number
  /**
   * The cash the portfolio's own trades imply it must have been funded with.
   * A portfolio holding positions but with no external inflow is valued against
   * a ledger that starts at zero, so its cash is negative by everything ever
   * spent and every stored value is offset.
   */
  impliedFunding: number
  minBalance: number
}

/**
 * §72.32 — portfolios that hold positions but were never funded in the import.
 *
 * `cashBalances` starts from an empty map and adds trade effects plus external
 * cash rows, so a portfolio whose opening deposit was never imported is not
 * merely "missing data" — it is valued as though the money never arrived, and its
 * whole value history comes out negative.
 *
 * PROD (XTB): 22 trades, 0 cash rows, 1680 negative snapshots, `invested = 0` on
 * every day (so its TWR/MWR is meaningless too). Quantities balanced exactly, so
 * the arithmetic was right and only the funding was absent.
 */
export function findUnfundedPortfolios(
  rows: Array<{
    portfolioId: string
    portfolioName: string
    tradeCount: number
    externalInflow: number
    impliedFunding: number
    minBalance: number
  }>,
): UnfundedFinding[] {
  const out: UnfundedFinding[] = []
  for (const r of rows) {
    // Has trades, nothing ever put money in, and the ledger is running negative.
    if (r.tradeCount <= 0) continue
    if (Math.abs(r.externalInflow) > 1e-6) continue
    if (!(r.minBalance < -1e-6)) continue
    out.push({
      kind: "unfunded-portfolio",
      portfolioId: r.portfolioId,
      portfolioName: r.portfolioName,
      tradeCount: r.tradeCount,
      impliedFunding: r.impliedFunding,
      minBalance: r.minBalance,
    })
  }
  return out
}

/** §72.32 — sweep for portfolios whose opening cash was never imported. */
export async function auditUnfunded(
  db: Awaited<ReturnType<typeof getDb>>,
  authToken: string,
) {
  // Candidate set in SQL: has trades, and nothing ever put money in. The balance
  // is then read through the real ledger rather than re-derived here — the
  // negative comes from the *trade* cash effects, not the cash rows, and
  // re-implementing that arithmetic in SQL is exactly how it drifts.
  const rows = await db
    .select({
      portfolioId: portfolioTransactions.portfolioId,
      portfolioName: portfolios.name,
      tradeCount: sql<string>`count(*)::text`,
      impliedFunding: sql<string>`coalesce(sum(${portfolioTransactions.totalAmount}) FILTER (WHERE ${portfolioTransactions.type} = 'BUY'), 0)::text`,
    })
    .from(portfolioTransactions)
    .innerJoin(portfolios, eq(portfolioTransactions.portfolioId, portfolios.id))
    .groupBy(portfolioTransactions.portfolioId, portfolios.name)
    .where(
      sql`coalesce((SELECT sum(c.amount) FROM ${portfolioCashTransactions} c
                     WHERE c.portfolio_id = ${portfolioTransactions.portfolioId}
                       AND c.type IN ('DEPOSIT','TRANSFER') AND c.amount > 0), 0) = 0`,
    )

  const out: UnfundedFinding[] = []
  for (const r of rows) {
    const balances = await cashBalances(db, authToken, r.portfolioId)
    let minBalance = 0
    for (const v of balances.values()) minBalance = Math.min(minBalance, v)
    out.push(
      ...findUnfundedPortfolios([
        {
          portfolioId: r.portfolioId,
          portfolioName: r.portfolioName,
          tradeCount: Number(r.tradeCount),
          externalInflow: 0,
          impliedFunding: Number(r.impliedFunding),
          minBalance,
        },
      ]),
    )
  }
  return out
}

/**
 * Pure comparison, exported so the rules are testable without a database.
 *
 * The audit REPORTS and never rewrites. Correcting a currency here would repeat
 * the very defect it exists to catch: the right value is a claim about which
 * source to believe, and this function is deliberately not in a position to make
 * it.
 */
export function findCurrencyMismatches(
  rows: Array<{ portfolioId: string; portfolioName: string; symbol: string; storedCurrency: string; transactionCurrencies: string[] }>,
): CurrencyFinding[] {
  return rows
    .filter((r) => {
      const stored = (r.storedCurrency ?? "").trim().toUpperCase()
      const seen = new Set(r.transactionCurrencies.map((c) => c.trim().toUpperCase()).filter(Boolean))
      // Only a genuine contradiction counts. A position with no currency-bearing
      // trade history cannot be checked and says nothing either way.
      //
      // The test is "the position cites a currency NONE of its trades used" —
      // not "some trade differs". I widened it to the latter and the first PROD
      // run returned 11 findings of which 8 were noise: these accounts buy
      // foreign listings paying in PLN, so AVGO reads USD against trades in
      // PLN/USD and 0M6S.IL reads EUR against EUR/PLN. Both are correct. Being
      // paid in a different currency than a stock trades in is the normal case,
      // not a defect, and a rule that flags it is worse than no rule.
      if (stored === "" || seen.size === 0) return false
      return !seen.has(stored)
    })
    .map((r) => ({
      kind: "currency-mismatch" as const,
      portfolioId: r.portfolioId,
      portfolioName: r.portfolioName,
      symbol: r.symbol,
      storedCurrency: (r.storedCurrency ?? "").trim().toUpperCase(),
      transactionCurrencies: [...new Set(r.transactionCurrencies.map((c) => c.trim().toUpperCase()))].sort(),
    }))
}

export function findReconciliationGaps(
  rows: Array<{
    portfolioId: string
    portfolioName: string
    snapshotDate: string
    storedValue: number
    liveValue: number
    tolerance?: number
  }>,
): ReconciliationFinding[] {
  const out: ReconciliationFinding[] = []
  for (const r of rows) {
    if (!(r.storedValue > 0)) continue // a zero baseline has no ratio to judge
    const delta = r.liveValue - r.storedValue
    const deltaPct = delta / r.storedValue
    if (Math.abs(deltaPct) <= (r.tolerance ?? DEFAULT_TOLERANCE)) continue
    out.push({
      kind: "reconciliation-gap",
      portfolioId: r.portfolioId,
      portfolioName: r.portfolioName,
      snapshotDate: r.snapshotDate,
      storedValue: r.storedValue,
      liveValue: r.liveValue,
      delta,
      deltaPct,
    })
  }
  return out
}

/** Positions whose currency disagrees with the currency on their own trades. */
export async function auditCurrencies(db: Awaited<ReturnType<typeof getDb>>) {
  return db
    .select({
      portfolioId: positions.portfolioId,
      portfolioName: portfolios.name,
      symbol: positions.symbol,
      storedCurrency: positions.instrumentCurrency,
      transactionCurrencies: sql<string[]>`array_agg(distinct ${portfolioTransactions.instrumentCurrency})`,
    })
    .from(positions)
    .innerJoin(portfolios, eq(positions.portfolioId, portfolios.id))
    .innerJoin(
      portfolioTransactions,
      and(
        eq(portfolioTransactions.portfolioId, positions.portfolioId),
        eq(portfolioTransactions.instrumentSymbol, positions.symbol),
      ),
    )
    .where(eq(positions.isOpen, true))
    .groupBy(positions.id, portfolios.name)
    .then((rows) => findCurrencyMismatches(rows as never))
}

/** Live valuation vs the stored snapshot for the same day, per portfolio. */
export async function auditReconciliation(
  db: Awaited<ReturnType<typeof getDb>>,
  authToken: string,
  tolerance: number,
) {
  const pfs = await db.select().from(portfolios)
  const out: ReconciliationFinding[] = []

  for (const p of pfs) {
    const base = p.baseCurrency.toUpperCase()
    // strict:false — this is a report. An unresolvable rate must degrade to a
    // visible wrong-looking number we then flag, not abort the whole audit.
    const toBase = await fxTo(authToken, base, new Map(), { strict: false })
    const posRows = await db
      .select({
        marketValue: positions.marketValue,
        quantity: positions.quantity,
        averageCostBasis: positions.averageCostBasis,
        instrumentCurrency: positions.instrumentCurrency,
      })
      .from(positions)
      .where(and(eq(positions.portfolioId, p.id), eq(positions.isOpen, true)))

    const split = await splitPortfolioValue(toBase, posRows, await cashBalances(db, authToken, p.id))
    if (split.unpricedPositions > 0) continue // an incomplete total cannot be compared

    // The most recent stored day: a snapshot for "today" only exists once
    // something has written one, and comparing against a stale day would flag
    // ordinary market movement as a defect.
    const [snap] = await db
      .select({ snapshotDate: valueSnapshots.snapshotDate, value: valueSnapshots.value })
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, p.id))
      .orderBy(sql`${valueSnapshots.snapshotDate} desc`)
      .limit(1)
    if (!snap) continue

    out.push(
      ...findReconciliationGaps(
        [
          {
            portfolioId: p.id,
            portfolioName: p.name,
            snapshotDate: String(snap.snapshotDate).slice(0, 10),
            storedValue: Number(snap.value),
            liveValue: split.totalValue,
            tolerance,
          },
        ],
      ),
    )
  }
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const toleranceArg = argv.indexOf("--tolerance")
  const tolerance = toleranceArg >= 0 ? Number(argv[toleranceArg + 1]) : DEFAULT_TOLERANCE
  const asJson = argv.includes("--json")

  const db = await getDb()
  try {
    // The sweep has no user identity, so it authenticates as a service (§63.10).
    const token = resolveServiceToken()
    const findings: Finding[] = [
      ...(await auditCurrencies(db)),
      ...(await auditReconciliation(db, token, tolerance)),
      ...(await auditUnfunded(db, token)),
    ]

    if (asJson) {
      console.log(JSON.stringify({ tolerance, findings }, null, 2))
    } else if (findings.length === 0) {
      console.log(`[valuation-audit] clean — no currency, reconciliation or funding findings (tolerance ${(tolerance * 100).toFixed(1)}%)`)
    } else {
      for (const f of findings) {
        if (f.kind === "currency-mismatch") {
          console.log(
            `[valuation-audit] CURRENCY pf=${f.portfolioName} ${f.symbol}: position says ${f.storedCurrency}, ` +
              `its transactions say ${f.transactionCurrencies.join("/")} — a currency discrepancy multiplies this ` +
              `position's value by the FX factor.`,
          )
        } else if (f.kind === "reconciliation-gap") {
          console.log(
            `[valuation-audit] RECONCILE pf=${f.portfolioName} ${f.snapshotDate}: stored ${f.storedValue.toFixed(2)} ` +
              `vs live ${f.liveValue.toFixed(2)} (${(f.deltaPct * 100).toFixed(1)}%) — ` +
              `check the CURRENCY findings above first: one mislabelled position moves a ` +
              `portfolio total by its FX factor without looking wrong.`,
          )
        } else {
          console.log(
            `[valuation-audit] UNFUNDED pf=${f.portfolioName}: ${f.tradeCount} trades but no DEPOSIT/TRANSFER ` +
              `anywhere in the import, and the cash ledger bottoms out at ${f.minBalance.toFixed(2)}. Those trades ` +
              `imply about ${f.impliedFunding.toFixed(2)} of funding that was never imported, so this portfolio's ` +
              `whole value history is offset and can go negative. Add the opening deposit to the source data.`,
          )
        }
      }
      console.log(`[valuation-audit] ${findings.length} finding(s). Nothing was modified.`)
    }
    // 2, not 0, when the audit itself could not run: an audit that cannot check
    // must never be mistaken for an audit that found nothing.
    process.exit(findings.length > 0 ? 1 : 0)
  } catch (e) {
    console.error(`[valuation-audit] could not run: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  } finally {
    await closeDb()
  }
}

if (process.argv[1]?.endsWith("valuation-audit.js") || process.argv[1]?.endsWith("valuation-audit.ts")) {
  void main()
}
