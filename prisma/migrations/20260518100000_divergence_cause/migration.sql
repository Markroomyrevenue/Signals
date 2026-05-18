-- Add divergence-cause classifier columns to pricing_comparison_snapshots.
-- All nullable, all backfill-friendly — existing rows just stay NULL.

ALTER TABLE "pricing_comparison_snapshots"
  ADD COLUMN IF NOT EXISTS "divergence_cause" TEXT,
  ADD COLUMN IF NOT EXISTS "our_lift" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "pl_lift" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lift_delta" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "keydata_forward_occ" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "keydata_forward_adr" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "keydata_forward_occ_ly" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "keydata_forward_adr_ly" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "pricing_comparison_snapshots_tenant_id_snapshot_date_divergence_cause_idx"
  ON "pricing_comparison_snapshots" ("tenant_id", "snapshot_date", "divergence_cause");
