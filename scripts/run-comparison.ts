/**
 * Manual ad-hoc trigger for the trial daily pipeline. Same code path as the
 * scheduled 06:00 job + the admin route.
 *
 * Usage:
 *   npx tsx scripts/run-comparison.ts
 *   npx tsx scripts/run-comparison.ts 2026-04-29
 */
import { ensureEnvLoaded } from "@/lib/load-env";
ensureEnvLoaded();

import { runDailyTrialPipeline } from "@/lib/agents/pricing-comparison/pipeline";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const snapshotDate = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : undefined;
  const result = await runDailyTrialPipeline({ snapshotDate, reason: "scripts/run-comparison" });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[run-comparison] FAILED:", err);
  process.exit(1);
});
