CREATE SCHEMA "portfolios";
--> statement-breakpoint
CREATE SCHEMA "wallets";
--> statement-breakpoint
CREATE TABLE "wallets"."fx_rates" (
	"rate_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"source" text DEFAULT 'ecb' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate_date_currency_pk" PRIMARY KEY("rate_date","currency")
);
--> statement-breakpoint
CREATE TABLE "wallets"."fx_sync_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_rate_date" date,
	"last_run_at" timestamp with time zone,
	"last_status" text
);
--> statement-breakpoint
CREATE TABLE "portfolios"."labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios"."portfolio_backfill_metadata" (
	"portfolio_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text
);
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
CREATE TABLE "portfolios"."position_labels" (
	"position_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "position_labels_position_id_label_id_pk" PRIMARY KEY("position_id","label_id")
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
CREATE TABLE "portfolios"."transaction_labels" (
	"transaction_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "transaction_labels_transaction_id_label_id_pk" PRIMARY KEY("transaction_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "portfolios"."value_snapshots" (
	"portfolio_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"value" numeric(20, 8) NOT NULL,
	"invested" numeric(20, 8) NOT NULL,
	"net_flow" numeric(20, 8) DEFAULT '0' NOT NULL,
	"cumulative_twr" numeric(20, 8),
	"cumulative_mwr" numeric(20, 8),
	"cumulative_simple" numeric(20, 8),
	CONSTRAINT "value_snapshots_portfolio_id_snapshot_date_pk" PRIMARY KEY("portfolio_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "portfolios"."wallet_transaction_labels" (
	"wallet_transaction_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "wallet_transaction_labels_wallet_transaction_id_label_id_pk" PRIMARY KEY("wallet_transaction_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "wallets"."wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"wallet_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"description" text,
	"transaction_date" date,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payment_method" text,
	"fees" numeric(20, 8),
	"fees_type" text,
	"fee_currency" char(3),
	"taxes" numeric(20, 8),
	"to_wallet_id" uuid,
	"linked_tx_id" uuid,
	"reference" text,
	"portfolio_id" uuid,
	"exchange_rate" numeric(20, 10),
	"rate_source" text DEFAULT 'automatic' NOT NULL,
	"fee_rate_source" text DEFAULT 'automatic' NOT NULL,
	"fee_exchange_rate" numeric(20, 10),
	"transfer_fx_rate" numeric(20, 10),
	"target_amount" numeric(20, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_wtx_type" CHECK ("wallets"."wallet_transactions"."type" in ('DEPOSIT','WITHDRAWAL','TRANSFER','INVEST','SELL','DIVIDEND','FEE','INTEREST','ADJUSTMENT')),
	CONSTRAINT "ck_wtx_fees_type" CHECK ("wallets"."wallet_transactions"."fees_type" in ('fixed','pct')),
	CONSTRAINT "ck_wtx_rate_source" CHECK ("wallets"."wallet_transactions"."rate_source" in ('automatic','manual')),
	CONSTRAINT "ck_wtx_fee_rate_source" CHECK ("wallets"."wallet_transactions"."fee_rate_source" in ('automatic','manual')),
	CONSTRAINT "ck_wtx_amount_nonzero" CHECK ("wallets"."wallet_transactions"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "wallets"."wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"base_currency" char(3) DEFAULT 'USD' NOT NULL,
	"balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"available_balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"reserved" numeric(20, 8) DEFAULT '0' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolios"."portfolio_backfill_metadata" ADD CONSTRAINT "portfolio_backfill_metadata_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "transactions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "transactions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "portfolios"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" ADD CONSTRAINT "portfolios_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."position_labels" ADD CONSTRAINT "position_labels_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "portfolios"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."position_labels" ADD CONSTRAINT "position_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "portfolios"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."positions" ADD CONSTRAINT "positions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."positions" ADD CONSTRAINT "positions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."shares" ADD CONSTRAINT "shares_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transaction_labels" ADD CONSTRAINT "transaction_labels_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "portfolios"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."transaction_labels" ADD CONSTRAINT "transaction_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "portfolios"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."value_snapshots" ADD CONSTRAINT "value_snapshots_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."wallet_transaction_labels" ADD CONSTRAINT "wallet_transaction_labels_wallet_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("wallet_transaction_id") REFERENCES "wallets"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."wallet_transaction_labels" ADD CONSTRAINT "wallet_transaction_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "portfolios"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."wallet_transactions" ADD CONSTRAINT "wallet_transactions_to_wallet_id_wallets_id_fk" FOREIGN KEY ("to_wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_labels_user_name" ON "portfolios"."labels" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "idx_labels_user" ON "portfolios"."labels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ptx_portfolio" ON "portfolios"."transactions" USING btree ("portfolio_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ptx_user" ON "portfolios"."transactions" USING btree ("user_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_ptx_position" ON "portfolios"."transactions" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "idx_portfolios_user" ON "portfolios"."portfolios" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_position_labels_label" ON "portfolios"."position_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "idx_positions_portfolio" ON "portfolios"."positions" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "idx_positions_symbol" ON "portfolios"."positions" USING btree ("user_id","symbol");--> statement-breakpoint
CREATE INDEX "idx_shares_portfolio" ON "portfolios"."shares" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_labels_label" ON "portfolios"."transaction_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "idx_snapshots_portfolio_date" ON "portfolios"."value_snapshots" USING btree ("portfolio_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "idx_wallet_transaction_labels_label" ON "portfolios"."wallet_transaction_labels" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "idx_wtx_wallet" ON "wallets"."wallet_transactions" USING btree ("wallet_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_wtx_user_recent" ON "wallets"."wallet_transactions" USING btree ("user_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wtx_reference" ON "wallets"."wallet_transactions" USING btree ("reference") WHERE reference is not null;--> statement-breakpoint
CREATE INDEX "idx_wallets_user" ON "wallets"."wallets" USING btree ("user_id");