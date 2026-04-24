import { Worker } from "bullmq";

import { redisConnectionOptions } from "@/lib/queue/connection";
import { processSyncJob } from "@/lib/queue/jobs";
import { SYNC_QUEUE_NAME } from "@/lib/queue/queues";

const worker = new Worker(SYNC_QUEUE_NAME, processSyncJob, {
  connection: redisConnectionOptions(),
  concurrency: 20
});

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
