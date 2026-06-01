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
 * Daily rate-copy queue. Two repeatable jobs per tenant:
 *   - 10:00 Europe/London: source-sync. Re-fetches source listings'
 *     Hostaway calendar rates into CalendarRate so the push 30 min
 *     later uses fresh data. Hostaway updates source-listing prices
 *     dynamically through the day, so anchoring on yesterday's data
 *     produces noticeably stale derived rates.
 *   - 10:30 Europe/London: push. Reads CalendarRate, applies our
 *     occupancy multiplier + overrides, pushes 365 days of derived
 *     rate + min-stay to every rate_copy-enabled target listing in
 *     the tenant.
 *
 * Independent of the sync queue — attempts capped at 2 because partial
 * failures are recorded in HostawayPushEvent regardless. Schedule
 * moved from 06:30 → 10:00/10:30 on 2026-06-01 at owner request to
 * match the dynamic-pricing rhythm of the Hostaway source listings.
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

/**
 * Idempotent: same `jobId` replaces the prior schedule.
 *
 * Schedules the daily 10:30 Europe/London rate-copy push for the
 * tenant. Job kind `"scheduled"` triggers `executeRateCopyPushForTenant`
 * over a 365-day horizon.
 */
export async function scheduleRateCopyDailyRun(args: { tenantId: string }): Promise<void> {
  await rateCopyPushQueue.add(
    `rate-copy-daily-${args.tenantId}`,
    { tenantId: args.tenantId, kind: "scheduled" },
    {
      repeat: { pattern: "30 10 * * *", tz: "Europe/London" },
      jobId: `rate-copy-daily-${args.tenantId}`
    }
  );
}

/**
 * Idempotent: same `jobId` replaces the prior schedule.
 *
 * Schedules the daily 10:00 Europe/London source-listing calendar sync
 * for the tenant. Job kind `"source-sync"` triggers a per-source-listing
 * Hostaway calendar pull (today → today + 365 days) so the 10:30 push
 * has fresh data to derive from.
 */
export async function scheduleRateCopySourceSyncDailyRun(args: { tenantId: string }): Promise<void> {
  await rateCopyPushQueue.add(
    `rate-copy-source-sync-daily-${args.tenantId}`,
    { tenantId: args.tenantId, kind: "source-sync" },
    {
      repeat: { pattern: "0 10 * * *", tz: "Europe/London" },
      jobId: `rate-copy-source-sync-daily-${args.tenantId}`
    }
  );
}
