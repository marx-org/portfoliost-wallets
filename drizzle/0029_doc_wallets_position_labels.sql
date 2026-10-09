COMMENT ON TABLE "portfolios"."position_labels" IS 'Many-to-many join: label to position (D65). Written with replace semantics (D67/D68): the full label set for a position is cleared and re-inserted in one transaction. Rows cascade on position or label delete.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."position_labels"."position_id" IS 'Position the label attaches to; cascades on position delete.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."position_labels"."label_id" IS 'Label being attached; cascades on label delete.';
