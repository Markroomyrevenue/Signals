// src/lib/queue/enqueue.ts
import { Job } from "bullmq";
import { CalendarSyncJobPayload, PaceSnapshotJobPayload, SYNC_JOB_NAMES, TenantSyncJobPayload } from "@/lib/queue/job-names";
import { syncQueue } from "@/lib/queue/queues";

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function enqueueTenantSync(payload: TenantSyncJobPayload): Promise<Job> {
  const reason = safeId(payload.reason ?? "manual");
  const tenantId = safeId(payload.tenantId);
  return syncQueue.add(SYNC_JOB_NAMES.TENANT_SYNC, payload, {
    jobId: `tenant-sync_${tenantId}_${reason}_${Date.now()}`
  });
}

export async function enqueueCalendarSyncJobs(payload: { tenantId: string; listingIds: string[]; dateFrom: string; dateTo: string; }): Promise<number> {
  if (payload.listingIds.length === 0) return 0;
  const tenantId = safeId(payload.tenantId);
  const dateFrom = safeId(payload.dateFrom);
  const dateTo = safeId(payload.dateTo);

  const jobs = payload.listingIds.map((listingId) => {
    const safeListing = safeId(listingId);
    return {
      name: SYNC_JOB_NAMES.CALENDAR_SYNC_LISTING,
      data: { tenantId: payload.tenantId, listingId, dateFrom: payload.dateFrom, dateTo: payload.dateTo } as CalendarSyncJobPayload,
      opts: { jobId: `calendar-sync_${tenantId}_${safeListing}_${dateFrom}_${dateTo}` }
    };
  });

  await syncQueue.addBulk(jobs);
  return jobs.length;
}

export async function enqueuePaceSnapshot(payload: PaceSnapshotJobPayload): Promise<Job> {
  const tenantId = safeId(payload.tenantId);
  const snap = safeId(payload.snapshotDate ?? "latest");
  const backfill = String(payload.backfillDays ?? 0);
  return syncQueue.add(SYNC_JOB_NAMES.PACE_SNAPSHOT, payload, {
    jobId: `pace-snapshot_${tenantId}_${snap}_${backfill}`
  });
}