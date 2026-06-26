import { Worker, type Job } from "bullmq";

import { redisConnectionOptions } from "@/lib/queue/connection";
import {
  OBSERVE_LEARN_QUEUE_NAME,
  observeLearnQueue,
  scheduleObserveDailyRun,
  scheduleObserveWeeklySettle
} from "@/lib/queue/queues";
import { runObserveForTenant, runWeeklySettleForTenant } from "@/lib/observe/observe-service";
import { prisma } from "@/lib/prisma";

/**
 * Observe-and-learn worker (SIGNALS-OBSERVE-LEARN-SPEC.md §10). Mirrors
 * `rate-copy-push-worker.ts` / `rate-scan-worker.ts`.
 *
 * Read-only with respect to the rest of the tool: every job runs
 * `runObserveForTenant` (engine snapshot + diff + window advance, silent until
 * graduation) or `runWeeklySettleForTenant` (read-only realised-history
 * refresh). Writes go only to the observe tables. `"observe"`/`"settle"` are the
 * repeatable runs; `"manual"` is a one-off for smoke-testing.
 */
type ObserveJob = { tenantId: string; kind: "observe" | "settle" | "manual" };

async function processJob(job: Job<ObserveJob>): Promise<unknown> {
  const { tenantId, kind } = job.data;
  if (!tenantId) throw new Error("observe: missing tenantId");

  if (kind === "settle") {
    console.log(`[observe-settle] starting tenant=${tenantId}`);
    const result = await runWeeklySettleForTenant({ tenantId });
    console.log(`[observe-settle] done tenant=${tenantId} day=${result.window.daysObserved}/30`);
    return result;
  }

  console.log(`[observe] starting tenant=${tenantId} kind=${kind}`);
  const result = await runObserveForTenant({ tenantId, trigger: kind === "manual" ? "manual" : "scheduled" });
  console.log(
    `[observe] done tenant=${tenantId} engine=${result.engine} day=${result.daysObserved}/30 ` +
      `status=${result.status} captured=${result.capture.captured} changes=${result.capture.changes}`
  );
  return result;
}

/**
 * Register one daily-observe + one weekly-settle repeatable per tenant, both
 * Europe/London. Prune every observe repeatable first so a changed cron never
 * leaves a stale duplicate firing (the BullMQ name+pattern+tz keying trap fixed
 * for rate-copy on 2026-06-02). Only these two observe jobs live on this queue,
 * so prune-all-then-re-add is safe and leaves a known-good state on every boot.
 */
export async function ensureObserveSchedules(): Promise<void> {
  const existing = await observeLearnQueue.getRepeatableJobs();
  for (const r of existing) {
    await observeLearnQueue.removeRepeatableByKey(r.key);
  }

  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const t of tenants) {
    await scheduleObserveDailyRun({ tenantId: t.id });
    await scheduleObserveWeeklySettle({ tenantId: t.id });
  }
  console.log(
    `[observe] registered daily (05:30) + weekly settle (Mon 06:00) Europe/London for ${tenants.length} ` +
      `tenants (pruned ${existing.length} stale repeatable(s) first)`
  );
}

export async function startWorker(): Promise<Worker<ObserveJob>> {
  const worker = new Worker<ObserveJob>(OBSERVE_LEARN_QUEUE_NAME, processJob, {
    connection: redisConnectionOptions(),
    concurrency: 1 // serialise — one tenant at a time so logs + engine load stay sane
  });
  worker.on("completed", (job) => console.log(`[observe] completed job ${job.id}`));
  worker.on("failed", (job, err) =>
    console.error(`[observe] failed job ${job?.id}`, err instanceof Error ? err.message : err)
  );
  process.on("SIGTERM", async () => {
    await worker.close();
    await observeLearnQueue.close();
    process.exit(0);
  });
  await ensureObserveSchedules();
  return worker;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startWorker()
    .then(() => console.log(`[observe] worker started on queue ${OBSERVE_LEARN_QUEUE_NAME}`))
    .catch((err) => {
      console.error("[observe] failed to start", err);
      process.exit(1);
    });
}
