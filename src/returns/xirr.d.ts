/**
 * Minimal type declaration for the `xirr` package (v1.x), which ships no
 * types. Only the surface this engine uses is declared.
 *
 * `xirr(transactions)` returns the annualised money-weighted rate as a
 * fraction, and throws on degenerate inputs (all one sign, all one day, or
 * no convergence).
 */
declare module "xirr" {
  export interface XirrTransaction {
    /** Negative for money paid in, positive for money out. */
    amount: number
    /** Epoch milliseconds. */
    when: number
  }
  export interface XirrOptions {
    guess?: number
  }
  export default function xirr(transactions: XirrTransaction[], options?: XirrOptions): number
}