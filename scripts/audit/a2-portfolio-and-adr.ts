/**
 * A2 — (1) portfolio-level occupancy/RevPAR distortion from the multi-unit
 * inventory bug, and (2) reservation-level ADR check (Mark's #1 suspicion).
 * READ-ONLY.
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildSalesReport, buildReservationsReport } from "@/lib/reports/service";

function sum(xs: number[]) { return xs.reduce((a, b) => a + b, 0); }

async function main() {
  const tenants = await getLiveTenants();
  const lf = tenants.find((t) => /little feather/i.test(t.name))!;

  const listings = await prisma.listing.findMany({
    where: { tenantId: lf.id, removedAt: null },
    select: { id: true, unitCount: true }
  });
  const unitCountById = new Map(listings.map((l) => [l.id, l.unitCount ?? 1]));

  // ---- (1) Portfolio occupancy/RevPAR: trailing 365 whole-tenant ----
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);

  const report = await buildSalesReport({
    tenantId: lf.id,
    request: {
      stayDateFrom: from, stayDateTo: to, granularity: "month",
      listingIds: [], channels: [], statuses: [],
      includeFees: true, includeVat: true, barMetric: "revenue", compareMode: "yoy_otb"
    } as any,
    displayCurrency: "GBP"
  });
  const repNights = sum(report.current.nights);
  const repInv = sum(report.current.inventory);
  const repRev = sum(report.current.revenue);

  // TRUE inventory: per active listing-day scaled by unit_count, lifecycle-gated
  // the same way the report scopes (use generate_series intersect listing life).
  // Simpler upper-bound proxy: unit_count * days for every active listing.
  const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  const trueInv = listings.reduce((s, l) => s + (l.unitCount ?? 1) * days, 0);
  const naiveInv = listings.length * days;

  console.log(`PORTFOLIO trailing-365 (${from}..${to}) — Little Feather, whole tenant`);
  console.log(`  report occupiedNights = ${repNights}`);
  console.log(`  report inventory      = ${repInv}   (naive listing-days = ${naiveInv})`);
  console.log(`  report revenue        = ${repRev.toFixed(0)}`);
  console.log(`  REPORT occupancy%     = ${(repNights / repInv * 100).toFixed(1)}`);
  console.log(`  REPORT RevPAR         = ${(repRev / repInv).toFixed(2)}`);
  console.log(`  unit-scaled inventory = ${trueInv}`);
  console.log(`  TRUE occupancy% (unit-scaled) = ${(repNights / trueInv * 100).toFixed(1)}`);
  console.log(`  TRUE RevPAR (unit-scaled)     = ${(repRev / trueInv).toFixed(2)}`);
  console.log(`  >> portfolio occupancy overstated ${(trueInv / repInv).toFixed(2)}x, RevPAR overstated ${(trueInv / repInv).toFixed(2)}x`);

  // ---- (2) Reservation-level ADR: pull real multi-unit reservations ----
  const multiIds = listings.filter((l) => (l.unitCount ?? 1) >= 2).map((l) => l.id);
  console.log(`\nRESERVATION-LEVEL ADR CHECK (Mark's #1 suspicion) — multi-unit reservations`);
  const sample = await prisma.reservation.findMany({
    where: { tenantId: lf.id, listingId: { in: multiIds }, status: { notIn: ["cancelled", "canceled"] }, nights: { gt: 0 } },
    select: { id: true, listingId: true, nights: true, total: true, accommodationFare: true, arrival: true, departure: true, currency: true },
    orderBy: { total: "desc" },
    take: 8
  });
  console.log("  sample (highest total) — total / nights = per-reservation ADR:");
  for (const r of sample) {
    const calcNights = Math.round((r.departure.getTime() - r.arrival.getTime()) / 86400000);
    const adr = r.nights > 0 ? Number(r.total) / r.nights : 0;
    console.log(`    res=${r.id.slice(-6)} uc=${unitCountById.get(r.listingId)} nights=${r.nights} (calc=${calcNights}) total=${Number(r.total).toFixed(0)} ${r.currency}  ADR=${adr.toFixed(2)}  ${adr > 600 ? "<-- SUSPICIOUS" : ""}`);
  }
  // Does nights ever diverge from (departure-arrival)? That's the tell for an aggregated-units total.
  const divergent = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS c FROM reservations r
     WHERE r.tenant_id=$1 AND r.listing_id = ANY($2)
       AND r.nights <> (r.departure::date - r.arrival::date)`,
    lf.id, multiIds
  );
  console.log(`  reservations where stored nights != (departure-arrival): ${divergent[0].c}`);

  // Reservations report ADR over a booked window, scoped to multi-unit listings.
  const rr = await buildReservationsReport({
    tenantId: lf.id,
    request: {
      bookingDateFrom: "2025-01-01", bookingDateTo: "2026-06-29",
      listingIds: multiIds, channels: [], statuses: [],
      includeFees: true, includeVat: true
    } as any,
    displayCurrency: "GBP"
  });
  console.log(`  Reservations-report summary (multi-unit scope): resv=${rr.summary.reservations} nights=${rr.summary.nights} revenue=${rr.summary.revenue.toFixed(0)} ADR=${rr.summary.adr.toFixed(2)}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
