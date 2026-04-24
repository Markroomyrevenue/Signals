CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_currency VARCHAR(3) NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX idx_users_tenant ON users (tenant_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sessions_tenant_user ON sessions (tenant_id, user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

CREATE TABLE hostaway_connections (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  hostaway_account_id TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  webhook_shared_token TEXT
);
CREATE INDEX idx_hostaway_connections_status ON hostaway_connections (status);

CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostaway_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  timezone TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, hostaway_id)
);
CREATE INDEX idx_listings_tenant_status ON listings (tenant_id, status);
CREATE INDEX idx_listings_tenant_timezone ON listings (tenant_id, timezone);
CREATE INDEX idx_listings_tags_gin ON listings USING GIN (tags);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostaway_id TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  channel TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  arrival DATE NOT NULL,
  departure DATE NOT NULL,
  nights INTEGER NOT NULL,
  guests INTEGER,
  currency VARCHAR(3) NOT NULL,
  total NUMERIC(18, 6) NOT NULL,
  accommodation_fare NUMERIC(18, 6) NOT NULL,
  cleaning_fee NUMERIC(18, 6) NOT NULL,
  taxes NUMERIC(18, 6) NOT NULL,
  commission NUMERIC(18, 6) NOT NULL,
  source_updated_at TIMESTAMPTZ,
  raw_json JSONB NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, hostaway_id)
);
CREATE INDEX idx_reservations_tenant_created_at ON reservations (tenant_id, created_at);
CREATE INDEX idx_reservations_tenant_arrival ON reservations (tenant_id, arrival);
CREATE INDEX idx_reservations_tenant_departure ON reservations (tenant_id, departure);
CREATE INDEX idx_reservations_tenant_hostaway_id ON reservations (tenant_id, hostaway_id);
CREATE INDEX idx_reservations_tenant_channel ON reservations (tenant_id, channel);
CREATE INDEX idx_reservations_tenant_status ON reservations (tenant_id, status);
CREATE INDEX idx_reservations_tenant_listing_stay ON reservations (tenant_id, listing_id, arrival, departure);

CREATE TABLE calendar_rates (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  available BOOLEAN NOT NULL,
  min_stay INTEGER,
  max_stay INTEGER,
  rate NUMERIC(18, 6) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  raw_json JSONB NOT NULL,
  PRIMARY KEY (tenant_id, listing_id, date)
);
CREATE INDEX idx_calendar_rates_tenant_listing_date ON calendar_rates (tenant_id, listing_id, date);
CREATE INDEX idx_calendar_rates_tenant_date ON calendar_rates (tenant_id, date);

CREATE TABLE night_facts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  fact_key TEXT NOT NULL,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
  is_occupied BOOLEAN NOT NULL,
  revenue_allocated NUMERIC(18, 6) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  channel TEXT,
  booking_created_at TIMESTAMPTZ,
  lead_time_days INTEGER,
  los_nights INTEGER,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, date, listing_id, fact_key)
) PARTITION BY RANGE (date);

CREATE TABLE pace_snapshots (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  stay_date DATE NOT NULL,
  nights_on_books INTEGER NOT NULL,
  revenue_on_books NUMERIC(18, 6) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, snapshot_date, listing_id, stay_date)
) PARTITION BY RANGE (snapshot_date);

CREATE OR REPLACE FUNCTION ensure_monthly_partition(base_table TEXT, month_start DATE)
RETURNS VOID AS $$
DECLARE
  normalized_month_start DATE := date_trunc('month', month_start)::date;
  part_name TEXT := format('%s_%s', base_table, to_char(normalized_month_start, 'YYYY_MM'));
  month_end DATE := (normalized_month_start + INTERVAL '1 month')::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    part_name,
    base_table,
    normalized_month_start,
    month_end
  );
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  i INTEGER;
  base_month DATE := date_trunc('month', CURRENT_DATE)::date;
BEGIN
  FOR i IN -24..24 LOOP
    PERFORM ensure_monthly_partition('night_facts', (base_month + (i || ' month')::interval)::date);
    PERFORM ensure_monthly_partition('pace_snapshots', (base_month + (i || ' month')::interval)::date);
  END LOOP;
END $$;

CREATE INDEX idx_night_facts_tenant_date ON night_facts (tenant_id, date);
CREATE INDEX idx_night_facts_tenant_listing_date ON night_facts (tenant_id, listing_id, date);
CREATE INDEX idx_night_facts_tenant_booking_created_at ON night_facts (tenant_id, booking_created_at);
CREATE INDEX idx_night_facts_tenant_channel ON night_facts (tenant_id, channel);
CREATE INDEX idx_night_facts_tenant_status ON night_facts (tenant_id, status);

CREATE INDEX idx_pace_snapshots_tenant_snapshot_stay ON pace_snapshots (tenant_id, snapshot_date, stay_date);
CREATE INDEX idx_pace_snapshots_tenant_listing_snapshot ON pace_snapshots (tenant_id, listing_id, snapshot_date);

CREATE TABLE daily_aggs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  occupied_nights INTEGER NOT NULL DEFAULT 0,
  available_nights INTEGER NOT NULL DEFAULT 0,
  stay_revenue NUMERIC(18, 6) NOT NULL DEFAULT 0,
  bookings_created INTEGER NOT NULL DEFAULT 0,
  booked_revenue NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cancellation_count INTEGER NOT NULL DEFAULT 0,
  live_rate_avg NUMERIC(18, 6),
  currency VARCHAR(3) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, listing_id, date)
);
CREATE INDEX idx_daily_aggs_tenant_date ON daily_aggs (tenant_id, date);
CREATE INDEX idx_daily_aggs_tenant_listing_date ON daily_aggs (tenant_id, listing_id, date);

CREATE TABLE fx_rates (
  date DATE NOT NULL,
  base_currency VARCHAR(3) NOT NULL,
  quote_currency VARCHAR(3) NOT NULL,
  rate NUMERIC(18, 8) NOT NULL,
  source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, base_currency, quote_currency)
);
CREATE INDEX idx_fx_rates_pair_date ON fx_rates (base_currency, quote_currency, date);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sync_runs_tenant_created_at ON sync_runs (tenant_id, created_at);
CREATE INDEX idx_sync_runs_tenant_status ON sync_runs (tenant_id, status);
