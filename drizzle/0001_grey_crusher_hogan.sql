CREATE TABLE "wallets"."sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"external_source" text NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"sheet" text NOT NULL,
	"last_row" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"inserted_wtx" integer DEFAULT 0 NOT NULL,
	"inserted_ptx" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallets"."wallet_transactions" DROP CONSTRAINT "ck_wtx_amount_nonzero";--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD COLUMN "original_quantity" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD COLUMN "original_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD COLUMN "external_source" text;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" ADD COLUMN "external_source" text;--> statement-breakpoint
ALTER TABLE "wallets"."wallet_transactions" ADD COLUMN "external_source" text;--> statement-breakpoint
ALTER TABLE "wallets"."wallet_transactions" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "wallets"."wallets" ADD COLUMN "external_source" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sync_runs" ON "wallets"."sync_runs" USING btree ("user_id","external_source","spreadsheet_id","sheet");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ptx_external" ON "portfolios"."transactions" USING btree ("external_source","external_id") WHERE "portfolios"."transactions"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wtx_external" ON "wallets"."wallet_transactions" USING btree ("external_source","external_id") WHERE "wallets"."wallet_transactions"."external_id" is not null;--> statement-breakpoint
ALTER TABLE "wallets"."wallet_transactions" ADD CONSTRAINT "ck_wtx_amount_nonzero" CHECK ("wallets"."wallet_transactions"."amount" <> 0 or "wallets"."wallet_transactions"."type" = 'ADJUSTMENT');