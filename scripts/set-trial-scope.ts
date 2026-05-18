/**
 * Phase 4 of the KeyData trial: set `keyDataTrialMode: "standard"` on every
 * in-trial listing's property-scope PricingSetting, log the scope counts,
 * and verify that `hostawayPushEnabled` is OFF on every trial listing.
 *
 * CRITICAL: Student-Accom listings are NOT given a different keyDataTrialMode
 * here — the exclusion is a runtime filter inside the comparison agent
 * (see `isStudentAccomListing` in agent.ts), re-evaluated every daily run.
 * This script simply skips them so they don't get a "standard" row written.
 *
 * Read-only by default. Pass `--apply` to actually upsert rows.
 *
 * Usage:
 *   ts-node scripts/set-trial-scope.ts             # dry-run, prints scope log
 *   ts-node scripts/set-trial-scope.ts --apply     # upsert keyDataTrialMode=standard
 */

import { prisma } from "@/lib/prisma";
import { listTrialTenants } from "@/lib/pricing/trial-tenants";

const STUDENT_ACCOM_LABELS = ["student accom", "student accommodation"];

function isStudentAccomListing(tags: string[] | null | undefined): boolean {
  if (!tags) return false;
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const normalised = tag.trim().toLowerCase();
    if (!normalised.startsWith("group:")) continue;
    const label = normalised.slice("group:".length).trim().replace(/\s+/g, " ").replace(/[-_]/g, " ");
    if (STUDENT_ACCOM_LABELS.includes(label) || label.startsWith("student accom")) return true;
  }
  return false;
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply) {
    console.log("[set-trial-scope] APPLY mode — will upsert keyDataTrialMode='standard' on in-trial listings.");
  } else {
    console.log("[set-trial-scope] DRY-RUN — pass --apply to write changes.");
  }

  const tenants = await listTrialTenants();
  if (tenants.length === 0) {
    console.log("[set-trial-scope] No trial tenants resolved. Check KEYDATA_TRIAL_TENANTS / KEYDATA_TRIAL_TENANT_IDS in .env.");
    return;
  }
  console.log(`[set-trial-scope] Trial tenants: ${tenants.map((t) => `${t.name} (${t.id})`).join(", ")}`);

  let grandTotalActive = 0;
  let grandTotalMultiUnit = 0;
  let grandTotalStudentAccom = 0;
  let grandTotalInTrial = 0;
  let grandTotalPushOn = 0;
  let grandTotalRowsUpserted = 0;

  for (const t of tenants) {
    const listings = await prisma.listing.findMany({
      where: { tenantId: t.id, status: { not: "inactive" } },
      select: { id: true, name: true, unitCount: true, tags: true }
    });
    const multiUnit = listings.filter((l) => (l.unitCount ?? 1) >= 2);
    const studentAccom = listings.filter((l) => (l.unitCount ?? 1) < 2 && isStudentAccomListing(l.tags));
    const inTrial = listings.filter(
      (l) => (l.unitCount ?? 1) < 2 && !isStudentAccomListing(l.tags)
    );

    console.log(`\n[${t.name}]`);
    console.log(`  active listings:        ${listings.length}`);
    console.log(`  multi-unit (skipped):   ${multiUnit.length}`);
    console.log(`  student-accom (excl.):  ${studentAccom.length}  — DYNAMIC, not persisted`);
    console.log(`  in trial today:         ${inTrial.length}`);

    grandTotalActive += listings.length;
    grandTotalMultiUnit += multiUnit.length;
    grandTotalStudentAccom += studentAccom.length;
    grandTotalInTrial += inTrial.length;

    // Verify hostawayPushEnabled — read the property-scope settings for each
    // in-trial listing. If push is enabled anywhere in the trial scope it's
    // a config error worth flagging loudly.
    const propertyScopeRows = await prisma.pricingSetting.findMany({
      where: {
        tenantId: t.id,
        scope: "property",
        scopeRef: { in: inTrial.map((l) => l.id) }
      },
      select: { scopeRef: true, settings: true }
    });
    const pushEnabledByListing = new Map<string, boolean>();
    for (const row of propertyScopeRows) {
      if (!row.scopeRef) continue;
      const s = (row.settings ?? {}) as Record<string, unknown>;
      pushEnabledByListing.set(row.scopeRef, s.hostawayPushEnabled === true);
    }
    const pushOnListings = inTrial.filter((l) => pushEnabledByListing.get(l.id) === true);
    if (pushOnListings.length > 0) {
      console.log(`  [WARN] hostawayPushEnabled=true on ${pushOnListings.length} trial listings:`);
      for (const l of pushOnListings) console.log(`    - ${l.id} ${l.name}`);
      grandTotalPushOn += pushOnListings.length;
    } else {
      console.log("  hostawayPushEnabled: OFF on every trial listing ✓");
    }

    if (apply) {
      const settingsByListing = new Map<string, Record<string, unknown>>();
      for (const row of propertyScopeRows) {
        if (!row.scopeRef) continue;
        settingsByListing.set(row.scopeRef, (row.settings ?? {}) as Record<string, unknown>);
      }
      let upsertedThisTenant = 0;
      for (const l of inTrial) {
        const existing = settingsByListing.get(l.id) ?? {};
        if (existing.keyDataTrialMode === "standard") continue; // no-op
        const nextSettings = { ...existing, keyDataTrialMode: "standard" };
        await prisma.pricingSetting.upsert({
          where: { tenantId_scope_scopeRef: { tenantId: t.id, scope: "property", scopeRef: l.id } },
          create: {
            tenantId: t.id,
            scope: "property",
            scopeRef: l.id,
            settings: nextSettings
          },
          update: { settings: nextSettings }
        });
        upsertedThisTenant += 1;
      }
      console.log(`  upserted keyDataTrialMode='standard' on ${upsertedThisTenant} listings (others already 'standard')`);
      grandTotalRowsUpserted += upsertedThisTenant;
    }
  }

  console.log("\n[set-trial-scope] Grand totals across all trial tenants:");
  console.log(`  active listings:        ${grandTotalActive}`);
  console.log(`  multi-unit skipped:     ${grandTotalMultiUnit}`);
  console.log(`  student-accom excluded: ${grandTotalStudentAccom}`);
  console.log(`  in trial today:         ${grandTotalInTrial}`);
  console.log(`  hostawayPushEnabled ON: ${grandTotalPushOn}`);
  if (apply) console.log(`  rows upserted:          ${grandTotalRowsUpserted}`);
  if (grandTotalPushOn > 0) {
    console.error("\n[set-trial-scope] ERROR: trial listings have hostawayPushEnabled=true. The trial is a comparison-only exercise — push must stay OFF.");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
