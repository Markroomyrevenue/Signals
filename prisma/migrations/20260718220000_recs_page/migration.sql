-- Recs page (2026-07-18). Additive only: new columns on suggestions, three new
-- tables. No existing column is altered, dropped, or repurposed.

-- AlterTable: suggestions — recs-page decision + provenance fields
ALTER TABLE "suggestions" ADD COLUMN "provenance" TEXT;
ALTER TABLE "suggestions" ADD COLUMN "provisional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "suggestions" ADD COLUMN "actioned_at" TIMESTAMP(3);
ALTER TABLE "suggestions" ADD COLUMN "actioned_by_email" TEXT;
ALTER TABLE "suggestions" ADD COLUMN "approved_price" DECIMAL(18,6);
ALTER TABLE "suggestions" ADD COLUMN "push_ref" TEXT;

-- CreateIndex
CREATE INDEX "suggestions_tenant_id_actioned_at_idx" ON "suggestions"("tenant_id", "actioned_at");

-- CreateTable: recs_evidence
CREATE TABLE "recs_evidence" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT 'warm-start',
    "payload" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recs_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recs_evidence_tenant_id_client_key_kind_key" ON "recs_evidence"("tenant_id", "client_key", "kind");
CREATE INDEX "recs_evidence_tenant_id_kind_idx" ON "recs_evidence"("tenant_id", "kind");

ALTER TABLE "recs_evidence" ADD CONSTRAINT "recs_evidence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: recs_market_snapshots
CREATE TABLE "recs_market_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "engine_listing_id" TEXT NOT NULL DEFAULT '',
    "day" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recs_market_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recs_market_snapshots_tenant_id_engine_kind_engine_listing__key" ON "recs_market_snapshots"("tenant_id", "engine", "kind", "engine_listing_id", "day");
CREATE INDEX "recs_market_snapshots_tenant_id_day_idx" ON "recs_market_snapshots"("tenant_id", "day");

ALTER TABLE "recs_market_snapshots" ADD CONSTRAINT "recs_market_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: oversight_runs
CREATE TABLE "oversight_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_key" TEXT NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "suggestion_count" INTEGER,
    "flag_count" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(12,6),
    "client_read" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oversight_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "oversight_runs_tenant_id_run_at_idx" ON "oversight_runs"("tenant_id", "run_at");

ALTER TABLE "oversight_runs" ADD CONSTRAINT "oversight_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
