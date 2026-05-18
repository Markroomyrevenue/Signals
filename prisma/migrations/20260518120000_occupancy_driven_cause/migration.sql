-- Add the occupancy multiplier + rate-without-occupancy columns powering
-- the `occupancy_driven` divergence-cause bucket. Idempotent so the
-- migration can be re-applied without conflicts.
ALTER TABLE "pricing_comparison_snapshots"
  ADD COLUMN IF NOT EXISTS "our_occupancy_multiplier" DOUBLE PRECISION;

ALTER TABLE "pricing_comparison_snapshots"
  ADD COLUMN IF NOT EXISTS "rate_without_occupancy" DECIMAL(18, 6);
