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
ALTER TABLE "wallets"."wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "wallets"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets"."wallet_transactions" ADD CONSTRAINT "wallet_transactions_to_wallet_id_wallet_transactions_id_fk" FOREIGN KEY ("to_wallet_id") REFERENCES "wallets"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_wtx_wallet" ON "wallets"."wallet_transactions" USING btree ("wallet_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_wtx_user_recent" ON "wallets"."wallet_transactions" USING btree ("user_id","executed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wtx_reference" ON "wallets"."wallet_transactions" USING btree ("reference") WHERE reference is not null;--> statement-breakpoint
CREATE INDEX "idx_wallets_user" ON "wallets"."wallets" USING btree ("user_id");