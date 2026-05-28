/**
 * KeyData trial: BullMQ worker for the daily pricing-comparison agent
 * (and the defensibility-audit follow-up). Independent of the sync worker.
 *
 * Run with: `tsx src/workers/pricing-comparison-worker.ts`
 *
 * Schedules a 06:00 Europe/London repeatable job on startup. The job runs
 * the comparison + audit pipelines for every trial tenant, renders the
 * HTML report, writes it to /trial-reports/, and emails it via Resend.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { Worker, type Job } from "bullmq";
import { redisConnectionOptions } from "@/lib/queue/connection";
import {
  PRICING_COMPARISON_JOB_NAMES,
  PRICING_COMPARISON_QUEUE_NAME,
  pricingComparisonQueue,
  type PricingComparisonDailyRunPayload,
  type Day14SummaryPayload,
  type SnapshotTrialFinalPayload
} from "@/lib/queue/pricing-comparison-queue";
import { runDailyTrialPipeline } from "@/lib/agents/pricing-comparison/pipeline";
import { sendDay14Summary } from "@/lib/agents/pricing-comparison/day14-runner";

/**
 * Spawn snapshot-trial-final.ts as a detached child. Non-blocking so
 * the BullMQ worker isn't held while the dump runs (1-2 minutes on
 * the trial dataset). The script is idempotent — date-stamped
 * directory under cache/trial-final-{YYYY-MM-DD}/ so re-runs the
 * same day overwrite.
 */
function spawnSnapshotTrialFinal(reason: string): { pid: number | null } {
  const worktreeRoot = path.resolve(__dirname, "../..");
  const child = spawn("npx", ["tsx", "scripts/snapshot-trial-final.ts"], {
    cwd: worktreeRoot,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  console.log(`[snapshot-trial-final] spawned pid=${child.pid} reason=${reason}`);
  return { pid: child.pid ?? null };
}

async function processJob(job: Job): Promise<unknown> {
  switch (job.name) {
    case PRICING_COMPARISON_JOB_NAMES.DAILY_RUN: {
      const payload = job.data as PricingComparisonDailyRunPayload;
      return runDailyTrialPipeline({ snapshotDate: payload.snapshotDate, reason: payload.reason ?? "scheduled" });
    }
    case PRICING_COMPARISON_JOB_NAMES.DAY14_SUMMARY: {
      const payload = job.data as Day14SummaryPayload;
      return sendDay14Summary({ reportDate: payload.reportDate, reason: payload.reason ?? "scheduled-day14" });
    }
    case PRICING_COMPARISON_JOB_NAMES.SNAPSHOT_TRIAL_FINAL: {
      const payload = job.data as SnapshotTrialFinalPayload;
      return spawnSnapshotTrialFinal(payload.reason ?? "scheduled-0700-london");
    }
    default:
      throw new Error(`pricing-comparison-worker: unknown job name "${job.name}"`);
  }
}

async function ensureSchedule(): Promise<void> {
  const queue = pricingComparisonQueue();
  // Daily 06:00 Europe/London. cron: "0 6 * * *" with explicit timezone.
  await queue.upsertJobScheduler(
    "comparison-daily-0600-london",
    { pattern: "0 6 * * *", tz: "Europe/London" },
    {
      name: PRICING_COMPARISON_JOB_NAMES.DAILY_RUN,
      data: { reason: "scheduled-0600-london" } satisfies PricingComparisonDailyRunPayload,
      opts: { removeOnComplete: 30, removeOnFail: 60 }
    }
  );
  console.log("[pricing-comparison-worker] scheduler registered for 06:00 Europe/London daily");

  // Daily 07:00 Europe/London — snapshot-trial-final (2026-05-28
  // trial-pause work). One hour after the comparison job so the
  // snapshot captures the latest run's rows.
  await queue.upsertJobScheduler(
    "snapshot-trial-final-0700-london",
    { pattern: "0 7 * * *", tz: "Europe/London" },
    {
      name: PRICING_COMPARISON_JOB_NAMES.SNAPSHOT_TRIAL_FINAL,
      data: { reason: "scheduled-0700-london" } satisfies SnapshotTrialFinalPayload,
      opts: { removeOnComplete: 30, removeOnFail: 60 }
    }
  );
  console.log("[pricing-comparison-worker] snapshot-trial-final scheduler registered for 07:00 Europe/London daily");

  // Day-14 one-shot. Fires at 09:00 Europe/London on the trial end date so it
  // runs AFTER that morning's daily report. We use upsertJobScheduler with a
  // one-shot cron (date-anchored pattern is not supported, so we use a
  // delayed `add` with a stable jobId — re-runs are idempotent).
  const trialEnd = process.env.KEYDATA_TRIAL_END ?? "2026-06-01";
  const fireAt = new Date(`${trialEnd}T09:00:00+01:00`).getTime(); // BST in summer
  const now = Date.now();
  const delay = Math.max(0, fireAt - now);
  // jobId is deterministic by date so repeated worker boots don't duplicate.
  const day14JobId = `day14-summary-${trialEnd}`;
  await queue.add(
    PRICING_COMPARISON_JOB_NAMES.DAY14_SUMMARY,
    { reportDate: trialEnd, reason: "scheduled-day14" } satisfies Day14SummaryPayload,
    { jobId: day14JobId, delay, removeOnComplete: 5, removeOnFail: 10 }
  );
  if (delay === 0) {
    console.log(`[pricing-comparison-worker] day14 summary jobId=${day14JobId} scheduled IMMEDIATELY (trial end ${trialEnd} is in the past — will fire on next poll)`);
  } else {
    const hours = (delay / 3600000).toFixed(1);
    console.log(`[pricing-comparison-worker] day14 summary jobId=${day14JobId} scheduled for ${trialEnd} 09:00 London (${hours}h from now)`);
  }
}

export async function startWorker(): Promise<Worker> {
  const worker = new Worker(PRICING_COMPARISON_QUEUE_NAME, processJob, {
    connection: redisConnectionOptions(),
    concurrency: 1 // serialise — one trial run at a time
  });
  worker.on("completed", (job) => console.log(`[pricing-comparison] completed job ${job.id} (${job.name})`));
  worker.on("failed", (job, err) => console.error(`[pricing-comparison] failed job ${job?.id} (${job?.name})`, err));
  process.on("SIGTERM", async () => {
    await worker.close();
    process.exit(0);
  });
  await ensureSchedule();
  return worker;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startWorker()
    .then(() => console.log(`[pricing-comparison-worker] started on queue ${PRICING_COMPARISON_QUEUE_NAME}`))
    .catch((err) => {
      console.error("[pricing-comparison-worker] failed to start", err);
      process.exit(1);
    });
}
