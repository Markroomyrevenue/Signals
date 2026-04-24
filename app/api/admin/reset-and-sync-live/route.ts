import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueTenantSync } from "@/lib/queue/enqueue";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Disabled in production" }, { status: 403 });
  }

  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = auth.tenantId;

  try {
    await prisma.$transaction([
      prisma.syncRun.deleteMany({ where: { tenantId } }),
      prisma.dailyAgg.deleteMany({ where: { tenantId } }),
      prisma.paceSnapshot.deleteMany({ where: { tenantId } }),
      prisma.calendarRate.deleteMany({ where: { tenantId } }),
      prisma.nightFact.deleteMany({ where: { tenantId } }),
      prisma.reservation.deleteMany({ where: { tenantId } }),
      prisma.listing.deleteMany({ where: { tenantId } }),
      prisma.hostawayConnection.updateMany({
        where: { tenantId },
        data: { lastSyncAt: null }
      })
    ]);

    const job = await enqueueTenantSync({
      tenantId,
      reason: "admin_reset_and_sync",
      forceFull: true,
      syncMode: "core",
      queueExtendedAfter: true
    });

    return NextResponse.json({
      queued: true,
      jobId: job.id,
      tenantId,
      status: "reset_started"
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reset failed" },
      { status: 500 }
    );
  }
}
