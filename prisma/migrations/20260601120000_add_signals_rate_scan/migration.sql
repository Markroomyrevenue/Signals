-- Signals rate scanner (see /SIGNALS-RATE-SCAN-SPEC.md). Read-only feature:
-- creates four NEW tables only. No ALTER on any existing table; the only
-- foreign keys point from the new tables to tenants(id)/listings(id) with
-- ON DELETE CASCADE, matching the existing multi-tenant ownership pattern.

-- CreateTable
CREATE TABLE "rate_scans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "scanned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "listing_count" INTEGER NOT NULL,
    "change_count" INTEGER NOT NULL,
    "failed_count" INTEGER NOT NULL,
    "error" TEXT,

    CONSTRAINT "rate_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_states" (
    "tenant_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "min_stay" INTEGER,
    "available" BOOLEAN NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "last_scan_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_states_pkey" PRIMARY KEY ("tenant_id","listing_id","date")
);

-- CreateTable
CREATE TABLE "rate_changes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "scan_id" TEXT NOT NULL,
    "lever" TEXT NOT NULL,
    "old_value" DECIMAL(18,6),
    "new_value" DECIMAL(18,6),
    "change_pct" DECIMAL(10,4),
    "yearly_adr_median" DECIMAL(18,6),
    "pct_of_yearly_adr" DECIMAL(10,4),
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_rate_contexts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "stay_date" DATE NOT NULL,
    "rate_change_id" TEXT,
    "booking_created_at" TIMESTAMP(3) NOT NULL,
    "hours_since_change" DECIMAL(10,4),
    "lever_changed" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_rate_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_scans_tenant_id_scanned_at_idx" ON "rate_scans"("tenant_id", "scanned_at");

-- CreateIndex
CREATE INDEX "rate_states_tenant_id_listing_id_date_idx" ON "rate_states"("tenant_id", "listing_id", "date");

-- CreateIndex
CREATE INDEX "rate_changes_tenant_id_listing_id_date_idx" ON "rate_changes"("tenant_id", "listing_id", "date");

-- CreateIndex
CREATE INDEX "rate_changes_tenant_id_detected_at_idx" ON "rate_changes"("tenant_id", "detected_at");

-- CreateIndex
CREATE INDEX "rate_changes_tenant_id_lever_idx" ON "rate_changes"("tenant_id", "lever");

-- CreateIndex
CREATE INDEX "booking_rate_contexts_tenant_id_listing_id_stay_date_idx" ON "booking_rate_contexts"("tenant_id", "listing_id", "stay_date");

-- CreateIndex
CREATE INDEX "booking_rate_contexts_tenant_id_booking_created_at_idx" ON "booking_rate_contexts"("tenant_id", "booking_created_at");

-- CreateIndex
CREATE UNIQUE INDEX "booking_rate_contexts_tenant_id_reservation_id_stay_date_ra_key" ON "booking_rate_contexts"("tenant_id", "reservation_id", "stay_date", "rate_change_id");

-- AddForeignKey
ALTER TABLE "rate_scans" ADD CONSTRAINT "rate_scans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_states" ADD CONSTRAINT "rate_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_states" ADD CONSTRAINT "rate_states_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_changes" ADD CONSTRAINT "rate_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_changes" ADD CONSTRAINT "rate_changes_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_rate_contexts" ADD CONSTRAINT "booking_rate_contexts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_rate_contexts" ADD CONSTRAINT "booking_rate_contexts_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

