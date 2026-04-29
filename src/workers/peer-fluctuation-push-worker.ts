import { Worker } from "bullmq";

import { redisConnectionOptions } from "@/lib/queue/connection";
import { PEER_FLUCTUATION_PUSH_QUEUE_NAME } from "@/lib/queue/queues";
import { pushPeerFluctuationForTenant } from "@/lib/pricing/peer-fluctuation-push-service";

/**
 * Worker for the daily peer-fluctuation push. One job per tenant; each job
 * iterates every fully-configured peer-fluctuation listing in that tenant
 * and (if the gates pass) computes + pushes the [today, today+90] rates.
 *
 * Job payload: `{ tenantId: string; kind: 'scheduled' | 'manual' }`.
 *
 * The push-service writes a HostawayPushEvent row for every outcome
 * (pushed / skipped / failed) so that's where to look for forensics, NOT
 * the worker logs. Worker logs only carry the per-tenant aggregate counts.
 */
type JobPayload = { tenantId: string; kind: "scheduled" | "manual" };

const worker = new Worker<JobPayload>(
  PEER_FLUCTUATION_PUSH_QUEUE_NAME,
  async (job) => {
    const { tenantId, kind } = job.data;
    if (!tenantId) {
      throw new Error("peer-fluctuation-push job missing tenantId");
    }
    const summary = await pushPeerFluctuationForTenant({
      tenantId,
      // System user — picks the daily worker apart from any human admin
      // in HostawayPushEvent.pushedBy. The string is intentionally not a
      // valid user ID; the column is free-text in the schema.
      triggeredBy: "system:peer-fluctuation-worker",
      triggerSource: kind === "manual" ? "manual" : "scheduled"
    });
    console.log(
      `[peer-fluctuation-worker] tenant=${tenantId} pushed=${summary.pushed} skipped=${summary.skipped} failed=${summary.failed}` +
        (summary.errors.length > 0 ? ` errors=${summary.errors.length}` : "")
    );
    return summary;
  },
  {
    connection: redisConnectionOptions(),
    concurrency: 1 // sequential per-tenant; pushing to Hostaway in parallel
    //               would risk hitting their rate limits.
  }
);

worker.on("completed", (job) => {
  console.log(`peer-fluctuation job ${job.id} completed`);
});
worker.on("failed", (job, error) => {
  console.error(`peer-fluctuation job ${job?.id} failed`, error);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});

console.log(`peer-fluctuation-push worker started on queue ${PEER_FLUCTUATION_PUSH_QUEUE_NAME}`);
