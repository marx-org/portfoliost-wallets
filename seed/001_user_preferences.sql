INSERT INTO users_auth.user_preferences (user_id, language, ui_preferences, custom_benchmarks, custom_timeframes, onboarding_status, onboarding_draft, created_at, updated_at)
VALUES
  ('test-user-001', 'en', '{"chartTimeframe":"1M","tableColumns":["name","value"]}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{"completed":true}'::jsonb, '{"draft":null}'::jsonb, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('test-user-002', 'de', '{"chartTimeframe":"1Y","tableColumns":["name","value","gain"]}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{"completed":false}'::jsonb, '{"draft":null}'::jsonb, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT (user_id) DO NOTHING;
