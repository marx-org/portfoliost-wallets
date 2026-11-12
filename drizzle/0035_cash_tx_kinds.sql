ALTER TABLE "portfolios"."portfolio_cash_transactions" DROP CONSTRAINT "ck_pctx_type";--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transactions" ADD COLUMN "to_currency" char(3);--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transactions" ADD COLUMN "to_amount" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transactions" ADD CONSTRAINT "ck_pctx_type" CHECK ("portfolios"."portfolio_cash_transactions"."type" in ('DEPOSIT','WITHDRAWAL','TRANSFER','INTEREST','FEE','FX_CONVERSION'));