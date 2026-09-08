import { Hono, type Context } from "hono"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { wallets, walletTransactions } from "../db/schema.js"
import { settleFee } from "@marx2/contracts/fx"
import { LABELS } from "./history.js"
import type { components } from "../generated/api-types.js"

type RecentCashTransaction = components["schemas"]["RecentCashTransaction"]

const EDITABLE_TYPES = ["DEPOSIT", "WITHDRAWAL", "ADJUSTMENT"] as const

const EditSchema = z.object({
  description: z.string().optional(),
  /** contract wire field for updateCashTransaction */
  date: z.string().optional(),
  /** legacy sibling of CashTransaction.transaction_date */
  transaction_date: z.string().optional(),
  payment_method: z.string().optional(),
  type: z.enum(EDITABLE_TYPES).optional(),
  /** unsigned magnitude; sign derives from the resulting type (D18) */
  amount: z.number().positive().optional(),
  fees: z.number().nonnegative().optional(),
  /** fees-and-custom-fx D28/D29 edit parity (plan §13 follow-up 2/6) */
  fees_type: z.enum(["fixed", "pct"]).optional(),
  feeCurrency: z.string().length(3).optional(),
  feeRateSource: z.enum(["automatic", "manual"]).optional(),
  feeExchangeRate: z.number().positive().optional(),
})

/** Signed cash effect of a ledger row on its wallet (in wallet currency). */
export function rowEffect(row: typeof walletTransactions.$inferSelect): number {
  const amount = Number(row.amount)
  switch (row.type) {
    case "DEPOSIT":
    case "SELL":
    case "DIVIDEND":
    case "INTEREST":
      return amount - settledFeeOf(row)
    case "WITHDRAWAL":
    case "FEE":
      return -(Math.abs(amount) + settledFeeOf(row))
    case "TRANSFER":
      return amount // targetAmount lives on the counterpart; amount already signed
    case "INVEST":
      return amount
    case "ADJUSTMENT":
      return amount
  }
}

function settledFeeOf(row: typeof walletTransactions.$inferSelect): number {
  const raw = Number(row.fees ?? 0)
  if (!raw) return 0
  const notional = Math.abs(Number(row.amount))
  const effective =
    row.feesType === "pct" ? (notional * raw) / 100 : raw
  if (!effective) return 0
  const ccy = row.feeCurrency ?? row.currency
  if (ccy === row.currency) return effective
  const manual = row.feeRateSource === "manual" ? Number(row.feeExchangeRate ?? NaN) : undefined
  if (manual !== undefined) {
    if (!Number.isFinite(manual) || manual <= 0) return effective // degenerate guard
    return effective * manual
  }
  // automatic without a resolvable table here: treat as same-currency (best effort;
  // movements resolution guarantees rates exist at write time)
  return effective
}

