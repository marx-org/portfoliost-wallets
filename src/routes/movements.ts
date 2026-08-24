import { Hono, type Context } from "hono"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { wallets, walletTransactions } from "../db/schema.js"
import { resolveFeeFx } from "../services/fee-fx.js"

const MovementSchema = z.object({
  amount: z.number().positive(),
  description: z.string().optional(),
  transaction_date: z.string().optional(),
  payment_method: z.string().optional(),
  fees: z.number().nonnegative().optional(),
  fees_type: z.enum(["fixed", "pct"]).optional(),
  feeCurrency: z.string().length(3).optional(),
  rateSource: z.enum(["automatic", "manual"]).optional(),
  exchangeRate: z.number().positive().optional(),
  feeRateSource: z.enum(["automatic", "manual"]).optional(),
  feeExchangeRate: z.number().positive().optional(),
  // elastic transfer target leg (wallets D22)
  to_wallet_id: z.string().uuid().optional(),
  targetAmount: z.number().positive().optional(),
  targetFxRate: z.number().positive().optional(),
})

const scale8 = (n: number) => n.toFixed(8)

export function createMovementRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)
  const getDbInstance = () => db ?? getDb()

  async function loadOwnWallet(database: DB, id: string, userId: string) {
    const [w] = await database
      .select()
      .from(wallets)
      .where(and(eq(wallets.id, id), eq(wallets.userId, userId)))
    return w
  }

  async function handle(c: Context, kind: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER") {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const parsed = MovementSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const body = parsed.data
    const walletId = c.req.param("id") as string

    const wallet = await loadOwnWallet(database, walletId, identity.id)
    if (!wallet) return c.json({ error: "NotFound", message: "Wallet not found" }, 404)

    let dest = null as typeof wallets.$inferSelect | null
    if (kind === "TRANSFER") {
      if (!body.to_wallet_id) return c.json({ error: "ValidationError", message: "to_wallet_id is required" }, 422)
      dest = await loadOwnWallet(database, body.to_wallet_id, identity.id)
      if (!dest || dest.id === wallet.id) {
        return c.json({ error: "NotFound", message: "Destination wallet not found" }, 404)
      }
    }

    const fx = await resolveFeeFx(database, body, wallet.currency, {
      notional: kind === "TRANSFER" && dest ? Number(wallet.balance) : body.amount,
      toWalletCcy: dest?.currency ?? null,
    })
    if (!fx.ok) return c.json({ error: "ValidationError", message: fx.message }, 422)

    const executedAt = new Date()
    const result = await database.transaction(async (tx) => {
      const [fresh] = await tx.select().from(wallets).where(eq(wallets.id, wallet.id)).for("update")
      const balance = Number(fresh.balance)
      const available = Number(fresh.availableBalance)

      const feesSettled = fx.feesSettled
      const delta =
        kind === "DEPOSIT" ? body.amount - feesSettled : -(body.amount + feesSettled)
      const newBalance = Math.round((balance + delta) * 1e8) / 1e8
      const newAvailable = Math.round((available + delta) * 1e8) / 1e8
      if (kind !== "DEPOSIT" && newAvailable < -1e-9) {
        return { insufficient: true as const }
      }

      const creditAmount =
        kind === "TRANSFER" && dest
          ? (fx.fields.targetAmount ??
            Math.round(body.amount * (fx.fields.transferFxRate ?? 1) * 1e8) / 1e8)
          : null

      let destFresh: typeof wallets.$inferSelect | null = null
      if (kind === "TRANSFER" && dest) {
        ;[destFresh] = await tx.select().from(wallets).where(eq(wallets.id, dest.id)).for("update")
        const dBalance = Math.round((Number(destFresh.balance) + creditAmount!) * 1e8) / 1e8
        const dAvailable = Math.round((Number(destFresh.availableBalance) + creditAmount!) * 1e8) / 1e8
        await tx
          .update(wallets)
          .set({ balance: scale8(dBalance), availableBalance: scale8(dAvailable), updatedAt: executedAt })
          .where(eq(wallets.id, dest.id))
        destFresh = { ...destFresh, balance: scale8(dBalance), availableBalance: scale8(dAvailable) } as typeof destFresh
      }

      const [outgoing] = await tx
        .insert(walletTransactions)
        .values({
          userId: identity.id,
          walletId: wallet.id,
          type: kind,
          amount: scale8(kind === "DEPOSIT" ? body.amount : -body.amount),
          currency: fresh.currency,
          description: body.description ?? null,
          transactionDate: body.transaction_date ?? null,
          paymentMethod: body.payment_method ?? null,
          fees: body.fees != null ? scale8(body.fees) : null,
          feesType: fx.fields.feesType,
          feeCurrency: fx.fields.feeCurrency,
          rateSource: fx.fields.rateSource,
          exchangeRate: scale8(fx.fields.exchangeRate),
          feeRateSource: fx.fields.feeRateSource,
          feeExchangeRate: fx.fields.feeExchangeRate != null ? String(fx.fields.feeExchangeRate) : null,
          toWalletId: kind === "TRANSFER" ? dest!.id : null,
          transferFxRate: fx.fields.transferFxRate != null ? String(fx.fields.transferFxRate) : null,
          targetAmount: creditAmount != null ? scale8(creditAmount) : null,
          executedAt,
        })
        .returning()

      await tx
        .update(wallets)
        .set({ balance: scale8(newBalance), availableBalance: scale8(newAvailable), updatedAt: executedAt })
        .where(eq(wallets.id, wallet.id))

      let incoming = null
      if (kind === "TRANSFER" && dest) {
        ;[incoming] = await tx
          .insert(walletTransactions)
          .values({
            userId: identity.id,
            walletId: dest.id,
            type: "TRANSFER",
            amount: scale8(creditAmount!),
            currency: dest.currency,
            description:
              body.description ?? `Transfer from ${fresh.name}`,
            transactionDate: body.transaction_date ?? null,
            linkedTxId: outgoing.id,
            rateSource: fx.fields.rateSource,
            exchangeRate: scale8(
              fx.fields.exchangeRate * (fx.fields.transferFxRate ?? 1),
            ),
            transferFxRate: fx.fields.transferFxRate != null ? String(fx.fields.transferFxRate) : null,
            targetAmount: scale8(creditAmount!),
            executedAt,
          })
          .returning()
        await tx
          .update(walletTransactions)
          .set({ linkedTxId: incoming.id })
          .where(eq(walletTransactions.id, outgoing.id))
      }

      const echo = {
        ...outgoing,
        amount: Number(outgoing.amount),
        fees: outgoing.fees != null ? Number(outgoing.fees) : null,
        fees_settled: feesSettled,
        new_balance: newBalance,
        remaining_balance: newAvailable,
      }
      return { insufficient: false as const, echo, incoming }
    })

    if (result.insufficient) {
      return c.json({ error: "ValidationError", message: "Insufficient funds" }, 422)
    }
    return c.json(result.echo, 201)
  }

  routes.post("/:id/deposits", (c) => handle(c, "DEPOSIT"))
  routes.post("/:id/withdrawals", (c) => handle(c, "WITHDRAWAL"))
  routes.post("/:id/transfers", (c) => handle(c, "TRANSFER"))

  return routes
}
