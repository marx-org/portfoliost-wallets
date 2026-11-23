import { and, eq, gte, inArray, lt, lte } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import {
  chartEventFacts,
  chartPositionDaily,
  chartProjectionState,
  portfolioCashTransactions,
  portfolioTransactions,
  portfolios,
} from "../../db/schema.js"
import {
  buildPriceMap,
  calendarDays,
  fetchPriceSeries,
  type PriceBarSeries,
} from "../backfill.js"
import {
  LOT_CLOSING_TYPES,
  LOT_OPENING_TYPES,
  quantitySign,
} from "../../transaction-types.js"
import { toDateStr } from "../cashLedger.js"

/**
 * Charting projection writer (feature #253/#254). Rebuilds the rebuildable
 * facts for one portfolio: per-position daily value/basis/income/realized and
 * the normalized income/cash event facts.
 *
 * Attribution is per (portfolio, position): quantities and cost are replayed
 * from the transactions that belong to that position through the canonical
 * owner (portfolio_transactions), never by multiplying a global position
 * quantity by every membership row. Prices are fetched once per symbol and
 * reused; this never runs on a chart read — only on an explicit recompute.
 */

type FetchPriceBars = (
  symbol: string,
  from: string,
  to: string,
  authToken: string,
  signal?: AbortSignal,
  currency?: string,
  baseCcy?: string,
  includePrevious?: boolean,
) => Promise<PriceBarSeries | null>

export interface BuildChartFactsOptions {
  /** Generation to write. A rebuild writes a fresh generation; readers pin one. */
  generation: number
  /** Window start (YYYY-MM-DD); null means the whole history. Default: earliest trade/cash date. */
  from?: string | null
  /** Window end (YYYY-MM-DD); default is yesterday. */
  to?: string
  /** Injectable price fetcher (tests); defaults to the instruments fetcher. */
  fetcher?: FetchPriceBars
  signal?: AbortSignal
  now?: Date
}

export interface BuildChartFactsResult {
  positionRows: number
  eventRows: number
  days: number
}

const QUANTITY_TYPES = [...LOT_OPENING_TYPES, ...LOT_CLOSING_TYPES]
// DIVIDEND is not a quantity-moving type but carries received income, so the
// replay reads it too (quantitySign returns 0 for it).
const REPLAY_TYPES = [...QUANTITY_TYPES, "DIVIDEND"]
const KNOWN_CURRENCY = /^[A-Z]{3}$/
const MS_DAY = 86_400_000

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Rebuild the charting facts for one portfolio at `generation`, over the
 * `[from, to]` window. Only that window is replaced, so a refresh pass can
 * extend or restate a slice of history without wiping days it did not recompute;
 * with no window it is a full rebuild. The publish is a single transaction.
 * Returns the number of fact rows written.
 */
