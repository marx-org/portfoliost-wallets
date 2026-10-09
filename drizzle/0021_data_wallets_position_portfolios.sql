-- Data migration (#115): seed the new position_portfolios membership from the
-- existing single positions.portfolio_id ownership, one-for-one, so current
-- portfolio results are unchanged. Guarded with ON CONFLICT DO NOTHING so an
-- interrupted boot cannot duplicate or corrupt rows.
INSERT INTO "portfolios"."position_portfolios" ("position_id", "portfolio_id")
SELECT "id", "portfolio_id" FROM "portfolios"."positions"
ON CONFLICT DO NOTHING;
