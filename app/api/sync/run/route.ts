import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { enqueueTenantSync } from "@/lib/queue/enqueue";
import { buildExtendedSyncReason } from "@/lib/sync/stages";
import { maybePromoteClonedOwnerMembership } from "@/lib/user-role-repair";

const syncRunBodySchema = z
  .object({
    forceFull: z.boolean().optional(),
    scope: z.enum(["full", "extended"]).optional()
  })
  .strict()
  .partial()
  .default({});

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

  // Body is optional — empty / malformed JSON falls back to a "full" core sync.
  let forceFull = false;
  let scope: "full" | "extended" = "full";
  try {
    const rawBody = await req.json().catch(() => ({}));
    const parsed = syncRunBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    forceFull = Boolean(parsed.data.forceFull);
    scope = parsed.data.scope === "extended" ? "extended" : "full";
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
