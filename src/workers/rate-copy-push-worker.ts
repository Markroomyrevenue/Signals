import { Worker, type Job } from "bullmq";

import { redisConnectionOptions } from "@/lib/queue/connection";
import {
  RATE_COPY_PUSH_QUEUE_NAME,
  rateCopyPushQueue,
  scheduleRateCopyDailyRun,
  scheduleRateCopySourceSyncDailyRun
} from "@/lib/queue/queues";
import { executeRateCopyPushForTenant } from "@/lib/pricing/rate-copy-push-service";
import { parsePricingSettingsOverride } from "@/lib/pricing/settings";
import { runCalendarSyncForListing } from "@/lib/sync/engine";
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";

/**
 * `"scheduled"` and `"manual"` both run the rate-copy push for a tenant.
 * `"source-sync"` is the pre-push step that runs 30 min before each
 * scheduled push (hourly, on the hour, Europe/London): for every
 * rate_copy-enabled target in the tenant, pull the source listing's
 * Hostaway calendar (today → today + 365 days) into our CalendarRate
 * table. This guarantees each push uses the latest source rates rather
 * than whatever the standard sync last happened to write.
 */
type ScheduledJob = { tenantId: string; kind: "scheduled" | "manual" | "source-sync" };

/** Push horizon: 365 days forward of today UTC. */
const PUSH_HORIZON_DAYS = 365;

function dateRangeFromTodayPlus(days: number): { dateFrom: string; dateTo: string } {
  const today = new Date();
  const dateFrom = toDateOnly(today);
  const dateTo = toDateOnly(addUtcDays(fromDateOnly(dateFrom), days));
  return { dateFrom, dateTo };
}

/**
 * Returns the set of source listing IDs referenced by every
 * rate_copy-enabled property-scope PricingSetting row in the tenant.
 * Falls through with an empty set when the tenant has no rate-copy
 * configuration — caller no-ops in that case.
 */
async function collectRateCopySourceListingIds(tenantId: string): Promise<Set<string>> {
  const rows = await prisma.pricingSetting.findMany({
    where: { tenantId, scope: "property", scopeRef: { not: null } }
  });
  const sources = new Set<string>();
  for (const row of rows) {
    const parsed = parsePricingSettingsOverride(row.settings);
    if (
      parsed.pricingMode === "rate_copy" &&
      parsed.rateCopyPushEnabled === true &&
      typeof parsed.rateCopySourceListingId === "string" &&
      parsed.rateCopySourceListingId.trim().length > 0
    ) {
      sources.add(parsed.rateCopySourceListingId.trim());
    }
  }
  return sources;
}

async function processSourceSync(tenantId: string): Promise<unknown> {
  console.log(`[rate-copy-source-sync] starting tenant=${tenantId}`);
  const sourceIds = await collectRateCopySourceListingIds(tenantId);
  if (sourceIds.size === 0) {
    console.log(`[rate-copy-source-sync] no rate_copy targets in tenant=${tenantId}, nothing to sync`);
    return { tenantId, sourceCount: 0, upserted: 0 };
  }
  const { dateFrom, dateTo } = dateRangeFromTodayPlus(PUSH_HORIZON_DAYS);
  let totalUpserted = 0;
  let failed = 0;
  for (const sourceListingId of sourceIds) {
    try {
      const result = await runCalendarSyncForListing({
        tenantId,
        listingId: sourceListingId,
        dateFrom,
        dateTo
      });
      totalUpserted += result.upserted;
      console.log(
        `[rate-copy-source-sync] synced source listingId=${sourceListingId} tenant=${tenantId} upserted=${result.upserted}`
      );
    } catch (error) {
      failed += 1;
      // Continue with the other sources — partial freshness is
      // strictly better than aborting the whole job and falling back
      // to yesterday's data for every source.
      console.error(
        `[rate-copy-source-sync] failed source listingId=${sourceListingId} tenant=${tenantId}`,
        error instanceof Error ? error.message : error
      );
    }
  }
  console.log(
    `[rate-copy-source-sync] done tenant=${tenantId} sources=${sourceIds.size} upserted=${totalUpserted} failed=${failed}`
  );
  return { tenantId, sourceCount: sourceIds.size, upserted: totalUpserted, failed };
}

