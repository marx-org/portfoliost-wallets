/**
 * Shared date constants and helpers for the returns engine.
 *
 * One definition of "days between two ISO dates" and "days per year", so the
 * annualisation constructs and the XIRR cash-flow builder cannot drift apart.
 */

/** Days per year used by every annualisation construct in this engine. */
export const DAYS_PER_YEAR = 365

/** Whole days between two ISO date strings (`b − a`), as a float. */
export function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86400000
}