/**
 * One-off backfill: populate Listing.vat_rate_pct from each listing's already
 * stored raw_json, using the SAME matcher the live sync uses
 * (extractListingVatRatePct). Safe to re-run — it only writes when the derived
 * rate differs from what's stored.
 *
 * Run against prod via the Railway public proxy:
 *   railway run -s Postgres-1_Oc bash -lc \
 *     'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/backfill-vat-rate.ts'
 */
import { prisma } from "@/lib/prisma";
import { extractListingVatRatePct } from "@/lib/sync/listing-vat";

async function main() {
  const listings = await prisma.listing.findMany({
    select: { id: true, tenantId: true, name: true, rawJson: true, vatRatePct: true }
  });

  let updated = 0;
  let withVat = 0;
  let unchanged = 0;

  for (const listing of listings) {
    const derived = extractListingVatRatePct(listing.rawJson);
    if (derived !== null) withVat += 1;

    const currentNum = listing.vatRatePct === null ? null : Number(listing.vatRatePct);
    const sameValue = (currentNum === null && derived === null) || (currentNum !== null && derived !== null && currentNum === derived);
    if (sameValue) {
      unchanged += 1;
      continue;
    }

    await prisma.listing.update({
      where: { id: listing.id },
      data: { vatRatePct: derived }
    });
    updated += 1;
    console.log(`  set vat_rate_pct=${derived ?? "null"} for "${listing.name}" (${listing.id})`);
  }

  console.log("\nBackfill complete:");
  console.log(`  listings scanned : ${listings.length}`);
  console.log(`  with VAT rate    : ${withVat}`);
  console.log(`  rows updated     : ${updated}`);
  console.log(`  already correct  : ${unchanged}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
