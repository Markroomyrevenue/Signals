/**
 * A7 — Hostaway-truth reconciliation for a finished month.
 *
 * For ~3 listings across 3 tenants, compute the stayed revenue + occupied nights
 * + ADR for a recent FINISHED month directly from RAW (cached) Hostaway
 * reservations, then compare to (a) DB NightFacts and (b) the report builder
 * (buildSalesReport scoped to that listing+month).
 *
 * Three Hostaway-truth lenses are computed per listing/month:
 *   HW_signalsdef : mirrors Signals' definition exactly — exclude cancelled/
 *                   no-show/declined/expired/inquiry, revenue = total/nights
 *                   (deposit already removed by parseReservationFinancials),
 *                   spread across each stay night that falls in the month.
 *   HW_naive_incl : the "Hostaway dashboard" naive view — ALL reservations
 *                   (incl. cancelled), gross totalPrice/nights spread across
 *                   stay nights in the month. Shows the cancellation gap.
 *   HW_arrivalmonth: Signals-def revenue but attributed to ARRIVAL month, not
 *                    per-stay-night — shows the booking/stay attribution gap.
 *
 * READ-ONLY. Reservations come from the scratchpad cache (a7-pull-hostaway.ts).
 */
import { readFileSync } from "node:fs";
import { prisma } from "./lib/ctx";
import { buildSalesReport } from "@/lib/reports/service";

const SCRATCH =
  "/private/tmp/claude-501/-Users-markmccracken-Documents-signals/2fb77a7b-d5a9-4f51-b197-f092c4606a27/scratchpad/a7";

const MONTH_FROM = "2026-05-01";
const MONTH_TO = "2026-05-31";

// Signals' non-booked statuses (nightfact.ts).
const NON_BOOKED = new Set([
  "cancelled",
  "canceled",
  "no-show",
  "no_show",
  "declined",
  "expired",
  "inquiry",
  "inquirypreapproved",
  "inquirynotpossible"
]);

type Resv = {
  id: string;
  listingMapId: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  totalPrice: number;
  currency: string;
};

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseUTC(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00Z`);
}
function nightsInMonth(arrival: string, departure: string, from: string, to: string): number {
  const a = parseUTC(arrival);
  const dep = parseUTC(departure);
  const lo = parseUTC(from);
  const hi = parseUTC(to);
  let n = 0;
  for (let c = new Date(a); c < dep; c.setUTCDate(c.getUTCDate() + 1)) {
    if (c >= lo && c <= hi) n += 1;
  }
  return n;
}

type Lens = { nights: number; revenue: number };

function computeHostawayTruth(
  reservations: Resv[],
  listingMapId: string,
  from: string,
  to: string
): { signalsdef: Lens; naiveIncl: Lens; arrivalMonth: Lens } {
  const signalsdef: Lens = { nights: 0, revenue: 0 };
  const naiveIncl: Lens = { nights: 0, revenue: 0 };
  const arrivalMonth: Lens = { nights: 0, revenue: 0 };
  const lo = parseUTC(from);
  const hi = parseUTC(to);

  for (const r of reservations) {
    if (String(r.listingMapId) !== String(listingMapId)) continue;
    const status = (r.status ?? "").toLowerCase();
    const computedNights = Math.max(
      0,
      Math.round((parseUTC(r.departureDate).getTime() - parseUTC(r.arrivalDate).getTime()) / 86400000)
    );
    if (computedNights <= 0) continue;
    const los = r.nights > 0 ? r.nights : computedNights;
    const total = Number(r.totalPrice) || 0;
    const perNight = los > 0 ? total / los : 0;
    const nm = nightsInMonth(r.arrivalDate, r.departureDate, from, to);

    // naive incl — every reservation, including cancelled
    naiveIncl.nights += nm;
    naiveIncl.revenue += perNight * nm;

    if (NON_BOOKED.has(status)) continue; // excluded from the booked lenses

    // signals-def — stay-night attribution
    signalsdef.nights += nm;
    signalsdef.revenue += perNight * nm;

    // arrival-month attribution
    const arr = parseUTC(r.arrivalDate);
    if (arr >= lo && arr <= hi) {
      arrivalMonth.nights += los;
      arrivalMonth.revenue += total;
    }
  }
  return { signalsdef, naiveIncl, arrivalMonth };
}

async function dbNightFacts(tenantId: string, listingId: string, from: string, to: string): Promise<Lens> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS nights,
            COALESCE(SUM(
              CASE WHEN COALESCE(nf.los_nights,0) > 0 AND COALESCE(r.total,0) > 0
                   THEN COALESCE(r.total,0) / nf.los_nights
                   ELSE COALESCE(nf.revenue_allocated,0) END
            ),0)::float AS revenue
     FROM night_facts nf
     LEFT JOIN reservations r ON r.id = nf.reservation_id
     WHERE nf.tenant_id = $1 AND nf.listing_id = $2 AND nf.is_occupied = true
       AND nf.date >= $3::date AND nf.date <= $4::date`,
    tenantId, listingId, from, to
  );
  return { nights: Number(rows[0].nights), revenue: Number(rows[0].revenue) };
}

