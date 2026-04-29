-- Migration: peer-fluctuation pricing mode + manual overrides on the
-- pricing calendar.  See BUILD-LOG.md (2026-04-29) for the design notes.

-- 1. New columns on hostaway_push_events for the audit trail.
--    triggerSource defaults to 'scheduled' so existing rows read as routine
--    (we don't have history on which old pushes were manual vs scheduled).
ALTER TABLE "hostaway_push_events"
  ADD COLUMN "trigger_source" TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN "override_id" TEXT;

CREATE INDEX "hostaway_push_events_tenant_id_trigger_source_created_at_idx"
  ON "hostaway_push_events" ("tenant_id", "trigger_source", "created_at" DESC);
CREATE INDEX "hostaway_push_events_override_id_idx"
  ON "hostaway_push_events" ("override_id");

-- 2. New table for manual price overrides on the pricing calendar.
CREATE TABLE "pricing_manual_overrides" (
  "id"             TEXT NOT NULL,
  "tenant_id"      TEXT NOT NULL,
  "listing_id"     TEXT NOT NULL,
  "start_date"     DATE NOT NULL,
  "end_date"       DATE NOT NULL,
  "override_type"  TEXT NOT NULL,
  "override_value" DOUBLE PRECISION NOT NULL,
  "notes"          TEXT,
  "created_by"     TEXT NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  "removed_at"     TIMESTAMP(3),
  "removed_by"     TEXT,

  CONSTRAINT "pricing_manual_overrides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pricing_manual_overrides_tenant_listing_dates_idx"
  ON "pricing_manual_overrides" ("tenant_id", "listing_id", "start_date", "end_date");
CREATE INDEX "pricing_manual_overrides_tenant_listing_removed_idx"
  ON "pricing_manual_overrides" ("tenant_id", "listing_id", "removed_at");

ALTER TABLE "pricing_manual_overrides"
  ADD CONSTRAINT "pricing_manual_overrides_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pricing_manual_overrides"
  ADD CONSTRAINT "pricing_manual_overrides_listing_id_fkey"
    FOREIGN KEY ("listing_id") REFERENCES "listings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
