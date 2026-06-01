import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runCalendarSyncForListing } from "@/lib/sync/engine";
import { parsePricingSettingsOverride, resolvePricingSettings } from "@/lib/pricing/settings";
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";

const bodySchema = z.object({ listingId: z.string().min(1) });

const SYNC_HORIZON_DAYS = 365;

/**
 * POST /api/pricing/rate-copy/sync-source
 *
 * For a rate_copy-enabled target listing, pull the configured source
 * listing's Hostaway calendar rates (today → today + 365 days) into
 * our `CalendarRate` table so the next pricing recompute reflects the
 * source's latest dynamic prices. Powers the manual ↻ refresh button
 * on each property row in the calendar workspace — a click pulls
 * fresh source data, after which "Push now" derives + writes the
 * updated rate to Hostaway.
 *
 * Designed to be safe to call unconditionally from the UI: if the
 * target is not in rate_copy mode (or has no source set), this is a
 * 200 no-op with `{ synced: false, reason }` so the caller doesn't
 * need to know pricingMode client-side.
 *
 * Admin-only. Tenant-scoped — the target listing must exist in
 * `auth.tenantId`, and the source must too (rate-copy was designed
 * with same-tenant sources only).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.flatten() }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // 1. Target listing must belong to this tenant
  const listing = await prisma.listing.findFirst({
    where: { id: body.listingId, tenantId: auth.tenantId },
    select: { id: true, tags: true }
  });
  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  // 2. Resolve PricingSettings (portfolio → group → property)
  const portfolioRow = await prisma.pricingSetting.findFirst({
    where: { tenantId: auth.tenantId, scope: "portfolio", scopeRef: null }
  });
  const groupKeys = listing.tags
    .filter((t) => t.toLowerCase().startsWith("group:"))
    .map((t) => t.slice(6).trim().toLowerCase())
    .filter((k) => k.length > 0);
  const groupRow =
    groupKeys.length > 0
      ? await prisma.pricingSetting.findFirst({
          where: { tenantId: auth.tenantId, scope: "group", scopeRef: { in: groupKeys } }
        })
      : null;
  const propertyRow = await prisma.pricingSetting.findFirst({
    where: { tenantId: auth.tenantId, scope: "property", scopeRef: body.listingId }
  });
  const { settings } = resolvePricingSettings({
    portfolio: parsePricingSettingsOverride(portfolioRow?.settings),
    group: parsePricingSettingsOverride(groupRow?.settings),
    property: parsePricingSettingsOverride(propertyRow?.settings)
  });

  // 3. Gate: only rate_copy mode does anything here
  if (settings.pricingMode !== "rate_copy") {
    return NextResponse.json({ synced: false, reason: "not_rate_copy" });
  }
  if (!settings.rateCopySourceListingId) {
    return NextResponse.json({ synced: false, reason: "no_source_set" });
  }

  // 4. Source must exist in the same tenant
  const sourceListing = await prisma.listing.findFirst({
    where: { id: settings.rateCopySourceListingId, tenantId: auth.tenantId },
    select: { id: true }
  });
  if (!sourceListing) {
    return NextResponse.json({ synced: false, reason: "source_not_found" });
  }

  // 5. Pull source's Hostaway calendar for today → today + 365 days
  const dateFrom = toDateOnly(new Date());
  const dateTo = toDateOnly(addUtcDays(fromDateOnly(dateFrom), SYNC_HORIZON_DAYS));
  try {
    const result = await runCalendarSyncForListing({
      tenantId: auth.tenantId,
      listingId: settings.rateCopySourceListingId,
      dateFrom,
      dateTo
    });
    return NextResponse.json({
      synced: true,
      sourceListingId: settings.rateCopySourceListingId,
      dateFrom,
      dateTo,
      upserted: result.upserted
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[rate-copy.sync-source] Hostaway pull failed", {
      tenantId: auth.tenantId,
      targetListingId: body.listingId,
      sourceListingId: settings.rateCopySourceListingId,
      error: message
    });
    return NextResponse.json(
      { synced: false, reason: "sync_failed", error: message },
      { status: 502 }
    );
  }
}
