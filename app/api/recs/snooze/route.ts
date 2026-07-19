import { NextResponse } from "next/server";

import { getInternalRecsAuth } from "@/lib/recs/auth";
import { snoozeListing, unsnoozeListing, SNOOZE_DEFAULT_DAYS } from "@/lib/recs/settings";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/recs/snooze — "don't raise this listing for 30 days" (and undo).
 * Body: { tenantId, listingId, action: "snooze" | "unsnooze", days? }.
 * Internal-only; the snooze expires on its own so a listing can't be forgotten.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  let body: { tenantId?: unknown; listingId?: unknown; action?: unknown; days?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const listingId = typeof body.listingId === "string" ? body.listingId : "";
  const action = body.action === "snooze" || body.action === "unsnooze" ? body.action : null;
  if (!tenantId || !listingId || !action) {
    return NextResponse.json({ error: "tenantId, listingId and action are required" }, { status: 400 });
  }
  const days =
    typeof body.days === "number" && Number.isFinite(body.days) ? body.days : SNOOZE_DEFAULT_DAYS;

  // The listing must belong to the tenant (tenant-scoped lookup).
  const listing = await prisma.listing.findFirst({ where: { id: listingId, tenantId }, select: { id: true } });
  if (!listing) return NextResponse.json({ error: "Unknown listing" }, { status: 404 });

  try {
    if (action === "snooze") {
      const { until } = await snoozeListing({ tenantId, listingId, byEmail: auth.email, days });
      return NextResponse.json({ ok: true, snoozedUntil: until });
    }
    await unsnoozeListing({ tenantId, listingId });
    return NextResponse.json({ ok: true, snoozedUntil: null });
  } catch {
    return NextResponse.json({ error: "Failed to update snooze" }, { status: 500 });
  }
}
