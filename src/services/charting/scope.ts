import { and, eq, inArray } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { labels, portfolios } from "../../db/schema.js"

/**
 * Which side of the account filter is active (feature #253, sub-issue #280).
 * `normal` selects real portfolios; `virtual` selects read-only virtual
 * portfolios. The two are mutually exclusive: a virtual and a normal portfolio
 * can never be combined in one request.
 */
export type ChartScopeKind = "normal" | "virtual"

/**
 * Raw chart-scope query input (feature #253). Accounts and labels are
 * multiselect; empty/absent means All. `from`/`to` bound the date window;
 * `currency` is the requested display currency; `metric` is a chart-specific
 * selector (e.g. twr | net_gain_change); `kind` picks normal vs virtual
 * portfolios.
 */
export interface ChartScopeInput {
  accountIds?: string[]
  labelIds?: string[]
  currency?: string
  from?: string | null
  to?: string | null
  metric?: string
  kind?: string | null
}

/**
 * Resolved, ownership-checked chart scope.
 *
 * `allAccounts` / `allLabels` distinguish "no filter supplied" (All) from "a
 * filter was supplied but matched nothing" — the latter must NOT fall back to
 * All, because that is exactly how a foreign or malformed id would otherwise
 * silently broaden the scope.
 *
 * In `virtual` mode the facts live on the real accounts (virtual portfolios
 * have no projection of their own), so `virtualLabelIds` carries the labels of
 * the selected virtual portfolios; the read layer resolves them to the
 * underlying positions across the real accounts. `accountIds` is therefore
 * empty in virtual mode and `virtualAccountIds` is empty in normal mode.
 */
export interface ResolvedChartScope {
  /** No account filter supplied — the caller asked for all owned real accounts. */
  allAccounts: boolean
  /** Active side of the account filter. */
  kind: ChartScopeKind
  /** Validated real portfolio IDs the caller owns (empty when allAccounts or virtual mode). */
  accountIds: string[]
  /** Validated virtual portfolio IDs among the requested accounts (virtual mode only). */
  virtualAccountIds: string[]
  /** Labels of the selected virtual portfolios (virtual mode only; empty in normal mode). */
  virtualLabelIds: string[]
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
 * dropped (never treated as All). The active `kind` decides which side of the
 * account filter is honoured: a normal request drops virtual ids and a virtual
 * request drops real ids, so the two can never be combined.
 */
export async function resolveChartScope(
  db: DB,
  userId: string,
  input: ChartScopeInput = {},
): Promise<ResolvedChartScope> {
  const allAccounts = isAll(input.accountIds)
  const allLabels = isAll(input.labelIds)
  const kind: ChartScopeKind = input.kind === "virtual" ? "virtual" : "normal"

  const requestedAccountIds = allAccounts ? [] : cleanIds(input.accountIds)
  const requestedLabelIds = allLabels ? [] : cleanIds(input.labelIds)

  let accountIds: string[] = []
  let virtualAccountIds: string[] = []
  let virtualLabelIds: string[] = []

  if (requestedAccountIds.length > 0) {
    const rows = await db
      .select({ id: portfolios.id, isVirtual: portfolios.isVirtual, labelId: portfolios.labelId })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), inArray(portfolios.id, requestedAccountIds)))
    const owned = new Map(rows.map((r) => [r.id, r]))
    if (kind === "virtual") {
      virtualAccountIds = requestedAccountIds.filter((id) => owned.get(id)?.isVirtual === true)
      virtualLabelIds = [
        ...new Set(
          virtualAccountIds
            .map((id) => owned.get(id)?.labelId)
            .filter((id): id is string => !!id),
        ),
      ]
    } else {
      accountIds = requestedAccountIds.filter((id) => owned.get(id)?.isVirtual === false)
    }
  } else if (kind === "virtual") {
    // All virtual portfolios: their labels are the position universe.
    const rows = await db
      .select({ labelId: portfolios.labelId })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.isVirtual, true)))
    virtualLabelIds = [...new Set(rows.map((r) => r.labelId).filter((id): id is string => !!id))]
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
    kind,
    accountIds,
    virtualAccountIds,
    virtualLabelIds,
    allLabels,
    labelIds,
    currency: (input.currency ?? "USD").toUpperCase(),
    from: input.from ?? null,
    to: input.to ?? null,
    metric: input.metric ?? null,
  }
}