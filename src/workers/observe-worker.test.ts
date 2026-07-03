import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  observeLearnQueue,
  rateCopyPushQueue,
  rateScanQueue,
  scheduleObserveDailyRun,
  scheduleObserveWeeklySettle,
  syncQueue
} from "@/lib/queue/queues";
import {
  ensureObserveSchedules,
  reconcileObserveSchedules,
  removeObserveSchedulesForTenant
} from "@/workers/observe-worker";

const DAILY_CRON = "30 5 * * *";
const SETTLE_CRON = "0 6 * * 1";
const RECONCILE_CRON = "15 5 * * *";
const TZ = "Europe/London";

type RepeatAddOpts = { repeat?: { pattern?: string; tz?: string }; jobId?: string };
type AddCall = { name: string; data: unknown; opts: RepeatAddOpts };
type StoredRepeatable = { key: string; name: string; pattern: string; tz: string };

// In-memory model of BullMQ's repeatable store, keyed (as BullMQ does) by
// name + pattern + tz — so a changed pattern is a NEW entry, which is exactly
// the stale-job hazard ensureObserveSchedules must prune.
let store: Map<string, StoredRepeatable>;
let addCalls: AddCall[];

function keyOf(name: string, pattern: string, tz: string): string {
  return `${name}::${pattern}::${tz}`;
}

function seedRepeatable(name: string, pattern: string, tz: string = TZ): void {
  store.set(keyOf(name, pattern, tz), { key: keyOf(name, pattern, tz), name, pattern, tz });
}

const realAdd = observeLearnQueue.add;
const realGetRepeatableJobs = observeLearnQueue.getRepeatableJobs;
const realRemoveRepeatableByKey = observeLearnQueue.removeRepeatableByKey;
const realFindMany = prisma.tenant.findMany;

// Swallow connection 'error' events so an absent/flaky Redis can't crash the
// test — every queue method the code under test calls is stubbed below.
observeLearnQueue.on("error", () => {});

beforeEach(() => {
  store = new Map();
  addCalls = [];

  observeLearnQueue.add = (async (name: string, data: unknown, opts: RepeatAddOpts) => {
    addCalls.push({ name, data, opts });
    if (opts.repeat?.pattern && opts.repeat.tz) seedRepeatable(name, opts.repeat.pattern, opts.repeat.tz);
    return { id: opts.jobId };
  }) as unknown as typeof observeLearnQueue.add;

  observeLearnQueue.getRepeatableJobs = (async () =>
    Array.from(store.values())) as unknown as typeof observeLearnQueue.getRepeatableJobs;

  observeLearnQueue.removeRepeatableByKey = (async (key: string) =>
    store.delete(key)) as typeof observeLearnQueue.removeRepeatableByKey;

  prisma.tenant.findMany = (async () => [
    { id: "tenant-a" },
    { id: "tenant-b" }
  ]) as unknown as typeof prisma.tenant.findMany;
});

afterEach(() => {
  observeLearnQueue.add = realAdd;
  observeLearnQueue.getRepeatableJobs = realGetRepeatableJobs;
  observeLearnQueue.removeRepeatableByKey = realRemoveRepeatableByKey;
  prisma.tenant.findMany = realFindMany;
});

after(async () => {
  await Promise.allSettled([
    observeLearnQueue.close(),
    syncQueue.close(),
    rateScanQueue.close(),
    rateCopyPushQueue.close()
  ]);
});

test("scheduleObserveDailyRun registers the daily observe at 05:30 Europe/London", async () => {
  await scheduleObserveDailyRun({ tenantId: "t1" });
  assert.equal(addCalls.length, 1);
  const call = addCalls[0];
  assert.equal(call.name, "observe-t1");
  assert.deepEqual(call.data, { tenantId: "t1", kind: "observe" });
  assert.equal(call.opts.repeat?.pattern, DAILY_CRON);
  assert.equal(call.opts.repeat?.tz, TZ);
  assert.equal(call.opts.jobId, "observe-t1");
});

test("scheduleObserveWeeklySettle registers the settle on Monday 06:00 Europe/London", async () => {
  await scheduleObserveWeeklySettle({ tenantId: "t1" });
  assert.equal(addCalls.length, 1);
  const call = addCalls[0];
  assert.equal(call.name, "observe-settle-t1");
  assert.deepEqual(call.data, { tenantId: "t1", kind: "settle" });
  assert.equal(call.opts.repeat?.pattern, SETTLE_CRON);
  assert.equal(call.opts.repeat?.tz, TZ);
  assert.equal(call.opts.jobId, "observe-settle-t1");
});

