/**
 * A7 — Multi-unit reconciliation. For Little Feather's multi-unit listings
 * (unit_count >= 2), reconcile HW-truth vs DB night_facts vs report for a month
 * where they HAVE stay activity. Checks whether revenue is double-counted and
 * how unit_count interacts with the night-level revenue (it should NOT multiply
 * revenue — revenue is per-reservation; unit_count only affects the inventory
 * denominator elsewhere).
 */
import { readFileSync } from "node:fs";
import { prisma } from "./lib/ctx";
import { buildSalesReport } from "@/lib/reports/service";

const SCRATCH =
  "/private/tmp/claude-501/-Users-markmccracken-Documents-signals/2fb77a7b-d5a9-4f51-b197-f092c4606a27/scratchpad/a7";
const TENANT = "cmoeuax4x000ery6qv2emihce"; // Little Feather

const NON_BOOKED = new Set([
  "cancelled", "canceled", "no-show", "no_show", "declined", "expired",
  "inquiry", "inquirypreapproved", "inquirynotpossible"
]);

function parseUTC(s: string): Date { return new Date(`${s.slice(0, 10)}T00:00:00Z`); }
function nightsInMonth(a: string, d: string, from: string, to: string): number {
  const lo = parseUTC(from), hi = parseUTC(to), dep = parseUTC(d);
  let n = 0;
  for (let c = parseUTC(a); c < dep; c.setUTCDate(c.getUTCDate() + 1)) if (c >= lo && c <= hi) n += 1;
  return n;
}

async function main() {
  const cache = JSON.parse(readFileSync(`${SCRATCH}/resv-${TENANT}.json`, "utf8"));
  const reservations: any[] = cache.reservations;

  const mu = await prisma.listing.findMany({
    where: { tenantId: TENANT, removedAt: null, unitCount: { gte: 2 } },
    select: { id: true, hostawayId: true, name: true, unitCount: true }
  });
  console.log(`Multi-unit listings: ${mu.length}`);
  for (const l of mu) console.log(`  ${l.name}  hostawayId=${l.hostawayId}  unit_count=${l.unitCount}`);

  for (const l of mu) {
    // find a finished month with the most stay nights for this listing
    const months = ["2026-03", "2026-04", "2026-05", "2026-02", "2026-01", "2025-12"];
    let best: { m: string; nm: number } | null = null;
    for (const m of months) {
      const from = `${m}-01`;
      const to = `${m}-28`;
      let nm = 0;
      for (const r of reservations) {
        if (String(r.listingMapId) !== String(l.hostawayId)) continue;
        if (NON_BOOKED.has((r.status ?? "").toLowerCase())) continue;
        nm += nightsInMonth(r.arrivalDate, r.departureDate, from, `${m}-31`);
      }
      if (!best || nm > best.nm) best = { m, nm };
    }
    if (!best || best.nm === 0) { console.log(`\n  ${l.name}: no stay activity found in tested months`); continue; }
    const from = `${best.m}-01`;
    const to = `${best.m}-31`;

    // HW-truth signals-def
    let hwNights = 0, hwRev = 0;
    let resCount = 0;
    for (const r of reservations) {
      if (String(r.listingMapId) !== String(l.hostawayId)) continue;
      if (NON_BOOKED.has((r.status ?? "").toLowerCase())) continue;
      const dep = parseUTC(r.departureDate);
      const computed = Math.max(0, Math.round((dep.getTime() - parseUTC(r.arrivalDate).getTime()) / 86400000));
      if (computed <= 0) continue;
      const los = r.nights > 0 ? r.nights : computed;
      const nm = nightsInMonth(r.arrivalDate, r.departureDate, from, to);
      if (nm > 0) { hwNights += nm; hwRev += (Number(r.totalPrice) || 0) / los * nm; resCount += 1; }
    }

    const db = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS nights,
              COALESCE(SUM(CASE WHEN COALESCE(nf.los_nights,0)>0 AND COALESCE(r.total,0)>0
                THEN COALESCE(r.total,0)/nf.los_nights ELSE COALESCE(nf.revenue_allocated,0) END),0)::float AS revenue,
              COUNT(DISTINCT nf.reservation_id)::int AS resv
       FROM night_facts nf LEFT JOIN reservations r ON r.id = nf.reservation_id
       WHERE nf.tenant_id=$1 AND nf.listing_id=$2 AND nf.is_occupied=true AND nf.date>=$3::date AND nf.date<=$4::date`,
      TENANT, l.id, from, to
    );

    const report = await buildSalesReport({
      tenantId: TENANT,
      request: { stayDateFrom: from, stayDateTo: to, granularity: "month", listingIds: [l.id],
        channels: [], statuses: [], includeFees: true, includeVat: true, barMetric: "revenue", compareMode: "yoy_otb" } as any,
      displayCurrency: "GBP"
    });
    const repN = report.current.nights.reduce((a, b) => a + b, 0);
    const repR = report.current.revenue.reduce((a, b) => a + b, 0);

    // Max possible occupied nights if NO double count = days-in-month * unit_count
    console.log(`\n  ${l.name}  unit_count=${l.unitCount}  month=${best.m}`);
    console.log(`    HW-truth: nights=${hwNights} rev=${hwRev.toFixed(2)} (${resCount} reservations)`);
    console.log(`    DB nf   : nights=${db[0].nights} rev=${Number(db[0].revenue).toFixed(2)} (${db[0].resv} distinct resv)`);
    console.log(`    Report  : nights=${repN} rev=${repR.toFixed(2)}`);
    console.log(`    DELTA report-HW: nights ${repN - hwNights}, rev ${(repR - hwRev).toFixed(2)}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
