import { Job } from "bullmq";

import {
  CalendarSyncJobPayload,
  PaceSnapshotJobPayload,
  SYNC_JOB_NAMES,
  TenantSyncJobPayload
} from "@/lib/queue/job-names";
import { runCalendarSyncForListing, runTenantSync } from "@/lib/sync/engine";
import { runPaceSnapshotForTenant } from "@/lib/sync/pace";

export async function processSyncJob(job: Job): Promise<unknown> {
  switch (job.name) {
    case SYNC_JOB_NAMES.TENANT_SYNC:
      return runTenantSync(job.data as TenantSyncJobPayload);
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
