-- Operator-set correction of WHEN a booking was made, for PMS migrations
-- that stamp imported history with the import date (Guesty did this to
-- Cityscape's pre-migration reservations). Nullable + additive; the sync
-- engine never writes this column, so PMS re-syncs cannot clobber it.
-- Night facts and booking-date reports prefer it over created_at.
ALTER TABLE "reservations" ADD COLUMN "booked_at_override" TIMESTAMP(3);
