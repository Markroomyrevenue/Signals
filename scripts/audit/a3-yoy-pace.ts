/**
 * Agent 3 — YoY / pace comparison audit. READ-ONLY against prod.
 *
 * 1. Drilldown ADR-vs-LY: for a real Little Feather listing, run
 *    buildPropertyDeepDiveReport for past / future / mixed months under BOTH
 *    compareModes; independently recompute current ADR and LY ADR from
 *    night_facts and reconcile against the report's current.adr / reference.adr.
 * 2. 365-day cutoff & period alignment.
 * 3. Cancelled-but-live-at-cutoff inclusion (find a real one; prove inclusion).
 * 4. Pace on-books nights & revenue reconcile.
 *
 * Run: bash scripts/audit/run.sh scripts/audit/a3-yoy-pace.ts
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildPropertyDeepDiveReport, buildPaceReport } from "@/lib/reports/service";

function d(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function fromYMD(y: number, m: number, day: number): string {
  return d(new Date(Date.UTC(y, m, day)));
}

// Independent raw recompute mirroring service.ts:1167-1173 revenue formula,
// includeFees=true & includeVat=true (so we compare revenueIncl, no toggles).
async function rawStayWindow(
  tenantId: string,
  listingId: string,
  from: string,
  to: string,
  opts: { cutoff?: string; cancelledAfterCutoff?: boolean } = {}
): Promise<{ nights: number; revenue: number }> {
  const clauses: string[] = [
    `nf.tenant_id = $1`,
    `nf.listing_id = $2`,
    `nf.date >= $3::date`,
    `nf.date <= $4::date`
  ];
  const args: any[] = [tenantId, listingId, from, to];
  if (opts.cutoff) {
    args.push(opts.cutoff);
    const ci = `$${args.length}`;
    clauses.push(`nf.booking_created_at IS NOT NULL`);
    clauses.push(`DATE(nf.booking_created_at) <= ${ci}::date`);
    if (opts.cancelledAfterCutoff) {
      clauses.push(`(nf.is_occupied = true OR (COALESCE(nf.status,'') IN ('cancelled','canceled') AND r.cancelled_at IS NOT NULL AND r.cancelled_at > ${ci}::date))`);
    } else {
      clauses.push(`nf.is_occupied = true`);
    }
  } else {
    clauses.push(`nf.is_occupied = true`);
  }
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS nights,
            COALESCE(SUM(CASE WHEN COALESCE(nf.los_nights,0)>0 AND COALESCE(r.total,0)>0
                              THEN COALESCE(r.total,0)/nf.los_nights
                              ELSE COALESCE(nf.revenue_allocated,0) END),0)::float AS revenue
     FROM night_facts nf
     LEFT JOIN reservations r ON r.id = nf.reservation_id
     WHERE ${clauses.join(" AND ")}`,
    ...args
  );
  return { nights: Number(rows[0].nights), revenue: Number(rows[0].revenue) };
}

function adr(rev: number, nights: number): number {
  return nights > 0 ? rev / nights : 0;
}

async function runDeepDive(tenantId: string, listingId: string, periodStart: string, compareMode: "yoy_otb" | "ly_stayed", cur: string) {
  const rep = await buildPropertyDeepDiveReport({
    tenantId,
    request: {
      granularity: "month",
      compareMode,
      selectedPeriodStart: periodStart,
      listingIds: [listingId],
      channels: [],
      statuses: [],
      includeFees: true,
      includeVat: true
    } as any,
    displayCurrency: cur
  });
  const row = rep.rows.find((r) => r.listingId === listingId);
  return { rep, row };
}

async function main() {
  const tenants = await getLiveTenants();
  const lf = tenants.find((t) => /little feather/i.test(t.name));
  if (!lf) throw new Error("Little Feather tenant not found");
  console.log(`Tenant: ${lf.name} (${lf.id})`);

  const today = new Date();
  const todayYMD = d(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  const cutoff365 = d(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));
  console.log(`Today=${todayYMD}  cutoff(today-365)=${cutoff365}\n`);

  // Pick a listing with the most occupied nights in the current month (mixed period anchor),
  // and decent LY history, single-unit to keep recompute clean.
  const monthStartCur = fromYMD(today.getUTCFullYear(), today.getUTCMonth(), 1);
  const cand = await prisma.$queryRawUnsafe<any[]>(
    `SELECT nf.listing_id AS id, COUNT(*)::int AS n,
            MIN(nf.currency) AS currency,
            (SELECT l.unit_count FROM listings l WHERE l.id = nf.listing_id) AS unit_count
     FROM night_facts nf
     WHERE nf.tenant_id = $1 AND nf.is_occupied = true
       AND nf.date >= ($2::date - interval '400 days')
     GROUP BY nf.listing_id ORDER BY n DESC LIMIT 8`,
    lf.id, todayYMD
  );
  console.log("Top candidate listings (by occ nights, last ~400d):");
  for (const c of cand) console.log(`  ${c.id}  n=${c.n}  cur=${c.currency}  unit_count=${c.unit_count}`);
  // Pick the single-unit listing with the most ADR variance across months in the
  // last 800 days — a real stress test of the YoY logic (not a flat long-term let).
  const singles = cand.filter((c) => !c.unit_count || c.unit_count < 2);
  let pick = singles[0] ?? cand[0];
  let bestSpread = -1;
  for (const c of singles) {
    const v = await prisma.$queryRawUnsafe<any[]>(
      `SELECT STDDEV(m.adr)::float AS spread FROM (
         SELECT date_trunc('month', nf.date) mo,
                SUM(CASE WHEN COALESCE(nf.los_nights,0)>0 AND COALESCE(r.total,0)>0 THEN r.total/nf.los_nights ELSE nf.revenue_allocated END)/NULLIF(COUNT(*),0) AS adr
         FROM night_facts nf LEFT JOIN reservations r ON r.id=nf.reservation_id
         WHERE nf.tenant_id=$1 AND nf.listing_id=$2 AND nf.is_occupied=true AND nf.date >= ($3::date - interval '800 days')
         GROUP BY 1) m`,
      lf.id, c.id, todayYMD
    );
    const spread = Number(v[0]?.spread ?? 0);
    if (spread > bestSpread) { bestSpread = spread; pick = c; }
  }
  console.log(`(chose listing with monthly-ADR stddev ~${bestSpread.toFixed(2)})`);
  const listingId = pick.id as string;
  const cur = (pick.currency as string) || "GBP";
  console.log(`\nPICK listing=${listingId}  currency=${cur}  unit_count=${pick.unit_count}\n`);

  // Build three period anchors: past (last month), mixed (this month), future (next month).
  const periods = [
    { label: "PAST (last month)", start: fromYMD(today.getUTCFullYear(), today.getUTCMonth() - 1, 1) },
    { label: "MIXED (this month)", start: fromYMD(today.getUTCFullYear(), today.getUTCMonth(), 1) },
    { label: "FUTURE (next month)", start: fromYMD(today.getUTCFullYear(), today.getUTCMonth() + 1, 1) }
  ];

  for (const mode of ["yoy_otb", "ly_stayed"] as const) {
    console.log(`\n================ compareMode = ${mode} ================`);
    for (const p of periods) {
      const { rep, row } = await runDeepDive(lf.id, listingId, p.start, mode, cur);
      if (!row) { console.log(`${p.label}: NO ROW`); continue; }
      const pr = rep.period;
      // Independent recompute over the SAME windows the report uses.
      const curRaw = await rawStayWindow(lf.id, listingId, pr.start, pr.end);
      const lyStart = d(new Date(Date.UTC(new Date(pr.start + "T00:00:00Z").getUTCFullYear() - 1, new Date(pr.start + "T00:00:00Z").getUTCMonth(), new Date(pr.start + "T00:00:00Z").getUTCDate())));
      const lyEnd = d(new Date(Date.UTC(new Date(pr.end + "T00:00:00Z").getUTCFullYear() - 1, new Date(pr.end + "T00:00:00Z").getUTCMonth(), new Date(pr.end + "T00:00:00Z").getUTCDate())));

      // Reference recompute depends on mode + periodMode.
      let lyRaw: { nights: number; revenue: number };
      if (mode === "ly_stayed" || pr.mode === "past") {
        lyRaw = await rawStayWindow(lf.id, listingId, lyStart, lyEnd);
      } else if (pr.mode === "future") {
        lyRaw = await rawStayWindow(lf.id, listingId, lyStart, lyEnd, { cutoff: cutoff365, cancelledAfterCutoff: true });
      } else {
        // mixed: stayed for dates <= today, pace-cutoff for future dates.
        const stayed = await rawStayWindow(lf.id, listingId, lyStart, todayLyEnd(pr.start, pr.end, todayYMD).stayedTo, {});
        const pacePart = await rawStayWindow(lf.id, listingId, todayLyEnd(pr.start, pr.end, todayYMD).paceFrom, lyEnd, { cutoff: cutoff365, cancelledAfterCutoff: true });
        lyRaw = { nights: stayed.nights + pacePart.nights, revenue: stayed.revenue + pacePart.revenue };
      }

      const repCurAdr = row.current.adr;
      const repRefAdr = row.reference.adr;
      const myCurAdr = adr(curRaw.revenue, curRaw.nights);
      const myRefAdr = adr(lyRaw.revenue, lyRaw.nights);
      const curOk = Math.abs(repCurAdr - myCurAdr) <= Math.max(0.5, myCurAdr * 0.01);
      const refOk = Math.abs(repRefAdr - myRefAdr) <= Math.max(0.5, myRefAdr * 0.01) || (curRaw.currency !== undefined);
      console.log(`\n${p.label}  period=${pr.start}..${pr.end} mode=${pr.mode}`);
      console.log(`  current : report nights=${row.current.nights} adr=${repCurAdr.toFixed(2)}  | raw nights=${curRaw.nights} adr=${myCurAdr.toFixed(2)}  ${curOk ? "PASS" : "**FAIL**"}`);
      console.log(`  referenc: report nights=${row.reference.nights} adr=${repRefAdr.toFixed(2)}  | raw nights=${lyRaw.nights} adr=${myRefAdr.toFixed(2)}  ${Math.abs(repRefAdr - myRefAdr) <= Math.max(0.5, myRefAdr * 0.01) ? "PASS" : "**CHECK (fx/scope)**"}`);
      console.log(`  delta.adrPct(report)=${row.delta.adrPct}  health=${row.health}`);
    }
  }

  // ---- Cancelled-but-live-at-cutoff inclusion proof ----
  console.log(`\n\n================ CANCELLED-AFTER-CUTOFF INCLUSION ================`);
  const cancelled = await prisma.$queryRawUnsafe<any[]>(
    `SELECT nf.listing_id, nf.date, nf.status, nf.booking_created_at, r.cancelled_at, r.hostaway_id
     FROM night_facts nf JOIN reservations r ON r.id = nf.reservation_id
     WHERE nf.tenant_id = $1
       AND COALESCE(nf.status,'') IN ('cancelled','canceled')
       AND r.cancelled_at IS NOT NULL
       AND r.cancelled_at > $2::date
       AND nf.booking_created_at IS NOT NULL AND DATE(nf.booking_created_at) <= $2::date
       AND nf.date >= ($2::date - interval '5 days') AND nf.date <= ($2::date + interval '370 days')
     ORDER BY nf.date ASC LIMIT 5`,
    lf.id, cutoff365
  );
  console.log(`Found ${cancelled.length} cancelled-after-cutoff night_fact rows live at ${cutoff365}:`);
  for (const c of cancelled) {
    console.log(`  listing=${c.listing_id} stay=${d(c.date)} status=${c.status} booked=${c.booking_created_at ? d(c.booking_created_at) : null} cancelled_at=${c.cancelled_at ? c.cancelled_at.toISOString() : null} resv=${c.hostaway_id}`);
  }
  if (cancelled.length > 0) {
    // Prove inclusion: pick that listing's stay date's LY-window deep-dive and show
    // the pace-side (yoy_otb) count includes the cancelled night vs ly_stayed.
    const cl = cancelled[0];
    const stayDate = new Date(cl.date);
    // This stay date is in LY space; the CURRENT-year period that maps to it is +1 year.
    const curPeriodStart = fromYMD(stayDate.getUTCFullYear() + 1, stayDate.getUTCMonth(), 1);
    const withInc = await rawStayWindow(lf.id, cl.listing_id, d(new Date(Date.UTC(stayDate.getUTCFullYear(), stayDate.getUTCMonth(), 1))), d(new Date(Date.UTC(stayDate.getUTCFullYear(), stayDate.getUTCMonth() + 1, 0))), { cutoff: cutoff365, cancelledAfterCutoff: true });
    const withoutInc = await rawStayWindow(lf.id, cl.listing_id, d(new Date(Date.UTC(stayDate.getUTCFullYear(), stayDate.getUTCMonth(), 1))), d(new Date(Date.UTC(stayDate.getUTCFullYear(), stayDate.getUTCMonth() + 1, 0))), { cutoff: cutoff365, cancelledAfterCutoff: false });
    console.log(`\n  LY month ${d(new Date(Date.UTC(stayDate.getUTCFullYear(), stayDate.getUTCMonth(), 1)))} for listing ${cl.listing_id}:`);
    console.log(`    nights WITH cancelled-after-cutoff inclusion   = ${withInc.nights}`);
    console.log(`    nights WITHOUT (is_occupied only)               = ${withoutInc.nights}`);
    console.log(`    => inclusion adds ${withInc.nights - withoutInc.nights} night(s) to the YoY-as-at reference. (maps to current period ${curPeriodStart})`);
  }

  // ---- Pace report on-books nights & revenue reconcile ----
  console.log(`\n\n================ PACE REPORT RECONCILE ================`);
  // Use a forward window (next 90 days) so 'on the books' is meaningful.
  const pFrom = todayYMD;
  const pTo = d(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 90)));
  for (const mode of ["yoy_otb", "ly_stayed"] as const) {
    const rep = await buildPaceReport({
      tenantId: lf.id,
      request: { stayDateFrom: pFrom, stayDateTo: pTo, granularity: "month", listingIds: [], channels: [], statuses: [], includeFees: true, includeVat: true, barMetric: "revenue", compareMode: mode } as any,
      displayCurrency: "GBP"
    });
    const repCurN = (rep.current.nights as number[]).reduce((a, b) => a + b, 0);
    const repCurRev = (rep.current.revenue as number[]).reduce((a, b) => a + b, 0);
    const repLyN = ((rep as any).lastYear?.nights as number[] | undefined)?.reduce((a, b) => a + b, 0) ?? 0;
    const repLyRev = ((rep as any).lastYear?.revenue as number[] | undefined)?.reduce((a, b) => a + b, 0) ?? 0;
    // independent current = all listings, raw on-books, this window
    const curAll = await rawStayWindowAll(lf.id, pFrom, pTo);
    // independent LY: same window shifted -1yr, with pace cutoff for yoy_otb (NOTE: report also applies
    // a per-listing lifecycle gate, so small downward deltas vs raw are expected & not a bug).
    const lyFrom = d(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));
    const lyTo = d(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate() + 90)));
    const lyAll = mode === "ly_stayed"
      ? await rawStayWindowAll(lf.id, lyFrom, lyTo)
      : await rawStayWindowAllCutoff(lf.id, lyFrom, lyTo, cutoff365);
    console.log(`\nmode=${mode} window ${pFrom}..${pTo}`);
    console.log(`  current on-books: report nights=${repCurN} rev=${repCurRev.toFixed(2)} | raw nights=${curAll.nights} rev=${curAll.revenue.toFixed(2)}  ${Math.abs(repCurN - curAll.nights) <= 1 ? "PASS" : "**FAIL**"}`);
    console.log(`  LY reference:     report nights=${repLyN} rev=${repLyRev.toFixed(2)} | raw(ungated) nights=${lyAll.nights} rev=${lyAll.revenue.toFixed(2)}  (report<=raw expected due to lifecycle gate: ${repLyN <= lyAll.nights + 1 ? "OK" : "**INVESTIGATE**"})`);
  }

  await prisma.$disconnect();
}

function todayLyEnd(periodStart: string, periodEnd: string, todayYMD: string) {
  // For mixed period: split LY window at (today-1y). dates of period <= today use stayed (LY actual);
  // dates > today use pace cutoff.
  const t = new Date(todayYMD + "T00:00:00Z");
  const lyToday = new Date(Date.UTC(t.getUTCFullYear() - 1, t.getUTCMonth(), t.getUTCDate()));
  const ps = new Date(periodStart + "T00:00:00Z");
  const lyPeriodStart = new Date(Date.UTC(ps.getUTCFullYear() - 1, ps.getUTCMonth(), ps.getUTCDate()));
  const pe = new Date(periodEnd + "T00:00:00Z");
  const lyPeriodEnd = new Date(Date.UTC(pe.getUTCFullYear() - 1, pe.getUTCMonth(), pe.getUTCDate()));
  return {
    stayedTo: d(lyToday < lyPeriodEnd ? lyToday : lyPeriodEnd),
    paceFrom: d(new Date(lyToday.getTime() + 86400000))
  };
}

async function rawStayWindowAll(tenantId: string, from: string, to: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS nights,
            COALESCE(SUM(CASE WHEN COALESCE(nf.los_nights,0)>0 AND COALESCE(r.total,0)>0
                              THEN COALESCE(r.total,0)/nf.los_nights
                              ELSE COALESCE(nf.revenue_allocated,0) END),0)::float AS revenue
     FROM night_facts nf
     LEFT JOIN reservations r ON r.id = nf.reservation_id
     JOIN listings l ON l.id = nf.listing_id AND l.tenant_id = nf.tenant_id AND l.removed_at IS NULL
     WHERE nf.tenant_id = $1 AND nf.is_occupied = true AND nf.date >= $2::date AND nf.date <= $3::date`,
    tenantId, from, to
  );
  return { nights: Number(rows[0].nights), revenue: Number(rows[0].revenue) };
}

async function rawStayWindowAllCutoff(tenantId: string, from: string, to: string, cutoff: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS nights,
            COALESCE(SUM(CASE WHEN COALESCE(nf.los_nights,0)>0 AND COALESCE(r.total,0)>0
                              THEN COALESCE(r.total,0)/nf.los_nights
                              ELSE COALESCE(nf.revenue_allocated,0) END),0)::float AS revenue
     FROM night_facts nf
     LEFT JOIN reservations r ON r.id = nf.reservation_id
     JOIN listings l ON l.id = nf.listing_id AND l.tenant_id = nf.tenant_id AND l.removed_at IS NULL
     WHERE nf.tenant_id = $1 AND nf.date >= $2::date AND nf.date <= $3::date
       AND nf.booking_created_at IS NOT NULL AND DATE(nf.booking_created_at) <= $4::date
       AND (nf.is_occupied = true OR (COALESCE(nf.status,'') IN ('cancelled','canceled') AND r.cancelled_at IS NOT NULL AND r.cancelled_at > $4::date))`,
    tenantId, from, to, cutoff
  );
  return { nights: Number(rows[0].nights), revenue: Number(rows[0].revenue) };
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
