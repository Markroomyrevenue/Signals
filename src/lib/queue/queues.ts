import { Queue } from "bullmq";

import { redisConnectionOptions } from "@/lib/queue/connection";

export const SYNC_QUEUE_NAME = "hostaway-sync";

export const syncQueue = new Queue(SYNC_QUEUE_NAME, {
  connection: redisConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000
    }
  }
});

/**
 * Daily rate-copy push queue. One job per tenant fires at 06:30
 * Europe/London (5 minutes after the standard 06:00 calendar refresh so
 * source listings have just-synced rates). Independent of the sync
 * queue — attempts capped at 2 because partial failures are recorded
 * in HostawayPushEvent regardless.
 */
export const RATE_COPY_PUSH_QUEUE_NAME = "rate-copy-push";

export const rateCopyPushQueue = new Queue(RATE_COPY_PUSH_QUEUE_NAME, {
  connection: redisConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 2,
    backoff: { type: "exponential", delay: 5000 }
  }
});

/** Idempotent: same `jobId` replaces the prior schedule. */
export async function scheduleRateCopyDailyRun(args: { tenantId: string }): Promise<void> {
  await rateCopyPushQueue.add(
    `rate-copy-daily-${args.tenantId}`,
    { tenantId: args.tenantId, kind: "scheduled" },
    {
      repeat: { pattern: "30 6 * * *", tz: "Europe/London" },
      jobId: `rate-copy-daily-${args.tenantId}`
    }
  );
}
