/**
 * Manually render + send a client's day-30 Observe & Learn readout.
 *
 *   npx tsx scripts/observe-day30.ts <tenantId>             # today's date
 *   npx tsx scripts/observe-day30.ts <tenantId> 2026-07-26  # explicit date
 *
 * Safe to re-run — the .email-sent marker blocks a double-send. Mirrors
 * scripts/run-day14-summary.ts. Never prints a key.
 */

import { sendDay30Readout } from "@/lib/observe/day30-runner";
import { prisma } from "@/lib/prisma";

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  const reportDate = process.argv[3] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3]) ? process.argv[3] : undefined;
  if (!tenantId) {
    console.error("usage: tsx scripts/observe-day30.ts <tenantId> [yyyy-mm-dd]");
    process.exitCode = 1;
    return;
  }
  const result = await sendDay30Readout({ tenantId, reportDate, reason: "scripts/observe-day30" });
  console.log(JSON.stringify(result, null, 2));
}

void main()
  .catch((error) => {
    console.error("observe-day30 failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
