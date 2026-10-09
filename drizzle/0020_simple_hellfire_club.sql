CREATE TABLE "portfolios"."position_portfolios" (
	"position_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	CONSTRAINT "position_portfolios_position_id_portfolio_id_pk" PRIMARY KEY("position_id","portfolio_id")
);
--> statement-breakpoint
ALTER TABLE "portfolios"."position_portfolios" ADD CONSTRAINT "position_portfolios_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "portfolios"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios"."position_portfolios" ADD CONSTRAINT "position_portfolios_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_position_portfolios_portfolio" ON "portfolios"."position_portfolios" USING btree ("portfolio_id");--> statement-breakpoint
COMMENT ON TABLE "portfolios"."position_portfolios" IS 'Many-to-many membership linking a position to the portfolios that hold it. Replaces the former single positions.portfolio_id ownership column so one position can belong to several portfolios (#115).';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."position_portfolios"."position_id" IS 'The position that holds membership. FK to portfolios.positions.id; cascades on position delete.';--> statement-breakpoint
COMMENT ON COLUMN "portfolios"."position_portfolios"."portfolio_id" IS 'The portfolio the position is a member of. FK to portfolios.portfolios.id; cascades on portfolio delete.';