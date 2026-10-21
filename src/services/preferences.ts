import { ISO_CURRENCY } from "./currency.js"
import { internalServiceUrl } from "./internal-url.js"

function usersAuthUrl(): string {
  return internalServiceUrl(
    process.env.USERS_AUTH_URL,
    "http://users-auth:3000",
    "users-auth",
  )
}

/** The only sanctioned default: a user who has genuinely never chosen a base
 * currency. Never used to paper over a read failure (§66.4). */
export const DEFAULT_BASE_CURRENCY = "USD"

/**
 * D21b: the display/base currency default comes from the user's preferences
 * (users_auth.user_preferences.ui_preferences.baseCurrency).
 *
 * §66.4 — this used to collapse "no preference set" and "could not read the
 * preference" into the same `return "USD"`, so a 2 s timeout or a 500 silently
 * *persisted* USD as a portfolio's base currency and silently denominated the
 * whole `total-metrics` aggregate in USD. Those are different: a genuine "unset"
 * may default, an unreadable one must not. `strict` (the default) throws on a
 * read failure; portfolio *creation* passes strict:false so a preference-service
 * blip cannot block creating a portfolio.
 */
export async function preferredBaseCurrency(
  authHeaders: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  opts: { strict?: boolean } = {},
): Promise<string> {
  const strict = opts.strict ?? true
  // Only a genuinely UNSET preference may default. §66.4: this function used to
  // collapse "unset" and "unreadable" into the same `return "USD"`, so a 2 s
  // timeout or a 500 silently persisted USD as a portfolio's base currency and
  // silently denominated the whole total-metrics aggregate in USD.
  const unreadable = (why: string): string => {
    if (strict) throw new Error(`preferences: ${why}`)
    console.warn(`[prefs] ${why}; falling back to ${DEFAULT_BASE_CURRENCY}`)
    return DEFAULT_BASE_CURRENCY
  }
  // The try block must only wrap the I/O: `unreadable` throws in strict mode, and
  // a throw from inside here would be caught by our own catch and re-wrapped,
  // losing the real reason.
  let res: Response
  let body: { uiPreferences?: { baseCurrency?: string } | string }
  try {
    res = await fetchImpl(`${usersAuthUrl()}/api/users/preferences`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(2000),
    })
  } catch (e) {
    return unreadable(`could not read preferences: ${e instanceof Error ? e.message : e}`)
  }
  if (!res.ok) return unreadable(`preferences returned ${res.status}`)
  try {
    body = (await res.json()) as typeof body
  } catch (e) {
    return unreadable(`preferences returned unparseable JSON: ${e instanceof Error ? e.message : e}`)
  }
  let prefs = body.uiPreferences
  if (typeof prefs === "string") {
    try {
      prefs = JSON.parse(prefs)
    } catch {
      return unreadable("ui_preferences is not valid JSON")
    }
  }
  const candidate = (prefs as { baseCurrency?: string } | null)?.baseCurrency
  if (candidate && ISO_CURRENCY.test(candidate)) return candidate.toUpperCase()
  return DEFAULT_BASE_CURRENCY // genuinely unset
}
