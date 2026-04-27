-- Foundation for two related features (2026-04-27):
--
--  1. Multi-unit listings — one Hostaway listing represents N rooms of the
--     same type (e.g. "Double Studio × 20"). The new `listings.unit_count`
--     column holds N. Single-unit listings keep `unit_count IS NULL`.
--
--  2. Hostaway push-pull — opt-in per-listing toggle that lets the user
--     push recommended rates back to the Hostaway calendar. Each push is
--     persisted in the new `hostaway_push_events` audit table so we can
--     diagnose / roll back if the API call did the wrong thing.
--
-- Other settings that change behaviour (the per-listing
-- `hostawayPushEnabled` toggle, the `multiUnitOccupancyLeadTimeMatrix`
-- seed values, the peer-set window size, etc) live inside
-- `pricing_settings.settings` JSON and don't need a column. Defaults are
-- applied in code via `src/lib/pricing/settings.ts`.

-- 1. listings.unit_count
ALTER TABLE listings ADD COLUMN IF NOT EXISTS unit_count INTEGER;

-- 2. hostaway_push_events audit table
CREATE TABLE IF NOT EXISTS hostaway_push_events (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  listing_id   TEXT NOT NULL,
  pushed_by    TEXT NOT NULL,
  date_from    DATE NOT NULL,
  date_to      DATE NOT NULL,
  date_count   INTEGER NOT NULL,
  status       TEXT NOT NULL,
  error_message TEXT,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT hostaway_push_events_tenant_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT hostaway_push_events_listing_fkey
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hostaway_push_events_tenant_listing_created
  ON hostaway_push_events (tenant_id, listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hostaway_push_events_tenant_created
  ON hostaway_push_events (tenant_id, created_at DESC);
