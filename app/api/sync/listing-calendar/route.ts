import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";
import { runCalendarSyncForListing } from "@/lib/sync/engine";

const bodySchema = z.object({
  listingId: z.string().trim().min(1)
});

/**
 * POST /api/sync/listing-calendar
 *
 * Pulls ONE listing's live calendar (price / min-stay / availability)
 * from its PMS straight into the local calendar_rates copy, synchronously.
 * Backs the per-row "Refresh" button on the pricing calendar: the owner
 * expects that button to show what's live on Hostaway right now, not the
 * last scheduled sync. Single listing + single PMS call, so unlike
 * /api/sync/run there is no queue involved — the response returns when
 * the copy is fresh.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.flatten() }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const listing = await prisma.listing.findFirst({
    where: { id: parsed.listingId, tenantId: auth.tenantId },
    select: { id: true }
  });
  if (!listing) {
    return NextResponse.json({ error: "Listing not found for this tenant" }, { status: 404 });
  }

  // Yesterday → +365d: mirrors the forward window the calendar UI shows;
  // the extra day behind guards against UTC-vs-local edge at midnight.
  const now = new Date();
  const dateFrom = toDateOnly(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const dateTo = toDateOnly(new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000));

  try {
    const result = await runCalendarSyncForListing({
      tenantId: auth.tenantId,
      listingId: listing.id,
      dateFrom,
      dateTo
    });
    return NextResponse.json({ ok: true, upserted: result.upserted, dateFrom, dateTo });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Calendar refresh failed" },
      { status: 502 }
    );
  }
}
