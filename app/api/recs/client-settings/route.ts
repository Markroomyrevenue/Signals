import { NextResponse } from "next/server";

import { getInternalRecsAuth } from "@/lib/recs/auth";
import { writeClientRecsSettings } from "@/lib/recs/settings";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/recs/client-settings — per-client recs toggles.
 * Body: { tenantId, allowBelowFloor: boolean }. Internal-only.
 * The toggle takes effect on the NEXT generation (05:30 or "Regenerate now") —
 * existing rows keep the floor semantics they were generated under.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  let body: { tenantId?: unknown; allowBelowFloor?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  if (!tenantId || typeof body.allowBelowFloor !== "boolean") {
    return NextResponse.json({ error: "tenantId and allowBelowFloor are required" }, { status: 400 });
  }
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) return NextResponse.json({ error: "Unknown tenant" }, { status: 404 });

  try {
    await writeClientRecsSettings({ tenantId, allowBelowFloor: body.allowBelowFloor, byEmail: auth.email });
    return NextResponse.json({ ok: true, allowBelowFloor: body.allowBelowFloor });
  } catch {
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
