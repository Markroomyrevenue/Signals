import { Worker, type Job } from "bullmq";

import {
  OBSERVE_DAILY_CRON,
  OBSERVE_RECONCILE_CRON,
  OBSERVE_TZ,
  OBSERVE_WEEKLY_SETTLE_CRON
} from "@/lib/observe/config";
import { redisConnectionOptions } from "@/lib/queue/connection";
import {
  OBSERVE_LEARN_QUEUE_NAME,
  OBSERVE_RECONCILE_JOB_NAME,
  observeLearnQueue,
  scheduleObserveDailyRun,
  scheduleObserveReconcile,
  scheduleObserveWeeklySettle
} from "@/lib/queue/queues";
import { sendDay30Readout } from "@/lib/observe/day30-runner";
import { runObserveForTenant, runWeeklySettleForTenant } from "@/lib/observe/observe-service";
import { maybeSendWeeklyLearnerReport } from "@/lib/observe/weekly-report";
import { prisma } from "@/lib/prisma";

/**
 * Observe-and-learn worker (SIGNALS-OBSERVE-LEARN-SPEC.md §10). Mirrors
 * `rate-copy-push-worker.ts` / `rate-scan-worker.ts`.
 *
 * Read-only with respect to the rest of the tool: every job runs
 * `runObserveForTenant` (engine snapshot + diff + window advance, silent until
 * graduation) or `runWeeklySettleForTenant` (read-only realised-history
 * refresh). Writes go only to the observe tables. `"observe"`/`"settle"` are the
 * repeatable runs; `"manual"` is a one-off for smoke-testing; `"reconcile"` is
 * the single estate-wide daily job that re-syncs the per-tenant schedules with
 * the live tenant table (boot-only registration left new tenants unobserved and
 * deleted tenants throwing daily — found live on 2026-07-03).
 */
type ObserveJob = { tenantId?: string; kind: "observe" | "settle" | "manual" | "reconcile" };

/** Parse a repeatable's job name back to its kind + tenant id. */
function parseObserveJobName(
  name: string
): { kind: "daily" | "settle"; tenantId: string } | { kind: "reconcile" } | null {
  if (name === OBSERVE_RECONCILE_JOB_NAME) return { kind: "reconcile" };
  if (name.startsWith("observe-settle-")) return { kind: "settle", tenantId: name.slice("observe-settle-".length) };
  if (name.startsWith("observe-")) return { kind: "daily", tenantId: name.slice("observe-".length) };
  return null;
}

/**
 * Remove every repeatable schedule belonging to one tenant. Used when a job
 * fires for a tenant id that no longer resolves — the schedule must remove
 * itself rather than throw `tenant not found` every morning forever.
 */
export async function removeObserveSchedulesForTenant(tenantId: string): Promise<number> {
  const existing = await observeLearnQueue.getRepeatableJobs();
  let removed = 0;
  for (const r of existing) {
    const parsed = parseObserveJobName(r.name);
    if (parsed && parsed.kind !== "reconcile" && parsed.tenantId === tenantId) {
      await observeLearnQueue.removeRepeatableByKey(r.key);
      removed += 1;
    }
  }
  return removed;
}

