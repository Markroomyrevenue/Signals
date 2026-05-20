import { cleanupStaleRunningSyncs } from "@/lib/sync/engine";
import { prisma } from "@/lib/prisma";

async function main() {
  const before = await prisma.syncRun.count({ where: { status: "running" } });
  console.log("Running rows before cleanup pass:", before);
  // Call cleanup as if from any tenant — should be idempotent on a clean DB
  const t = await prisma.tenant.findFirst({ where: { name: "Little Feather Management" } });
  await cleanupStaleRunningSyncs(t!.id);
  const after = await prisma.syncRun.count({ where: { status: "running" } });
  console.log("Running rows after cleanup pass:", after);
  console.log("Idempotent on clean DB:", before === after && before === 0 ? "yes" : "no");
}
main().finally(() => prisma.$disconnect());
