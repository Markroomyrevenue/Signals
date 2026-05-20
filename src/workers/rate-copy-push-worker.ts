import { Worker, type Job } from "bullmq";

import { redisConnectionOptions } from "@/lib/queue/connection";
import { RATE_COPY_PUSH_QUEUE_NAME, rateCopyPushQueue, scheduleRateCopyDailyRun } from "@/lib/queue/queues";
import { executeRateCopyPushForTenant } from "@/lib/pricing/rate-copy-push-service";
import { prisma } from "@/lib/prisma";

type ScheduledJob = { tenantId: string; kind: "scheduled" | "manual" };

async function processJob(job: Job<ScheduledJob>): Promise<unknown> {
  const { tenantId, kind } = job.data;
  if (!tenantId) throw new Error("rate-copy-push: missing tenantId");
  console.log(`[rate-copy-push] starting tenant=${tenantId} kind=${kind ?? "scheduled"}`);
  const summaries = await executeRateCopyPushForTenant({
    tenantId,
    pushedBy: "rate-copy-worker",
    triggerSource: kind === "manual" ? "manual" : "scheduled"
  });
  const success = summaries.filter((s) => s.status === "success").length;
  const failed = summaries.filter((s) => s.status === "failed").length;
  const skipped = summaries.filter((s) => s.status === "skipped").length;
  console.log(
    `[rate-copy-push] done tenant=${tenantId} success=${success} failed=${failed} skipped=${skipped}`
  );
  return { tenantId, summaries };
}

async function ensureSchedulesForActiveTenants(): Promise<void> {
  // Schedule one repeatable job per tenant. Adding/removing tenants will be
  // picked up on the next worker boot — re-running this function is
  // idempotent (the jobId stays stable per tenant).
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const t of tenants) {
    await scheduleRateCopyDailyRun({ tenantId: t.id });
  }
  console.log(`[rate-copy-push] registered daily 06:30 Europe/London schedule for ${tenants.length} tenants`);
}

export async function startWorker(): Promise<Worker<ScheduledJob>> {
  const worker = new Worker<ScheduledJob>(RATE_COPY_PUSH_QUEUE_NAME, processJob, {
    connection: redisConnectionOptions(),
    concurrency: 1 // serialise — one tenant at a time so logs stay readable
  });
  worker.on("completed", (job) => console.log(`[rate-copy-push] completed job ${job.id}`));
  worker.on("failed", (job, err) =>
    console.error(`[rate-copy-push] failed job ${job?.id}`, err instanceof Error ? err.message : err)
  );
  process.on("SIGTERM", async () => {
    await worker.close();
    await rateCopyPushQueue.close();
    process.exit(0);
  });
  await ensureSchedulesForActiveTenants();
  return worker;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startWorker()
    .then(() => console.log(`[rate-copy-push] worker started on queue ${RATE_COPY_PUSH_QUEUE_NAME}`))
    .catch((err) => {
      console.error("[rate-copy-push] failed to start", err);
      process.exit(1);
    });
}
