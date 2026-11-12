import { and, eq, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { positions, positionPortfolios } from "../db/schema.js"
import { positionInPortfolio } from "../db/position-membership.js"
import { samePositionInstrument } from "./positionGroups.js"

const round2 = (n: number) => Math.round(n * 100) / 100
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

/**
 * Open (or reopen) a position for an instrument that just entered a portfolio.
 *
 * Lives in a service rather than in `routes/import.ts` because two paths need the
 * exact same arithmetic: the bulk importer, for a BUY, and the in-kind transfer,
 * for the leg that ARRIVES in the receiving portfolio (§74). A transferred lot is
 * a lot like any other opening — quantity in at a price — with zero fee, so the
 * importer's version is reused rather than duplicated; a second copy is how the
 * receiving side's average cost basis drifts from the source lot's.
 */
export async function upsertImportPositionOnBuy(
  tx: DB,
  userId: string,
  portfolioId: string,
  body: {
    symbol: string
    instrumentName: string | null
    quantity: number
    price: number
    currency: string
    assetType: string
    feeInTransactionCurrency: number
    /** §72.8 — the instrument's listing currency when the importer resolved it. */
    listingCurrency?: string | null
    /** §72.13 — the TRADE's date, which is when the lot opened. */
    executedAt: Date
    direction?: "LONG" | "SHORT" | null
    optionType?: "CALL" | "PUT" | null
    contractSize?: number | null
    strikePrice?: number | null
    expirationDate?: string | null
    sector?: string | null
    industry?: string | null
    country?: string | null
  },
) {
  const symbol = body.symbol.toUpperCase()
  const candidates = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        positionInPortfolio(portfolioId),
        eq(positions.symbol, symbol),
        body.direction
          ? eq(positions.direction, body.direction)
          : sql`${positions.direction} is null or ${positions.direction} = 'LONG'`,
      ),
    )
  const compatible = candidates.filter((candidate) => samePositionInstrument(candidate, { ...body, symbol }))
  const existing = compatible.find((candidate) => candidate.isOpen)
    ?? compatible.filter((candidate) => !candidate.isOpen)
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())[0]
  // A LONG opening's settled cost includes its commission; a SHORT opening's
  // recorded premium is net of that cost.
  const feeSign = body.direction === "SHORT" ? -1 : 1
  const costOfTrade = body.quantity * body.price + feeSign * body.feeInTransactionCurrency
  const costPerUnit = round8(costOfTrade / body.quantity)

  if (existing) {
    const reopening = !existing.isOpen
    const oldQty = reopening ? 0 : Number(existing.quantity)
    const oldCost = Number(existing.averageCostBasis)
    const newQty = oldQty + body.quantity
    const newAvgCost = round2((oldQty * oldCost + costOfTrade) / newQty)

    const [updated] = await tx
      .update(positions)
      .set({
        // §72.13 — a later BUY must not push the lot's opening forward. Rows
        // can arrive out of order, and the opening date is what the historical
        // rebuild anchors the position's existence to.
        openedAt:
          body.executedAt < existing.openedAt ? body.executedAt : existing.openedAt,
        quantity: String(newQty),
        averageCostBasis: String(newAvgCost),
        companyName: body.instrumentName ?? existing.companyName,
        instrumentCurrency: body.listingCurrency?.toUpperCase() ?? body.currency,
        assetType: body.assetType ?? existing.assetType,
        contractSize: body.contractSize != null ? String(body.contractSize) : existing.contractSize,
        optionType: body.optionType ?? existing.optionType,
        strikePrice: body.strikePrice != null ? String(body.strikePrice) : existing.strikePrice,
        expirationDate: body.expirationDate ?? existing.expirationDate,
        sector: body.sector ?? existing.sector,
        industry: body.industry ?? existing.industry,
        country: body.country ?? existing.country,
        ...(reopening
          ? {
              isOpen: true,
              closedAt: null,
              currentPrice: null,
              priceAsOf: null,
              marketValue: null,
              unrealizedGainLoss: null,
              dayChange: null,
              dayChangePercent: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, existing.id))
      .returning()
    return updated
  }

  const [created] = await tx
    .insert(positions)
    .values({
      userId,
      symbol,
      companyName: body.instrumentName,
      quantity: String(body.quantity),
      averageCostBasis: String(costPerUnit),
      instrumentCurrency: body.listingCurrency?.toUpperCase() ?? body.currency,
      assetType: body.assetType,
      contractSize: body.contractSize != null ? String(body.contractSize) : null,
      direction: body.direction ?? null,
      strikePrice: body.strikePrice != null ? String(body.strikePrice) : null,
      expirationDate: body.expirationDate ?? null,
      optionType: body.optionType ?? null,
      sector: body.sector ?? "Other",
      industry: body.industry ?? "Other",
      country: body.country ?? "Other",
      isOpen: true,
      // §72.13 — was `new Date()`, i.e. the import's own timestamp. Every one of
      // the 269 positions in the database opened on 2026-09-28, the day of the
      // import, while their first trades go back to 2019. The rebuild computes
      // what a position was worth on each day by testing whether it was open
      // yet, so a lot that "opened" in 2026 contributed NOTHING to every
      // snapshot before it — the whole series was cash-only, and the final day,
      // priced by a different path, was the only point that included it. That
      // is the spike on Equate+; it is on every portfolio, not just that one.
      openedAt: body.executedAt,
    })
    .returning()
  // #115 — ownership is the many-to-many membership, not a column on positions.
  await tx.insert(positionPortfolios).values({ positionId: created.id, portfolioId })
  return created
}

/**
 * Take `quantity` off the sending portfolio's position without booking a disposal.
 *
 * `averageCostBasis` is deliberately not in the SET: a transfer is not a sale, so
 * the cost of what remains is unchanged. Returns the position row as it was BEFORE
 * the decrement, so the caller can stamp labels on the lifecycle the stock left.
 */
export async function decrementTransferPosition(
  tx: DB,
  userId: string,
  portfolioId: string,
  symbol: string,
  quantity: number,
) {
  const [pos] = await tx
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        positionInPortfolio(portfolioId),
        eq(positions.symbol, symbol),
        eq(positions.isOpen, true),
        sql`${positions.direction} is null or ${positions.direction} = 'LONG'`,
      ),
    )
  if (!pos) return null

  const newQty = round8(Number(pos.quantity) - quantity)
  if (newQty <= 1e-8) {
    await tx
      .update(positions)
      .set({ quantity: "0", isOpen: false, updatedAt: new Date() })
      .where(eq(positions.id, pos.id))
    return pos
  }
  // averageCostBasis deliberately not in the SET: unchanged by a transfer.
  await tx
    .update(positions)
    .set({ quantity: String(newQty), updatedAt: new Date() })
    .where(eq(positions.id, pos.id))
  return pos
}
