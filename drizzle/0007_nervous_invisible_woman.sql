CREATE TABLE "portfolios"."portfolio_cash_transaction_labels" (
	"cash_transaction_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "portfolio_cash_transaction_labels_cash_transaction_id_label_id_pk" PRIMARY KEY("cash_transaction_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "portfolios"."portfolio_cash_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(28, 8) NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"description" text,
	"transaction_date" date,
	"payment_method" text,
	"fees" numeric(20, 8),
	"fees_type" text,
	"fee_currency" char(3),
	"to_portfolio_id" uuid,
	"linked_tx_id" uuid,
	"reference" text,
	"exchange_rate" numeric(20, 10),
	"rate_source" text DEFAULT 'automatic' NOT NULL,
	"fee_rate_source" text DEFAULT 'automatic' NOT NULL,
	"fee_exchange_rate" numeric(20, 10),
	"transfer_fx_rate" numeric(20, 10),
	"target_amount" numeric(20, 8),
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_pctx_type" CHECK ("portfolios"."portfolio_cash_transactions"."type" in ('DEPOSIT','WITHDRAWAL','TRANSFER')),
	CONSTRAINT "ck_pctx_fees_type" CHECK ("portfolios"."portfolio_cash_transactions"."fees_type" in ('fixed','pct')),
	CONSTRAINT "ck_pctx_rate_source" CHECK ("portfolios"."portfolio_cash_transactions"."rate_source" in ('automatic','manual')),
	CONSTRAINT "ck_pctx_fee_rate_source" CHECK ("portfolios"."portfolio_cash_transactions"."fee_rate_source" in ('automatic','manual')),
	CONSTRAINT "ck_pctx_amount_nonzero" CHECK ("portfolios"."portfolio_cash_transactions"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "portfolios"."wallet_transaction_labels" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallets"."wallet_transactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wallets"."wallets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "portfolios"."wallet_transaction_labels" CASCADE;--> statement-breakpoint
DROP TABLE "wallets"."wallet_transactions" CASCADE;--> statement-breakpoint
DROP TABLE "wallets"."wallets" CASCADE;--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transaction_labels" ADD CONSTRAINT "portfolio_cash_transaction_labels_cash_transaction_id_portfolio_cash_transactions_id_fk" FOREIGN KEY ("cash_transaction_id") REFERENCES "portfolios"."portfolio_cash_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transaction_labels" ADD CONSTRAINT "portfolio_cash_transaction_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "portfolios"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transactions" ADD CONSTRAINT "portfolio_cash_transactions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_cash_transactions" ADD CONSTRAINT "portfolio_cash_transactions_to_portfolio_id_portfolios_id_fk" FOREIGN KEY ("to_portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cash_transaction_labels_label" ON "portfolios"."portfolio_cash_transaction_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "idx_pctx_portfolio" ON "portfolios"."portfolio_cash_transactions" USING btree ("portfolio_id","transaction_date");--> statement-breakpoint
CREATE INDEX "idx_pctx_user_recent" ON "portfolios"."portfolio_cash_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pctx_external" ON "portfolios"."portfolio_cash_transactions" USING btree ("external_source","external_id") WHERE "portfolios"."portfolio_cash_transactions"."external_id" is not null;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" DROP COLUMN "wallet_id";--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" DROP COLUMN "wallet_id";--> statement-breakpoint
ALTER TABLE "portfolios"."positions" DROP COLUMN "wallet_id";