async function processJob(job: Job<ObserveJob>): Promise<unknown> {
  const { tenantId, kind } = job.data;

  if (kind === "reconcile") {
    return reconcileObserveSchedules();
  }

  if (!tenantId) throw new Error("observe: missing tenantId");

  // Dead-tenant self-heal: if the tenant id no longer resolves (tenant deleted
  // and recreated with a new id since the schedule was registered), prune this
  // tenant's schedules and skip — never throw daily forever.
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) {
    const removed = await removeObserveSchedulesForTenant(tenantId);
    console.warn(
      `[observe] tenant ${tenantId} not found — pruned ${removed} schedule(s) for it and skipped the run ` +
        `(tenant deleted/recreated since registration; the daily reconcile enrols any new tenant)`
    );
    return { skipped: "tenant_not_found", tenantId, schedulesRemoved: removed };
  }

  if (kind === "settle") {
    console.log(`[observe-settle] starting tenant=${tenantId}`);
    let result: Awaited<ReturnType<typeof runWeeklySettleForTenant>> | null = null;
    let settleError: unknown = null;
    try {
      result = await runWeeklySettleForTenant({ tenantId });
      console.log(`[observe-settle] done tenant=${tenantId} day=${result.window.daysObserved}/30`);
    } catch (err) {
      settleError = err;
    }
    // Learner weekly report (build 06): record this tenant's settle ATTEMPT
    // (success or failure — a failing tenant must not block the report forever)
    // and, once every tenant has attempted this ISO week, generate + email the
    // owner's plain-language weekly report. `maybeSendWeeklyLearnerReport`
    // never throws; report problems are logged and must never fail the settle.
    const report = await maybeSendWeeklyLearnerReport({ tenantId });
    if (report.generated) {
      console.log(
        `[observe-weekly-report] week=${report.isoWeek} generated html=${report.htmlPath} ` +
          `emailSent=${report.emailMessageId ? "yes" : "no"}${
            report.errors.length > 0 ? ` errors=${report.errors.join("; ")}` : ""
          }`
      );
    } else if (report.errors.length > 0) {
      console.error(`[observe-weekly-report] week=${report.isoWeek} errors=${report.errors.join("; ")}`);
    } else if (report.skipped) {
      console.log(`[observe-weekly-report] week=${report.isoWeek} already generated this week — skipped`);
    } else {
      console.log(
        `[observe-weekly-report] week=${report.isoWeek} waiting (${report.settledCount}/${report.tenantCount} tenants settled)`
      );
    }
    if (settleError) throw settleError;
    return result;
  }

  console.log(`[observe] starting tenant=${tenantId} kind=${kind}`);
  const result = await runObserveForTenant({ tenantId, trigger: kind === "manual" ? "manual" : "scheduled" });
  console.log(
    `[observe] done tenant=${tenantId} engine=${result.engine} day=${result.daysObserved}/30 ` +
      `status=${result.status} captured=${result.capture.captured} changes=${result.capture.changes}`
  );

  // Fire the one-time day-30 readout (HTML/JSON + email, guarded) the day a
  // client graduates. A readout failure must not fail the observe job.
  if (result.graduatedNow) {
    try {
      const readout = await sendDay30Readout({ tenantId, reason: "graduation" });
      console.log(
        `[observe] day-30 readout tenant=${tenantId} sent=${readout.emailMessageId ? "yes" : "no"} ` +
          `skipped=${readout.skipped} errors=${readout.errors.length}`
      );
    } catch (err) {
      console.error(`[observe] day-30 readout failed tenant=${tenantId}`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

export type ObserveReconcileResult = { tenants: number; added: number; pruned: number };

/**
 * Run-time schedule reconciliation (fired daily at 05:15 by the `"reconcile"`
 * repeatable, before the 05:30 observe runs). Re-enumerates `tenant.findMany`
 * and syncs the queue's repeatables to it:
 *   - prunes any daily/settle repeatable whose tenant id no longer resolves
 *     (deleted tenant) or whose cron/tz drifted from the desired pattern;
 *   - adds the daily + settle repeatables for any tenant that lacks one
 *     (tenant created since the last worker boot);
 *   - re-adds the reconcile repeatable itself if its cron drifted.
 * Reuses the prune-before-re-add pattern from `ensureObserveSchedules`.
 */
export async function reconcileObserveSchedules(): Promise<ObserveReconcileResult> {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  const liveIds = new Set(tenants.map((t) => t.id));

  const existing = await observeLearnQueue.getRepeatableJobs();
  const haveDaily = new Set<string>();
  const haveSettle = new Set<string>();
  let haveReconcile = false;
  let pruned = 0;

  for (const r of existing) {
    const parsed = parseObserveJobName(r.name);
    if (!parsed) continue; // unknown job — leave it alone

    if (parsed.kind === "reconcile") {
      if (r.pattern === OBSERVE_RECONCILE_CRON && r.tz === OBSERVE_TZ) {
        haveReconcile = true;
      } else {
        await observeLearnQueue.removeRepeatableByKey(r.key);
        pruned += 1;
      }
      continue;
    }

    const expectedCron = parsed.kind === "daily" ? OBSERVE_DAILY_CRON : OBSERVE_WEEKLY_SETTLE_CRON;
    const dead = !liveIds.has(parsed.tenantId);
    if (dead || r.pattern !== expectedCron || r.tz !== OBSERVE_TZ) {
      await observeLearnQueue.removeRepeatableByKey(r.key);
      pruned += 1;
      if (dead) {
        console.warn(`[observe] reconcile: pruned schedule "${r.name}" — tenant ${parsed.tenantId} no longer exists`);
      }
      continue;
    }
    (parsed.kind === "daily" ? haveDaily : haveSettle).add(parsed.tenantId);
  }

  let added = 0;
  for (const t of tenants) {
    if (!haveDaily.has(t.id)) {
      await scheduleObserveDailyRun({ tenantId: t.id });
      added += 1;
      console.log(`[observe] reconcile: enrolled tenant ${t.id} for the daily observe run`);
    }
    if (!haveSettle.has(t.id)) {
      await scheduleObserveWeeklySettle({ tenantId: t.id });
      added += 1;
    }
  }
  if (!haveReconcile) {
    await scheduleObserveReconcile();
    added += 1;
  }

  console.log(`[observe] reconcile: ${tenants.length} tenant(s), added ${added}, pruned ${pruned} repeatable(s)`);
  return { tenants: tenants.length, added, pruned };
}

/**
 * Register one daily-observe + one weekly-settle repeatable per tenant, plus
 * the single estate-wide daily reconcile, all Europe/London. Prune every
 * observe repeatable first so a changed cron never leaves a stale duplicate
 * firing (the BullMQ name+pattern+tz keying trap fixed for rate-copy on
 * 2026-06-02). Only observe jobs live on this queue, so
 * prune-all-then-re-add is safe and leaves a known-good state on every boot.
 * The reconcile repeatable then keeps the set in sync with the tenant table
 * BETWEEN boots, so a tenant created or deleted after boot no longer needs a
 * worker restart.
 */
export async function ensureObserveSchedules(): Promise<void> {
  const existing = await observeLearnQueue.getRepeatableJobs();
  for (const r of existing) {
    await observeLearnQueue.removeRepeatableByKey(r.key);
  }

  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const t of tenants) {
    await scheduleObserveDailyRun({ tenantId: t.id });
    await scheduleObserveWeeklySettle({ tenantId: t.id });
  }
  await scheduleObserveReconcile();
  console.log(
    `[observe] registered daily (05:30) + weekly settle (Mon 06:00) + reconcile (05:15) Europe/London for ` +
      `${tenants.length} tenants (pruned ${existing.length} stale repeatable(s) first)`
  );
}

export async function startWorker(): Promise<Worker<ObserveJob>> {
  const worker = new Worker<ObserveJob>(OBSERVE_LEARN_QUEUE_NAME, processJob, {
    connection: redisConnectionOptions(),
    concurrency: 1 // serialise — one tenant at a time so logs + engine load stay sane
  });
  worker.on("completed", (job) => console.log(`[observe] completed job ${job.id}`));
  worker.on("failed", (job, err) =>
    console.error(`[observe] failed job ${job?.id}`, err instanceof Error ? err.message : err)
  );
  process.on("SIGTERM", async () => {
    await worker.close();
    await observeLearnQueue.close();
    process.exit(0);
  });
  await ensureObserveSchedules();
  return worker;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startWorker()
    .then(() => console.log(`[observe] worker started on queue ${OBSERVE_LEARN_QUEUE_NAME}`))
    .catch((err) => {
      console.error("[observe] failed to start", err);
      process.exit(1);
    });
}
