/**
 * Agent 7b — Hostaway-vs-Signals reconciliation spot-check (READ-ONLY, bounded).
 *
 * For 2 tenants, picks 1 listing + 1 finished month and compares:
 *   (A) raw Hostaway reservation fields (stayed revenue + occupied nights)
 *   (B) DB night_facts
 *   (C) buildSalesReport output
 *
 * HARD CAPS: <=10 Hostaway pages/tenant; caches raw pulls to scratchpad JSON.
 */
import { promises as fs } from "fs";
import path from "path";

import { buildSalesReport } from "@/lib/reports/service";
import { prisma, getReadonlyGatewayForTenant } from "./lib/ctx";

const SCRATCH = "/private/tmp/claude-501/-Users-markmccracken-Documents-signals/2fb77a7b-d5a9-4f51-b197-f092c4606a27/scratchpad";
const MONTH_FROM = "2026-05-01";
const MONTH_TO = "2026-05-31";
const MAX_PAGES = 10;

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "no-show", "no_show"]);
const NON_BOOKED = new Set([
  ...CANCELLED_STATUSES,
  "declined",
  "expired",
  "inquiry",
  "inquirypreapproved",
  "inquirynotpossible"
]);

function normStatus(s: string): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function eachNight(arrival: string, departure: string): string[] {
  const out: string[] = [];
  if (!arrival || !departure) return out;
  let d = new Date(`${arrival}T00:00:00Z`);
  const end = new Date(`${departure}T00:00:00Z`);
  while (d < end) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

async function pullForTenant(tenantId: string, name: string): Promise<any[]> {
  const cacheFile = path.join(SCRATCH, `a7b-raw-${tenantId}.json`);
  try {
    const cached = await fs.readFile(cacheFile, "utf8");
    console.log(`  [cache hit] ${name}`);
    return JSON.parse(cached);
  } catch {
    /* no cache */
  }
  const gw = await getReadonlyGatewayForTenant(tenantId);
  const all: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await gw.fetchReservations({ page });
    all.push(...res.items);
    if (!res.hasMore || res.items.length === 0) break;
  }
  await fs.writeFile(cacheFile, JSON.stringify(all));
  console.log(`  [pulled] ${name}: ${all.length} resv (<=${MAX_PAGES} pages)`);
  return all;
}

/** Pick a listing that has reservations stayed in the target month, in the raw pull. */
function pickListing(raw: any[]): { listingMapId: string; count: number } | null {
  const tally = new Map<string, number>();
  for (const r of raw) {
    const status = normStatus(r.status);
    if (NON_BOOKED.has(status)) continue;
    const nights = eachNight(r.arrivalDate, r.departureDate).filter((d) => d >= MONTH_FROM && d <= MONTH_TO);
    if (nights.length === 0) continue;
    const lid = String(r.listingMapId ?? "");
    if (!lid) continue;
    tally.set(lid, (tally.get(lid) ?? 0) + nights.length);
  }
  let best: { listingMapId: string; count: number } | null = null;
  for (const [lid, count] of tally) {
    if (!best || count > best.count) best = { listingMapId: lid, count };
  }
  return best;
}