export async function buildChartFacts(
  db: DB,
  portfolioId: string,
  authToken: string,
  opts: BuildChartFactsOptions,
): Promise<BuildChartFactsResult> {
  const [pf] = await db
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1)
  if (!pf) throw new Error(`charting: portfolio ${portfolioId} not found`)
  const base = pf.baseCurrency.toUpperCase()

  /**
   * Clear this generation's facts for the recomputed window only. A refresh pass
   * recomputes a window (see `refreshChartingFacts`), so deleting the whole
   * generation would erase days the pass never touched. With no window the pass
   * is a full rebuild and the whole generation goes.
   */
  const clearGenerationWindow = async (executor: DB, from: string | null, to: string | null) => {
    const posConds = [eq(chartPositionDaily.portfolioId, portfolioId), eq(chartPositionDaily.generation, opts.generation)]
    if (from) posConds.push(gte(chartPositionDaily.day, from))
    if (to) posConds.push(lte(chartPositionDaily.day, to))
    const evtConds = [eq(chartEventFacts.portfolioId, portfolioId), eq(chartEventFacts.generation, opts.generation)]
    if (from) evtConds.push(gte(chartEventFacts.eventDate, from))
    if (to) evtConds.push(lte(chartEventFacts.eventDate, to))
    await executor.delete(chartPositionDaily).where(and(...posConds))
    await executor.delete(chartEventFacts).where(and(...evtConds))
  }

  // 1. Position-movement transactions for this portfolio, ordered by date.
  const txRows = await db
    .select({
      id: portfolioTransactions.id,
      positionId: portfolioTransactions.positionId,
      type: portfolioTransactions.type,
      symbol: portfolioTransactions.instrumentSymbol,
      assetType: portfolioTransactions.assetType,
      quantity: portfolioTransactions.quantity,
      price: portfolioTransactions.price,
      currency: portfolioTransactions.currency,
      instrumentCurrency: portfolioTransactions.instrumentCurrency,
      exchangeRate: portfolioTransactions.exchangeRate,
      convertedTotalAmount: portfolioTransactions.convertedTotalAmount,
      realizedGainLoss: portfolioTransactions.realizedGainLoss,
      convertedRealizedGainLoss: portfolioTransactions.convertedRealizedGainLoss,
      externalId: portfolioTransactions.externalId,
      sourceTransactionId: portfolioTransactions.sourceTransactionId,
      executedAt: portfolioTransactions.executedAt,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.portfolioId, portfolioId),
        inArray(portfolioTransactions.type, REPLAY_TYPES as string[]),
    ),
    )
    .orderBy(portfolioTransactions.executedAt)

  const cashRows = await db
    .select({
      id: portfolioCashTransactions.id,
      type: portfolioCashTransactions.type,
      amount: portfolioCashTransactions.amount,
      currency: portfolioCashTransactions.currency,
      exchangeRate: portfolioCashTransactions.exchangeRate,
      linkedTradeId: portfolioCashTransactions.linkedTradeId,
      transactionDate: portfolioCashTransactions.transactionDate,
      createdAt: portfolioCashTransactions.createdAt,
    })
    .from(portfolioCashTransactions)
    .where(eq(portfolioCashTransactions.portfolioId, portfolioId))

  const tradeDates = txRows.map((t) => toDateStr(t.executedAt)).filter((d): d is string => !!d)
  // Cash rows created via the API may carry a null transaction_date; fall back to
  // the created_at date so a same-day deposit/withdrawal is still a dated event.
  const cashDate = (c: { transactionDate: string | null; createdAt: Date }) => c.transactionDate ?? toDateStr(c.createdAt)
  const cashDates = cashRows.map(cashDate).filter((d): d is string => !!d)
  const allDates = [...tradeDates, ...cashDates].sort()
  if (allDates.length === 0) {
    await clearGenerationWindow(db, opts.from ?? null, opts.to ?? null)
    return { positionRows: 0, eventRows: 0, days: 0 }
  }

  const from = opts.from ?? allDates[0]
  const to = opts.to ?? (opts.now ? toDateStr(new Date(opts.now.getTime() - MS_DAY))! : allDates[allDates.length - 1])
  if (from > to) {
    await clearGenerationWindow(db, from, to)
    return { positionRows: 0, eventRows: 0, days: 0 }
  }

  // 2. Per-position cumulative quantity and cost maps (replay from the ledger).
  //    A position is keyed by positionId; a null positionId (portfolio-level row)
  //    contributes no per-position fact.
  type QtyEvent = { date: string; delta: number; costDelta: number }
  const positionEvents = new Map<string, QtyEvent[]>()
  const positionSymbol = new Map<string, string>()
  const positionInstrumentCcy = new Map<string, string | null>()
  const incomeByPosDay = new Map<string, number>() // `${positionId}|${day}`
  const realizedByPosDay = new Map<string, number>()
  const days = calendarDays(from, to)

  // A TRANSFER_OUT that moved a specific lot out of this portfolio carries no
  // position_id of its own — it is a portfolio-level row — but its
  // `source_transaction_id` names the original BUY whose lot it drew, and that
  // BUY carries the position. Resolving through it is what keeps the
  // transfer-out on the position's running quantity. Skipping it (the old
  // `if (!tx.positionId) continue`) never subtracts the shares it removed, so
  // the position is inflated: PROD Equate+ SAP.DE replayed to 469.35 shares
  // against a real 18.57 (BUY 499.57 − TRANSFER_OUT 481.00), adding ~369k PLN
  // to the Charting → Performance aggregate.
  const positionById = new Map<string, string>()
  for (const tx of txRows) {
    if (tx.positionId) positionById.set(tx.id, tx.positionId)
  }

  for (const tx of txRows) {
    const positionId =
      tx.positionId ?? (tx.sourceTransactionId ? positionById.get(tx.sourceTransactionId) : undefined)
    if (!positionId) continue
    const date = toDateStr(tx.executedAt)
    if (!date) continue
    // Received income (DIVIDEND) and realized gain (SELL) are attributed to the
    // day regardless of whether the row moves quantity (DIVIDEND does not).
    const key = `${positionId}|${date}`
    if (tx.type === "DIVIDEND") {
      const rate0 = num(tx.exchangeRate) || 1
      const amount = tx.convertedTotalAmount != null ? num(tx.convertedTotalAmount) : Math.abs(num(tx.quantity)) * num(tx.price) * rate0
      incomeByPosDay.set(key, (incomeByPosDay.get(key) ?? 0) + amount)
    }
    if (tx.type === "SELL" && tx.realizedGainLoss != null) {
      const g = tx.convertedRealizedGainLoss != null ? num(tx.convertedRealizedGainLoss) : num(tx.realizedGainLoss)
      realizedByPosDay.set(key, (realizedByPosDay.get(key) ?? 0) + g)
    }
    const sign = quantitySign(tx.type)
    if (sign === 0) continue
    if (tx.symbol) positionSymbol.set(positionId, tx.symbol)
    positionInstrumentCcy.set(positionId, tx.instrumentCurrency)
    const delta = sign * num(tx.quantity)
    const rate = num(tx.exchangeRate) || 1
    const costDelta = sign * Math.abs(delta) * num(tx.price) * rate
    const arr = positionEvents.get(positionId) ?? []
    arr.push({ date, delta, costDelta })
    positionEvents.set(positionId, arr)
  }

  // 3. Per-position daily quantity/cost maps.
  const qtyMaps = new Map<string, Map<string, number>>()
  const costMaps = new Map<string, Map<string, number>>()
  for (const [posId, events] of positionEvents) {
    const sorted = events.slice().sort((a, b) => a.date.localeCompare(b.date))
    const dayQty = new Map<string, number>()
    const dayCost = new Map<string, number>()
    let cum = 0
    let cumCost = 0
    let ei = 0
    for (const day of days) {
      while (ei < sorted.length && sorted[ei].date <= day) {
        cum += sorted[ei].delta
        cumCost += sorted[ei].costDelta
        ei++
      }
      dayQty.set(day, Math.max(0, cum))
      dayCost.set(day, Math.max(0, cumCost))
    }
    qtyMaps.set(posId, dayQty)
    costMaps.set(posId, dayCost)
  }

  // 4. Price series per symbol (fetched once, reused across positions).
  const symbolCcy = new Map<string, string | null>()
  for (const [posId, sym] of positionSymbol) {
    if (!symbolCcy.has(sym)) symbolCcy.set(sym, positionInstrumentCcy.get(posId) ?? null)
  }
  const targetCcy = new Map<string, string | null>()
  const declaredBase = new Map<string, string | null>()
  for (const [sym, ccy] of symbolCcy) {
    const known = ccy && KNOWN_CURRENCY.test(ccy) ? ccy.toUpperCase() : null
    declaredBase.set(sym, known)
    targetCcy.set(sym, known && known !== base ? base : null)
  }
  const symbols = [...symbolCcy.keys()]
  const fetcher = opts.fetcher
  // Every symbol asks for the bar BEFORE the window. A window that starts on a
  // non-trading day (the 2-day refresh tail lands on weekends and holidays) has
  // no bars of its own, and without the previous close buildPriceMap has nothing
  // to carry forward — it writes value 0 for every day in the window and wipes
  // the last two days of the chart. The extra bar is outside [from, to], so it
  // is used only as the carry-forward source; facts are still written for the
  // window alone.
  const priceSeries = symbols.length
    ? await fetchPriceSeries(
        symbols, from, to, authToken, fetcher, opts.signal,
        targetCcy, declaredBase, base, new Set(symbols),
      )
    : new Map<string, PriceBarSeries>()
  const priceMaps = new Map<string, Map<string, number>>()
  for (const sym of symbols) {
    const series = priceSeries.get(sym)
    if (series) priceMaps.set(sym, buildPriceMap(series.dates, series.closes, days))
  }

  // 5. Emit per-position daily facts.
  const positionRows: (typeof chartPositionDaily.$inferInsert)[] = []
  for (const [posId, dayQty] of qtyMaps) {
    const sym = positionSymbol.get(posId) ?? ""
    const ccy = positionInstrumentCcy.get(posId) ?? "USD"
    const prices = priceMaps.get(sym)
    const series = priceSeries.get(sym)
    for (const day of days) {
      const qty = dayQty.get(day) ?? 0
      if (qty <= 0 && (incomeByPosDay.get(`${posId}|${day}`) ?? 0) === 0 && (realizedByPosDay.get(`${posId}|${day}`) ?? 0) === 0) {
        continue
      }
      const price = prices?.get(day) ?? null
      const value = price == null ? 0 : qty * price
      const basis = costMaps.get(posId)?.get(day) ?? 0
      const carriedForward = !!(price != null && series && !series.dates.includes(day))
      positionRows.push({
        generation: opts.generation,
        portfolioId,
        positionId: posId,
        day,
        quantity: round(qty).toFixed(8),
        value: round(value).toFixed(8),
        remainingBasis: round(basis).toFixed(8),
        realizedGain: round(realizedByPosDay.get(`${posId}|${day}`) ?? 0).toFixed(8),
        income: round(incomeByPosDay.get(`${posId}|${day}`) ?? 0).toFixed(8),
        netFlow: "0",
        instrumentCurrency: ccy,
        priceKnown: price != null,
        carriedForward,
      })
    }
  }

  // 6. Emit normalized event facts (income/cash/funding) with source identity.
  const eventRows: (typeof chartEventFacts.$inferInsert)[] = []
  for (const tx of txRows) {
    const date = toDateStr(tx.executedAt)
    if (!date || date < from || date > to) continue
    const rate = num(tx.exchangeRate) || 1
    const amountBase =
      tx.convertedTotalAmount != null
        ? num(tx.convertedTotalAmount)
        : num(tx.quantity) * num(tx.price) * rate
    let receiptKind: string | null = null
    if (tx.type === "DIVIDEND") receiptKind = "dividend"
    else if (tx.assetType === "OPTION") receiptKind = "option"
    else if (tx.type === "SELL" || tx.type === "BUY") receiptKind = "trade"
    else if (tx.type === "TRANSFER_OUT" || tx.type === "TRANSFER_IN") receiptKind = "transfer"
    if (!receiptKind) continue
    eventRows.push({
      generation: opts.generation,
      portfolioId,
      positionId: tx.positionId ?? null,
      eventDate: date,
      receiptKind,
      amountBase: round(amountBase).toFixed(8),
      amountOriginal: round(Math.abs(num(tx.quantity) * num(tx.price))).toFixed(8),
      originalCurrency: tx.currency,
      sourceTransactionId: tx.id,
      standalone: false,
      linkedPositionId: tx.positionId ?? null,
    })
  }
  for (const c of cashRows) {
    const date = cashDate(c)
    if (!date || date < from || date > to) continue
    const rate = num(c.exchangeRate) || 1
    const amountBase = num(c.amount) * rate
    let receiptKind: string | null = null
    if (c.type === "INTEREST") receiptKind = "interest"
    else if (c.type === "DEPOSIT") receiptKind = "contribution"
    else if (c.type === "WITHDRAWAL") receiptKind = "withdrawal"
    else if (c.type === "TRANSFER") receiptKind = "transfer"
    if (!receiptKind) continue
    eventRows.push({
      generation: opts.generation,
      portfolioId,
      positionId: null,
      eventDate: date,
      receiptKind,
      amountBase: round(amountBase).toFixed(8),
      amountOriginal: round(Math.abs(num(c.amount))).toFixed(8),
      originalCurrency: c.currency,
      sourceCashTransactionId: c.id,
      standalone: c.linkedTradeId == null,
      linkedPositionId: null,
    })
  }

  // 7. Publish atomically: replace the window's facts and mark the projection
  // complete in one transaction, so a reader never sees a half-written
  // generation. A rollback leaves the previous complete result readable.
  await db.transaction(async (tx) => {
    await clearGenerationWindow(tx, from, to)
    for (let i = 0; i < positionRows.length; i += 200) {
      await tx.insert(chartPositionDaily).values(positionRows.slice(i, i + 200))
    }
    for (let i = 0; i < eventRows.length; i += 200) {
      await tx.insert(chartEventFacts).values(eventRows.slice(i, i + 200))
    }
    await tx
      .insert(chartProjectionState)
      .values({ portfolioId, generation: opts.generation, version: 1, status: "complete", dirtyFrom: null, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: chartProjectionState.portfolioId,
        set: { generation: opts.generation, status: "complete", dirtyFrom: null, updatedAt: new Date() },
      })

    // 8. Prune superseded generations. Readers pin the published generation, so
    // rows from an older one are unreachable; leaving them would grow the fact
    // tables by a whole history per rebuild (a portfolio mutated daily would add a
    // generation a day). The new generation is published before this runs, and a
    // failed rebuild never reaches it, so the last complete result is always
    // readable.
    await tx.delete(chartPositionDaily).where(and(eq(chartPositionDaily.portfolioId, portfolioId), lt(chartPositionDaily.generation, opts.generation)))
    await tx.delete(chartEventFacts).where(and(eq(chartEventFacts.portfolioId, portfolioId), lt(chartEventFacts.generation, opts.generation)))
  })

  return { positionRows: positionRows.length, eventRows: eventRows.length, days: days.length }
}