export function createTransactionRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)
  const getDbInstance = () => db ?? getDb()

  async function loadOwn(database: DB, txId: string, userId: string) {
    const [row] = await database
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.id, txId), eq(walletTransactions.userId, userId)))
    return row
  }

  routes.patch("/:txId", async (c: Context) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const txId = c.req.param("txId") as string
    const row = await loadOwn(database, txId, identity.id)
    if (!row) return c.json({ error: "NotFound", message: "Transaction not found" }, 404)

    // D23 #6: trade-derived cash rows are immutable
    if (!EDITABLE_TYPES.includes(row.type as (typeof EDITABLE_TYPES)[number])) {
      return c.json(
        { error: "ValidationError", message: `${row.type} transactions cannot be edited` },
        422,
      )
    }
    // transfer legs are a pair; edit via delete+recreate
    if (row.type === "TRANSFER" || row.linkedTxId || row.toWalletId) {
      return c.json({ error: "ValidationError", message: "Transfers cannot be edited" }, 422)
    }

    const parsed = EditSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const patchBody = parsed.data

    const updated = await database.transaction(async (tx) => {
      const oldEffect = rowEffect(row)

      const newType = patchBody.type ?? row.type
      const newAmount = patchBody.amount ?? Math.abs(Number(row.amount))
      const newFees = patchBody.fees ?? Number(row.fees ?? 0)
      const newFeesType = patchBody.fees_type ?? row.feesType ?? "fixed"
      const newFeeCcy = patchBody.feeCurrency ?? row.feeCurrency ?? row.currency
      const newFeeRateSource = patchBody.feeRateSource ?? row.feeRateSource ?? "automatic"
      const newFeeFx = patchBody.feeExchangeRate ?? (row.feeExchangeRate != null ? Number(row.feeExchangeRate) : null)

      const notional = newAmount
      const effectiveFee =
        newFees > 0 ? (newFeesType === "pct" ? (notional * newFees) / 100 : newFees) : 0
      const settledFee =
        effectiveFee > 0 && newFeeCcy !== row.currency
          ? (() => {
              const manual =
                newFeeRateSource === "manual" ? (newFeeFx ?? NaN) : undefined
              const v = settleFee(effectiveFee, newFeeCcy, row.currency, {}, manual as number | undefined)
              return v ?? effectiveFee
            })()
          : effectiveFee

      const signedNew = newType === "WITHDRAWAL" ? -newAmount : newAmount
      const newEffect =
        newType === "WITHDRAWAL" ? -(newAmount + settledFee) : newAmount - settledFee

      const [updatedRow] = await tx
        .update(walletTransactions)
        .set({
          description: patchBody.description ?? row.description,
          transactionDate:
            patchBody.date ?? patchBody.transaction_date ?? (row.transactionDate as string | null),
          paymentMethod: patchBody.payment_method ?? row.paymentMethod,
          type: newType,
          amount: signedNew.toFixed(8),
          fees: newFees > 0 || patchBody.fees != null ? newFees.toFixed(8) : row.fees,
          feesType: newFeesType,
          feeCurrency: newFeeCcy,
          feeRateSource: newFeeRateSource,
          feeExchangeRate: newFeeFx != null ? String(newFeeFx) : row.feeExchangeRate,
          updatedAt: new Date(),
        })
        .where(eq(walletTransactions.id, row.id))
        .returning()

      const delta = Math.round((newEffect - oldEffect) * 1e8) / 1e8
      if (delta !== 0) {
        await tx
          .update(wallets)
          .set({
            balance: sqlAdd(wallets.balance, delta),
            availableBalance: sqlAdd(wallets.availableBalance, delta),
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, row.walletId))
      }
      return updatedRow
    })

    return c.json({ ...serializeTx(updated) } satisfies RecentCashTransaction)
  })

  routes.delete("/:txId", async (c: Context) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const txId = c.req.param("txId") as string
    const row = await loadOwn(database, txId, identity.id)
    if (!row) return c.json({ error: "NotFound", message: "Transaction not found" }, 404)

    if (!EDITABLE_TYPES.includes(row.type as (typeof EDITABLE_TYPES)[number]) && row.type !== "TRANSFER") {
      return c.json(
        { error: "ValidationError", message: `${row.type} transactions cannot be deleted` },
        422,
      )
    }

    await database.transaction(async (tx) => {
      const effect = rowEffect(row)
      await tx
        .update(wallets)
        .set({
          balance: sqlAdd(wallets.balance, -effect),
          availableBalance: sqlAdd(wallets.availableBalance, -effect),
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, row.walletId))
      await tx.delete(walletTransactions).where(eq(walletTransactions.id, row.id))

      if (row.type === "TRANSFER") {
        const pairId = row.linkedTxId ?? null
        if (pairId) {
          const [counterpart] = await tx
            .select()
            .from(walletTransactions)
            .where(eq(walletTransactions.id, pairId))
          if (counterpart) {
            const counterEffect = rowEffect(counterpart)
            await tx
              .update(wallets)
              .set({
                balance: sqlAdd(wallets.balance, -counterEffect),
                availableBalance: sqlAdd(wallets.availableBalance, -counterEffect),
                updatedAt: new Date(),
              })
              .where(eq(wallets.id, counterpart.walletId))
            await tx.delete(walletTransactions).where(eq(walletTransactions.id, pairId))
          }
        }
      }
    })

    return c.body(null, 204)
  })

  return routes
}

function sqlAdd(column: unknown, delta: number) {
  return sql`coalesce(${column}, 0) + ${delta.toFixed(8)}`
}

function serializeTx(row: typeof walletTransactions.$inferSelect): RecentCashTransaction {
  return {
    id: row.id,
    walletId: row.walletId,
    walletName: null,
    type: row.type,
    displayLabel: LABELS[row.type] ?? row.type,
    amount: row.amount,
    currency: row.currency,
    exchangeRate: row.exchangeRate != null ? Number(row.exchangeRate) : null,
    reference: row.reference ?? null,
    date: (row.transactionDate as string | null) ?? row.executedAt.toISOString(),
    description: row.description ?? null,
    createdAt: row.createdAt.toISOString(),
    portfolioId: row.portfolioId ?? null,
    fees: row.fees != null ? Number(row.fees) : null,
    taxes: row.taxes != null ? Number(row.taxes) : null,
    isInternalTransfer: false,
    feeCurrency: row.feeCurrency ?? null,
    rateSource: row.rateSource,
    feeRateSource: row.feeRateSource,
    feeExchangeRate: row.feeExchangeRate != null ? Number(row.feeExchangeRate) : null,
    labels: [],
  }
}
