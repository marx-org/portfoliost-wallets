CREATE TABLE "portfolios"."chart_event_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation" integer NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"position_id" uuid,
	"event_date" date NOT NULL,
	"receipt_kind" text NOT NULL,
	"amount_base" numeric(20, 8) DEFAULT '0' NOT NULL,
	"amount_original" numeric(20, 8) DEFAULT '0' NOT NULL,
	"original_currency" char(3) NOT NULL,
	"source_transaction_id" uuid,
	"source_cash_transaction_id" uuid,
	"transfer_group_id" uuid,
	"standalone" boolean DEFAULT false NOT NULL,
	"linked_position_id" uuid
);
--> statement-breakpoint
CREATE TABLE "portfolios"."chart_position_daily" (
	"generation" integer NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"day" date NOT NULL,
	"quantity" numeric(20, 8) DEFAULT '0' NOT NULL,
	"value" numeric(20, 8) DEFAULT '0' NOT NULL,
	"remaining_basis" numeric(20, 8) DEFAULT '0' NOT NULL,
	"realized_gain" numeric(20, 8) DEFAULT '0' NOT NULL,
	"income" numeric(20, 8) DEFAULT '0' NOT NULL,
	"net_flow" numeric(20, 8) DEFAULT '0' NOT NULL,
	"instrument_currency" char(3) DEFAULT 'USD' NOT NULL,
	"price_known" boolean DEFAULT true NOT NULL,
	"carried_forward" boolean DEFAULT false NOT NULL,
	CONSTRAINT "chart_position_daily_generation_portfolio_id_position_id_day_pk" PRIMARY KEY("generation","portfolio_id","position_id","day")
);
--> statement-breakpoint
CREATE TABLE "portfolios"."chart_projection_state" (
	"portfolio_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dirty_from" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portfolios"."chart_event_facts" ADD CONSTRAINT "chart_event_facts_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."chart_event_facts" ADD CONSTRAINT "chart_event_facts_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "portfolios"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."chart_position_daily" ADD CONSTRAINT "chart_position_daily_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."chart_position_daily" ADD CONSTRAINT "chart_position_daily_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "portfolios"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."chart_projection_state" ADD CONSTRAINT "chart_projection_state_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chart_event_facts_scope" ON "portfolios"."chart_event_facts" USING btree ("portfolio_id","event_date");--> statement-breakpoint
CREATE INDEX "idx_chart_event_facts_generation" ON "portfolios"."chart_event_facts" USING btree ("generation","portfolio_id");--> statement-breakpoint
CREATE INDEX "idx_chart_position_daily_scope" ON "portfolios"."chart_position_daily" USING btree ("portfolio_id","day");