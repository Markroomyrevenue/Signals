ALTER TABLE hostaway_connections
  ALTER COLUMN hostaway_account_id DROP NOT NULL,
  ALTER COLUMN api_key_encrypted DROP NOT NULL;

ALTER TABLE hostaway_connections
  ADD COLUMN IF NOT EXISTS hostaway_client_id TEXT,
  ADD COLUMN IF NOT EXISTS hostaway_client_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS hostaway_access_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS hostaway_access_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS webhook_basic_user TEXT,
  ADD COLUMN IF NOT EXISTS webhook_basic_pass_encrypted TEXT;
