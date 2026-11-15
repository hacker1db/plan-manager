-- Additive and idempotent: token lifecycle visibility (GET /api/v1/tokens).
ALTER TABLE cli_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE cli_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
