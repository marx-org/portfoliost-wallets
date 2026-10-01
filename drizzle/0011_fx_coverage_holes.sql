ALTER TABLE portfolios.portfolio_backfill_metadata
  ADD COLUMN IF NOT EXISTS fx_coverage_holes jsonb;