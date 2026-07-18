/**
 * Guarded LIVE self-test for the recs engine push path. Run MANUALLY only.
 *
 *   npx tsx scripts/recs-push-selftest.ts <pricelabs|wheelhouse> \
 *     --tenant "<tenant name>" --listing <engineListingId> --confirm-live \
 *     [--days-out 260] [--currency GBP]
 *
 * What it does (see src/lib/recs/push/selftest.ts): picks a far-future date
 * (today + --days-out, default 260, refused under 180), reads the engine's
 * CURRENT price for that date, pushes that SAME value (a no-op), verifies it
 * landed, deletes it again, verifies it is gone, and prints the evidence
 * trail. Every PushLog row it writes carries detail.kind = "selftest".
 *
 * Refuses to run without --confirm-live. Keys come from the env registry
 * (PRICELABS_KEY_* / WHEELHOUSE_KEY_* + WHEELHOUSE_WRITE_KEY_*, longest-prefix
 * slug rule) — key values are never printed.
 */

import { prisma } from "@/lib/prisma";
import { isRecsPushEngine } from "@/lib/recs/push/types";
import { runRecsPushSelfTest, SELFTEST_DEFAULT_DAYS_OUT } from "@/lib/recs/push/selftest";

const USAGE =
  'Usage: npx tsx scripts/recs-push-selftest.ts <pricelabs|wheelhouse> --tenant "<name>" --listing <engineListingId> --confirm-live [--days-out 260] [--currency GBP]';

function readFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value.\n${USAGE}`);
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const engine = argv[0];
  if (!engine || engine.startsWith("--") || !isRecsPushEngine(engine)) {
    throw new Error(`First argument must be the engine (pricelabs|wheelhouse).\n${USAGE}`);
  }
  const tenantName = readFlag(argv, "--tenant");
  const listing = readFlag(argv, "--listing");
  const daysOutRaw = readFlag(argv, "--days-out");
  const currency = readFlag(argv, "--currency") ?? undefined;
  const confirmLive = argv.includes("--confirm-live");

  if (!tenantName) throw new Error(`--tenant "<name>" is required.\n${USAGE}`);
  if (!listing) throw new Error(`--listing <engineListingId> is required.\n${USAGE}`);
  if (!confirmLive) {
    throw new Error(
      `Refusing to run: this test performs LIVE engine writes (push + delete). Re-run with --confirm-live.\n${USAGE}`
    );
  }

  const tenant = await prisma.tenant.findFirst({
    where: { name: { equals: tenantName, mode: "insensitive" } },
    select: { id: true, name: true }
  });
  if (!tenant) {
    const names = await prisma.tenant.findMany({ select: { name: true } });
    throw new Error(
      `No tenant named "${tenantName}". Known tenants: ${names.map((t) => t.name).join(", ")}`
    );
  }

  const evidence = await runRecsPushSelfTest({
    engine,
    tenantId: tenant.id,
    tenantName: tenant.name,
    engineListingId: listing,
    confirmLive: true,
    daysOut: daysOutRaw !== null ? Number(daysOutRaw) : SELFTEST_DEFAULT_DAYS_OUT,
    currency
  });

  console.log("\n=== Evidence summary ===");
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
