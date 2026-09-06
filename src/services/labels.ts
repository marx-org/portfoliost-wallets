import { eq, inArray, sql, type SQL } from "drizzle-orm"
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core"
import type { DB } from "../db/index.js"
import {
  labels,
  positionLabels,
  transactionLabels,
  walletTransactionLabels,
} from "../db/schema.js"
import type { components } from "../generated/api-types.js"

type Label = components["schemas"]["Label"]

type LabelRow = typeof labels.$inferSelect

export function serializeLabel(l: LabelRow): Label {
  return {
    id: l.id,
    name: l.name,
    color: l.color,
    createdAt: l.createdAt.toISOString(),
  }
}

/**
 * Verify that every label id belongs to the user (D24 scoping). Returns true
 * only when the whole requested set is owned.
 */
export async function assertLabelsOwned(
  db: DB,
  userId: string,
  labelIds: string[],
): Promise<boolean> {
  if (labelIds.length === 0) return true
  const rows = await db
    .select({ id: labels.id })
    .from(labels)
    .where(inArray(labels.id, labelIds))
  return rows.length === labelIds.length
}

/**
 * Replace semantics (D67/D68, matching D19 push model): clear existing join
 * rows for the entity and insert the full new set — one DELETE + one INSERT,
 * atomic within a single Postgres transaction.
 */
export async function setPositionLabels(
  db: DB,
  positionId: string,
  labelIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(positionLabels).where(eq(positionLabels.positionId, positionId))
    if (labelIds.length > 0) {
      await tx.insert(positionLabels).values(labelIds.map((labelId) => ({ positionId, labelId })))
    }
  })
}

export async function setTransactionLabels(
  db: DB,
  transactionId: string,
  labelIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(transactionLabels).where(eq(transactionLabels.transactionId, transactionId))
    if (labelIds.length > 0) {
      await tx
        .insert(transactionLabels)
        .values(labelIds.map((labelId) => ({ transactionId, labelId })))
    }
  })
}

export async function setWalletTransactionLabels(
  db: DB,
  walletTransactionId: string,
  labelIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(walletTransactionLabels)
      .where(eq(walletTransactionLabels.walletTransactionId, walletTransactionId))
    if (labelIds.length > 0) {
      await tx
        .insert(walletTransactionLabels)
        .values(labelIds.map((labelId) => ({ walletTransactionId, labelId })))
    }
  })
}

type JoinRow = { labelId: string }

async function labelsByIds(db: DB, labelIds: string[]): Promise<LabelRow[]> {
  if (labelIds.length === 0) return []
  return db.select().from(labels).where(inArray(labels.id, labelIds))
}

/**
 * Bulk-load the labels attached to a set of join rows (which tie entity ids to
 * label ids). Returns a Map<entityId, Label[]> sorted alphabetically by name.
 */
export async function labelsGroupedByEntity(
  db: DB,
  joinRows: { entityId: string; labelId: string }[],
): Promise<Map<string, Label[]>> {
  const labelIds = [...new Set(joinRows.map((j) => j.labelId))]
  const rows = await labelsByIds(db, labelIds)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out = new Map<string, Label[]>()
  for (const j of joinRows) {
    const row = byId.get(j.labelId)
    if (!row) continue
    if (!out.has(j.entityId)) out.set(j.entityId, [])
    out.get(j.entityId)!.push(serializeLabel(row))
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name))
  }
  return out
}

export async function labelsForPositions(
  db: DB,
  positionIds: string[],
): Promise<Map<string, Label[]>> {
  if (positionIds.length === 0) return new Map()
  const joinRows = await db
    .select({ entityId: positionLabels.positionId, labelId: positionLabels.labelId })
    .from(positionLabels)
    .where(inArray(positionLabels.positionId, positionIds))
  return labelsGroupedByEntity(db, joinRows)
}

export async function labelsForTransactions(
  db: DB,
  transactionIds: string[],
): Promise<Map<string, Label[]>> {
  if (transactionIds.length === 0) return new Map()
  const joinRows = await db
    .select({ entityId: transactionLabels.transactionId, labelId: transactionLabels.labelId })
    .from(transactionLabels)
    .where(inArray(transactionLabels.transactionId, transactionIds))
  return labelsGroupedByEntity(db, joinRows)
}

export async function labelsForWalletTransactions(
  db: DB,
  walletTransactionIds: string[],
): Promise<Map<string, Label[]>> {
  if (walletTransactionIds.length === 0) return new Map()
  const joinRows = await db
    .select({
      entityId: walletTransactionLabels.walletTransactionId,
      labelId: walletTransactionLabels.labelId,
    })
    .from(walletTransactionLabels)
    .where(inArray(walletTransactionLabels.walletTransactionId, walletTransactionIds))
  return labelsGroupedByEntity(db, joinRows)
}

/** D67: `?labels=a,b` — comma-separated label ids → array. */
export function labelFilterIds(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * Subquery: entity ids that carry ALL of the given labels (AND semantics via
 * group-by + distinct-count HAVING). Guarded by the caller's ownership scope.
 */
export function entityIdsWithAllLabels(
  labelEntityIdCol: PgColumn,
  labelIdCol: PgColumn,
  join: AnyPgTable,
  database: DB,
  labelIds: string[],
) {
  return database
    .select({ id: labelEntityIdCol })
    .from(join)
    .where(inArray(labelIdCol, labelIds))
    .groupBy(labelEntityIdCol)
    .having(sql`count(distinct ${labelIdCol}) = ${labelIds.length}`)
}

/** Adds `entityId IN (<subquery of ids carrying all labels>)` when filtering. */
export function attachLabelCondition(
  conditions: (SQL | undefined)[],
  entityIdCol: PgColumn,
  labelEntityIdCol: PgColumn,
  labelIdCol: PgColumn,
  join: AnyPgTable,
  database: DB,
  labelIds: string[],
): void {
  if (labelIds.length > 0) {
    conditions.push(
      inArray(
        entityIdCol,
        entityIdsWithAllLabels(labelEntityIdCol, labelIdCol, join, database, labelIds),
      ),
    )
  }
}