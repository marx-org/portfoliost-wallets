import { and, eq, inArray } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import {
  chartEventFacts,
  chartPositionDaily,
  chartProjectionState,
  portfolioCashTransactions,
  portfolioTransactions,
  portfolios,
  positions,
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
  /** Window start (YYYY-MM-DD); default is the earliest trade/cash date. */
  from?: string
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
 * Rebuild the charting facts for one portfolio at `generation`. Deletes any
 * existing facts for that generation first, so a re-run is idempotent. Returns
 * the number of fact rows written.
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
    })
    .from(portfolioCashTransactions)
    .where(eq(portfolioCashTransactions.portfolioId, portfolioId))

  const tradeDates = txRows.map((t) => toDateStr(t.executedAt)).filter((d): d is string => !!d)
  const cashDates = cashRows.map((c) => c.transactionDate).filter((d): d is string => !!d)
  const allDates = [...tradeDates, ...cashDates].sort()
  if (allDates.length === 0) {
    await db.delete(chartPositionDaily).where(and(eq(chartPositionDaily.portfolioId, portfolioId), eq(chartPositionDaily.generation, opts.generation)))
    await db.delete(chartEventFacts).where(and(eq(chartEventFacts.portfolioId, portfolioId), eq(chartEventFacts.generation, opts.generation)))
    return { positionRows: 0, eventRows: 0, days: 0 }
  }

  const from = opts.from ?? allDates[0]
  const to = opts.to ?? (opts.now ? toDateStr(new Date(opts.now.getTime() - MS_DAY))! : allDates[allDates.length - 1])
  if (from > to) {
    await db.delete(chartPositionDaily).where(and(eq(chartPositionDaily.portfolioId, portfolioId), eq(chartPositionDaily.generation, opts.generation)))
    await db.delete(chartEventFacts).where(and(eq(chartEventFacts.portfolioId, portfolioId), eq(chartEventFacts.generation, opts.generation)))
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

  for (const tx of txRows) {
    if (!tx.positionId) continue
    const date = toDateStr(tx.executedAt)
    if (!date) continue
    // Received income (DIVIDEND) and realized gain (SELL) are attributed to the
    // day regardless of whether the row moves quantity (DIVIDEND does not).
    const key = `${tx.positionId}|${date}`
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
    if (tx.symbol) positionSymbol.set(tx.positionId, tx.symbol)
    positionInstrumentCcy.set(tx.positionId, tx.instrumentCurrency)
    const delta = sign * num(tx.quantity)
    const rate = num(tx.exchangeRate) || 1
    const costDelta = sign * Math.abs(delta) * num(tx.price) * rate
    const arr = positionEvents.get(tx.positionId) ?? []
    arr.push({ date, delta, costDelta })
    positionEvents.set(tx.positionId, arr)
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
  const priceSeries = symbols.length
    ? await fetchPriceSeries(
        symbols, from, to, authToken, fetcher, opts.signal,
        targetCcy, declaredBase, base, new Set<string>(),
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
    if (!c.transactionDate || c.transactionDate < from || c.transactionDate > to) continue
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
      eventDate: c.transactionDate,
      receiptKind,
      amountBase: round(amountBase).toFixed(8),
      amountOriginal: round(Math.abs(num(c.amount))).toFixed(8),
      originalCurrency: c.currency,
      sourceCashTransactionId: c.id,
      standalone: c.linkedTradeId == null,
      linkedPositionId: null,
    })
  }

  // 7. Replace the generation's facts and mark the projection complete.
  await db.delete(chartPositionDaily).where(and(eq(chartPositionDaily.portfolioId, portfolioId), eq(chartPositionDaily.generation, opts.generation)))
  await db.delete(chartEventFacts).where(and(eq(chartEventFacts.portfolioId, portfolioId), eq(chartEventFacts.generation, opts.generation)))
  for (let i = 0; i < positionRows.length; i += 200) {
    await db.insert(chartPositionDaily).values(positionRows.slice(i, i + 200))
  }
  for (let i = 0; i < eventRows.length; i += 200) {
    await db.insert(chartEventFacts).values(eventRows.slice(i, i + 200))
  }
  await db
    .insert(chartProjectionState)
    .values({ portfolioId, generation: opts.generation, version: 1, status: "complete", dirtyFrom: null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: chartProjectionState.portfolioId,
      set: { generation: opts.generation, status: "complete", dirtyFrom: null, updatedAt: new Date() },
    })

  return { positionRows: positionRows.length, eventRows: eventRows.length, days: days.length }
}