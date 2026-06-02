-- Mirror Hostaway: soft-delete listings that drop out of the account.
-- When a successful, non-empty Hostaway listing sync no longer returns a
-- listing, the sync engine stamps removed_at instead of deleting the row,
-- so all booking history is preserved and the listing simply hides from
-- the app. The marker is cleared back to NULL if the listing reappears.
-- The index supports the (tenant_id, removed_at IS NULL) enumeration filter.

-- AlterTable
ALTER TABLE "listings" ADD COLUMN "removed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "listings_tenant_id_removed_at_idx" ON "listings"("tenant_id", "removed_at");
