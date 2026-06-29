/**
 * A7 — Pull live Hostaway reservations for a sample of tenants and CACHE to
 * scratchpad JSON. Respects rate limit via the gateway's own throttle; we only
 * pull each tenant once and cache.
 *
 * READ-ONLY (no-op token writeback). Run via run.sh.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { prisma, getLiveTenants, getReadonlyGatewayForTenant } from "./lib/ctx";

const SCRATCH =
  "/private/tmp/claude-501/-Users-markmccracken-Documents-signals/2fb77a7b-d5a9-4f51-b197-f092c4606a27/scratchpad/a7";

// Sample tenants by name substring (include Little Feather + 2 others).
const SAMPLE_TENANT_NAMES = ["Little Feather", "Stay Belfast", "Coorie Doon"];

async function main() {
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
  const tenants = await getLiveTenants();
  const sample = tenants.filter((t) =>
    SAMPLE_TENANT_NAMES.some((n) => t.name.includes(n))
  );
  console.log(`Sample tenants: ${sample.map((t) => t.name).join(", ")}`);

  for (const t of sample) {
    const cacheFile = `${SCRATCH}/resv-${t.id}.json`;
    if (existsSync(cacheFile)) {
      console.log(`  [cached] ${t.name} -> ${cacheFile}`);
      continue;
    }
    console.log(`  Pulling ${t.name} ...`);
    const gw = await getReadonlyGatewayForTenant(t.id);
    const all: any[] = [];
    for (let page = 1; page <= 500; page += 1) {
      const res = await gw.fetchReservations({ page });
      all.push(...res.items);
      if (!res.hasMore || res.items.length === 0) break;
      if (page % 10 === 0) console.log(`    ...page ${page}, ${all.length} so far`);
    }
    writeFileSync(cacheFile, JSON.stringify({ tenantId: t.id, name: t.name, reservations: all }));
    console.log(`  Wrote ${all.length} reservations -> ${cacheFile}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
