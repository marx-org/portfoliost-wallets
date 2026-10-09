COMMENT ON TABLE "portfolios"."portfolio_backfill_metadata" IS 'Tracks the historical backfill status per portfolio (H6). A single row per portfolio; upserted when a backfill pass starts, completes or fails.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_backfill_metadata"."portfolio_id" IS 'Portfolio this status row belongs to; primary key, one row per portfolio.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_backfill_metadata"."status" IS 'Backfill lifecycle status: pending, complete or failed.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_backfill_metadata"."started_at" IS 'When the latest backfill pass started.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_backfill_metadata"."completed_at" IS 'When the latest backfill pass finished (success or failure).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_backfill_metadata"."error_message" IS 'Why the latest pass failed; null when the latest pass did not fail.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_backfill_metadata"."gap_symbols" IS 'Window-wide symbols held in the backfill window with no price bar, so the stored value is a partial sum; null or absent means every held symbol was priced.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_backfill_metadata"."held_gap_symbols" IS 'Subset of gap_symbols still held on the window last day; non-empty means the latest stored point is itself a partial sum.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolio_backfill_metadata"."fx_coverage_holes" IS 'symbol to number of held days with no price bar; null means no symbol had a hole.';