async function processPush(tenantId: string, kind: "scheduled" | "manual"): Promise<unknown> {
  console.log(`[rate-copy-push] starting tenant=${tenantId} kind=${kind}`);
  const { dateFrom, dateTo } = dateRangeFromTodayPlus(PUSH_HORIZON_DAYS);
  const summaries = await executeRateCopyPushForTenant({
    tenantId,
    pushedBy: "rate-copy-worker",
    triggerSource: kind === "manual" ? "manual" : "scheduled",
    dateFrom,
    dateTo,
    // Hourly scheduled cycles push only changed dates; a manual "push now"
    // re-asserts the full calendar. (Fix 3.)
    deltaOnly: kind === "scheduled"
  });
  const success = summaries.filter((s) => s.status === "success").length;
  const failed = summaries.filter((s) => s.status === "failed").length;
  const skipped = summaries.filter((s) => s.status === "skipped").length;
  const blocked = summaries.filter((s) => s.status === "blocked-allowlist").length;
  // Per-cycle structured backpressure log (Fix 3): listings considered, dates
  // considered, dates changed/pushed, dates accepted, deferred by cap, errors.
  const listingsConsidered = summaries.length;
  const datesConsidered = summaries.reduce((n, s) => n + (s.consideredCount ?? s.dateCount), 0);
  const datesPushed = summaries.reduce((n, s) => n + s.dateCount, 0);
  const datesAccepted = summaries.reduce((n, s) => n + s.pushedCount, 0);
  const deferred = summaries.reduce((n, s) => n + (s.deferredCount ?? 0), 0);
  console.log(
    `[rate-copy-push] cycle tenant=${tenantId} kind=${kind} dateFrom=${dateFrom} dateTo=${dateTo} ` +
      `listings=${listingsConsidered} datesConsidered=${datesConsidered} datesChanged=${datesPushed} ` +
      `datesAccepted=${datesAccepted} deferred=${deferred} ` +
      `success=${success} failed=${failed} skipped=${skipped} blocked-allowlist=${blocked}`
  );
  return { tenantId, summaries };
}

async function processJob(job: Job<ScheduledJob>): Promise<unknown> {
  const { tenantId, kind } = job.data;
  if (!tenantId) throw new Error("rate-copy-push: missing tenantId");
  if (kind === "source-sync") {
    return processSourceSync(tenantId);
  }
  return processPush(tenantId, kind === "manual" ? "manual" : "scheduled");
}

export async function ensureSchedulesForActiveTenants(): Promise<void> {
  // Schedule one hourly source-sync (every hour :00) + one hourly push
  // (every hour :30) repeatable job per tenant, all Europe/London (Fix 3).
  // Adding/removing tenants is picked up on the next worker boot.
  //
  // Remove any rate-copy repeatable whose cron is not the current desired
  // one first, so changing the schedule doesn't leave the old 10:00/10:30
  // (or the earlier 06:30) jobs firing in parallel. BullMQ keys
  // repeatables by name + pattern + tz, so a changed pattern is a NEW job
  // unless the old one is explicitly removed. The only repeatables on this
  // queue are these two rate-copy jobs, so pruning everything and re-adding
  // the desired two is safe, idempotent, and leaves the queue in a
  // known-good state on every boot.
  const existing = await rateCopyPushQueue.getRepeatableJobs();
  for (const r of existing) {
    await rateCopyPushQueue.removeRepeatableByKey(r.key);
  }

  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const t of tenants) {
    await scheduleRateCopySourceSyncDailyRun({ tenantId: t.id });
    await scheduleRateCopyDailyRun({ tenantId: t.id });
  }
  console.log(
    `[rate-copy-push] registered HOURLY source-sync (:00) + push (:30, delta-only) ` +
      `Europe/London for ${tenants.length} tenants ` +
      `(pruned ${existing.length} stale repeatable(s) first)`
  );
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
