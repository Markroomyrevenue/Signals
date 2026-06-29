/**
 * Core reconciliation — for every live tenant, compare the report service's
 * headline stay metrics (occupied nights, inventory nights, occupancy, stay
 * revenue, ADR, RevPAR) for a trailing-365 stay window against an INDEPENDENT
 * raw recompute over night_facts / calendar_rates that mirrors the report's
 * own revenue definition (r.total/los_nights per occupied night-row).
 *
 * A delta beyond a rounding tolerance = a real aggregation bug to investigate.
 * READ-ONLY. Run via: bash scripts/audit/run.sh scripts/audit/reconcile-core.ts
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildSalesReport } from "@/lib/reports/service";

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type Raw = {
  occNights: number;
  invNights: number;
  revenueIncl: number;
};

async function rawStay(tenantId: string, from: string, to: string): Promise<Raw> {
  // Occupied nights + revenue mirroring service.ts lines 1166-1173 (los-spread).
  const occ = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS nights,
            COALESCE(SUM(
              CASE WHEN COALESCE(nf.los_nights,0) > 0 AND COALESCE(r.total,0) > 0
                   THEN COALESCE(r.total,0) / nf.los_nights
                   ELSE COALESCE(nf.revenue_allocated,0) END
            ),0)::float AS revenue
     FROM night_facts nf
     LEFT JOIN reservations r ON r.id = nf.reservation_id
     JOIN listings l ON l.id = nf.listing_id AND l.tenant_id = nf.tenant_id AND l.removed_at IS NULL
     WHERE nf.tenant_id = $1 AND nf.is_occupied = true
       AND nf.date >= $2::date AND nf.date <= $3::date`,
    tenantId, from, to
  );
  // Inventory nights mirroring service.ts lines 1222-1231 (calendar_rates count),
  // scoped to non-removed listings.
  const inv = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS inv
     FROM calendar_rates cr
     JOIN listings l ON l.id = cr.listing_id AND l.tenant_id = cr.tenant_id AND l.removed_at IS NULL
     WHERE cr.tenant_id = $1 AND cr.date >= $2::date AND cr.date <= $3::date`,
    tenantId, from, to
  );
  return {
    occNights: Number(occ[0].nights),
    revenueIncl: Number(occ[0].revenue),
    invNights: Number(inv[0].inv)
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

async function main() {
  const today = new Date();
  const to = dateOnly(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  const fromD = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));
  const from = dateOnly(fromD);

  const tenants = await getLiveTenants();
  console.log(`\nCORE RECONCILE  stay window ${from} .. ${to}  (includeFees=true, includeVat=true)\n`);
  console.log("tenant".padEnd(26), "metric".padEnd(12), "report".padStart(14), "raw".padStart(14), "delta".padStart(12), "  verdict");
  console.log("-".repeat(96));

  const results: any[] = [];
  for (const t of tenants) {
    const report = await buildSalesReport({
      tenantId: t.id,
      request: {
        stayDateFrom: from,
        stayDateTo: to,
        granularity: "month",
        listingIds: [],
        channels: [],
        statuses: [],
        includeFees: true,
        includeVat: true,
        barMetric: "revenue",
        compareMode: "yoy_otb"
      } as any,
      displayCurrency: "GBP"
    });

    const repNights = sum(report.current.nights);
    const repRevenue = sum(report.current.revenue);
    const repInv = sum(report.current.inventory);
    const repAdr = repNights > 0 ? repRevenue / repNights : 0;
    const repRevpar = repInv > 0 ? repRevenue / repInv : 0;
    const repOcc = repInv > 0 ? (repNights / repInv) * 100 : 0;

    const raw = await rawStay(t.id, from, to);
    const rawAdr = raw.occNights > 0 ? raw.revenueIncl / raw.occNights : 0;
    const rawRevpar = raw.invNights > 0 ? raw.revenueIncl / raw.invNights : 0;
    const rawOcc = raw.invNights > 0 ? (raw.occNights / raw.invNights) * 100 : 0;

    const rows = [
      ["occ_nights", repNights, raw.occNights],
      ["inv_nights", repInv, raw.invNights],
      ["occupancy%", repOcc, rawOcc],
      ["revenue", repRevenue, raw.revenueIncl],
      ["adr", repAdr, rawAdr],
      ["revpar", repRevpar, rawRevpar]
    ] as [string, number, number][];

    for (const [metric, rep, rw] of rows) {
      const delta = rep - rw;
      const tol = Math.max(0.5, Math.abs(rw) * 0.005); // 0.5% or 0.5 abs
      const verdict = Math.abs(delta) <= tol ? "PASS" : "**FAIL**";
      console.log(
        t.name.slice(0, 25).padEnd(26),
        metric.padEnd(12),
        rep.toFixed(2).padStart(14),
        rw.toFixed(2).padStart(14),
        delta.toFixed(2).padStart(12),
        "  " + verdict
      );
      results.push({ tenant: t.name, metric, report: rep, raw: rw, delta, verdict });
    }
    console.log("-".repeat(96));
  }

  const fails = results.filter((r) => r.verdict.includes("FAIL"));
  console.log(`\n${fails.length} FAIL row(s) out of ${results.length}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
