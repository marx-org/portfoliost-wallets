-- §87.2 — link a cash leg to the trade it funds, and let both deletes follow.
--
-- The key lives on the CASH row pointing at the TRADE, not the other way round,
-- because that direction makes both delete paths work with zero application
-- logic: deleting the trade cascades to the cash leg (a money row can never be
-- orphaned by deleting the trade it belongs to), and deleting the cash row leaves
-- the trade alone because the link *was* the row. The reverse layout would need
-- hand-written cascade code in portfolio-transactions.ts for the direction that
-- matters most.
--
-- Nullable on purpose: it exists only when a related cash transaction exists.
-- AU=0 trades (pure replay) and every hand-written Wpłata/Wypłata stay NULL — no
-- row, no key, no sentinel.
--
-- `linked_tx_id` is deliberately untouched: that is the cash↔cash transfer pair
-- (D22) and means something else.
--
-- NOTE — the statements `drizzle-kit generate` also wanted to emit for
-- held_gap_symbols / fx_coverage_holes / unpriced_value / carried_value were
-- removed on purpose: those four are migrations 0010–0013, applied in every
-- environment including PROD, and the meta snapshots behind them were never
-- refreshed. Re-emitting them would fail on a populated database. The 0014
-- snapshot does contain them, so the drift is gone from here on.
ALTER TABLE "portfolios"."portfolio_cash_transactions" ADD COLUMN "linked_trade_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transactions" ADD CONSTRAINT "portfolio_cash_transactions_linked_trade_id_transactions_id_fk" FOREIGN KEY ("linked_trade_id") REFERENCES "portfolios"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_cash_transactions_linked_trade_id_idx" ON "portfolios"."portfolio_cash_transactions" USING btree ("linked_trade_id");--> statement-breakpoint
-- Backfill, §7b data migration: the `#d` (deposit), `#w` (withdrawal, new in
-- §87.1) and `#t` (server-created transfer credit) suffixes are a documented
-- convention, so the trade is fully derivable from the cash row's own
-- external_id — the link does not depend on the importer having been right.
-- Measured in PROD before writing: 362 of 362 suffixed cash rows match a trade,
-- 1 977 of 1 977 trades carry an external_id. Matching external_source as well
-- keeps a multi-source install from linking one source's leg to another source's
-- trade with a colliding id. Guarded by IS NULL, so it is idempotent.
--
-- Out of scope by construction: Equate+'s TRANSFER *debit* leg carries the
-- sale's own external_id (unsuffixed), so the suffix rule does not reach it. The
-- `#t` credit leg on IBKR is the one that links to the sale.
UPDATE portfolios.portfolio_cash_transactions c
   SET linked_trade_id = t.id
  FROM portfolios.transactions t
 WHERE c.linked_trade_id IS NULL
   AND (c.external_id LIKE '%#d' OR c.external_id LIKE '%#w' OR c.external_id LIKE '%#t')
   AND left(c.external_id, length(c.external_id) - 2) = t.external_id
   AND c.external_source = t.external_source;