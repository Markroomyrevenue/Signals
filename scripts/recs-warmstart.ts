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
import { toDateOnly } from "@/lib/metrics/helpers";
import type { PriceLabsAdapter } from "@/lib/observe/engine/pricelabs";
import type { WheelhouseAdapter } from "@/lib/observe/engine/wheelhouse";
import { resolveObserveSource } from "@/lib/observe/registry";
import { computeEngineHistoryEvidence, computeOwnHistoryEvidence, upsertRecsEvidence } from "@/lib/recs/warmstart";

function parseArgs(argv: string[]): { prod: boolean; tenantPrefix: string | null; engines: boolean } {
  const prod = argv.includes("--prod");
  const engines = argv.includes("--engines");
  const tIdx = argv.indexOf("--tenant");
  const tenantPrefix = tIdx !== -1 && argv[tIdx + 1] ? argv[tIdx + 1].toLowerCase() : null;
  return { prod, tenantPrefix, engines };
}

/** Live read-only engine sweep for one tenant (slow: rate-limit spaced). */
async function collectEngineHistory(
  db: PrismaClient,
  tenant: { id: string; name: string }
): Promise<{ kind: string; payload: unknown } | null> {
  const source = resolveObserveSource({ id: tenant.id, name: tenant.name });
  if (!source.adapter || (source.kind !== "pricelabs" && source.kind !== "wheelhouse")) return null;
  const listings = await db.listing.findMany({
    where: { tenantId: tenant.id, removedAt: null, hostawayId: { not: "" } },
    select: { hostawayId: true }
  });
  const ids = listings.map((l) => String(l.hostawayId));
  const today = toDateOnly(new Date());
  const payload =
    source.kind === "pricelabs"
      ? await computeEngineHistoryEvidence({
          engine: "pricelabs",
          engineListingIds: ids,
          forwardCalendar: async (id) =>
            (await (source.adapter as PriceLabsAdapter).fetchPriceCalendar(id, today, 30)).map((d) => ({
              date: d.date,
              price: d.price
            }))
        })
      : await computeEngineHistoryEvidence({
          engine: "wheelhouse",
          engineListingIds: ids,
          baseHistory: async (id) =>
            (await (source.adapter as WheelhouseAdapter).fetchBasePriceHistory(id)).map((r) => ({
              modelDate: r.modelDate,
              recommendation: r.recommendation
            }))
        });
  return { kind: "engine-history", payload };
}

async function main(): Promise<void> {
  ensureEnvLoaded();
  const { prod, tenantPrefix, engines } = parseArgs(process.argv.slice(2));
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
      if (engines) {
        const engineHistory = await collectEngineHistory(db, tenant);
        if (engineHistory) {
          await upsertRecsEvidence(db, {
            tenantId: tenant.id,
            clientKey: tenant.id,
            kind: engineHistory.kind,
            provenance: "warm-start",
            payload: engineHistory.payload
          });
          console.log(`[recs-warmstart] ${tenant.name}: engine-history collected (read-only sweep)`);
        }
      }
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
