/**
 * A1 — Booking-window report recompute (cancellation rate, avg LOS, ADR-by-window).
 *
 * Reconciles buildBookWindowReport (booked mode, default 30d lookback) against an
 * independent raw recompute over reservations using the SAME booking-date resolution
 * (8 raw_json keys → created_at) and lead-time bucketing.
 *
 * READ-ONLY.  Run via: bash scripts/audit/run.sh scripts/audit/a1-book-window.ts
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildBookWindowReport } from "@/lib/reports/service";

function utcTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysStr(s: string, days: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function rawBuckets(tenantId: string, from: string, to: string) {
  // Mirror buildBookWindowReport booked-mode SQL: lead_days = arrival - bookedAnchor.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `WITH scoped AS (
       SELECT r.*,
         DATE(COALESCE(
           CASE WHEN COALESCE(
             NULLIF(r.raw_json->>'reservationDate',''),NULLIF(r.raw_json->>'reservation_date',''),
             NULLIF(r.raw_json->>'bookedOn',''),NULLIF(r.raw_json->>'booked_on',''),
             NULLIF(r.raw_json->>'bookingCreatedDate',''),NULLIF(r.raw_json->>'booking_created_date',''),
             NULLIF(r.raw_json->>'createdAt',''),NULLIF(r.raw_json->>'created_at','')
           ) ~ '^\\d{4}-\\d{2}-\\d{2}'
           THEN REPLACE(COALESCE(
             NULLIF(r.raw_json->>'reservationDate',''),NULLIF(r.raw_json->>'reservation_date',''),
             NULLIF(r.raw_json->>'bookedOn',''),NULLIF(r.raw_json->>'booked_on',''),
             NULLIF(r.raw_json->>'bookingCreatedDate',''),NULLIF(r.raw_json->>'booking_created_date',''),
             NULLIF(r.raw_json->>'createdAt',''),NULLIF(r.raw_json->>'created_at','')
           ),' ','T')::timestamptz ELSE NULL END, r.created_at)) AS banchor,
         GREATEST(0, DATE(r.arrival) - DATE(COALESCE(
           CASE WHEN COALESCE(
             NULLIF(r.raw_json->>'reservationDate',''),NULLIF(r.raw_json->>'reservation_date',''),
             NULLIF(r.raw_json->>'bookedOn',''),NULLIF(r.raw_json->>'booked_on',''),
             NULLIF(r.raw_json->>'bookingCreatedDate',''),NULLIF(r.raw_json->>'booking_created_date',''),
             NULLIF(r.raw_json->>'createdAt',''),NULLIF(r.raw_json->>'created_at','')
           ) ~ '^\\d{4}-\\d{2}-\\d{2}'
           THEN REPLACE(COALESCE(
             NULLIF(r.raw_json->>'reservationDate',''),NULLIF(r.raw_json->>'reservation_date',''),
             NULLIF(r.raw_json->>'bookedOn',''),NULLIF(r.raw_json->>'booked_on',''),
             NULLIF(r.raw_json->>'bookingCreatedDate',''),NULLIF(r.raw_json->>'booking_created_date',''),
             NULLIF(r.raw_json->>'createdAt',''),NULLIF(r.raw_json->>'created_at','')
           ),' ','T')::timestamptz ELSE NULL END, r.created_at)))::int AS lead_days
       FROM reservations r WHERE r.tenant_id=$1
     )
     SELECT
       CASE WHEN lead_days<=1 THEN '0-1' WHEN lead_days<=3 THEN '2-3' WHEN lead_days<=7 THEN '4-7'
            WHEN lead_days<=14 THEN '8-14' WHEN lead_days<=30 THEN '15-30' WHEN lead_days<=60 THEN '31-60'
            WHEN lead_days<=90 THEN '61-90' WHEN lead_days<=120 THEN '91-120' ELSE '121+' END AS bucket,
       COUNT(*)::int AS reservations,
       SUM(CASE WHEN LOWER(COALESCE(status,'')) IN ('cancelled','canceled','no-show','no_show') THEN 1 ELSE 0 END)::int AS cancelled,
       COALESCE(SUM(COALESCE(nights,0)),0)::int AS nights,
       COALESCE(SUM(COALESCE(total,0)),0)::float AS revenue
     FROM scoped WHERE banchor >= $2::date AND banchor <= $3::date
     GROUP BY 1`,
    tenantId, from, to
  );
  const map = new Map<string, any>();
  for (const r of rows) map.set(r.bucket, r);
  return map;
}

function vEq(a: number, b: number, tolAbs = 0.05): string {
  return Math.abs(a - b) <= Math.max(tolAbs, Math.abs(b) * 0.005) ? "PASS" : "**FAIL**";
}

async function main() {
  const to = utcTodayStr();
  const from = addDaysStr(to, -29); // default 30d lookback
  console.log(`\nA1 BOOK-WINDOW RECOMPUTE  (booked mode, ${from}..${to}, includeFees=true includeVat=true)\n`);
  const tenants = await getLiveTenants();

  for (const t of tenants) {
    const rep = await buildBookWindowReport({
      tenantId: t.id,
      request: {
        mode: "booked",
        lookbackDays: 30,
        listingIds: [],
        channels: [],
        statuses: [],
        includeFees: true,
        includeVat: true
      } as any,
      displayCurrency: "GBP"
    });
    const raw = await rawBuckets(t.id, from, to);

    console.log(`===== ${t.name} =====`);
    console.log("bucket".padEnd(8), "resv(r/raw)".padStart(14), "canc%(r/raw)".padStart(18), "avgLos(r/raw)".padStart(18), "  v");
    // totals for cancellation-rate overall
    let repCanc = 0, repResv = 0, rawCanc = 0, rawResv = 0;
    for (const b of rep.buckets) {
      const rw = raw.get(b.key);
      const rawResvB = rw ? Number(rw.reservations) : 0;
      const rawCancB = rw ? Number(rw.cancelled) : 0;
      const rawNightsB = rw ? Number(rw.nights) : 0;
      const rawCancPct = rawResvB > 0 ? (rawCancB / rawResvB) * 100 : 0;
      const rawLos = rawResvB > 0 ? rawNightsB / rawResvB : 0;
      repCanc += b.cancelledReservations; repResv += b.reservations;
      rawCanc += rawCancB; rawResv += rawResvB;
      const vr = vEq(b.reservations, rawResvB);
      const vc = vEq(b.cancellationPct, rawCancPct);
      const vl = vEq(b.avgLos, rawLos);
      const v = [vr, vc, vl].some((x) => x.includes("FAIL")) ? "**FAIL**" : "PASS";
      console.log(
        b.key.padEnd(8),
        `${b.reservations}/${rawResvB}`.padStart(14),
        `${b.cancellationPct.toFixed(1)}/${rawCancPct.toFixed(1)}`.padStart(18),
        `${b.avgLos.toFixed(2)}/${rawLos.toFixed(2)}`.padStart(18),
        "  " + v
      );
    }
    const repOverallCanc = repResv > 0 ? (repCanc / repResv) * 100 : 0;
    const rawOverallCanc = rawResv > 0 ? (rawCanc / rawResv) * 100 : 0;
    console.log(
      `OVERALL cancellation rate: report ${repOverallCanc.toFixed(2)}%  raw ${rawOverallCanc.toFixed(2)}%  ${vEq(repOverallCanc, rawOverallCanc)}`
    );
    console.log("");
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
