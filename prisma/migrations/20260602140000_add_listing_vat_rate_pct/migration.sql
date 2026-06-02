-- Listing.vatRatePct: mandatory percent VAT rate (e.g. 20.000 = 20%) derived
-- from the Hostaway listingFeeSetting at sync time. Nullable: most listings
-- have no mandatory percent VAT fee. Backfilled from existing raw_json by
-- scripts/backfill-vat-rate.ts (which reuses the same TS matcher the sync
-- uses) so the stored rate can never drift from the sync logic.
ALTER TABLE "listings" ADD COLUMN "vat_rate_pct" DECIMAL(6,3);
