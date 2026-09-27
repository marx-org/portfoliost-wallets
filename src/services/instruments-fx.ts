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

/**
 * §63.10 — one place that decides how wallets authenticates to instruments.
 *
 * instruments has two accepted credentials: a **user JWT** (the browser, which
 * wallets forwards verbatim as `Authorization: Bearer …`) and a **service token**
 * (the scheduled snapshot sweep, which has no user to be — it iterates every
 * portfolio of every user, so a user JWT is the wrong credential for it by
 * construction).
 *
 * They are told apart by shape, not by a flag: a user credential always arrives
 * with the `Bearer ` prefix (that is literally what the wallets routes forward,
 * `c.req.header("Authorization")`), a service token is an opaque secret without
 * one. Getting it wrong fails loudly — instruments answers 401 and the backfill
 * aborts — rather than silently degrading, which is the §63.10 failure mode.
 */
export function instrumentsAuthHeaders(token: string | null | undefined): Record<string, string> {
  if (!token) return {}
  return /^Bearer\s/i.test(token) ? { Authorization: token } : { "X-Service-Token": token }
}

/**
 * Thrown when instruments could not be asked at all (auth rejection, a non-2xx,
 * a network error) — as opposed to answering "this symbol/date has no data".
 *
 * §63.10: a price source that cannot be reached must abort the pass, never look
 * like an empty series. The old `if (!res.ok) return null` made a 401
 * indistinguishable from "no price history", so the snapshot backfill dropped
 * every position and wrote cash-only values over correct ones, twice a day.
 */
export class InstrumentsUnavailableError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly url: string,
    cause?: unknown,
  ) {
    super(
      status === null
        ? `instruments unreachable: ${url}`
        : `instruments answered ${status} for ${url}`,
      { cause },
    )
    this.name = "InstrumentsUnavailableError"
  }
}

/** Resolved pair rate with server-side carry-forward (weekends/holidays). */
export async function resolvedFxRate(
  authToken: string | null | undefined,
  from: string,
  to: string,
  date?: string,
  /**
   * §63.10 — `strict` makes a transport/auth failure throw instead of degrading
   * to 1:1. The historical backfill sets it: a silent 1:1 across a whole
   * valuation silently misvalues every non-base position. The single-transaction
   * paths (deposit/withdraw fees, the cash ledger) leave it off so a transient
   * instruments blip cannot fail a user's deposit — they log instead.
   */
  opts: { strict?: boolean } = {},
): Promise<FxRateResult | null> {
  const base = instrumentsBase()
  if (!base) {
    if (opts.strict) throw new InstrumentsUnavailableError(null, "instruments (INSTRUMENTS_URL unset)")
    return null
  }
  const q = new URLSearchParams({ from: from.toUpperCase(), to: to.toUpperCase() })
  if (date) q.set("date", date)
  const url = `${base}/api/internal/fx-rates?${q}`
  let res: Response
  try {
    res = await fetch(url, { headers: instrumentsAuthHeaders(authToken) })
  } catch (e) {
    // "no rate for this pair" degrades 1:1; "could not ask" does not.
    if (opts.strict) throw new InstrumentsUnavailableError(null, url, e)
    console.warn(`[fx] ${url} unreachable:`, e instanceof Error ? e.message : e)
    return null
  }
  if (!res.ok) {
    if (opts.strict) throw new InstrumentsUnavailableError(res.status, url)
    console.warn(`[fx] ${url} -> HTTP ${res.status}; degrading 1:1`)
    return null
  }
  const body = (await res.json()) as Partial<FxRateResult>
  if (typeof body.rate === "number" && typeof body.asOf === "string") {
    return { rate: body.rate, asOf: body.asOf }
  }
  return null
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
  opts: { strict?: boolean } = {},
): Promise<(from: string, amount?: number) => Promise<number>> {
  const target = to.toUpperCase()
  return async (from: string, amount = 1): Promise<number> => {
    const f = (from ?? "").toUpperCase()
    if (!f || f === target) return amount
    const key = `${f}>${target}`
    let rate = cache.get(key)
    if (rate === undefined) {
      const r = await resolvedFxRate(authToken, f, target, undefined, opts)
      rate = r?.rate ?? 1
      cache.set(key, rate)
    }
    return amount * rate
  }
}

/**
 * Async convert-into-`to` callback for a SPECIFIC day: the pair rate is
 * resolved at that date (instruments' weekend/holiday carry-forward) and
 * memoized on `cache` keyed by (from, to, day). Same 1:1 degrade as `fxTo`.
 */
export async function fxToOnDay(
  authToken: string | null | undefined,
  to: string,
  day: string,
  cache: Map<string, number> = new Map(),
  opts: { strict?: boolean } = {},
): Promise<(from: string, amount?: number) => Promise<number>> {
  const target = to.toUpperCase()
  return async (from: string, amount = 1): Promise<number> => {
    const f = (from ?? "").toUpperCase()
    if (!f || f === target) return amount
    const key = `${f}>${target}@${day}`
    let rate = cache.get(key)
    if (rate === undefined) {
      const r = await resolvedFxRate(authToken, f, target, day, opts)
      rate = r?.rate ?? 1
      cache.set(key, rate)
    }
    return amount * rate
  }
}
