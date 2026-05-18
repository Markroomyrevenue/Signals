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
import { Worker, type Job } from "bullmq";
import { redisConnectionOptions } from "@/lib/queue/connection";
import {
  PRICING_COMPARISON_JOB_NAMES,
  PRICING_COMPARISON_QUEUE_NAME,
  pricingComparisonQueue,
  type PricingComparisonDailyRunPayload,
  type Day14SummaryPayload
} from "@/lib/queue/pricing-comparison-queue";
import { runDailyTrialPipeline } from "@/lib/agents/pricing-comparison/pipeline";
import { sendDay14Summary } from "@/lib/agents/pricing-comparison/day14-runner";

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
