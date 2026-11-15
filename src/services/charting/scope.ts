import { and, eq, inArray } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { labels, portfolios } from "../../db/schema.js"

/**
 * Raw chart-scope query input (feature #253). Accounts and labels are
 * multiselect; empty/absent means All. `from`/`to` bound the date window;
 * `currency` is the requested display currency; `metric` is a chart-specific
 * selector (e.g. twr | net_gain_change).
 */
export interface ChartScopeInput {
  accountIds?: string[]
  labelIds?: string[]
  currency?: string
  from?: string | null
  to?: string | null
  metric?: string
}

/**
 * Resolved, ownership-checked chart scope.
 *
 * `allAccounts` / `allLabels` distinguish "no filter supplied" (All) from "a
 * filter was supplied but matched nothing" — the latter must NOT fall back to
 * All, because that is exactly how a foreign or malformed id would otherwise
 * silently broaden the scope.
 */
export interface ResolvedChartScope {
  /** No account filter supplied — the caller asked for all owned real accounts. */
  allAccounts: boolean
  /** Validated real portfolio IDs the caller owns (empty when allAccounts). */
  accountIds: string[]
  /** Validated virtual portfolio IDs among the requested accounts (never extra capital). */
  virtualAccountIds: string[]
  /** No label filter supplied. */
  allLabels: boolean
  /** Validated position-label IDs the caller owns. */
  labelIds: string[]
  currency: string
  from: string | null
  to: string | null
  metric: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Split a raw id list into the well-formed unique ids; flag any malformed entry. */
function cleanIds(raw: string[] | undefined): string[] {
  const out: string[] = []
  for (const v of raw ?? []) {
    const id = v.trim()
    if (id && UUID_RE.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/** True when the caller supplied no non-empty id at all (i.e. "All"). */
function isAll(raw: string[] | undefined): boolean {
  return (raw ?? []).every((v) => v.trim().length === 0)
}

/**
 * Resolve and ownership-check a chart scope. Foreign or malformed ids are
 * dropped (never treated as All). Virtual portfolios are reported separately so
 * the query layer can resolve them to their underlying real positions without
 * counting them as additional capital.
 */
export async function resolveChartScope(
  db: DB,
  userId: string,
  input: ChartScopeInput = {},
): Promise<ResolvedChartScope> {
  const allAccounts = isAll(input.accountIds)
  const allLabels = isAll(input.labelIds)

  const requestedAccountIds = allAccounts ? [] : cleanIds(input.accountIds)
  const requestedLabelIds = allLabels ? [] : cleanIds(input.labelIds)

  let accountIds: string[] = []
  let virtualAccountIds: string[] = []
  if (requestedAccountIds.length > 0) {
    const rows = await db
      .select({ id: portfolios.id, isVirtual: portfolios.isVirtual })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), inArray(portfolios.id, requestedAccountIds)))
    const owned = new Map(rows.map((r) => [r.id, r.isVirtual]))
    accountIds = requestedAccountIds.filter((id) => owned.get(id) === false)
    virtualAccountIds = requestedAccountIds.filter((id) => owned.get(id) === true)
  }

  let labelIds: string[] = []
  if (requestedLabelIds.length > 0) {
    const rows = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.userId, userId), inArray(labels.id, requestedLabelIds)))
    const owned = new Set(rows.map((r) => r.id))
    labelIds = requestedLabelIds.filter((id) => owned.has(id))
  }

  return {
    allAccounts,
    accountIds,
    virtualAccountIds,
    allLabels,
    labelIds,
    currency: (input.currency ?? "USD").toUpperCase(),
    from: input.from ?? null,
    to: input.to ?? null,
    metric: input.metric ?? null,
  }
}