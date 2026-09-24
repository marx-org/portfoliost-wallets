import { resolvedFxRate } from "./instruments-fx.js"

/** Snapshot semantics (D21): manual wins verbatim; auto resolves from
 * instruments' fx_rates (plan §48.3). */
export async function snapshotRate(
  authToken: string | null,
  fromCcy: string,
  toCcy: string,
  manual?: number,
): Promise<{ rate: number; source: "automatic" | "manual" }> {
  if (fromCcy === toCcy) return { rate: 1, source: manual != null ? "manual" : "automatic" }
  if (manual != null && Number.isFinite(manual) && manual > 0) return { rate: manual, source: "manual" }
  const rate = (await resolvedFxRate(authToken, fromCcy, toCcy))?.rate
  return { rate: rate ?? 1, source: "automatic" }
}
