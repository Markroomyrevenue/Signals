/**
 * A1 — Inventory / occupancy definition probe + multi-unit (unit_count) check.
 *
 * Confirms what buildSalesReport actually uses as the occupancy/RevPAR denominator:
 *   per day: max( occupiedNights, calendarRateCount>0 ? calendarRateCount : scopedListingCount )
 * with NO lifecycle gating (every non-removed listing counts every day) and NO
 * unit_count scaling. We quantify the gap between this and the alternatives.
 *
 * READ-ONLY.  Run via: bash scripts/audit/run.sh scripts/audit/a1-inventory.ts
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildSalesReport } from "@/lib/reports/service";

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const today = new Date();
  const to = dateOnly(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  const from = dateOnly(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));
  const tenants = await getLiveTenants();

  console.log(`\nA1 INVENTORY / OCCUPANCY DEFINITION   stay window ${from}..${to}\n`);

  for (const t of tenants) {
    // unit_count distribution
    const listings = await prisma.listing.findMany({
      where: { tenantId: t.id, removedAt: null },
      select: { id: true, name: true, unitCount: true }
    });
    const multi = listings.filter((l) => (l.unitCount ?? 1) >= 2);
    const sumUnits = listings.reduce((a, l) => a + Math.max(1, l.unitCount ?? 1), 0);

    // Report inventory (the displayed denominator)
    const rep = await buildSalesReport({
      tenantId: t.id,
      request: {
        stayDateFrom: from, stayDateTo: to, granularity: "month",
        listingIds: [], channels: [], statuses: [],
        includeFees: true, includeVat: true, barMetric: "revenue", compareMode: "yoy_otb"
      } as any,
      displayCurrency: "GBP"
    });
    const repInv = rep.current.inventory.reduce((a, b) => a + b, 0);
    const repNights = rep.current.nights.reduce((a, b) => a + b, 0);

    // Alt A: pure listing-count × days (no lifecycle, no unit_count) — naive upper baseline
    const days = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
    const altListingDays = listings.length * days;
    // Alt B: with unit_count scaling
    const altUnitDays = sumUnits * days;
    // Alt C: calendar_rates count (registry/available denominator)
    const cal = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS c FROM calendar_rates cr
       JOIN listings l ON l.id=cr.listing_id AND l.tenant_id=cr.tenant_id AND l.removed_at IS NULL
       WHERE cr.tenant_id=$1 AND cr.date>=$2::date AND cr.date<=$3::date`,
      t.id, from, to
    );
    const calCount = Number(cal[0].c);
    // Alt D: lifecycle-gated listing-days (only count a listing-day on/after its first booked night)
    const lifeRows = await prisma.$queryRawUnsafe<any[]>(
      `WITH firstnight AS (
         SELECT listing_id, MIN(date) AS first_date
         FROM night_facts WHERE tenant_id=$1 AND is_occupied=true GROUP BY listing_id
       )
       SELECT COALESCE(SUM(
         GREATEST(0,
           LEAST($3::date, CURRENT_DATE) -
           GREATEST($2::date, fn.first_date) + 1)
       ),0)::bigint AS d
       FROM listings l JOIN firstnight fn ON fn.listing_id=l.id
       WHERE l.tenant_id=$1 AND l.removed_at IS NULL`,
      t.id, from, to
    );
    const lifeDays = Number(lifeRows[0].d);

    console.log(`===== ${t.name} =====`);
    console.log(`  listings(active)=${listings.length}  multi-unit=${multi.length}  sum(unit_count)=${sumUnits}  days=${days}`);
    if (multi.length > 0) {
      console.log(`  multi-unit listings: ${multi.map((m) => `${m.name?.slice(0, 24)}(uc=${m.unitCount})`).join(", ")}`);
    }
    console.log(`  REPORT inventory (displayed denom) = ${repInv.toLocaleString()}`);
    console.log(`  occ_nights = ${repNights.toLocaleString()}   report occupancy% = ${repInv > 0 ? ((repNights / repInv) * 100).toFixed(1) : "n/a"}`);
    console.log(`  --- alternative denominators ---`);
    console.log(`  A listing-count×days (no lifecycle, no unit)   = ${altListingDays.toLocaleString()}  -> occ ${((repNights / altListingDays) * 100).toFixed(1)}%`);
    console.log(`  B sum(unit_count)×days                          = ${altUnitDays.toLocaleString()}  -> occ ${((repNights / altUnitDays) * 100).toFixed(1)}%`);
    console.log(`  C calendar_rates count (available)              = ${calCount.toLocaleString()}  -> occ ${calCount > 0 ? ((repNights / calCount) * 100).toFixed(1) : "n/a"}%`);
    console.log(`  D lifecycle-gated listing-days                  = ${lifeDays.toLocaleString()}  -> occ ${lifeDays > 0 ? ((repNights / lifeDays) * 100).toFixed(1) : "n/a"}%`);
    console.log("");
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
