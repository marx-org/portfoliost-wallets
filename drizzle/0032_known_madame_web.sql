ALTER TABLE "portfolios"."portfolios" ADD COLUMN "is_virtual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" ADD COLUMN "label_id" uuid;--> statement-breakpoint
ALTER TABLE "portfolios"."portfolios" ADD CONSTRAINT "portfolios_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "portfolios"."labels"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."is_virtual" IS 'Whether this portfolio is a read-only view over instruments selected by label_id.';
--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."portfolios"."label_id" IS 'The user-owned label selecting instruments included in a virtual portfolio; NULL for casual portfolios.';
