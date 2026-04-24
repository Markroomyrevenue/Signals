-- Add cancelled_at timestamp to reservations for tracking when bookings were cancelled.
-- This is critical for pace YoY comparisons: we need to know if a booking was live
-- at a historical cutoff date even if it was later cancelled.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Index for efficient pace queries that filter by cancellation date
CREATE INDEX IF NOT EXISTS idx_reservations_cancelled_at
  ON reservations (tenant_id, cancelled_at)
  WHERE cancelled_at IS NOT NULL;
