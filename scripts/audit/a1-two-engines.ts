/**
 * A1 — Two-engine divergence quantification.
 *
 * Same-named metrics, two engines:
 *   - registry (signal_lab / /api/metrics) via queryMetrics
 *   - reports service (main tabs) via buildSalesReport / buildBookedReport
 *
 * Compares stay revenue / occupied nights / occupancy% / ADR over an identical
 * trailing-365 STAY window, and booked revenue / bookings over an identical
 * trailing-365 BOOKING window. Reports the delta a user would see comparing
 * signal_lab to the Stayed / Bookings tabs.
 *
 * READ-ONLY.  Run via: bash scripts/audit/run.sh scripts/audit/a1-two-engines.ts
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildSalesReport, buildBookedReport } from "@/lib/reports/service";
import { queryMetrics } from "@/lib/metrics/service";

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function sumSeries(result: any, metricId: string): number {
  const s = result.series.find((x: any) => x.metricId === metricId);
  if (!s) return 0;
  return s.points.reduce((a: number, p: any) => a + (p.value ?? 0), 0);
}
function lastVal(result: any, metricId: string): number {
  // for ratio metrics (occupancy/adr) the per-bucket value isn't summable; take a
  // recomputed overall from the components instead where possible.
  const s = result.series.find((x: any) => x.metricId === metricId);
  if (!s || s.points.length === 0) return 0;
  return s.points.reduce((a: number, p: any) => a + (p.value ?? 0), 0) / s.points.length;
}

async function main() {
  const today = new Date();
  const to = dateOnly(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  const from = dateOnly(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));
  const tenants = await getLiveTenants();

  console.log(`\nA1 TWO-ENGINE DIVERGENCE  trailing-365 ${from}..${to}\n`);

  for (const t of tenants) {
    // ---- reports service (main tabs) ----
    const sales = await buildSalesReport({
      tenantId: t.id,
      request: {
        stayDateFrom: from, stayDateTo: to, granularity: "month",
        listingIds: [], channels: [], statuses: [],
        includeFees: true, includeVat: true, barMetric: "revenue", compareMode: "yoy_otb"
      } as any,
      displayCurrency: "GBP"
    });
    const repStayRev = sales.current.revenue.reduce((a, b) => a + b, 0);
    const repOccN = sales.current.nights.reduce((a, b) => a + b, 0);
    const repInv = sales.current.inventory.reduce((a, b) => a + b, 0);
    const repAdr = repOccN > 0 ? repStayRev / repOccN : 0;
    const repOcc = repInv > 0 ? (repOccN / repInv) * 100 : 0;

    const booked = await buildBookedReport({
      tenantId: t.id,
      request: {
        stayDateFrom: from, stayDateTo: to, granularity: "month",
        listingIds: [], channels: [], statuses: [],
        includeFees: true, includeVat: true, barMetric: "revenue", compareMode: "yoy_otb"
      } as any,
      displayCurrency: "GBP"
    }).catch((e) => { console.log("  buildBookedReport err:", e.message); return null; });
    const repBookedRev = booked ? booked.current.revenue.reduce((a: number, b: number) => a + b, 0) : NaN;

    // ---- registry (signal_lab) ----
    const stayMetrics = await queryMetrics({
      tenantId: t.id,
      metricIds: ["stay_revenue", "occupied_nights", "occupancy_pct"] as any,
      filters: { stayDateFrom: from, stayDateTo: to, granularity: "month" } as any,
      displayCurrency: "GBP"
    });
    const adrMetrics = await queryMetrics({
      tenantId: t.id,
      metricIds: ["adr_stay", "available_nights"] as any,
      filters: { stayDateFrom: from, stayDateTo: to, granularity: "month" } as any,
      displayCurrency: "GBP"
    });
    const bookMetrics = await queryMetrics({
      tenantId: t.id,
      metricIds: ["booked_revenue_by_booking_date", "bookings_created_count"] as any,
      filters: { bookingDateFrom: from, bookingDateTo: to, granularity: "month" } as any,
      displayCurrency: "GBP"
    });

    const regStayRev = sumSeries(stayMetrics, "stay_revenue");
    const regOccN = sumSeries(stayMetrics, "occupied_nights");
    const regAvailN = sumSeries(adrMetrics, "available_nights");
    const regAdr = regOccN > 0 ? regStayRev / regOccN : 0;
    const regOcc = regAvailN > 0 ? (regOccN / regAvailN) * 100 : 0;
    const regBookedRev = sumSeries(bookMetrics, "booked_revenue_by_booking_date");

    const line = (label: string, rep: number, reg: number, unit = "") => {
      const delta = rep - reg;
      const pct = reg !== 0 ? (delta / reg) * 100 : null;
      const flag = Math.abs(pct ?? 0) > 1 || (reg === 0 && rep !== 0) ? "  <-- DIVERGE" : "";
      console.log(
        "  " + label.padEnd(22),
        `reports=${rep.toFixed(2)}${unit}`.padEnd(22),
        `registry=${reg.toFixed(2)}${unit}`.padEnd(22),
        `Δ=${delta.toFixed(2)}${pct === null ? "" : ` (${pct.toFixed(1)}%)`}${flag}`
      );
    };

    console.log(`===== ${t.name} =====`);
    line("stay_revenue", repStayRev, regStayRev);
    line("occupied_nights", repOccN, regOccN);
    line("occupancy_pct", repOcc, regOcc, "%");
    line("adr_stay", repAdr, regAdr);
    line("inventory/available", repInv, regAvailN);
    line("booked_revenue", repBookedRev, regBookedRev);
    console.log("");
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
