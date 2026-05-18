/**
 * Manual ad-hoc trigger for the Day-14 KeyData trial summary email.
 *
 * Usage:
 *   npx tsx scripts/run-day14-summary.ts                # uses KEYDATA_TRIAL_END
 *   npx tsx scripts/run-day14-summary.ts 2026-06-01     # explicit date
 *
 * Idempotent — re-running on the same date will regenerate the HTML/JSON
 * artifacts but skip the email if the marker file already exists. Delete
 * /trial-reports/keydata-day14-summary-YYYY-MM-DD.email-sent to force a
 * resend.
 */
import { ensureEnvLoaded } from "@/lib/load-env";
ensureEnvLoaded();

import { sendDay14Summary } from "@/lib/agents/pricing-comparison/day14-runner";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const fallback = process.env.KEYDATA_TRIAL_END ?? "2026-06-01";
  const reportDate = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : fallback;
  const result = await sendDay14Summary({ reportDate, reason: "scripts/run-day14-summary" });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[run-day14-summary] FAILED:", err);
  process.exit(1);
});
