import { cleanupStaleRunningSyncs } from "@/lib/sync/engine";
import { prisma } from "@/lib/prisma";

async function main() {
  // Find two distinct tenants
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true }, take: 2 });
  if (tenants.length < 2) {
    console.log("need at least 2 tenants for this test");
    return;
  }
  const [tA, tB] = tenants;
  // Insert a fake stale running row for tenant A, dated 12 hours ago
  // (well past the 6-hour global threshold but obviously > 30-min tenant
  // threshold too).
  const stale = await prisma.syncRun.create({
    data: {
      tenantId: tA.id,
      jobType: "verify_cross_tenant_cleanup_2026_05_20",
      status: "running",
      startedAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
      details: { test: true }
    }
  });
  console.log("Inserted fake stale row for", tA.name, "(id=" + stale.id + ")");
  // Call cleanup with a DIFFERENT tenant id (tB) — should still clean tA's row
  // via the global threshold pass.
  await cleanupStaleRunningSyncs(tB.id);
  const after = await prisma.syncRun.findUnique({ where: { id: stale.id }, select: { status: true } });
  console.log("After cleanup called as tenant B:", tB.name);
  console.log("Tenant A's stale row status:", after?.status);
  console.log("Cross-tenant cleanup works:", after?.status === "failed" ? "YES" : "NO");
  // Tidy up the fake row.
  await prisma.syncRun.delete({ where: { id: stale.id } });
}
main().finally(() => prisma.$disconnect());
