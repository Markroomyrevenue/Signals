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

/**
 * Signals rate-scan queue. Two repeatable read-only jobs per tenant
 * (07:00 + 12:00 Europe/London) that snapshot live Hostaway calendar
 * rates and diff them against the scanner's own RateState table. This
 * queue is fully isolated from the sync + rate-copy queues — it never
 * writes to any shared table (see SIGNALS-RATE-SCAN-SPEC.md §2.1).
 *
 * Attempts capped at 2 with exponential backoff, matching the rate-copy
 * queue; a partial scan still records whatever it managed to read.
 */
export const RATE_SCAN_QUEUE_NAME = "rate-scan";

export const rateScanQueue = new Queue(RATE_SCAN_QUEUE_NAME, {
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
 * Schedules the 07:00 Europe/London rate scan for the tenant. Job kind
 * `"scheduled"` triggers `scanTenant`.
 */
export async function scheduleRateScanMorning(args: { tenantId: string }): Promise<void> {
  await rateScanQueue.add(
    `rate-scan-morning-${args.tenantId}`,
    { tenantId: args.tenantId, kind: "scheduled" },
    {
      repeat: { pattern: "0 7 * * *", tz: "Europe/London" },
      jobId: `rate-scan-morning-${args.tenantId}`
    }
  );
}

/**
 * Idempotent: same `jobId` replaces the prior schedule.
 *
 * Schedules the 12:00 Europe/London rate scan for the tenant. Job kind
 * `"scheduled"` triggers `scanTenant`.
 */
export async function scheduleRateScanMidday(args: { tenantId: string }): Promise<void> {
  await rateScanQueue.add(
    `rate-scan-midday-${args.tenantId}`,
    { tenantId: args.tenantId, kind: "scheduled" },
    {
      repeat: { pattern: "0 12 * * *", tz: "Europe/London" },
      jobId: `rate-scan-midday-${args.tenantId}`
    }
  );
}
