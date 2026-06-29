/**
 * A1 — Home dashboard headline recompute (Data-correctness audit).
 *
 * Independently recomputes the overview tab's headline windows
 * (today / yesterday / this-week / this-month) for Booked / Arrivals / Stayed
 * straight from the prod DB, then reconciles against buildHomeDashboard().
 *
 * Also probes the UTC-vs-Europe/London "today" boundary.
 *
 * READ-ONLY.  Run via: bash scripts/audit/run.sh scripts/audit/a1-home-dashboard.ts
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildHomeDashboard } from "@/lib/reports/service";

function utcTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function londonTodayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
function addDaysStr(s: string, days: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function startOfWeekStr(s: string): string {
  const d = new Date(`${s}T00:00:00Z`);
  const off = (d.getUTCDay() + 6) % 7; // Monday start
  return addDaysStr(s, -off);
}
function startOfMonthStr(s: string): string {
  return `${s.slice(0, 7)}-01`;
}
function endOfMonthStr(s: string): string {
  const d = new Date(`${s.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Raw booked-headline totals (mirrors groupBookingHeadlineDaily + bookingWindowTotals).
 *  Booking date resolved from the 8 raw_json keys else created_at; revenue = SUM(total)
 *  (assume GBP single-currency tenants; FX is identity for GBP). */
async function rawBooked(tenantId: string, from: string, to: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `WITH scoped AS (
       SELECT r.*,
         DATE(COALESCE(
           CASE WHEN COALESCE(
             NULLIF(r.raw_json->>'reservationDate',''),
             NULLIF(r.raw_json->>'reservation_date',''),
             NULLIF(r.raw_json->>'bookedOn',''),
             NULLIF(r.raw_json->>'booked_on',''),
             NULLIF(r.raw_json->>'bookingCreatedDate',''),
             NULLIF(r.raw_json->>'booking_created_date',''),
             NULLIF(r.raw_json->>'createdAt',''),
             NULLIF(r.raw_json->>'created_at','')
           ) ~ '^\\d{4}-\\d{2}-\\d{2}'
           THEN REPLACE(COALESCE(
             NULLIF(r.raw_json->>'reservationDate',''),
             NULLIF(r.raw_json->>'reservation_date',''),
             NULLIF(r.raw_json->>'bookedOn',''),
             NULLIF(r.raw_json->>'booked_on',''),
             NULLIF(r.raw_json->>'bookingCreatedDate',''),
             NULLIF(r.raw_json->>'booking_created_date',''),
             NULLIF(r.raw_json->>'createdAt',''),
             NULLIF(r.raw_json->>'created_at','')
           ),' ','T')::timestamptz
           ELSE NULL END,
           r.created_at)) AS bdate
       FROM reservations r WHERE r.tenant_id = $1
     )
     SELECT COUNT(*)::int AS reservations,
            COALESCE(SUM(COALESCE(nights,0)),0)::int AS nights,
            COALESCE(SUM(COALESCE(total,0)),0)::float AS revenue
     FROM scoped WHERE bdate >= $2::date AND bdate <= $3::date`,
    tenantId, from, to
  );
  return {
    reservations: Number(rows[0].reservations),
    nights: Number(rows[0].nights),
    revenue: Number(rows[0].revenue)
  };
}

/** Raw stay-headline totals (mirrors groupStayHeadlineDaily + bookingWindowTotals).
 *  Occupied night facts on [from,to]; revenue = per-night r.total/los else allocated.
 *  NB: report's stay headline does NOT subtract VAT (vatAllocated never selected),
 *  so to match "displayed" we also do not subtract VAT; includeFees=true => no fee sub. */
