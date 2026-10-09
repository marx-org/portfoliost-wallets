ALTER TABLE "portfolios"."portfolios" DROP COLUMN "strategy";--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" DROP COLUMN "margin_rate";--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" DROP COLUMN "maintenance_margin_rate";--> statement-breakpoint
COMMENT ON TABLE "portfolios"."portfolios" IS 'Portfolio container: the unit a user organizes holdings around. One row per (user_id, name); the uq_portfolios_user_name natural key is also the import bootstrap idempotency key. A portfolio owns its cash natively; the per-currency ledger lives in portfolio_cash_transactions. base_currency is the display/valuation currency; total_invested (capital basis) and current_value are denominated in it. is_public toggles the public share projection; is_margin_enabled suppresses the negative-cash warning. external_source tags import-created portfolios (NULL = manual).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."id" IS 'Primary key; generated UUID.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."user_id" IS 'Owning user; the authorization scope for every portfolio query.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."name" IS 'Portfolio name; unique per user (uq_portfolios_user_name) and the import bootstrap natural key.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."description" IS 'Free-text blurb shown on the portfolio card/detail; NULL for most portfolios.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."base_currency" IS 'Display and valuation currency (ISO-4217, 3 chars); total_invested and current_value are denominated in it.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."external_source" IS 'Import source tag for portfolios created by an import; NULL means created manually.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."total_invested" IS 'Capital basis in base_currency: net external contributions plus in-kind transfer cost (wire field capitalBasis).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."current_value" IS 'Live market valuation in base_currency (instruments plus cash).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."is_public" IS 'Toggles the auth-exempt public share projection.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."cash_leg_on_trade" IS 'UI-only switch that pre-ticks the transaction form cash box; it does not govern the sheet import.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."is_margin_enabled" IS 'Suppresses the negative-cash warning in the cash UI; margin accounts are expected to run a negative cash balance.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."created_at" IS 'Row creation timestamp.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."updated_at" IS 'Bumped on every portfolio mutation (name, currency, flags).';
