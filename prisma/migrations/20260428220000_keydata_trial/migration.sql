-- KeyData trial: 5 new tables wrapped in a single transaction.
-- See /BUILD-LOG.md for context.

BEGIN;

-- ---------------------------------------------------------------------------
-- KeyDataCacheEntry: caches KeyData API responses to stay inside the trial
-- call budget. Keyed by cacheKey (e.g. "benchmark:belfast:bedrooms=2:tier=mid_scale").
-- ---------------------------------------------------------------------------
CREATE TABLE "keydata_cache_entries" (
    "cache_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sample_size" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "keydata_cache_entries_pkey" PRIMARY KEY ("cache_key")
);

CREATE INDEX "keydata_cache_entries_expires_at_idx" ON "keydata_cache_entries"("expires_at");

-- ---------------------------------------------------------------------------
-- PricingComparisonRun: one row per daily comparison agent invocation.
-- ---------------------------------------------------------------------------
CREATE TABLE "pricing_comparison_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "listings_processed" INTEGER NOT NULL DEFAULT 0,
    "cells_compared" INTEGER NOT NULL DEFAULT 0,
    "errors_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "pricing_comparison_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pricing_comparison_runs_tenant_id_snapshot_date_idx" ON "pricing_comparison_runs"("tenant_id", "snapshot_date");
CREATE INDEX "pricing_comparison_runs_tenant_id_status_idx" ON "pricing_comparison_runs"("tenant_id", "status");

ALTER TABLE "pricing_comparison_runs"
    ADD CONSTRAINT "pricing_comparison_runs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PricingComparisonSnapshot: one row per (snapshot_date, listing, target_date)
-- captured by the daily comparison agent.
-- ---------------------------------------------------------------------------
CREATE TABLE "pricing_comparison_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "listing_id" TEXT NOT NULL,
    "target_date" DATE NOT NULL,
    "our_rate" DECIMAL(18,6) NOT NULL,
    "hostaway_rate" DECIMAL(18,6),
    "delta_abs" DECIMAL(18,6),
    "delta_pct" DOUBLE PRECISION,
    "window_days" INTEGER NOT NULL,
    "classification" TEXT NOT NULL,
    "our_breakdown" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_comparison_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pricing_comparison_snapshots_tenant_id_snapshot_date_idx" ON "pricing_comparison_snapshots"("tenant_id", "snapshot_date");
CREATE INDEX "pricing_comparison_snapshots_tenant_id_listing_id_target_date_idx" ON "pricing_comparison_snapshots"("tenant_id", "listing_id", "target_date");
CREATE INDEX "pricing_comparison_snapshots_tenant_id_snapshot_date_classification_idx" ON "pricing_comparison_snapshots"("tenant_id", "snapshot_date", "classification");

ALTER TABLE "pricing_comparison_snapshots"
    ADD CONSTRAINT "pricing_comparison_snapshots_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PricingBacktestResult: rows from the historical backtest harness.
-- ---------------------------------------------------------------------------
CREATE TABLE "pricing_backtest_results" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "stay_date" DATE NOT NULL,
    "booked_adr" DECIMAL(18,6),
    "recommended_adr" DECIMAL(18,6),
    "abs_error" DECIMAL(18,6),
    "pct_error" DOUBLE PRECISION,
    "booking_count" INTEGER NOT NULL DEFAULT 0,
    "notes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_backtest_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pricing_backtest_results_tenant_id_run_id_idx" ON "pricing_backtest_results"("tenant_id", "run_id");
CREATE INDEX "pricing_backtest_results_tenant_id_run_id_stay_date_idx" ON "pricing_backtest_results"("tenant_id", "run_id", "stay_date");
CREATE INDEX "pricing_backtest_results_tenant_id_listing_id_stay_date_idx" ON "pricing_backtest_results"("tenant_id", "listing_id", "stay_date");

ALTER TABLE "pricing_backtest_results"
    ADD CONSTRAINT "pricing_backtest_results_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- PricingDefensibilityAudit: LLM-graded recommendations from the daily audit.
-- ---------------------------------------------------------------------------
CREATE TABLE "pricing_defensibility_audits" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "listing_id" TEXT NOT NULL,
    "target_date" DATE NOT NULL,
    "verdict" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "key_strengths" JSONB NOT NULL,
    "key_concerns" JSONB NOT NULL,
    "questionable_multiplier" TEXT NOT NULL,
    "full_reasoning" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_defensibility_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pricing_defensibility_audits_tenant_id_snapshot_date_verdict_idx" ON "pricing_defensibility_audits"("tenant_id", "snapshot_date", "verdict");
CREATE INDEX "pricing_defensibility_audits_tenant_id_snapshot_date_listing_id_idx" ON "pricing_defensibility_audits"("tenant_id", "snapshot_date", "listing_id");

ALTER TABLE "pricing_defensibility_audits"
    ADD CONSTRAINT "pricing_defensibility_audits_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
