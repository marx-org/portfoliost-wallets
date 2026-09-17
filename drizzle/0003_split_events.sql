CREATE TABLE "portfolios"."split_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"factor" numeric(20, 8) NOT NULL,
	"effective_date" date NOT NULL,
	"source" text DEFAULT 'admin' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_split_events" ON "portfolios"."split_events" USING btree ("symbol","effective_date");