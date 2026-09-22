/**
 * plan §48.3 — FX data moved to instruments; wallets reads it over the module
 * boundary (`INSTRUMENTS_URL`, already configured for price-bars). The D27
 * cross-rate is resolved server-side (instruments, via @marx2/contracts/fx);
 * this client only fetches the resolved pair rate and applies it. Unconfigured
 * or unreachable instruments degrades 1:1 — the old table-miss behavior.
 */
export interface FxRateResult {
  rate: number
  asOf: string
}

export function instrumentsBase(): string {
  return (process.env.INSTRUMENTS_URL ?? process.env.API_INSTRUMENTS_URL ?? "").replace(/\/$/, "")
}

/** Resolved pair rate with server-side carry-forward (weekends/holidays). */
export async function resolvedFxRate(
  authToken: string | null | undefined,
  from: string,
  to: string,
  date?: string,
): Promise<FxRateResult | null> {
  const base = instrumentsBase()
  if (!base) return null
  const q = new URLSearchParams({ from: from.toUpperCase(), to: to.toUpperCase() })
  if (date) q.set("date", date)
  try {
    const res = await fetch(`${base}/api/internal/fx-rates?${q}`, {
      headers: authToken ? { Authorization: authToken } : {},
    })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<FxRateResult>
    if (typeof body.rate === "number" && typeof body.asOf === "string") {
      return { rate: body.rate, asOf: body.asOf }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Pre-resolve from→to rates for a set of source currencies (one call per
 * distinct currency, memoized). Returns a sync lookup: `null` marks a pair
 * instruments could not resolve — callers render the old "no rate" behavior
 * (converted field null / 1:1 degrade, per site).
 */
export async function resolveRates(
  authToken: string | null | undefined,
  to: string,
  froms: Iterable<string | null | undefined>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  const target = to.toUpperCase()
  const unique = new Set<string>()
  for (const f of froms) {
    const u = (f ?? "").toUpperCase()
    if (u && u !== target) unique.add(u)
  }
  for (const f of unique) {
    const r = await resolvedFxRate(authToken, f, target)
    out.set(f, r ? r.rate : null)
  }
  return out
}

/**
 * `latestRates` replacement: an async convert-into-`to` callback, resolved
 * per (from→to) pair through instruments and memoized on `cache` for the
 * request. Degrades to the identity rate (old table-miss behavior) when
 * instruments is unconfigured or the pair is unresolvable.
 */
export async function fxTo(
  authToken: string | null | undefined,
  to: string,
  cache: Map<string, number> = new Map(),
): Promise<(from: string, amount?: number) => Promise<number>> {
  const target = to.toUpperCase()
  return async (from: string, amount = 1): Promise<number> => {
    const f = (from ?? "").toUpperCase()
    if (!f || f === target) return amount
    const key = `${f}>${target}`
    let rate = cache.get(key)
    if (rate === undefined) {
      const r = await resolvedFxRate(authToken, f, target)
      rate = r?.rate ?? 1
      cache.set(key, rate)
    }
    return amount * rate
  }
}
