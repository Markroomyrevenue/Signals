/**
 * Phase A runner — warm-start the recs evidence store from history.
 *
 * Per tenant: mine the ≥3% drop-episode record (same design as
 * scripts/mine-drop-outcomes.ts, pure logic in src/lib/observe/drop-outcomes.ts)
 * into `recs_evidence` rows: kind "mark-prior" (revealed sizing bands, with the
 * attribution caveat) + kind "drop-outcomes" (matched-control dose-response
 * cells, with the observational caveat). Provenance "warm-start"; the live
 * loop re-checks these as real days accumulate.
 *
 * Writes ONLY the recs_evidence table. Reads everything else. Never prints a
 * connection string.
 *
 * Usage:
 *   npx tsx scripts/recs-warmstart.ts                # local dev DB (DATABASE_URL)
 *   npx tsx scripts/recs-warmstart.ts --prod         # prod (DATABASE_PUBLIC_URL); recs_evidence upserts only
 *   npx tsx scripts/recs-warmstart.ts --tenant "Stay Belfast"   # name-prefix filter
 */

import { PrismaClient } from "@prisma/client";

import { ensureEnvLoaded } from "@/lib/load-env";
import { computeOwnHistoryEvidence, upsertRecsEvidence } from "@/lib/recs/warmstart";

function parseArgs(argv: string[]): { prod: boolean; tenantPrefix: string | null } {
  const prod = argv.includes("--prod");
  const tIdx = argv.indexOf("--tenant");
  const tenantPrefix = tIdx !== -1 && argv[tIdx + 1] ? argv[tIdx + 1].toLowerCase() : null;
  return { prod, tenantPrefix };
}

async function main(): Promise<void> {
  ensureEnvLoaded();
  const { prod, tenantPrefix } = parseArgs(process.argv.slice(2));
  const url = prod ? process.env.DATABASE_PUBLIC_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(prod ? "DATABASE_PUBLIC_URL is not set" : "DATABASE_URL is not set");
  const db = new PrismaClient({ datasources: { db: { url } } });

  try {
    const tenants = (await db.tenant.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })).filter(
      (t) => tenantPrefix === null || t.name.toLowerCase().startsWith(tenantPrefix)
    );
    for (const tenant of tenants) {
      const evidence = await computeOwnHistoryEvidence(db, tenant);
      await upsertRecsEvidence(db, {
        tenantId: tenant.id,
        clientKey: tenant.id,
        kind: "mark-prior",
        provenance: "warm-start",
        payload: evidence.markPrior
      });
      await upsertRecsEvidence(db, {
        tenantId: tenant.id,
        clientKey: tenant.id,
        kind: "drop-outcomes",
        provenance: "warm-start",
        payload: evidence.dropOutcomes
      });
      const bandLine = evidence.markPrior.bands
        .map((b) => `${b.leadBucket}:${(b.medianDropPct * 100).toFixed(0)}%(n=${b.n})`)
        .join(" ");
      console.log(
        `[recs-warmstart] ${tenant.name}: episodes=${evidence.episodesFound} settledTreated=${evidence.treatedNightsSettled} ` +
          `cells=${evidence.dropOutcomes.cells.length} prior=[${bandLine || "none"}]`
      );
    }
    console.log(`[recs-warmstart] done (${tenants.length} tenant(s), ${prod ? "prod" : "local"})`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[recs-warmstart] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