async function reconcileTenant(tenantId: string, name: string) {
  console.log(`\n=== ${name} (${tenantId}) ===`);
  const raw = await pullForTenant(tenantId, name);

  const picked = pickListing(raw);
  if (!picked) {
    console.log("  No stayed nights in window from raw pull; skipping.");
    return;
  }
  const hostawayListingId = picked.listingMapId;

  // Map hostaway listingMapId -> internal listing id + name
  const listing = await prisma.listing.findFirst({
    where: { tenantId, hostawayId: String(hostawayListingId) },
    select: { id: true, name: true, hostawayId: true, unitCount: true, vatRatePct: true }
  });
  console.log(`  Picked Hostaway listing ${hostawayListingId} -> ${listing?.name ?? "(not in DB)"} (internal ${listing?.id})`);

  // ---- (A) RAW HOSTAWAY: occupied nights + stayed revenue (deposit-incl total) in window ----
  let rawNights = 0;
  let rawTotalPrice = 0; // r.totalPrice (deposit already stripped by parseReservationFinancials)
  let rawAccommodation = 0;
  for (const r of raw) {
    if (String(r.listingMapId ?? "") !== hostawayListingId) continue;
    const status = normStatus(r.status);
    if (NON_BOOKED.has(status)) continue;
    const stayNights = eachNight(r.arrivalDate, r.departureDate);
    const inWindow = stayNights.filter((d) => d >= MONTH_FROM && d <= MONTH_TO);
    if (inWindow.length === 0) continue;
    const los = stayNights.length || 1;
    rawNights += inWindow.length;
    // allocate per-night like the report does (total / los)
    rawTotalPrice += (Number(r.totalPrice) || 0) * (inWindow.length / los);
    rawAccommodation += (Number(r.accommodationFare) || 0) * (inWindow.length / los);
  }
  console.log(
    `  (A) RAW  : occNights=${rawNights}  allocTotal(incl fees, ex deposit)=${rawTotalPrice.toFixed(2)}  allocRoom=${rawAccommodation.toFixed(2)}`
  );

  // ---- (B) DB night_facts (independent SQL, mirrors service formula) ----
  const dbRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT
       COUNT(*)::int AS nights,
       COALESCE(SUM(
         CASE WHEN COALESCE(nf.los_nights,0) > 0 AND COALESCE(r.total,0) > 0
              THEN COALESCE(r.total,0) / nf.los_nights
              ELSE COALESCE(nf.revenue_allocated,0) END), 0)::float AS revincl,
       COALESCE(SUM(nf.revenue_allocated),0)::float AS revroom
     FROM night_facts nf
     LEFT JOIN reservations r ON r.id = nf.reservation_id
     WHERE nf.tenant_id = $1 AND nf.listing_id = $2
       AND nf.is_occupied = true
       AND nf.date >= $3::date AND nf.date <= $4::date`,
    tenantId,
    listing?.id ?? "__none__",
    MONTH_FROM,
    MONTH_TO
  );
  const db = dbRows[0] ?? { nights: 0, revincl: 0, revroom: 0 };
  console.log(`  (B) DB nf: occNights=${db.nights}  revIncl(r.total/los)=${Number(db.revincl).toFixed(2)}  revRoom(revenue_allocated)=${Number(db.revroom).toFixed(2)}`);

  // ---- (C) buildSalesReport scoped to listing + month ----
  if (listing) {
    const report = await buildSalesReport({
      tenantId,
      displayCurrency: "GBP",
      request: {
        stayDateFrom: MONTH_FROM,
        stayDateTo: MONTH_TO,
        listingIds: [listing.id],
        granularity: "month",
        channels: [],
        statuses: [],
        includeFees: true,
        includeVat: false
      } as any
    });
    const revNoFees = (await buildSalesReport({
      tenantId,
      displayCurrency: "GBP",
      request: {
        stayDateFrom: MONTH_FROM,
        stayDateTo: MONTH_TO,
        listingIds: [listing.id],
        granularity: "month",
        channels: [],
        statuses: [],
        includeFees: false,
        includeVat: false
      } as any
    })) as any;
    const sumRev = (report.current.revenue || []).reduce((a, b) => a + b, 0);
    const sumNights = (report.current.nights || []).reduce((a, b) => a + b, 0);
    const sumRevNoFees = (revNoFees.current.revenue || []).reduce((a: number, b: number) => a + b, 0);
    console.log(
      `  (C) report: occNights=${sumNights}  revenue(incl fees)=${sumRev.toFixed(2)}  revenue(ex fees)=${sumRevNoFees.toFixed(2)}`
    );
  }
}

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  const wanted = tenants.filter(
    (t) => /little feather/i.test(t.name) || /stay belfast/i.test(t.name)
  );
  for (const t of wanted) {
    await reconcileTenant(t.id, t.name);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
