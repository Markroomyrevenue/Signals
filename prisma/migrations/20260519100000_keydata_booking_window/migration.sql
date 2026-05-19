-- Add KeyData booking-window and revpar_adj fields powering the
-- soft demand-spike detector + the revpar-adj-based stability signals.
ALTER TABLE "pricing_comparison_snapshots"
  ADD COLUMN IF NOT EXISTS "keydata_forward_revpar_adj" DOUBLE PRECISION;
ALTER TABLE "pricing_comparison_snapshots"
  ADD COLUMN IF NOT EXISTS "keydata_forward_revpar_adj_ly" DOUBLE PRECISION;
ALTER TABLE "pricing_comparison_snapshots"
  ADD COLUMN IF NOT EXISTS "keydata_forward_booking_window" DOUBLE PRECISION;
ALTER TABLE "pricing_comparison_snapshots"
  ADD COLUMN IF NOT EXISTS "keydata_forward_booking_window_median" DOUBLE PRECISION;
