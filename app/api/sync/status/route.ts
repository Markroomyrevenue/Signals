import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncQueue } from "@/lib/queue/queues";
import { cleanupStaleRunningSyncs } from "@/lib/sync/engine";
import { syncScopeFromJobType } from "@/lib/sync/stages";

// Empty job-counts shape used as the fallback when Redis is unreachable. Queue
// counts only feed the loading-screen progress bar — the real "is the sync
// done?" signal comes from Postgres (HostawayConnection + SyncRun). It is
// strictly better to render the UI with zeroed counts than to hang the
// endpoint forever waiting on a dead Redis.
const EMPTY_JOB_COUNTS = {
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0
} as const;

// Time-box an async call. If it doesn't settle within `timeoutMs`, resolve
// with `fallback` so the caller can keep going. We resolve (rather than
// reject) on timeout because every consumer here has a safe fallback and
// the goal is to never let a single slow dependency hang the response.
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[sync.status] ${label} timed out after ${timeoutMs}ms — using fallback`);
      resolve(fallback);
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        console.warn(
          `[sync.status] ${label} threw (non-fatal) — using fallback:`,
          error instanceof Error ? error.message : String(error)
        );
        resolve(fallback);
      });
  });
}

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Self-healing safety net: any SyncRun stuck "running" past 30 min gets
  // marked failed before we report status. Without this, a sync that
  // crashed mid-flight (e.g. Railway disk-full) leaves the dashboard
  // showing "Syncing..." forever for everyone — including viewers who
  // can't trigger a fresh sync to clear the stale row themselves. This
  // endpoint is hit on every dashboard load and every poll, so the
  // cleanup runs constantly and recovery is automatic.
  //
  // Time-boxed (5s) so a slow/locked DB cannot wedge the entire status
  // endpoint. Failure here must NEVER block status — we swallow + log.
  await withTimeout(
    cleanupStaleRunningSyncs(auth.tenantId),
    5000,
    undefined,
    "cleanupStaleRunningSyncs"
  );

  // Queue counts come from Redis (BullMQ). The BullMQ Redis connection uses
  // maxRetriesPerRequest:null (required for blocking commands), which means
  // a Redis command will retry forever if Redis is unreachable. Without a
  // timeout here, a downed Redis hangs this endpoint indefinitely, which
  // hangs the "Checking whether this portfolio needs a fresh sync." screen
  // for every user. Time-box to 3s and fall back to zeroed counts — the
  // freshness data below comes from Postgres and is the real source of
  // truth.
  const [connection, recentRuns, latestExtendedSuccess, counts] = await Promise.all([
    prisma.hostawayConnection.findUnique({
      where: { tenantId: auth.tenantId },
      select: { status: true, lastSyncAt: true }
    }),
    prisma.syncRun.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: "desc" },
      take: 20
    }),
    prisma.syncRun.findFirst({
      where: {
        tenantId: auth.tenantId,
        status: "success",
        jobType: {
          endsWith: "__extended"
        }
      },
      orderBy: {
        finishedAt: "desc"
      }
    }),
    withTimeout(
      syncQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
      3000,
      { ...EMPTY_JOB_COUNTS },
      "syncQueue.getJobCounts"
    )
  ]);
  const activeScopes = [...new Set(recentRuns.filter((run) => run.status === "running").map((run) => syncScopeFromJobType(run.jobType)))];

  return NextResponse.json({
    connection,
    queueCounts: counts,
    recentRuns,
    freshness: {
      coreLastSyncAt: connection?.lastSyncAt ?? null,
      extendedLastSyncAt: latestExtendedSuccess?.finishedAt ?? null,
      activeScopes
    }
  });
}
