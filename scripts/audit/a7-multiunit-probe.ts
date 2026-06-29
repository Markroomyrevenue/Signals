import { prisma } from "./lib/ctx";
const TENANT = "cmoeuax4x000ery6qv2emihce";
async function main() {
  const ids = ["514009", "554857", "515526"];
  for (const hwId of ids) {
    const l = await prisma.listing.findFirst({
      where: { tenantId: TENANT, hostawayId: hwId },
      select: { id: true, name: true, unitCount: true, removedAt: true, status: true }
    });
    if (!l) { console.log(`${hwId}: not found`); continue; }
    const resvTotal = await prisma.reservation.count({ where: { tenantId: TENANT, listingId: l.id } });
    const resvOcc = await prisma.reservation.count({ where: { tenantId: TENANT, listingId: l.id, status: { notIn: ["cancelled", "canceled", "declined", "expired"] } } });
    const nfTotal = await prisma.nightFact.count({ where: { tenantId: TENANT, listingId: l.id } });
    const nfOcc = await prisma.nightFact.count({ where: { tenantId: TENANT, listingId: l.id, isOccupied: true } });
    const crCount = await prisma.calendarRate.count({ where: { tenantId: TENANT, listingId: l.id } });
    console.log(`\n${l.name} (hostaway ${hwId})`);
    console.log(`  unit_count=${l.unitCount}  status=${l.status}  removedAt=${l.removedAt ? l.removedAt.toISOString() : "null"}`);
    console.log(`  reservations: total=${resvTotal} occupied-ish=${resvOcc}`);
    console.log(`  night_facts: total=${nfTotal} occupied=${nfOcc}`);
    console.log(`  calendar_rates rows: ${crCount}`);
  }
  // Also: what does the portfolio inventory look like with unit_count multiplication?
  const listings = await prisma.listing.findMany({
    where: { tenantId: TENANT, removedAt: null },
    select: { unitCount: true }
  });
  const totalUnits = listings.reduce((a, l) => a + (l.unitCount ?? 1), 0);
  console.log(`\nPortfolio: ${listings.length} active listings, sum(unit_count)=${totalUnits}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
