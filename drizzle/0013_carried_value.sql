ALTER TABLE portfolios.value_snapshots
  ADD COLUMN IF NOT EXISTS carried_value numeric(20,8) NOT NULL DEFAULT 0;
