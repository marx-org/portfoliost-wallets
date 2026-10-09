ALTER TABLE "portfolios"."portfolio_cash_transactions" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transactions" DROP COLUMN "payment_method";--> statement-breakpoint
COMMENT ON TABLE "portfolios"."portfolio_cash_transactions" IS 'Portfolio-owned cash ledger (plan section 62): the external cash rows for one portfolio - deposits, withdrawals and transfers. Balances are DERIVED by replay of these rows plus the portfolio trade rows (BUY/SELL/DIVIDEND cash effects); no balance is stored. Amounts are signed in the row currency (DEPOSIT positive, WITHDRAWAL negative, TRANSFER as sent). Cross-currency transfers store both legs linked via linked_tx_id plus transfer_fx_rate (D22). external_source + external_id tag imported rows and are the import idempotency key; reference correlates a row to its source transaction/import row, or a human-readable manual transfer reference.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."id" IS 'Primary key; generated UUID.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."user_id" IS 'Denormalized owner (D24): direct authorization on every cash-row operation.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."portfolio_id" IS 'Owning portfolio; deleting the portfolio cascades to its ledger rows.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."type" IS 'Cash event kind: DEPOSIT, WITHDRAWAL or TRANSFER.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."amount" IS 'Signed in the row currency: DEPOSIT positive, WITHDRAWAL negative, TRANSFER as sent.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."currency" IS 'The row currency (ISO-4217), independent of the portfolio base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."description" IS 'Free-text note shown on the cash row.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."transaction_date" IS 'User-facing date of the cash event; null for a row dated today.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."fees" IS 'Fee amount, denominated in fee_currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."fees_type" IS 'How the fee was expressed: fixed amount or percentage of the principal.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."fee_currency" IS 'Currency the fee was paid in (ISO-4217); null when there is no fee.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."to_portfolio_id" IS 'TRANSFER destination portfolio; null for non-transfer rows.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."linked_tx_id" IS 'The paired cash leg for a cross-currency transfer (D22); null otherwise.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."linked_trade_id" IS 'The trade this cash leg belongs to (section 87.2): a deposit funding a buy or a withdrawal taking out sell proceeds. Nullable; the key lives on the cash row so ON DELETE CASCADE pairs both directions.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."reference" IS 'Source-row correlation: for imported rows the base source transaction/import-row id; for a manual transfer a human-readable transfer reference.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."exchange_rate" IS 'FX rate applied to the row currency against the portfolio base.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."rate_source" IS 'Whether exchange_rate came from the FX service (automatic) or was set by hand (manual).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."fee_rate_source" IS 'Whether fee_exchange_rate came from the FX service (automatic) or was set by hand (manual).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."fee_exchange_rate" IS 'FX rate applied to the fee currency against the portfolio base.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."transfer_fx_rate" IS 'Cross-currency transfer rate between the two legs (D22).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."target_amount" IS 'D22 elastic target leg: the destination-side amount, server-computed when omitted.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."external_source" IS 'Import provenance tag for imported rows; null when created manually.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."external_id" IS 'Importer-supplied dedup key; unique per external_source (idempotency).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."created_at" IS 'Row creation timestamp.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_cash_transactions"."updated_at" IS 'Bumped on every ledger-row mutation.';
