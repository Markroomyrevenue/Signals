CREATE TABLE IF NOT EXISTS external_api_cache (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  request_label TEXT,
  status TEXT NOT NULL,
  payload JSONB,
  error_message TEXT,
  fetched_at TIMESTAMP(3) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS external_api_cache_provider_cache_key_key
  ON external_api_cache (provider, cache_key);

CREATE INDEX IF NOT EXISTS external_api_cache_provider_expires_at_idx
  ON external_api_cache (provider, expires_at);
