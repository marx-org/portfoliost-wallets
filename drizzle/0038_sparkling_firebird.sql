CREATE TABLE "portfolios"."stock_chart_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"symbol" text NOT NULL,
	"instrument_currency" char(3) NOT NULL,
	"category" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_stock_chart_categories_category" CHECK ("portfolios"."stock_chart_categories"."category" in ('balanced','high_yield','high_growth','very_high_growth','not_classified'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_stock_chart_categories_owner_stock" ON "portfolios"."stock_chart_categories" USING btree ("user_id","symbol","instrument_currency");--> statement-breakpoint
CREATE INDEX "idx_stock_chart_categories_user" ON "portfolios"."stock_chart_categories" USING btree ("user_id");