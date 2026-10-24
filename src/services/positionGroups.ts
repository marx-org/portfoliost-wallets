import type { positions } from "../db/schema.js"
import { positionMembershipKey } from "./realizedGainLoss.js"

export type PositionRow = typeof positions.$inferSelect

type PositionIdentity = {
  symbol: string
  assetType?: string | null
  direction?: string | null
  optionType?: string | null
  strikePrice?: string | number | null
  expirationDate?: string | null
  contractSize?: string | number | null
}

function identityValue(value: string | number | null | undefined): string {
  return value == null ? "" : String(value).trim().toUpperCase()
}

function identityNumber(value: string | number | null | undefined): string {
  return value == null ? "" : String(Number(value))
}

/**
 * The stock identity is its symbol and asset type. Derivative contracts add
 * their terms so two options on the same underlying remain separate positions.
 */
export function positionInstrumentKey(position: PositionIdentity): string {
  const assetType = identityValue(position.assetType ?? "STOCK")
  const direction = identityValue(position.direction ?? "LONG")
  const contractKey = assetType === "OPTION"
    ? [
        identityValue(position.optionType),
        identityNumber(position.strikePrice),
        identityValue(position.expirationDate),
        identityNumber(position.contractSize),
      ]
    : []
  return [identityValue(position.symbol), assetType, direction, ...contractKey].join("\u0000")
}

export function samePositionInstrument(a: PositionIdentity, b: PositionIdentity): boolean {
  return positionInstrumentKey(a) === positionInstrumentKey(b)
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8
}

function latestFirst(rows: PositionRow[]): PositionRow[] {
  return [...rows].sort((a, b) => {
    const aDate = a.isOpen ? a.priceAsOf ?? a.updatedAt : a.closedAt ?? a.updatedAt
    const bDate = b.isOpen ? b.priceAsOf ?? b.updatedAt : b.closedAt ?? b.updatedAt
    return bDate.getTime() - aDate.getTime()
  })
}

function sumNullable(rows: PositionRow[], read: (row: PositionRow) => string | null): string | null {
  const values = rows.map(read)
  if (values.some((value) => value == null)) return null
  return round8(values.reduce((sum, value) => sum + Number(value), 0)).toFixed(8)
}

function aggregatePositionRows(rows: PositionRow[]): PositionRow {
  if (rows.length === 1) return rows[0]

  const open = rows.filter((row) => row.isOpen)
  const currentRows = latestFirst(open.length > 0 ? open : rows)
  const current = currentRows[0]
  const openedAt = new Date(Math.min(...rows.map((row) => row.openedAt.getTime())))
  const closedDates = rows.flatMap((row) => row.closedAt == null ? [] : [row.closedAt.getTime()])

  if (open.length === 0) {
    return {
      ...current,
      quantity: "0",
      isOpen: false,
      openedAt,
      closedAt: closedDates.length > 0 ? new Date(Math.max(...closedDates)) : current.closedAt,
      createdAt: new Date(Math.min(...rows.map((row) => row.createdAt.getTime()))),
      updatedAt: new Date(Math.max(...rows.map((row) => row.updatedAt.getTime()))),
    }
  }

  const quantity = open.reduce((sum, row) => sum + Number(row.quantity), 0)
  const totalCost = open.reduce(
    (sum, row) => sum + Number(row.quantity) * Number(row.averageCostBasis),
    0,
  )
  const averageCostBasis = quantity === 0
    ? Number(current.averageCostBasis)
    : round8(totalCost / quantity)
  const marketValues = open.map((row) =>
    row.marketValue != null
      ? Number(row.marketValue)
      : row.currentPrice != null ? Number(row.currentPrice) * Number(row.quantity) : null,
  )
  const marketValue = marketValues.some((value) => value == null)
    ? null
    : round8(marketValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)).toFixed(8)
  const currentPrice = marketValue == null || quantity === 0
    ? null
    : (Number(marketValue) / quantity).toFixed(8)

  return {
    ...current,
    quantity: round8(quantity).toFixed(8),
    averageCostBasis: averageCostBasis.toFixed(8),
    isOpen: true,
    openedAt,
    closedAt: null,
    currentPrice,
    marketValue,
    unrealizedGainLoss: sumNullable(open, (row) => row.unrealizedGainLoss),
    dayChange: sumNullable(open, (row) => row.dayChange),
    createdAt: new Date(Math.min(...rows.map((row) => row.createdAt.getTime()))),
    updatedAt: new Date(Math.max(...rows.map((row) => row.updatedAt.getTime()))),
  }
}

/**
 * Collapse lifecycle rows to one Holdings Position per instrument membership.
 * Context such as the owning portfolio name/base currency is carried through
 * from the first row; callers use `members` to sum the matching ledger history
 * and merge labels from every lifecycle row.
 */
export function groupPositionMembershipRows<
  T extends { position: PositionRow; portfolioId: string },
>(rows: T[]): Array<T & { position: PositionRow; members: PositionRow[] }> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const key = `${row.portfolioId}\u0001${positionInstrumentKey(row.position)}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }

  return [...groups.values()].map((group) => ({
    ...group[0],
    position: aggregatePositionRows(group.map((row) => row.position)),
    members: group.map((row) => row.position),
  }))
}

export function realizedGainLossForPositionGroup(
  portfolioId: string,
  members: PositionRow[],
  totals: Map<string, number>,
): number {
  const amount = members.reduce(
    (sum, position) => sum + (totals.get(positionMembershipKey(portfolioId, position.id)) ?? 0),
    0,
  )
  return round8(amount)
}
