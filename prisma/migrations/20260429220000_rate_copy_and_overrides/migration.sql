-- Rate-copy pricing mode + bulk manual overrides on the pricing calendar.
-- Idempotent: parts of this schema may already exist on Railway from the
-- earlier (reverted) peer-fluctuation work. Every CREATE/ALTER uses
-- IF [NOT] EXISTS guards so this migration applies cleanly to either:
--   (a) a fresh database where none of these objects exist, OR
--   (b) Railway, where pricing_manual_overrides + the two new
--       hostaway_push_events columns already exist (empty / unused).

-- 1. New columns on hostaway_push_events. IF NOT EXISTS guards preserve
--    the prior state on Railway and add nothing destructive.
ALTER TABLE "hostaway_push_events"
  ADD COLUMN IF NOT EXISTS "trigger_source" TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE "hostaway_push_events"
  ADD COLUMN IF NOT EXISTS "override_id" TEXT;

CREATE INDEX IF NOT EXISTS "hostaway_push_events_tenant_id_trigger_source_created_at_idx"
  ON "hostaway_push_events" ("tenant_id", "trigger_source", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "hostaway_push_events_override_id_idx"
  ON "hostaway_push_events" ("override_id");

-- 2. Manual price overrides table. Same shape as the prior (reverted)
--    migration plus a `min_stay` column for per-date min-stay overrides.
CREATE TABLE IF NOT EXISTS "pricing_manual_overrides" (
  "id"             TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "listing_id"     TEXT NOT NULL,
  "start_date"     DATE NOT NULL,
  "end_date"       DATE NOT NULL,
  "override_type"  TEXT NOT NULL,
  "override_value" DOUBLE PRECISION NOT NULL,
  "min_stay"       INTEGER,
  "notes"          TEXT,
  "created_by"     TEXT NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  "removed_at"     TIMESTAMP(3),
  "removed_by"     TEXT,
  CONSTRAINT "pricing_manual_overrides_pkey" PRIMARY KEY ("id")
);

-- min_stay column for the case where the table existed before this migration
-- (Railway's already-applied earlier migration didn't have it).
ALTER TABLE "pricing_manual_overrides"
  ADD COLUMN IF NOT EXISTS "min_stay" INTEGER;

CREATE INDEX IF NOT EXISTS "pricing_manual_overrides_tenant_listing_dates_idx"
  ON "pricing_manual_overrides" ("tenant_id", "listing_id", "start_date", "end_date");
CREATE INDEX IF NOT EXISTS "pricing_manual_overrides_tenant_listing_removed_idx"
  ON "pricing_manual_overrides" ("tenant_id", "listing_id", "removed_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pricing_manual_overrides_tenant_id_fkey'
  ) THEN
    ALTER TABLE "pricing_manual_overrides"
      ADD CONSTRAINT "pricing_manual_overrides_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pricing_manual_overrides_listing_id_fkey'
  ) THEN
    ALTER TABLE "pricing_manual_overrides"
      ADD CONSTRAINT "pricing_manual_overrides_listing_id_fkey"
        FOREIGN KEY ("listing_id") REFERENCES "listings"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