function fmt(l: Lens): string {
  const adr = l.nights > 0 ? l.revenue / l.nights : 0;
  return `nights=${l.nights}  rev=${l.revenue.toFixed(2)}  adr=${adr.toFixed(2)}`;
}

async function main() {
  // tenant -> { cacheFile, hostawayClientId-mapping via listing.hostawayId }
  const tenantNames: Record<string, string> = {
    cmodikcm90004of6sp4cl066s: "Stay Belfast",
    cmoerbvuc0007ry6q21ofwkb8: "Coorie Doon Stays",
    cmoeuax4x000ery6qv2emihce: "Little Feather Management"
  };

  for (const [tenantId, name] of Object.entries(tenantNames)) {
    const cache = JSON.parse(readFileSync(`${SCRATCH}/resv-${tenantId}.json`, "utf8"));
    const reservations: Resv[] = cache.reservations;

    // Pick the listing with the most stay nights in the month (by hostaway map id),
    // then map to our DB listing. For Little Feather, also force-include a
    // multi-unit listing if present.
    const listings = await prisma.listing.findMany({
      where: { tenantId, removedAt: null },
      select: { id: true, hostawayId: true, name: true, unitCount: true }
    });
    const byHostaway = new Map(listings.map((l) => [String(l.hostawayId), l]));

    // rank hostaway listingMapIds by signals-def nights in the month
    const ranked = new Map<string, number>();
    for (const r of reservations) {
      const status = (r.status ?? "").toLowerCase();
      if (NON_BOOKED.has(status)) continue;
      const nm = nightsInMonth(r.arrivalDate, r.departureDate, MONTH_FROM, MONTH_TO);
      if (nm > 0) ranked.set(String(r.listingMapId), (ranked.get(String(r.listingMapId)) ?? 0) + nm);
    }
    const sorted = [...ranked.entries()].sort((a, b) => b[1] - a[1]);
    const pickedHostawayIds: string[] = [];
    if (sorted[0]) pickedHostawayIds.push(sorted[0][0]);
    // multi-unit pick for Little Feather
    if (name.includes("Little Feather")) {
      const mu = listings.find((l) => (l.unitCount ?? 1) >= 2 && ranked.has(String(l.hostawayId)));
      if (mu && !pickedHostawayIds.includes(String(mu.hostawayId))) pickedHostawayIds.push(String(mu.hostawayId));
    }

    console.log(`\n================ ${name} (${tenantId}) — month ${MONTH_FROM}..${MONTH_TO} ================`);
    for (const hwId of pickedHostawayIds) {
      const dbListing = byHostaway.get(hwId);
      if (!dbListing) {
        console.log(`  hostaway listing ${hwId}: NOT FOUND in DB listings (orphan)`);
        continue;
      }
      const hw = computeHostawayTruth(reservations, hwId, MONTH_FROM, MONTH_TO);
      const db = await dbNightFacts(tenantId, dbListing.id, MONTH_FROM, MONTH_TO);
      const report = await buildSalesReport({
        tenantId,
        request: {
          stayDateFrom: MONTH_FROM,
          stayDateTo: MONTH_TO,
          granularity: "month",
          listingIds: [dbListing.id],
          channels: [],
          statuses: [],
          includeFees: true,
          includeVat: true,
          barMetric: "revenue",
          compareMode: "yoy_otb"
        } as any,
        displayCurrency: "GBP"
      });
      const repNights = report.current.nights.reduce((a, b) => a + b, 0);
      const repRev = report.current.revenue.reduce((a, b) => a + b, 0);
      const rep: Lens = { nights: repNights, revenue: repRev };

      console.log(`\n  Listing: "${dbListing.name}"  hostawayId=${hwId}  unit_count=${dbListing.unitCount ?? 1}`);
      console.log(`    HW signals-def (stay-night, excl cancel): ${fmt(hw.signalsdef)}`);
      console.log(`    DB night_facts (is_occupied=true)        : ${fmt(db)}`);
      console.log(`    Report builder (buildSalesReport, GBP)   : ${fmt(rep)}`);
      console.log(`    -- definitional reference lenses --`);
      console.log(`    HW naive incl-cancellations              : ${fmt(hw.naiveIncl)}`);
      console.log(`    HW arrival-month attribution             : ${fmt(hw.arrivalMonth)}`);
      // deltas
      const dN = rep.nights - hw.signalsdef.nights;
      const dR = rep.revenue - hw.signalsdef.revenue;
      const dbN = db.nights - hw.signalsdef.nights;
      const dbR = db.revenue - hw.signalsdef.revenue;
      console.log(`    DELTA report vs HW-signalsdef : nights ${dN}, rev ${dR.toFixed(2)}`);
      console.log(`    DELTA db     vs HW-signalsdef : nights ${dbN}, rev ${dbR.toFixed(2)}`);
      console.log(`    NOTE currency of HW reservations on this listing: ${[...new Set(reservations.filter((r)=>String(r.listingMapId)===hwId).map((r)=>r.currency))].join(",")}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
