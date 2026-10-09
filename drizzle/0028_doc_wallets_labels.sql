COMMENT ON TABLE "portfolios"."labels" IS 'User-created labels (D65). color is a hex #rrggbb from the shared 10-colour palette (D66); auto-assigned via palette cycling when omitted at creation. Name is unique per user. Labels attach to positions, portfolio transactions and cash transactions via the *_labels join tables.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."labels"."id" IS 'Label primary key.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."labels"."user_id" IS 'Owner of the label; the authorization boundary and the unique-name scope.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."labels"."name" IS 'Label name; unique per user (uq_labels_user_name).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."labels"."color" IS 'Hex #rrggbb from the fixed 10-colour palette; auto-assigned via palette cycling when omitted.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."labels"."created_at" IS 'When the label was created.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."labels"."updated_at" IS 'When the label was last modified.';
