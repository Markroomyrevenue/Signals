import { Worker } from "bullmq";

import { redisConnectionOptions } from "@/lib/queue/connection";
import { processSyncJob } from "@/lib/queue/jobs";
import { ensurePmsDailySyncSchedule, SYNC_QUEUE_NAME } from "@/lib/queue/queues";

const worker = new Worker(SYNC_QUEUE_NAME, processSyncJob, {
  connection: redisConnectionOptions(),
  concurrency: 20
});

// Daily 04:15 London delta sync for non-Hostaway (Guesty/Avantio) tenants —
// pull-only PMSes have no webhooks, so without this their data goes stale.
ensurePmsDailySyncSchedule()
  .then(() => console.log("[sync-worker] registered daily 04:15 London pms-daily-sync repeatable"))
  .catch((error) => console.error("[sync-worker] failed to register pms-daily-sync schedule", error));

worker.on("completed", (job) => {
  console.log(`completed job ${job.id} (${job.name})`);
});

worker.on("failed", (job, error) => {
  console.error(`failed job ${job?.id} (${job?.name})`, error);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});

console.log(`sync worker started on queue ${SYNC_QUEUE_NAME}`);
