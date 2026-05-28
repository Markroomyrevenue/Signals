/**
 * Trial-final archive (2026-05-27).
 *
 * Produces a single self-contained directory at
 * `cache/trial-final-{ISO date}/` containing everything needed to
 * replay or audit the trial post-subscription-end.
 *
 * Layout:
 *   cache/trial-final-YYYY-MM-DD/
 *     README.md
 *     engine/   - git HEAD pointer, package.json, prisma-schema.prisma, env-keys.txt
 *     db/       - one JSONL per model, streamed in batches
 *     keydata/  - copy of cache/keydata-* + cache/keydata-fallback
 *     logs/     - last 10000 lines of worker.log
 *
 * Idempotent: same date in same day re-runs overwrite. Different days
 * write to different directories (BullMQ scheduler in Task 3 calls
 * this daily at 07:00 BST).
 *
 * Usage:
 *   npx tsx scripts/snapshot-trial-final.ts
 */

import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

const WORKTREE_ROOT = "/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8";
const BATCH = 5000;

function bigintSafeStringify(row: unknown): string {
  return JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function execCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: WORKTREE_ROOT });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
      else resolve(Buffer.concat(chunks).toString("utf-8").trim());
    });
    child.on("error", reject);
  });
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSizeBytes(p);
      else {
        const s = await fs.stat(p);
        total += s.size;
      }
    }
  } catch {
    // dir may not exist
  }
  return total;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Stream one Prisma model to a JSONL file. Batched via skip/take
 * pagination so it works for tables with composite primary keys
 * (e.g. PaceSnapshot, DailyAgg) as well as tables with a string `id`.
 * Skips gracefully when the model doesn't exist on this branch's
 * Prisma client OR when its findMany throws (e.g. row with corrupt
 * Decimal/date) — logs the error and moves on.
 */
async function streamModelToJsonl(
  prismaModelName: string,
  outputPath: string
): Promise<{ rows: number; bytes: number } | { skipped: string }> {
  const model = (prisma as unknown as Record<string, { findMany?: (args?: object) => Promise<unknown[]> }>)[prismaModelName];
  if (!model || typeof model.findMany !== "function") {
    return { skipped: `model ${prismaModelName} not found on Prisma client` };
  }
  const out = createWriteStream(outputPath, { encoding: "utf-8" });
  let rowsWritten = 0;
  let skip = 0;
  try {
    while (true) {
      // skip/take pagination — works on every table regardless of PK
      // shape. Postgres `OFFSET` is O(n) on the skip value so this is
      // slower than cursor-by-id for huge tables, but the trial dataset
      // is small (hundreds of thousands max) and we want correctness
      // over micro-optimisation.
      const batch: unknown[] = await model.findMany({ skip, take: BATCH });
      if (batch.length === 0) break;
      for (const row of batch) {
        out.write(bigintSafeStringify(row) + "\n");
        rowsWritten++;
      }
      skip += batch.length;
      if (batch.length < BATCH) break;
    }
  } catch (e) {
    await new Promise<void>((resolve) => out.end(() => resolve()));
    return { skipped: `findMany error: ${(e as Error).message}` };
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  const stat = await fs.stat(outputPath);
  return { rows: rowsWritten, bytes: stat.size };
}

async function copyDir(src: string, dest: string): Promise<void> {
  try {
    await fs.cp(src, dest, { recursive: true });
  } catch (e) {
    // Source may not exist (e.g. no keydata cache yet). Log and continue.
    console.warn(`  (skipped copy ${src} → ${dest}: ${(e as Error).message})`);
  }
}

async function copyKeyDataCaches(destBase: string): Promise<void> {
  await fs.mkdir(destBase, { recursive: true });
  const cacheRoot = path.join(WORKTREE_ROOT, "cache");
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // Match any directory matching keydata-* (covers keydata-2026-05-26, keydata-fallback, etc.)
    if (!e.name.startsWith("keydata-")) continue;
    await copyDir(path.join(cacheRoot, e.name), path.join(destBase, e.name));
  }
}

async function tailWorkerLog(destPath: string): Promise<{ lines: number; bytes: number } | { skipped: string }> {
  const logPath = path.join(WORKTREE_ROOT, "worker.log");
  try {
    const buf = await fs.readFile(logPath, "utf-8");
    const lines = buf.split("\n");
    const tail = lines.slice(-10000).join("\n");
    await fs.writeFile(destPath, tail, "utf-8");
    const stat = await fs.stat(destPath);
    return { lines: Math.min(lines.length, 10000), bytes: stat.size };
  } catch {
    return { skipped: "worker.log not found" };
  }
}

async function writeEngineState(destBase: string): Promise<void> {
  await fs.mkdir(destBase, { recursive: true });
  const sha = await execCapture("git", ["rev-parse", "HEAD"]).catch(() => "(git unavailable)");
  const branch = await execCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "(unknown)");
  await fs.writeFile(
    path.join(destBase, "commit.txt"),
    `commit: ${sha}\nbranch: ${branch}\ndate:   ${new Date().toISOString()}\n`,
    "utf-8"
  );
  for (const filename of ["package.json", "package-lock.json"]) {
    try {
      await fs.copyFile(path.join(WORKTREE_ROOT, filename), path.join(destBase, filename));
    } catch {
      // package-lock may not exist
    }
  }
  try {
    await fs.copyFile(
      path.join(WORKTREE_ROOT, "prisma/schema.prisma"),
      path.join(destBase, "prisma-schema.prisma")
    );
  } catch {
    // ignore
  }
  const envKeys = Object.keys(process.env).sort();
  await fs.writeFile(path.join(destBase, "env-keys.txt"), envKeys.join("\n") + "\n", "utf-8");
}

