/**
 * Tenant-scoped sync-queue counts.
 *
 * The sync queue is shared by every tenant, but the dashboard's
 * "Syncing..." state must reflect only the CALLER's tenant — otherwise
 * one tenant's queued daily syncs pin every other tenant's Refresh Sync
 * button in a disabled "Syncing..." state (observed 2026-07-15).
 *
 * BullMQ has no per-tenant counts, so we page the relevant states and
 * count jobs whose payload carries the tenantId. States are capped at
 * MAX_JOBS_PER_STATE — if a state somehow exceeds the cap the count is
 * a floor, which only ever keeps "Syncing..." visible a little longer
 * for tenants that genuinely have queued work.
 */
import type { Queue } from "bullmq";

export const MAX_JOBS_PER_STATE = 200;

export type TenantQueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
};

export function countJobsForTenant(
  jobs: Array<{ data?: unknown } | null | undefined>,
  tenantId: string
): number {
  let count = 0;
  for (const job of jobs) {
    const data = job?.data as { tenantId?: unknown } | undefined;
    if (data && typeof data.tenantId === "string" && data.tenantId === tenantId) {
      count += 1;
    }
  }
  return count;
}

export async function getTenantScopedJobCounts(
  queue: Pick<Queue, "getJobs">,
  tenantId: string
): Promise<TenantQueueCounts> {
  const [waiting, paused, active, delayed] = await Promise.all([
    queue.getJobs(["waiting"], 0, MAX_JOBS_PER_STATE - 1),
    queue.getJobs(["paused"], 0, MAX_JOBS_PER_STATE - 1),
    queue.getJobs(["active"], 0, MAX_JOBS_PER_STATE - 1),
    queue.getJobs(["delayed"], 0, MAX_JOBS_PER_STATE - 1)
  ]);
  return {
    // Paused jobs are waiting jobs on a paused queue — same bucket as far
    // as "is a sync pending for this tenant" is concerned.
    waiting: countJobsForTenant(waiting, tenantId) + countJobsForTenant(paused, tenantId),
    active: countJobsForTenant(active, tenantId),
    // Completed/failed history is irrelevant to the pending-work signal
    // the dashboard consumes; reporting zeros keeps the response shape.
    completed: 0,
    failed: 0,
    delayed: countJobsForTenant(delayed, tenantId)
  };
}
