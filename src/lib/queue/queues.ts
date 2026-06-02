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
 * Rate-copy queue. Two repeatable jobs per tenant, each firing 5× a day
 * (all Europe/London):
 *   - source-sync at 06:00, 10:00, 14:00, 18:00, 22:00. Re-fetches source
 *     listings' Hostaway calendar rates into CalendarRate so the push 30
 *     min later uses fresh data. Hostaway updates source-listing prices
 *     dynamically through the day, so anchoring on a once-a-day pull
 *     produces noticeably stale derived rates.
 *   - push at 06:30, 10:30, 14:30, 18:30, 22:30. Reads CalendarRate,
 *     applies our occupancy multiplier + overrides, pushes 365 days of
 *     derived rate + min-stay to every rate_copy-enabled target listing
 *     in the tenant.
 *
 * Independent of the sync queue — attempts capped at 2 because partial
 * failures are recorded in HostawayPushEvent regardless.
 *
 * Schedule history: 06:30 → 10:00/10:30 (once a day) on 2026-06-01, then
 * to 5×/day on 2026-06-02 so live target listings are never more than
 * ~4h staler than the PriceLabs-driven source (a once-a-day push let a
 * mid-day source move sit un-mirrored for ~24h). Each kind is ONE
 * repeatable job firing on a 5-slot cron — not five separate jobs.
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
 * Idempotent re-add, BUT: BullMQ keys a repeatable by name + pattern +
 * tz, so re-adding with the SAME `jobId` but a CHANGED `pattern` does
 * NOT replace the old repeatable — it adds a second one and leaves the
 * old cron firing in parallel. `ensureSchedulesForActiveTenants` prunes
 * every existing rate-copy repeatable before calling this, for exactly
 * that reason. Don't rely on jobId alone to swap a schedule.
 *
 * Schedules the rate-copy push for the tenant at 06:30, 10:30, 14:30,
 * 18:30, 22:30 Europe/London. Job kind `"scheduled"` triggers
 * `executeRateCopyPushForTenant` over a 365-day horizon.
 */
export async function scheduleRateCopyDailyRun(args: { tenantId: string }): Promise<void> {
  await rateCopyPushQueue.add(
    `rate-copy-daily-${args.tenantId}`,
    { tenantId: args.tenantId, kind: "scheduled" },
    {
      repeat: { pattern: "30 6,10,14,18,22 * * *", tz: "Europe/London" },
      jobId: `rate-copy-daily-${args.tenantId}`
    }
  );
}

/**
 * Idempotent re-add — see the BullMQ-keying caveat on
 * `scheduleRateCopyDailyRun` (a changed pattern is a NEW repeatable, so
 * stale ones must be pruned before re-registering).
 *
 * Schedules the source-listing calendar sync for the tenant at 06:00,
 * 10:00, 14:00, 18:00, 22:00 Europe/London. Job kind `"source-sync"`
 * triggers a per-source-listing Hostaway calendar pull (today → today +
 * 365 days) so each push 30 min later has fresh data to derive from.
 */
export async function scheduleRateCopySourceSyncDailyRun(args: { tenantId: string }): Promise<void> {
  await rateCopyPushQueue.add(
    `rate-copy-source-sync-daily-${args.tenantId}`,
    { tenantId: args.tenantId, kind: "source-sync" },
    {
      repeat: { pattern: "0 6,10,14,18,22 * * *", tz: "Europe/London" },
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
