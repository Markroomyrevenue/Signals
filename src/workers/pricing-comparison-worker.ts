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
  type PricingComparisonDailyRunPayload
} from "@/lib/queue/pricing-comparison-queue";
import { runDailyTrialPipeline } from "@/lib/agents/pricing-comparison/pipeline";

async function processJob(job: Job): Promise<unknown> {
  switch (job.name) {
    case PRICING_COMPARISON_JOB_NAMES.DAILY_RUN: {
      const payload = job.data as PricingComparisonDailyRunPayload;
      return runDailyTrialPipeline({ snapshotDate: payload.snapshotDate, reason: payload.reason ?? "scheduled" });
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
