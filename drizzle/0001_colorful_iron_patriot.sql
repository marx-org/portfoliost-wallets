CREATE SCHEMA "portfolios";
--> statement-breakpoint
CREATE TABLE "portfolios"."transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"position_id" uuid,
	"wallet_id" uuid,
	"type" text NOT NULL,
	"instrument_symbol" text,
	"instrument_name" text,
	"sector" text,
	"industry" text,
	"country" text,
	"quantity" numeric(20, 8) DEFAULT '0' NOT NULL,
	"price" numeric(20, 8) DEFAULT '0' NOT NULL,
	"currency" char(3) NOT NULL,
	"instrument_currency" char(3),
	"asset_type" text DEFAULT 'STOCK' NOT NULL,
	"fees" numeric(20, 8),
	"fees_type" text,
	"fee_currency" char(3),
	"taxes" numeric(20, 8),
	"fees_settled" numeric(20, 8),
	"total_amount" numeric(20, 8) DEFAULT '0' NOT NULL,
	"realized_gain_loss" numeric(20, 8),
	"exchange_rate" numeric(20, 10),
	"rate_source" text DEFAULT 'automatic' NOT NULL,
	"fee_rate_source" text DEFAULT 'automatic' NOT NULL,
	"fee_exchange_rate" numeric(20, 10),
	"converted_total_amount" numeric(20, 8),
	"converted_price" numeric(20, 8),
	"converted_fees" numeric(20, 8),
	"converted_realized_gain_loss" numeric(20, 8),
	"display_currency" char(3),
	"is_gift" boolean DEFAULT false NOT NULL,
	"synthesized_opening_lot" boolean DEFAULT false NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_ptx_type" CHECK ("portfolios"."transactions"."type" in ('BUY','SELL','DIVIDEND')),
	CONSTRAINT "ck_ptx_rate_source" CHECK ("portfolios"."transactions"."rate_source" in ('automatic','manual')),
	CONSTRAINT "ck_ptx_fee_rate_source" CHECK ("portfolios"."transactions"."fee_rate_source" in ('automatic','manual')),
	CONSTRAINT "ck_ptx_fees_type" CHECK ("portfolios"."transactions"."fees_type" in ('fixed','pct'))
);
--> statement-breakpoint
CREATE TABLE "portfolios"."portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"strategy" text DEFAULT 'GROWTH' NOT NULL,
	"type" text DEFAULT 'regular' NOT NULL,
	"currency" char(3) NOT NULL,
	"base_currency" char(3) DEFAULT 'USD' NOT NULL,
	"wallet_id" uuid,
	"total_invested" numeric(20, 8) DEFAULT '0' NOT NULL,
	"current_value" numeric(20, 8) DEFAULT '0' NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_margin_enabled" boolean DEFAULT false NOT NULL,
	"margin_rate" numeric(9, 4),
	"maintenance_margin_rate" numeric(9, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios"."positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"company_name" text,
	"asset_type" text DEFAULT 'STOCK' NOT NULL,
	"contract_size" numeric(20, 8),
	"direction" text,
	"option_type" text,
	"strike_price" numeric(20, 8),
	"expiration_date" date,
	"quantity" numeric(20, 8) DEFAULT '0' NOT NULL,
	"average_cost_basis" numeric(20, 8) DEFAULT '0' NOT NULL,
	"instrument_currency" char(3) DEFAULT 'USD' NOT NULL,
	"purchase_currency" char(3),
	"sector" text,
	"industry" text,
	"country" text,
	"wallet_id" uuid,
	"fees" numeric(20, 8),
	"fees_type" text,
	"fee_currency" char(3),
	"is_open" boolean DEFAULT true NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"current_price" numeric(20, 8),
	"price_source" text DEFAULT 'manual' NOT NULL,
	"price_as_of" timestamp with time zone,
	"market_value" numeric(20, 8),
	"unrealized_gain_loss" numeric(20, 8),
	"day_change" numeric(20, 8),
	"day_change_percent" numeric(20, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_positions_direction" CHECK ("portfolios"."positions"."direction" in ('LONG','SHORT')),
	CONSTRAINT "ck_positions_option_type" CHECK ("portfolios"."positions"."option_type" in ('CALL','PUT')),
	CONSTRAINT "ck_positions_fees_type" CHECK ("portfolios"."positions"."fees_type" in ('fixed','pct'))
);
--> statement-breakpoint
CREATE TABLE "portfolios"."shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"privacy_settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios"."value_snapshots" (
	"portfolio_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"value" numeric(20, 8) NOT NULL,
	"invested" numeric(20, 8) NOT NULL,
	"net_flow" numeric(20, 8) DEFAULT '0' NOT NULL,
	CONSTRAINT "value_snapshots_portfolio_id_snapshot_date_pk" PRIMARY KEY("portfolio_id","snapshot_date")
);
--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "transactions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "transactions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "portfolios"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" ADD CONSTRAINT "portfolios_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."positions" ADD CONSTRAINT "positions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."positions" ADD CONSTRAINT "positions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."shares" ADD CONSTRAINT "shares_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."value_snapshots" ADD CONSTRAINT "value_snapshots_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ptx_portfolio" ON "portfolios"."transactions" USING btree ("portfolio_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ptx_user" ON "portfolios"."transactions" USING btree ("user_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ptx_position" ON "portfolios"."transactions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "idx_portfolios_user" ON "portfolios"."portfolios" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_positions_portfolio" ON "portfolios"."positions" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "idx_positions_symbol" ON "portfolios"."positions" USING btree ("user_id","symbol");--> statement-breakpoint
CREATE INDEX "idx_shares_portfolio" ON "portfolios"."shares" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "idx_snapshots_portfolio_date" ON "portfolios"."value_snapshots" USING btree ("portfolio_id","snapshot_date");