ALTER TABLE "portfolios"."value_snapshots" ADD COLUMN "cumulative_twr" numeric(20, 8);
--> statement-breakpoint
ALTER TABLE "portfolios"."value_snapshots" ADD COLUMN "cumulative_mwr" numeric(20, 8);
--> statement-breakpoint
ALTER TABLE "portfolios"."value_snapshots" ADD COLUMN "cumulative_simple" numeric(20, 8);
