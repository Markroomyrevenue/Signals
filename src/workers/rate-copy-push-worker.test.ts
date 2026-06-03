import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  rateCopyPushQueue,
  rateScanQueue,
  scheduleRateCopyDailyRun,
  scheduleRateCopySourceSyncDailyRun,
  syncQueue
} from "@/lib/queue/queues";
import { ensureSchedulesForActiveTenants } from "@/workers/rate-copy-push-worker";

const PUSH_CRON = "30 6,10,14,18,22 * * *";
const SOURCE_SYNC_CRON = "0 6,10,14,18,22 * * *";
const TZ = "Europe/London";

type RepeatAddOpts = { repeat?: { pattern?: string; tz?: string }; jobId?: string };
type AddCall = { name: string; data: unknown; opts: RepeatAddOpts };
type StoredRepeatable = { key: string; name: string; pattern: string; tz: string };

// Minimal in-memory model of BullMQ's repeatable-job store. BullMQ keys a
// repeatable by name + pattern + tz, so we key the same way. The consequence
// — re-adding the same jobId with a DIFFERENT pattern creates a SECOND entry
// rather than replacing the first — is exactly the stale-job hazard
// `ensureSchedulesForActiveTenants` has to prune. Modelling the key this way
// is what lets the end-state test prove the old cron is actually removed and
// not merely shadowed.
let store: Map<string, StoredRepeatable>;
let addCalls: AddCall[];

function keyOf(name: string, pattern: string, tz: string): string {
  return `${name}::${pattern}::${tz}`;
}

function seedRepeatable(name: string, pattern: string, tz: string = TZ): void {
  store.set(keyOf(name, pattern, tz), { key: keyOf(name, pattern, tz), name, pattern, tz });
}

// Real methods, captured once so each test can restore them.
const realAdd = rateCopyPushQueue.add;
const realGetRepeatableJobs = rateCopyPushQueue.getRepeatableJobs;
const realRemoveRepeatableByKey = rateCopyPushQueue.removeRepeatableByKey;
const realFindMany = prisma.tenant.findMany;

// Swallow connection 'error' events so an absent/flaky Redis can't crash the
// test via EventEmitter's unhandled-'error' throw. Every queue method the
// code under test calls is stubbed below, so no real Redis command is issued.
rateCopyPushQueue.on("error", () => {});

beforeEach(() => {
  store = new Map();
  addCalls = [];

  rateCopyPushQueue.add = (async (name: string, data: unknown, opts: RepeatAddOpts) => {
    addCalls.push({ name, data, opts });
    if (opts.repeat?.pattern && opts.repeat.tz) {
      seedRepeatable(name, opts.repeat.pattern, opts.repeat.tz);
    }
    return { id: opts.jobId };
  }) as unknown as typeof rateCopyPushQueue.add;

  rateCopyPushQueue.getRepeatableJobs = (async () =>
    Array.from(store.values())) as unknown as typeof rateCopyPushQueue.getRepeatableJobs;

  rateCopyPushQueue.removeRepeatableByKey = (async (key: string) =>
    store.delete(key)) as typeof rateCopyPushQueue.removeRepeatableByKey;

  prisma.tenant.findMany = (async () => [
    { id: "tenant-a" },
    { id: "tenant-b" }
  ]) as unknown as typeof prisma.tenant.findMany;
});

afterEach(() => {
  rateCopyPushQueue.add = realAdd;
  rateCopyPushQueue.getRepeatableJobs = realGetRepeatableJobs;
  rateCopyPushQueue.removeRepeatableByKey = realRemoveRepeatableByKey;
  prisma.tenant.findMany = realFindMany;
});

after(async () => {
  // Release the Redis handles the three queue constructors opened at import
  // time so `node --test` can exit instead of hanging on open sockets.
  await Promise.allSettled([rateCopyPushQueue.close(), syncQueue.close(), rateScanQueue.close()]);
});

test("scheduleRateCopyDailyRun registers the push at :30 past 06/10/14/18/22, Europe/London", async () => {
  await scheduleRateCopyDailyRun({ tenantId: "t1" });

  assert.equal(addCalls.length, 1);
  const call = addCalls[0];
  assert.equal(call.name, "rate-copy-daily-t1");
  assert.deepEqual(call.data, { tenantId: "t1", kind: "scheduled" });
  assert.equal(call.opts.repeat?.pattern, PUSH_CRON);
  assert.equal(call.opts.repeat?.tz, TZ);
  assert.equal(call.opts.jobId, "rate-copy-daily-t1");
});

test("scheduleRateCopySourceSyncDailyRun registers the source-sync on the hour at 06/10/14/18/22, Europe/London", async () => {
  await scheduleRateCopySourceSyncDailyRun({ tenantId: "t1" });

  assert.equal(addCalls.length, 1);
  const call = addCalls[0];
  assert.equal(call.name, "rate-copy-source-sync-daily-t1");
  assert.deepEqual(call.data, { tenantId: "t1", kind: "source-sync" });
  assert.equal(call.opts.repeat?.pattern, SOURCE_SYNC_CRON);
  assert.equal(call.opts.repeat?.tz, TZ);
  assert.equal(call.opts.jobId, "rate-copy-source-sync-daily-t1");
});

test("ensureSchedulesForActiveTenants prunes stale crons and ends with exactly the two 5-slot repeatables per tenant", async () => {
  // Simulate the queue under earlier schedules: the once-a-day 10:00/10:30
  // jobs AND a leftover 06:30 push from the schedule before that. A changed
  // pattern keys a NEW repeatable, so all three sit here in parallel — every
  // one of them must be gone afterwards.
  seedRepeatable("rate-copy-source-sync-daily-tenant-a", "0 10 * * *");
  seedRepeatable("rate-copy-daily-tenant-a", "30 10 * * *");
  seedRepeatable("rate-copy-daily-tenant-a", "30 6 * * *"); // legacy 06:30 → distinct key
  assert.equal(store.size, 3);

  await ensureSchedulesForActiveTenants();

  const entries = Array.from(store.values());

  // Exactly two repeatables per tenant (a + b) — nothing left over.
  assert.equal(entries.length, 4);

  const signature = entries.map((e) => `${e.name}|${e.pattern}|${e.tz}`).sort();
  assert.deepEqual(
    signature,
    [
      `rate-copy-daily-tenant-a|${PUSH_CRON}|${TZ}`,
      `rate-copy-daily-tenant-b|${PUSH_CRON}|${TZ}`,
      `rate-copy-source-sync-daily-tenant-a|${SOURCE_SYNC_CRON}|${TZ}`,
      `rate-copy-source-sync-daily-tenant-b|${SOURCE_SYNC_CRON}|${TZ}`
    ].sort()
  );

  // No old single-slot cron survives anywhere on the queue.
  const survivingPatterns = entries.map((e) => e.pattern);
  for (const stale of ["0 10 * * *", "30 10 * * *", "30 6 * * *"]) {
    assert.ok(!survivingPatterns.includes(stale), `stale cron "${stale}" should have been pruned`);
  }

  // Every tenant got one source-sync + one push (2 tenants × 2 = 4 add calls).
  assert.equal(addCalls.length, 4);
});
