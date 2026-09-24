ALTER TABLE "portfolios"."value_snapshots" ALTER COLUMN "cumulative_twr" SET DATA TYPE numeric(28, 8);--> statement-breakpoint
ALTER TABLE "portfolios"."value_snapshots" ALTER COLUMN "cumulative_mwr" SET DATA TYPE numeric(28, 8);--> statement-breakpoint
ALTER TABLE "portfolios"."value_snapshots" ALTER COLUMN "cumulative_simple" SET DATA TYPE numeric(28, 8);