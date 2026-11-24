/**
 * The single returns engine.
 *
 * Every portfolio return calculation — simple, TWR, MWR (XIRR), annualisation
 * and monthly returns — is defined here and re-exported from this barrel.
 * `services/returnColumns.ts` and `services/riskMetrics.ts` re-export from here
 * for backwards compatibility, so there is exactly one implementation and one
 * place to test or extend.
 */

export { DAYS_PER_YEAR, daysBetween } from "./dates.js"
export { buildSimple } from "./simple.js"
export { buildDailyReturns, chainReturns, buildTwr } from "./twr.js"
export { xirr, buildMwr } from "./mwr.js"
export { annualizedReturn, periodReturnPercent, annualizedReturnWithheldReason } from "./annualize.js"
export { buildMonthlyReturns } from "./monthly.js"