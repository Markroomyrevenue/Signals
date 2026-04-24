import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncQueue } from "@/lib/queue/queues";
import { syncScopeFromJobType } from "@/lib/sync/stages";

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
