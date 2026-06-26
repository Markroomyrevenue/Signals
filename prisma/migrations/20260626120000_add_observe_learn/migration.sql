-- Observe-and-Learn pricing intelligence (see /SIGNALS-OBSERVE-LEARN-SPEC.md).
--
-- Additive, read-only feature: creates EIGHT NEW tables only. There is NO ALTER
-- on any existing table and NO change to any existing column. The only foreign
-- keys point from the new tables to tenants(id) with ON DELETE CASCADE, matching
-- the existing multi-tenant ownership pattern. `global_methodology` is the single
-- deliberate non-tenant table (one internal anonymised doc; spec §4 / §8).
--
-- Hand-authored from `prisma migrate diff` output, trimmed to the new tables so
-- that pre-existing cosmetic drift between the legacy migration history and the
-- formatted schema (index renames, timestamp precision) is NOT swept in here.

-- CreateTable
CREATE TABLE "engine_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "engine_listing_id" TEXT NOT NULL,
    "listing_id" TEXT,
    "base" DECIMAL(18,6),
    "min" DECIMAL(18,6),
    "max" DECIMAL(18,6),
    "min_stay" INTEGER,
    "recommended_base" DECIMAL(18,6),
    "occ_next_7" DECIMAL(10,4),
    "occ_next_30" DECIMAL(10,4),
    "occ_next_60" DECIMAL(10,4),
    "market_occ_next_7" DECIMAL(10,4),
    "market_occ_next_30" DECIMAL(10,4),
    "market_occ_next_60" DECIMAL(10,4),
    "push_enabled" BOOLEAN,
    "last_refreshed_at" TIMESTAMP(3),
    "last_date_pushed" TEXT,
    "raw" JSONB,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_changes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "engine_listing_id" TEXT NOT NULL,
    "listing_id" TEXT,
    "lever" TEXT NOT NULL,
    "old_value" DECIMAL(18,6),
    "new_value" DECIMAL(18,6),
    "change_pct" DECIMAL(10,4),
    "source" TEXT NOT NULL,
    "from_snapshot_id" TEXT,
    "to_snapshot_id" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observation_windows" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_key" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "days_observed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'observing',
    "graduated_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "backfilled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observation_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "peer_controls" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "listing_id" TEXT,
    "engine_change_id" TEXT,
    "rate_change_id" TEXT,
    "event_date" DATE,
    "rung" INTEGER NOT NULL,
    "control_listing_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "moved_pickup" DECIMAL(18,6),
    "control_pickup" DECIMAL(18,6),
    "confidence" DECIMAL(10,4),
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "peer_controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_key" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_methodology" (
    "id" TEXT NOT NULL,
    "methodology" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_methodology_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggestions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_key" TEXT,
    "listing_id" TEXT,
    "engine_listing_id" TEXT,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "lever" TEXT NOT NULL,
    "old_value" DECIMAL(18,6),
    "proposed_value" DECIMAL(18,6),
    "type" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "revenue_at_risk" DECIMAL(18,6),
    "confidence" DECIMAL(10,4),
    "rung" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_key" TEXT,
    "listing_id" TEXT,
    "engine_listing_id" TEXT,
    "engine" TEXT,
    "date_from" DATE,
    "date_to" DATE,
    "lever" TEXT,
    "old_value" DECIMAL(18,6),
    "new_value" DECIMAL(18,6),
    "reason" TEXT,
    "result" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "engine_snapshots_tenant_id_engine_listing_id_captured_at_idx" ON "engine_snapshots"("tenant_id", "engine_listing_id", "captured_at");

-- CreateIndex
CREATE INDEX "engine_snapshots_tenant_id_captured_at_idx" ON "engine_snapshots"("tenant_id", "captured_at");

-- CreateIndex
CREATE INDEX "engine_snapshots_tenant_id_listing_id_idx" ON "engine_snapshots"("tenant_id", "listing_id");

-- CreateIndex
CREATE INDEX "engine_changes_tenant_id_engine_listing_id_detected_at_idx" ON "engine_changes"("tenant_id", "engine_listing_id", "detected_at");

-- CreateIndex
CREATE INDEX "engine_changes_tenant_id_detected_at_idx" ON "engine_changes"("tenant_id", "detected_at");

-- CreateIndex
CREATE INDEX "engine_changes_tenant_id_lever_idx" ON "engine_changes"("tenant_id", "lever");

-- CreateIndex
CREATE INDEX "engine_changes_tenant_id_source_idx" ON "engine_changes"("tenant_id", "source");

-- CreateIndex
CREATE INDEX "observation_windows_tenant_id_status_idx" ON "observation_windows"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "observation_windows_tenant_id_client_key_key" ON "observation_windows"("tenant_id", "client_key");

-- CreateIndex
CREATE INDEX "peer_controls_tenant_id_listing_id_idx" ON "peer_controls"("tenant_id", "listing_id");

-- CreateIndex
CREATE INDEX "peer_controls_tenant_id_rung_idx" ON "peer_controls"("tenant_id", "rung");

-- CreateIndex
CREATE INDEX "peer_controls_tenant_id_created_at_idx" ON "peer_controls"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "client_profiles_tenant_id_idx" ON "client_profiles"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_profiles_tenant_id_client_key_key" ON "client_profiles"("tenant_id", "client_key");

-- CreateIndex
CREATE INDEX "suggestions_tenant_id_status_idx" ON "suggestions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "suggestions_tenant_id_revenue_at_risk_idx" ON "suggestions"("tenant_id", "revenue_at_risk");

-- CreateIndex
CREATE INDEX "suggestions_tenant_id_listing_id_idx" ON "suggestions"("tenant_id", "listing_id");

-- CreateIndex
CREATE INDEX "push_logs_tenant_id_created_at_idx" ON "push_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "push_logs_tenant_id_listing_id_idx" ON "push_logs"("tenant_id", "listing_id");

-- AddForeignKey
ALTER TABLE "engine_snapshots" ADD CONSTRAINT "engine_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_changes" ADD CONSTRAINT "engine_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observation_windows" ADD CONSTRAINT "observation_windows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "peer_controls" ADD CONSTRAINT "peer_controls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_logs" ADD CONSTRAINT "push_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
