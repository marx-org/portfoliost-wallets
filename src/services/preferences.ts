import { ISO_CURRENCY } from "../routes/wallets.js"

const USERS_AUTH_URL = process.env.USERS_AUTH_URL ?? "http://users-auth:3000"

/**
 * D21b: the display/base currency default comes from the user's preferences
 * (users_auth.user_preferences.ui_preferences.baseCurrency). Best-effort:
 * any failure falls back to USD so wallet creation never breaks because of
 * the preference service.
 */
export async function preferredBaseCurrency(
  authHeaders: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetchImpl(`${USERS_AUTH_URL}/api/users/preferences`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return "USD"
    const body = (await res.json()) as { uiPreferences?: { baseCurrency?: string } | string }
    let prefs = body.uiPreferences
    if (typeof prefs === "string") {
      try {
        prefs = JSON.parse(prefs)
      } catch {
        return "USD"
      }
    }
    const candidate = (prefs as { baseCurrency?: string } | null)?.baseCurrency
    if (candidate && ISO_CURRENCY.test(candidate)) return candidate.toUpperCase()
    return "USD"
  } catch {
    return "USD"
  }
}
