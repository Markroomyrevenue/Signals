-- Add last_suggestion_run: summary of the latest suggestion generation
-- (generated + blocked-by-reason counts) for the day-30 readout trust line.
ALTER TABLE "observation_windows" ADD COLUMN "last_suggestion_run" JSONB;
