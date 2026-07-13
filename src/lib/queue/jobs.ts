import { Job } from "bullmq";

import { enqueueTenantSync } from "@/lib/queue/enqueue";
import {
  CalendarSyncJobPayload,
  PaceSnapshotJobPayload,
  SYNC_JOB_NAMES,
  TenantSyncJobPayload
} from "@/lib/queue/job-names";
import { prisma } from "@/lib/prisma";
import { runCalendarSyncForListing, runTenantSync } from "@/lib/sync/engine";
import { runPaceSnapshotForTenant } from "@/lib/sync/pace";

/**
 * Daily fan-out: enqueue a core delta sync for every non-Hostaway tenant.
 * Run-time enumeration means tenants created after worker boot are
 * included and deleted tenants simply stop appearing — no per-tenant
 * repeatable to reconcile.
 */
async function runPmsDailySyncFanOut(): Promise<{ enqueued: number }> {
  const tenants = await prisma.tenant.findMany({
    where: { pmsType: { not: "HOSTAWAY" } },
    select: { id: true, name: true, pmsType: true }
  });
  for (const tenant of tenants) {
    await enqueueTenantSync({
      tenantId: tenant.id,
      reason: "scheduled_daily",
      syncMode: "core",
      queueExtendedAfter: true
    });
  }
  console.log(
    `[pms-daily-sync] enqueued daily delta sync for ${tenants.length} non-Hostaway tenant(s): ` +
      tenants.map((t) => `${t.name} (${t.pmsType})`).join(", ")
  );
  return { enqueued: tenants.length };
}

export async function processSyncJob(job: Job): Promise<unknown> {
  switch (job.name) {
    case SYNC_JOB_NAMES.TENANT_SYNC:
      return runTenantSync(job.data as TenantSyncJobPayload);
    case SYNC_JOB_NAMES.PMS_DAILY_SYNC:
      return runPmsDailySyncFanOut();
    case SYNC_JOB_NAMES.CALENDAR_SYNC_LISTING:
      return runCalendarSyncForListing(job.data as CalendarSyncJobPayload);
    case SYNC_JOB_NAMES.PACE_SNAPSHOT: {
      const payload = job.data as PaceSnapshotJobPayload;
      await runPaceSnapshotForTenant(
        payload.tenantId,
        payload.snapshotDate ? new Date(payload.snapshotDate) : new Date(),
        payload.backfillDays ?? 0
      );
      return { ok: true };
    }
    default:
      throw new Error(`Unknown sync job: ${job.name}`);
  }
}
