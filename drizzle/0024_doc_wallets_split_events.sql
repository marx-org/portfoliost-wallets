COMMENT ON TABLE "portfolios"."split_events" IS 'Durable stock-split event ledger (§23.6). Each row is one split: factor is the QUANTITY multiplier (2 for a 2:1 split). Pre-split transactions are restated from frozen original_quantity/original_price × the product of applicable events, which keeps apply-split idempotent. The instruments split_adjustments table holds price multipliers and is wiped by stooq imports, so it cannot serve as this history.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."split_events"."id" IS 'Split event primary key.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."split_events"."symbol" IS 'Ticker the split applies to.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."split_events"."factor" IS 'Quantity multiplier (2 for a 2:1 split); not a price multiplier.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."split_events"."effective_date" IS 'First date the factor applies; pre-split rows on/before this date are restated.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."split_events"."source" IS 'Who recorded the event; "admin" is the default internal-ingest source.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."split_events"."applied_at" IS 'When the event was recorded.';
