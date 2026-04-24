import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { enqueueTenantSync } from "@/lib/queue/enqueue";
import { buildExtendedSyncReason } from "@/lib/sync/stages";
import { maybePromoteClonedOwnerMembership } from "@/lib/user-role-repair";

export async function POST(req: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const repairedMembership =
    auth.role === "admin" ? { role: "admin" } : await maybePromoteClonedOwnerMembership(auth.userId);
  if (repairedMembership?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let forceFull = false;
  let scope: "full" | "extended" = "full";
  try {
    const body = (await req.json()) as {
      forceFull?: boolean;
      scope?: "full" | "extended";
    };
    forceFull = Boolean(body?.forceFull);
    scope = body?.scope === "extended" ? "extended" : "full";
  } catch {
    forceFull = false;
    scope = "full";
  }

  const baseReason = forceFull ? "manual_full_sync" : "manual_trigger";
  const job = await enqueueTenantSync({
    tenantId: auth.tenantId,
    reason: scope === "extended" ? buildExtendedSyncReason(baseReason) : baseReason,
    forceFull,
    syncMode: scope === "extended" ? "extended" : "core",
    queueExtendedAfter: scope === "full"
  });

  return NextResponse.json({
    queued: true,
    jobId: job.id,
    queueName: job.queueName,
    scope
  });
}
