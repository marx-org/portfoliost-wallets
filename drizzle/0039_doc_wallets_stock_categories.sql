COMMENT ON TABLE "portfolios"."stock_chart_categories" IS 'Feature #253/#258: one user-owned fixed stock category per (owner, STOCK symbol, instrument currency) across all lots/accounts. Options and other asset types are excluded, so a same-ticker option never inherits the equity category. Absence of a row means not_classified; assignments are retained when the stock is temporarily unheld.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."stock_chart_categories"."id" IS 'Assignment primary key.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."stock_chart_categories"."user_id" IS 'Owner of the assignment; the authorization boundary and the unique scope.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."stock_chart_categories"."symbol" IS 'Equity ticker symbol, e.g. AAPL. A same-ticker option is a different asset type and never collides here.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."stock_chart_categories"."instrument_currency" IS 'Instrument quote currency (ISO 4217); part of the equity identity.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."stock_chart_categories"."category" IS 'Fixed category: balanced | high_yield | high_growth | very_high_growth | not_classified (chk_stock_chart_categories_category).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."stock_chart_categories"."created_at" IS 'When the assignment was created.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."stock_chart_categories"."updated_at" IS 'When the assignment was last edited.';
