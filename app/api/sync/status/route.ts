import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncQueue } from "@/lib/queue/queues";
import { cleanupStaleRunningSyncs } from "@/lib/sync/engine";
import { syncScopeFromJobType } from "@/lib/sync/stages";

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
  // Failure here must NEVER block status — wrap and swallow.
  try {
    await cleanupStaleRunningSyncs(auth.tenantId);
  } catch (cleanupError) {
    console.warn(
      "[sync.status] cleanupStaleRunningSyncs failed (non-fatal)",
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    );
  }

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
    syncQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed")
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
