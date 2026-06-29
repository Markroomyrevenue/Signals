/**
 * A2 — Multi-unit occupancy / RevPAR distortion. READ-ONLY.
 *
 * For each multi-unit listing, compare on busy dates:
 *   - occupiedNights (count of overlapping reservations) — the NUMERATOR
 *   - calendar_rates rows for that date — the report's per-date inventory
 *   - unit_count — the TRUE capacity
 * and show how the report's max(occupied, calInventory||fallback) clamp behaves.
 *
 * Then run buildSalesReport scoped to JUST each multi-unit listing over a window
 * that includes the busy August peak, and reconcile occupancy% / RevPAR.
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildSalesReport } from "@/lib/reports/service";

function sum(xs: number[]) { return xs.reduce((a, b) => a + b, 0); }

async function main() {
  const tenants = await getLiveTenants();
  const lf = tenants.find((t) => /little feather/i.test(t.name))!;

  const multi = await prisma.listing.findMany({
    where: { tenantId: lf.id, unitCount: { gte: 2 } },
    select: { id: true, hostawayId: true, name: true, unitCount: true }
  });

  // Window covering the August peak demand for student accommodation.
  const from = "2026-08-01";
  const to = "2026-08-31";

  for (const l of multi) {
    console.log(`\n=== ${l.name}  (hwId=${l.hostawayId}, unit_count=${l.unitCount}) ===`);

    // Per-date: occupied (reservation overlaps) vs calendar_rates rows vs unit_count.
    const perDate = await prisma.$queryRawUnsafe<any[]>(
      `SELECT d.date::text AS date,
              (SELECT COUNT(*)::int FROM night_facts nf
                 WHERE nf.tenant_id=$1 AND nf.listing_id=$2 AND nf.is_occupied=true AND nf.date=d.date) AS occ,
              (SELECT COUNT(*)::int FROM calendar_rates cr
                 WHERE cr.tenant_id=$1 AND cr.listing_id=$2 AND cr.date=d.date) AS cal_rows
       FROM generate_series($3::date, $4::date, '1 day') d(date)
       ORDER BY occ DESC LIMIT 5`,
      lf.id, l.id, from, to
    );
    console.log("  busiest dates (occ = overlapping reservations, cal_rows = calendar_rates rows):");
    for (const r of perDate) {
      const trueOcc = (r.occ / (l.unitCount ?? 1)) * 100;
      const reportInvForDate = Math.max(r.occ, r.cal_rows > 0 ? r.cal_rows : 1); // mirrors withInventoryDailyFallback (per listing scope, fallback=1)
      const reportOcc = (r.occ / reportInvForDate) * 100;
      console.log(
        `    ${r.date}: occ=${String(r.occ).padStart(3)}  cal_rows=${r.cal_rows}  unit_count=${l.unitCount}` +
        `  | TRUE occ%=${trueOcc.toFixed(1).padStart(6)}  REPORT occ%=${reportOcc.toFixed(1).padStart(6)}`
      );
    }

    // Whole-window report scoped to just this listing.
    const report = await buildSalesReport({
      tenantId: lf.id,
      request: {
        stayDateFrom: from, stayDateTo: to, granularity: "month",
        listingIds: [l.id], channels: [], statuses: [],
        includeFees: true, includeVat: true, barMetric: "revenue", compareMode: "yoy_otb"
      } as any,
      displayCurrency: "GBP"
    });
    const nights = sum(report.current.nights);
    const inv = sum(report.current.inventory);
    const rev = sum(report.current.revenue);
    const days = 31;
    const trueInv = (l.unitCount ?? 1) * days;
    console.log(`  REPORT (whole month, scoped to this listing):`);
    console.log(`    occupiedNights=${nights}  reportInventory=${inv}  revenue=${rev.toFixed(0)}`);
    console.log(`    REPORT occ% = ${(nights / inv * 100).toFixed(1)}   RevPAR = ${(rev / inv).toFixed(2)}`);
    console.log(`    TRUE inventory (unit_count*${days}) = ${trueInv}`);
    console.log(`    TRUE  occ% = ${(nights / trueInv * 100).toFixed(1)}   TRUE RevPAR = ${(rev / trueInv).toFixed(2)}`);
    console.log(`    >> occupancy OVERSTATED by factor ${(trueInv / inv).toFixed(2)}x ; RevPAR OVERSTATED by same factor`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
