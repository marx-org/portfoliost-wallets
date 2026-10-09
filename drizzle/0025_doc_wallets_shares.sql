COMMENT ON TABLE "portfolios"."shares" IS 'Public portfolio share links (D54). A row is one auth-exempt link exposing a portfolio; the public route is addressed by id. A 10-active limit per user is enforced at write time (D59); delete is unconditional. privacy_settings jsonb controls position projection for the auth-exempt public route.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."id" IS 'Public share-link id; the auth-exempt route is addressed by this id.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."user_id" IS 'Owner who created the link; the authorization boundary for list/create/delete.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."portfolio_id" IS 'Portfolio this link exposes; cascades on portfolio delete.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."display_name" IS 'Public display name; falls back to the portfolio name when empty.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."view_count" IS 'Count of public views; incremented on each auth-exempt read.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."expires_at" IS 'Optional expiry; null means the link does not expire.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."privacy_settings" IS 'Position-projection switches for the public route (showValues, positionsToHide, …).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."created_at" IS 'When the link was created.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."shares"."updated_at" IS 'Last touched (bumped on each public view).';
