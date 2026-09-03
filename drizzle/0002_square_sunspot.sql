CREATE TABLE "portfolios"."portfolio_backfill_metadata" (
	"portfolio_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_backfill_metadata" ADD CONSTRAINT "portfolio_backfill_metadata_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;