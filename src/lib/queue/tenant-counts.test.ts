import assert from "node:assert/strict";
import test from "node:test";

import { countJobsForTenant, getTenantScopedJobCounts } from "./tenant-counts";

function job(tenantId: string | null): { data?: unknown } {
  return tenantId === null ? { data: {} } : { data: { tenantId } };
}

test("countJobsForTenant counts only the caller's tenant", () => {
  const jobs = [job("tenant-a"), job("tenant-b"), job("tenant-a"), job(null), null, undefined];
  assert.equal(countJobsForTenant(jobs, "tenant-a"), 2);
  assert.equal(countJobsForTenant(jobs, "tenant-b"), 1);
  assert.equal(countJobsForTenant(jobs, "tenant-c"), 0);
});

test("getTenantScopedJobCounts never reports another tenant's queue as activity", async () => {
  // The bug this guards: tenant B's queued daily syncs pinned tenant A's
  // "Refresh Sync" button into a disabled "Syncing..." state.
  const byState: Record<string, Array<{ data?: unknown }>> = {
    waiting: [job("tenant-b"), job("tenant-b"), job("tenant-b")],
    paused: [job("tenant-b")],
    active: [job("tenant-b")],
    delayed: [job("tenant-b")]
  };
  const fakeQueue = {
    getJobs: async (types: string[]) => byState[types[0] ?? ""] ?? []
  };

  const forTenantA = await getTenantScopedJobCounts(fakeQueue as never, "tenant-a");
  assert.deepEqual(forTenantA, { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });

  const forTenantB = await getTenantScopedJobCounts(fakeQueue as never, "tenant-b");
  assert.equal(forTenantB.waiting, 4); // waiting + paused
  assert.equal(forTenantB.active, 1);
  assert.equal(forTenantB.delayed, 1);
});
