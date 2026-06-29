/**
 * A2 — (a) does any multi-unit date exceed unit_count (overbook / double-count)?
 *       (b) does the property deep-dive (drilldown tab) show the same inflated occ?
 * READ-ONLY.
 */
import { prisma, getLiveTenants } from "./lib/ctx";
import { buildPropertyDeepDiveReport } from "@/lib/reports/service";

async function main() {
  const tenants = await getLiveTenants();
  const lf = tenants.find((t) => /little feather/i.test(t.name))!;
  const multi = await prisma.listing.findMany({
    where: { tenantId: lf.id, unitCount: { gte: 2 } },
    select: { id: true, name: true, unitCount: true }
  });

  console.log("OVERFLOW CHECK — any date where occupied reservations > unit_count?");
  for (const l of multi) {
    const over = await prisma.$queryRawUnsafe<any[]>(
      `SELECT nf.date::text AS d, COUNT(*)::int AS c
       FROM night_facts nf
       WHERE nf.tenant_id=$1 AND nf.listing_id=$2 AND nf.is_occupied=true
       GROUP BY nf.date HAVING COUNT(*) > $3 ORDER BY c DESC LIMIT 5`,
      lf.id, l.id, l.unitCount
    );
    console.log(`  ${l.name} (uc=${l.unitCount}): ${over.length === 0 ? "none exceed unit_count (good — no double-count)" : over.map((o) => `${o.d}:${o.c}`).join(", ")}`);
  }

  console.log("\nPROPERTY DEEP-DIVE (drilldown tab) occ% for multi-unit listings:");
  try {
    const dd = await buildPropertyDeepDiveReport({
      tenantId: lf.id,
      request: {
        stayDateFrom: "2026-08-01", stayDateTo: "2026-08-31",
        granularity: "month", listingIds: [], channels: [], statuses: [],
        includeFees: true, includeVat: true, compareMode: "yoy_otb"
      } as any,
      displayCurrency: "GBP"
    });
    const rows: any[] = (dd as any).rows ?? [];
    for (const l of multi) {
      const row = rows.find((r) => r.listingId === l.id);
      if (row) {
        console.log(`  ${l.name} (uc=${l.unitCount}): occ%=${row.currentOccupancyPct ?? row.occupancyPct ?? "?"}  nights=${row.currentNights ?? row.nights ?? "?"}  revpar=${row.currentRevpar ?? row.revpar ?? "?"}`);
      } else {
        console.log(`  ${l.name}: (no row; keys=${rows[0] ? Object.keys(rows[0]).join(",") : "no rows"})`);
      }
    }
  } catch (e) {
    console.log("  deep-dive call failed:", (e as Error).message);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
