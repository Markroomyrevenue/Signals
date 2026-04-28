/**
 * One-shot backtest harness driver. Writes HTML + JSON to /trial-reports/.
 *
 * Usage:
 *   npx tsx scripts/run-backtest.ts
 */
import { ensureEnvLoaded } from "@/lib/load-env";
ensureEnvLoaded();

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runBacktest } from "@/lib/backtest/runner";
import { renderBacktestHtml } from "@/lib/backtest/report";

const TRIAL_REPORTS_DIR = "/Users/markmccracken/Documents/signals/trial-reports";

async function main(): Promise<void> {
  console.log("[backtest] starting…");
  const summary = await runBacktest();
  console.log("[backtest] tenants:", summary.tenants.length);
  await mkdir(TRIAL_REPORTS_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const htmlPath = path.join(TRIAL_REPORTS_DIR, `keydata-backtest-${today}.html`);
  const jsonPath = path.join(TRIAL_REPORTS_DIR, `keydata-backtest-${today}.json`);
  await writeFile(htmlPath, renderBacktestHtml(summary), "utf8");
  await writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`[backtest] wrote ${htmlPath}`);
  console.log(`[backtest] wrote ${jsonPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("[backtest] FAILED:", err);
  process.exit(1);
});
