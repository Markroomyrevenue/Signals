import { prisma, getLiveTenants } from "./lib/ctx";
async function main() {
  const tenants = await getLiveTenants();
  for (const t of tenants) {
    const listings = await prisma.listing.count({ where: { tenantId: t.id } });
    const resv = await prisma.reservation.count({ where: { tenantId: t.id } });
    console.log(`${t.id}\t${t.name}\t${listings} listings\t${resv} resv`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
