COMMENT ON TABLE "portfolios"."value_snapshots" IS 'EOD value snapshots (D54/D61). Analytics source of truth; append-only reference data recomputable by rebuild for one portfolio. Recomputing history = truncate + rebuild (same philosophy as balance-history D21). All amounts are in the portfolio base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."portfolio_id" IS 'Portfolio this snapshot belongs to; PK with snapshot_date.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."snapshot_date" IS 'Business day of the snapshot; PK with portfolio_id.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."value" IS 'Total portfolio value (positions + cash) for the day, in base currency; excludes unpriced positions.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."invested" IS 'Cumulative net invested capital (position cost basis) as of the day, in base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."net_flow" IS 'Net cash flow of the day (trades + transfers), in base currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."unpriced_value" IS 'Base-currency cost of positions with no price on the day; value excludes them, so this is the only place the withheld amount exists.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."carried_value" IS 'Base-currency cost of positions priced from a carried-forward close on a market-open day; closures excluded.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."cumulative_twr" IS 'Cumulative time-weighted return as of the day; null until computed.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."cumulative_mwr" IS 'Cumulative money-weighted (XIRR) return as of the day; null until computed.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."value_snapshots"."cumulative_simple" IS 'Cumulative simple return as of the day; null until computed.';
