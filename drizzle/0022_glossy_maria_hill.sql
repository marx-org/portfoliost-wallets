ALTER TABLE "portfolios"."positions" DROP CONSTRAINT "ck_positions_fees_type";--> statement-breakpoint
ALTER TABLE "portfolios"."positions" DROP CONSTRAINT "positions_portfolio_id_portfolios_id_fk";
--> statement-breakpoint
DROP INDEX "portfolios"."idx_positions_portfolio";--> statement-breakpoint
ALTER TABLE "portfolios"."positions" DROP COLUMN "portfolio_id";--> statement-breakpoint
ALTER TABLE "portfolios"."positions" DROP COLUMN "fees";--> statement-breakpoint
ALTER TABLE "portfolios"."positions" DROP COLUMN "fees_type";--> statement-breakpoint
ALTER TABLE "portfolios"."positions" DROP COLUMN "fee_currency";--> statement-breakpoint
COMMENT ON TABLE "portfolios"."positions" IS 'Position lots owned by a user; ownership is the many-to-many position_portfolios membership, so a position may belong to several portfolios (#115). Quote refresh recalculates and stores the quote-derived valuation fields.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."id" IS 'Position primary key.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."user_id" IS 'Owner of the position; the direct authorization boundary (D24).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."symbol" IS 'Ticker symbol of the instrument, e.g. AAPL.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."company_name" IS 'Display name of the issuer/instrument, when known.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."asset_type" IS 'Instrument class; defaults to STOCK.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."contract_size" IS 'Derivative contract size (units per contract), accepted by imports and returned by the position API; null for cash equities.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."direction" IS 'Position direction, LONG or SHORT; null when untracked.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."option_type" IS 'Option type, CALL or PUT; null for non-option positions.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."strike_price" IS 'Option strike price in instrument currency; null when not an option.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."expiration_date" IS 'Option expiration date; null when not an option.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."quantity" IS 'Current open quantity in instrument units (negative for short).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."average_cost_basis" IS 'Average cost basis per unit in purchase currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."instrument_currency" IS 'Currency the instrument is quoted in (ISO 4217).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."purchase_currency" IS 'Currency the position was purchased in, when it differs from the instrument currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."sector" IS 'Sector classification, when known.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."industry" IS 'Industry classification within the sector, when known.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."country" IS 'Country of the instrument listing/issuer, when known.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."is_open" IS 'True while the position has an open quantity; drives lifecycle filtering and API/UI behavior.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."opened_at" IS 'Timestamp the position was first opened.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."closed_at" IS 'Timestamp the position was fully closed; null while open.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."current_price" IS 'Latest quote price in instrument currency.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."price_source" IS 'Source of current_price (e.g. manual or a quote provider).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."price_as_of" IS 'Timestamp the latest quote price was captured.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."market_value" IS 'Quote-derived market value, recalculated and stored on quote refresh.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."unrealized_gain_loss" IS 'Unrealized gain/loss versus cost basis.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."day_change" IS 'Quote-derived change in value since the prior close, stored on quote refresh.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."day_change_percent" IS 'Quote-derived day change as a percentage of the prior value, stored on quote refresh.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."created_at" IS 'Row creation timestamp.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."positions"."updated_at" IS 'Row last-update timestamp.';