test("ensureObserveSchedules prunes stale crons and ends with two repeatables per tenant plus the reconcile", async () => {
  // Earlier schedules: a once-daily observe at 06:00 and a settle on Sunday —
  // both keyed distinctly from the desired crons, so all must be pruned.
  seedRepeatable("observe-tenant-a", "0 6 * * *");
  seedRepeatable("observe-settle-tenant-a", "0 6 * * 0");
  assert.equal(store.size, 2);

  await ensureObserveSchedules();

  const entries = Array.from(store.values());
  assert.equal(entries.length, 5); // 2 tenants × (daily + settle) + 1 reconcile

  const signature = entries.map((e) => `${e.name}|${e.pattern}|${e.tz}`).sort();
  assert.deepEqual(
    signature,
    [
      `observe-reconcile|${RECONCILE_CRON}|${TZ}`,
      `observe-settle-tenant-a|${SETTLE_CRON}|${TZ}`,
      `observe-settle-tenant-b|${SETTLE_CRON}|${TZ}`,
      `observe-tenant-a|${DAILY_CRON}|${TZ}`,
      `observe-tenant-b|${DAILY_CRON}|${TZ}`
    ].sort()
  );

  // No stale single-slot cron survives.
  const survivingPatterns = entries.map((e) => e.pattern);
  for (const stale of ["0 6 * * *", "0 6 * * 0"]) {
    assert.ok(!survivingPatterns.includes(stale), `stale cron "${stale}" should have been pruned`);
  }

  assert.equal(addCalls.length, 5); // each tenant got daily + settle, plus the reconcile
});

test("reconcileObserveSchedules enrols a new tenant and prunes a dead one", async () => {
  // Queue state from an earlier boot: tenant-a (still live) fully scheduled,
  // tenant-dead (since deleted) fully scheduled, reconcile present. tenant-b
  // (created after that boot) has no schedules at all.
  seedRepeatable("observe-tenant-a", DAILY_CRON);
  seedRepeatable("observe-settle-tenant-a", SETTLE_CRON);
  seedRepeatable("observe-tenant-dead", DAILY_CRON);
  seedRepeatable("observe-settle-tenant-dead", SETTLE_CRON);
  seedRepeatable("observe-reconcile", RECONCILE_CRON);
  assert.equal(store.size, 5);

  const result = await reconcileObserveSchedules();

  assert.equal(result.tenants, 2);
  assert.equal(result.pruned, 2); // tenant-dead daily + settle
  assert.equal(result.added, 2); // tenant-b daily + settle

  const names = Array.from(store.values()).map((e) => e.name).sort();
  assert.deepEqual(names, [
    "observe-reconcile",
    "observe-settle-tenant-a",
    "observe-settle-tenant-b",
    "observe-tenant-a",
    "observe-tenant-b"
  ]);

  // tenant-a's healthy schedules were left untouched (no churn re-adds).
  const addedNames = addCalls.map((c) => c.name).sort();
  assert.deepEqual(addedNames, ["observe-settle-tenant-b", "observe-tenant-b"]);
});

test("reconcileObserveSchedules replaces a drifted cron and re-adds a missing reconcile", async () => {
  // tenant-a's daily drifted to 06:00 and the reconcile repeatable is absent.
  seedRepeatable("observe-tenant-a", "0 6 * * *");
  seedRepeatable("observe-settle-tenant-a", SETTLE_CRON);
  seedRepeatable("observe-tenant-b", DAILY_CRON);
  seedRepeatable("observe-settle-tenant-b", SETTLE_CRON);

  const result = await reconcileObserveSchedules();

  assert.equal(result.pruned, 1); // the drifted daily
  assert.equal(result.added, 2); // corrected daily for tenant-a + the reconcile itself

  const signature = Array.from(store.values()).map((e) => `${e.name}|${e.pattern}|${e.tz}`).sort();
  assert.deepEqual(
    signature,
    [
      `observe-reconcile|${RECONCILE_CRON}|${TZ}`,
      `observe-settle-tenant-a|${SETTLE_CRON}|${TZ}`,
      `observe-settle-tenant-b|${SETTLE_CRON}|${TZ}`,
      `observe-tenant-a|${DAILY_CRON}|${TZ}`,
      `observe-tenant-b|${DAILY_CRON}|${TZ}`
    ].sort()
  );
});

test("removeObserveSchedulesForTenant prunes exactly that tenant's schedules", async () => {
  seedRepeatable("observe-tenant-dead", DAILY_CRON);
  seedRepeatable("observe-settle-tenant-dead", SETTLE_CRON);
  seedRepeatable("observe-tenant-a", DAILY_CRON);
  seedRepeatable("observe-settle-tenant-a", SETTLE_CRON);
  seedRepeatable("observe-reconcile", RECONCILE_CRON);

  const removed = await removeObserveSchedulesForTenant("tenant-dead");

  assert.equal(removed, 2);
  const names = Array.from(store.values()).map((e) => e.name).sort();
  assert.deepEqual(names, ["observe-reconcile", "observe-settle-tenant-a", "observe-tenant-a"]);
});