async function writeReadme(destPath: string, sha: string, branch: string): Promise<void> {
  const body = `# Trial-final archive

Created: ${new Date().toISOString()}
Worktree commit: ${sha}
Branch: ${branch}

## What's here
A self-contained snapshot of the KeyData trial. Captures every Hostaway
listing, every reservation, every pricing recommendation produced, every
KeyData API response cached locally, and the engine code-state pointer.

## How to use post-trial
To replay a recommendation: find the cell in
db/pricing_comparison_snapshots.jsonl by (tenantId, listingId,
targetDate, snapshotDate). \`ourBreakdown\` JSON has the full multiplier
breakdown.

To test a new engine version against trial truth: rerun the engine
offline with cache/keydata-* mounted as the KD cache directory.

## Caveats
- Secrets stripped: env-keys.txt has names only.
- Worker.log: last 10000 lines only.
- Re-run scripts/snapshot-trial-final.ts close to trial close to
  capture the final state. The daily 07:00 BST scheduler in Task 3
  does this automatically.
`;
  await fs.writeFile(destPath, body, "utf-8");
}

async function main() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const root = path.join(WORKTREE_ROOT, "cache", `trial-final-${todayIso}`);
  console.log(`[snapshot] target: ${root}\n`);
  await fs.mkdir(root, { recursive: true });

  // Engine state
  console.log("[snapshot] engine/...");
  await writeEngineState(path.join(root, "engine"));
  const sha = await execCapture("git", ["rev-parse", "HEAD"]).catch(() => "(unknown)");
  const branch = await execCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "(unknown)");
  await writeReadme(path.join(root, "README.md"), sha, branch);

  // DB dumps. (prismaModelName, fileName) pairs — actual rate_states /
  // rate_changes / booking_rate_contexts models don't exist on this
  // branch's Prisma client and will be SKIPPED gracefully.
  const dbDir = path.join(root, "db");
  await fs.mkdir(dbDir, { recursive: true });
  const tables: Array<{ model: string; file: string }> = [
    { model: "tenant", file: "tenants.jsonl" },
    { model: "listing", file: "listings.jsonl" },
    { model: "pricingSetting", file: "pricing_settings.jsonl" },
    { model: "pricingComparisonSnapshot", file: "pricing_comparison_snapshots.jsonl" },
    { model: "pricingComparisonRun", file: "pricing_comparison_runs.jsonl" },
    { model: "reservation", file: "reservations.jsonl" },
    { model: "nightFact", file: "night_facts.jsonl" },
    { model: "calendarRate", file: "calendar_rates.jsonl" },
    { model: "rateState", file: "rate_states.jsonl" },
    { model: "rateChange", file: "rate_changes.jsonl" },
    { model: "bookingRateContext", file: "booking_rate_contexts.jsonl" },
    { model: "paceSnapshot", file: "pace_snapshots.jsonl" },
    { model: "syncRun", file: "sync_runs.jsonl" },
    { model: "dailyAgg", file: "daily_aggs.jsonl" }
  ];
  const dbCounts: Record<string, number | string> = {};
  for (const t of tables) {
    const out = path.join(dbDir, t.file);
    const r = await streamModelToJsonl(t.model, out);
    if ("skipped" in r) {
      console.log(`  [skip] ${t.file}: ${r.skipped}`);
      dbCounts[t.file] = `skipped (${r.skipped})`;
    } else {
      console.log(`  ${t.file}: ${r.rows} rows, ${fmtBytes(r.bytes)}`);
      dbCounts[t.file] = r.rows;
    }
  }

  // KeyData caches
  console.log("\n[snapshot] keydata/...");
  await copyKeyDataCaches(path.join(root, "keydata"));

  // Logs
  console.log("\n[snapshot] logs/...");
  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  const logResult = await tailWorkerLog(path.join(root, "logs", "worker.log.copy"));
  if ("skipped" in logResult) console.log(`  ${logResult.skipped}`);
  else console.log(`  worker.log.copy: ${logResult.lines} lines, ${fmtBytes(logResult.bytes)}`);

  // Summary
  console.log("\n[snapshot] summary:");
  const dirs = ["engine", "db", "keydata", "logs"];
  for (const d of dirs) {
    const size = await dirSizeBytes(path.join(root, d));
    console.log(`  ${d}/: ${fmtBytes(size)}`);
  }
  const totalSize = await dirSizeBytes(root);
  console.log(`  TOTAL: ${fmtBytes(totalSize)}`);
  console.log(`\n  row counts:`);
  for (const [file, count] of Object.entries(dbCounts)) {
    console.log(`    ${file}: ${count}`);
  }
  console.log(`\n[snapshot] done — ${root}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[snapshot] FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
