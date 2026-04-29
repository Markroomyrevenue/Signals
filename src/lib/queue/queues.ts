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
 * Daily peer-fluctuation push queue. Schedules one job per tenant at
 * 06:30 Europe/London (5 minutes after the legacy 06:00 comparison-agent
 * job, so source-listing CalendarRates have just been refreshed).
 */
export const PEER_FLUCTUATION_PUSH_QUEUE_NAME = "peer-fluctuation-push";

export const peerFluctuationPushQueue = new Queue(PEER_FLUCTUATION_PUSH_QUEUE_NAME, {
  connection: redisConnectionOptions(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
    // Bumped attempts to 2 — partial failures are recorded in
    // HostawayPushEvent regardless, so a single retry is enough; we don't
    // want repeated retries thumping Hostaway's rate limit.
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 5000
    }
  }
});

/** Schedule the daily run for one tenant. Idempotent — calling twice with
 *  the same tenantId replaces the prior repeat schedule. */
export async function schedulePeerFluctuationDailyRun(args: { tenantId: string }): Promise<void> {
  await peerFluctuationPushQueue.add(
    `peer-fluctuation-daily-${args.tenantId}`,
    { tenantId: args.tenantId, kind: "scheduled" },
    {
      // 06:30 every day, Europe/London. BullMQ uses standard cron in UTC by
      // default; we accept a 1h DST drift here — for the daily push a
      // 30-minute window either side is operationally indistinguishable.
      // To pin precisely to local time, set `tz: 'Europe/London'`.
      repeat: { pattern: "30 6 * * *", tz: "Europe/London" },
      jobId: `peer-fluctuation-daily-${args.tenantId}`
    }
  );
}
