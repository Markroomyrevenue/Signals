/**
 * A2 — Multi-unit inventory map. READ-ONLY.
 * Identify Little Feather's multi-unit listings (unit_count >= 2), describe the
 * unit_count=100 listing, and show how the report's inventory denominator is
 * built (active-listing-days, lifecycle-gated) vs a unit_count-scaled denom.
 */
import { prisma, getLiveTenants } from "./lib/ctx";

async function main() {
  const tenants = await getLiveTenants();
  const lf = tenants.find((t) => /little feather/i.test(t.name));
  if (!lf) throw new Error("Little Feather not found among live tenants");
  console.log(`Little Feather tenantId = ${lf.id}\n`);

  // All listings with their unit_count, removed_at, tags.
  const listings = await prisma.listing.findMany({
    where: { tenantId: lf.id },
    select: {
      id: true,
      hostawayId: true,
      name: true,
      unitCount: true,
      removedAt: true,
      tags: true,
      bedroomsNumber: true,
      personCapacity: true,
      createdAt: true
    },
    orderBy: { unitCount: "desc" }
  });

  const multi = listings.filter((l) => (l.unitCount ?? 1) >= 2);
  console.log(`Total listings: ${listings.length}  |  multi-unit (>=2): ${multi.length}\n`);
  console.log("MULTI-UNIT LISTINGS:");
  for (const l of multi) {
    console.log(
      `  unit_count=${String(l.unitCount).padStart(3)}  removed=${l.removedAt ? "Y" : "n"}  hwId=${String(l.hostawayId).padStart(8)}  beds=${l.bedroomsNumber} cap=${l.personCapacity}  tags=${JSON.stringify(l.tags)}  "${l.name}"`
    );
  }

  // For each multi-unit listing: count reservations + distinct date-spanning nights.
  console.log("\nPER MULTI-UNIT LISTING RESERVATION / NIGHTFACT PROFILE:");
  for (const l of multi) {
    const resvCount = await prisma.reservation.count({ where: { tenantId: lf.id, listingId: l.id } });
    const nfCount = await prisma.nightFact.count({ where: { tenantId: lf.id, listingId: l.id } });
    // Max concurrent reservations overlapping any single date (does a date ever exceed unit_count?)
    const overlap = await prisma.$queryRawUnsafe<any[]>(
      `SELECT nf.date::text AS d, COUNT(*)::int AS c
       FROM night_facts nf
       WHERE nf.tenant_id = $1 AND nf.listing_id = $2 AND nf.is_occupied = true
       GROUP BY nf.date ORDER BY c DESC LIMIT 3`,
      lf.id, l.id
    );
    console.log(
      `  hwId=${l.hostawayId} uc=${l.unitCount}: resv=${resvCount} nightfacts=${nfCount}  topConcurrentNights=${overlap.map((o) => `${o.d}:${o.c}`).join(", ")}`
    );
  }

  // Report inventory denominator: how many active listing-days does the report
  // count over trailing 365, and does it multiply by unit_count?
  const today = new Date();
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const from = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  const activeListings = listings.filter((l) => !l.removedAt).length;
  console.log(`\nTrailing window ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)} = ${days} days`);
  console.log(`Active (non-removed) listings: ${activeListings}`);
  const naiveInv = activeListings * days;
  const unitScaledInv = listings.filter((l) => !l.removedAt).reduce((s, l) => s + (l.unitCount ?? 1) * days, 0);
  console.log(`Naive listing-days inventory (×1 each):       ${naiveInv.toLocaleString()}`);
  console.log(`If scaled ×unit_count:                         ${unitScaledInv.toLocaleString()}`);
  console.log(`Extra inventory unit_count WOULD add:          ${(unitScaledInv - naiveInv).toLocaleString()}  (${(((unitScaledInv - naiveInv) / naiveInv) * 100).toFixed(1)}% of naive)`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