async function rawStayed(tenantId: string, from: string, to: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(DISTINCT nf.reservation_id)::int AS reservations,
            COUNT(*)::int AS nights,
            COALESCE(SUM(
              CASE WHEN COALESCE(nf.los_nights,0)>0 AND COALESCE(r.total,0)>0
                   THEN COALESCE(r.total,0)/nf.los_nights
                   ELSE COALESCE(nf.revenue_allocated,0) END),0)::float AS revenue
     FROM night_facts nf
     LEFT JOIN reservations r ON r.id = nf.reservation_id
     WHERE nf.tenant_id=$1 AND nf.is_occupied=true
       AND nf.date >= $2::date AND nf.date <= $3::date`,
    tenantId, from, to
  );
  return {
    reservations: Number(rows[0].reservations),
    nights: Number(rows[0].nights),
    revenue: Number(rows[0].revenue)
  };
}

function verdict(rep: number, raw: number): string {
  const tol = Math.max(0.5, Math.abs(raw) * 0.005);
  return Math.abs(rep - raw) <= tol ? "PASS" : "**FAIL**";
}

async function main() {
  const utc = utcTodayStr();
  const lon = londonTodayStr();
  console.log(`\nA1 HOME DASHBOARD RECOMPUTE`);
  console.log(`UTC today = ${utc}   Europe/London today = ${lon}   ${utc === lon ? "(same)" : "*** DIFFER ***"}`);
  console.log(`buildHomeDashboard anchors 'today' on UTC (toDateOnly(new Date())).\n`);

  const today = utc;
  const yesterday = addDaysStr(today, -1);
  const weekStart = startOfWeekStr(today);
  const monthStart = startOfMonthStr(today);
  const monthEnd = endOfMonthStr(today);
  const weekEnd = addDaysStr(weekStart, 6);

  const tenants = await getLiveTenants();

  for (const t of tenants) {
    const rep = await buildHomeDashboard({
      tenantId: t.id,
      request: {
        listingIds: [],
        channels: [],
        statuses: [],
        includeFees: true,
        includeVat: true
      } as any,
      displayCurrency: "GBP"
    });

    // BOOKED windows: today / yesterday / week(weekStart..today) / month(monthStart..today)
    const bookedRaw = {
      today: await rawBooked(t.id, today, today),
      yesterday: await rawBooked(t.id, yesterday, yesterday),
      thisWeek: await rawBooked(t.id, weekStart, today),
      thisMonth: await rawBooked(t.id, monthStart, today)
    };
    // STAYED windows: today / yesterday / week(weekStart..today) / month(monthStart..today)
    const stayedRaw = {
      today: await rawStayed(t.id, today, today),
      yesterday: await rawStayed(t.id, yesterday, yesterday),
      thisWeek: await rawStayed(t.id, weekStart, today),
      thisMonth: await rawStayed(t.id, monthStart, today)
    };
    // ARRIVALS windows (per code): today(today..today) / yesterday(ZERO) /
    //   week(today..weekEnd) / month(today..monthEnd) — forward-looking, on stayDaily.
    const arrivalsRaw = {
      today: await rawStayed(t.id, today, today),
      yesterday: { reservations: 0, nights: 0, revenue: 0 },
      thisWeek: await rawStayed(t.id, today, weekEnd),
      thisMonth: await rawStayed(t.id, today, monthEnd)
    };

    console.log(`\n===== ${t.name} =====`);
    const wins = ["today", "yesterday", "thisWeek", "thisMonth"] as const;
    const cats: Array<["booked" | "arrivals" | "stayed", any]> = [
      ["booked", bookedRaw],
      ["arrivals", arrivalsRaw],
      ["stayed", stayedRaw]
    ];
    console.log(
      "cat/window".padEnd(20),
      "metric".padEnd(8),
      "report".padStart(13),
      "raw".padStart(13),
      "  v"
    );
    for (const [cat, rawObj] of cats) {
      for (const w of wins) {
        const r = (rep.headline as any)[cat][w].current as { revenue: number; reservations: number; nights: number };
        const raw = rawObj[w];
        for (const m of ["revenue", "reservations", "nights"] as const) {
          console.log(
            `${cat}/${w}`.padEnd(20),
            m.slice(0, 7).padEnd(8),
            (r[m] ?? 0).toFixed(2).padStart(13),
            (raw[m] ?? 0).toFixed(2).padStart(13),
            "  " + verdict(r[m] ?? 0, raw[m] ?? 0)
          );
        }
      }
    }
    // Is arrivals identical to stayed for the 'today' window? (semantic-dup check)
    const aT = (rep.headline as any).arrivals.today.current;
    const sT = (rep.headline as any).stayed.today.current;
    console.log(
      `  arrivals.today == stayed.today ? ${
        aT.revenue === sT.revenue && aT.nights === sT.nights ? "YES (identical compute)" : "no"
      }`
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
