/**
 * Rate-copy push pipeline.
 *
 * Reads `computeRateCopyByDate` results for a target listing and pushes
 * each per-date result (rate + min-stay) to Hostaway via the existing
 * push client. Persists a HostawayPushEvent row tagged `triggerSource`
 * (`'manual'` or `'scheduled'`) for audit.
 *
 * Used by:
 *   - `peer-fluctuation-push-worker` ← daily 06:30 Europe/London (scheduled)
 *   - `POST /api/pricing/rate-copy/push-now` (manual UI button)
 *
 * Multi-tenant isolation is enforced because every Prisma read filters by
 * `tenantId` and the Hostaway client factory looks up credentials by
 * `tenantId` as well.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { getHostawayPushClientForTenant, type HostawayCalendarPushRate } from "@/lib/hostaway/push";
import { computeRateCopyByDate } from "@/lib/pricing/rate-copy";
import { resolvePricingSettings, parsePricingSettingsOverride } from "@/lib/pricing/settings";
import { computeMultiUnitOccupancyByDate } from "@/lib/pricing/multi-unit-occupancy";

export type RateCopyPushSummary = {
  tenantId: string;
  listingId: string;
  hostawayId: string;
  /** ISO date strings. */
  dateFrom: string;
  dateTo: string;
  /** Number of dates we attempted to push. */
  dateCount: number;
  /** Number of dates Hostaway accepted. */
  pushedCount: number;
  /** Skip counts by reason. */
  skipped: { no_source_rate: number; missing_user_min: number; other: number };
  /** Status of the push event row. */
  status: "success" | "failed" | "skipped" | "blocked-allowlist" | "verify-mismatch";
  errorMessage: string | null;
  eventId: string | null;
};

export type RateCopyPushOptions = {
  tenantId: string;
  /** Target listing.id (the listing whose rates we're WRITING). */
  listingId: string;
  /** ISO date `YYYY-MM-DD`. Defaults to today UTC. */
  dateFrom?: string;
  /** ISO date `YYYY-MM-DD`. Defaults to dateFrom + 90 days. */
  dateTo?: string;
  pushedBy: string;
  triggerSource: "manual" | "scheduled";
};

const DEFAULT_HORIZON_DAYS = 90;

function addDays(iso: string, days: number): string {
  const d = fromDateOnly(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateOnly(d);
}

export async function executeRateCopyPush(opts: RateCopyPushOptions): Promise<RateCopyPushSummary> {
  const dateFrom = opts.dateFrom ?? toDateOnly(new Date());
  const dateTo = opts.dateTo ?? addDays(dateFrom, DEFAULT_HORIZON_DAYS);

  // 1. Load target listing + Hostaway id + tags (for group resolution)
  const listing = await prisma.listing.findFirst({
    where: { id: opts.listingId, tenantId: opts.tenantId },
    select: {
      id: true,
      hostawayId: true,
      tags: true,
      unitCount: true,
      bedroomsNumber: true,
      personCapacity: true
    }
  });
  if (!listing) {
    return {
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: "?",
      dateFrom,
      dateTo,
      dateCount: 0,
      pushedCount: 0,
      skipped: { no_source_rate: 0, missing_user_min: 0, other: 0 },
      status: "failed",
      errorMessage: `Listing ${opts.listingId} not found in tenant ${opts.tenantId}`,
      eventId: null
    };
  }

  // 2. Resolve pricing settings (portfolio → group → property)
  const portfolioRow = await prisma.pricingSetting.findFirst({
    where: { tenantId: opts.tenantId, scope: "portfolio", scopeRef: null }
  });
  const groupKeys = listing.tags
    .filter((t) => t.toLowerCase().startsWith("group:"))
    .map((t) => t.slice(6).trim().toLowerCase())
    .filter((k) => k.length > 0);
  const groupRow =
    groupKeys.length > 0
      ? await prisma.pricingSetting.findFirst({
          where: { tenantId: opts.tenantId, scope: "group", scopeRef: { in: groupKeys } }
        })
      : null;
  const propertyRow = await prisma.pricingSetting.findFirst({
    where: { tenantId: opts.tenantId, scope: "property", scopeRef: opts.listingId }
  });
  const { settings } = resolvePricingSettings({
    portfolio: parsePricingSettingsOverride(portfolioRow?.settings),
    group: parsePricingSettingsOverride(groupRow?.settings),
    property: parsePricingSettingsOverride(propertyRow?.settings)
  });

  // 3. Hard gates: must be in rate_copy mode, push must be enabled,
  //    source must be set, base + min must be set, listing must be synced
  if (settings.pricingMode !== "rate_copy") {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "Listing is not in rate_copy mode"
    });
  }
  if (!settings.rateCopyPushEnabled) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "rateCopyPushEnabled is false"
    });
  }
  if (!settings.rateCopySourceListingId) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "rateCopySourceListingId is unset"
    });
  }
  if (settings.basePriceOverride === null || settings.basePriceOverride <= 0) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "basePriceOverride is unset"
    });
  }
  const targetUserMin =
    settings.minimumPriceOverride !== null && settings.minimumPriceOverride > 0
      ? settings.minimumPriceOverride
      : settings.basePriceOverride * 0.7;

  // 4. Verify the source listing exists in the same tenant
  const sourceListing = await prisma.listing.findFirst({
    where: { id: settings.rateCopySourceListingId, tenantId: opts.tenantId },
    select: { id: true }
  });
  if (!sourceListing) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "failed",
      errorMessage: `Source listing ${settings.rateCopySourceListingId} not found in tenant`
    });
  }

  // 5. Compute multi-unit occupancy for target listing if unitCount >= 2
  const isMulti = listing.unitCount !== null && listing.unitCount >= 2;
  let occupancyByDate: Awaited<ReturnType<typeof computeMultiUnitOccupancyByDate>> | null = null;
  if (isMulti) {
    occupancyByDate = await computeMultiUnitOccupancyByDate({
      tenantId: opts.tenantId,
      listingInputs: [
        { listingId: listing.id, tags: listing.tags, unitCount: listing.unitCount }
      ],
      fromDate: dateFrom,
      toDate: dateTo,
      prisma
    });
  }

  // 6. Compute the rate-copy result per date
  const rateCopyMap = await computeRateCopyByDate({
    prisma,
    tenantId: opts.tenantId,
    sourceListingId: settings.rateCopySourceListingId,
    targetListingId: opts.listingId,
    fromDate: dateFrom,
    toDate: dateTo,
    multiUnitMatrix: isMulti ? settings.multiUnitOccupancyLeadTimeMatrix : null,
    targetDefaultMinStay: settings.minimumNightStay,
    targetUserMin,
    occupancyByDate: occupancyByDate?.get(opts.listingId) ?? null,
    roundingIncrement: settings.roundingIncrement,
    todayDateOnly: dateFrom
  });

  // 7. Build the push payload
  const rates: HostawayCalendarPushRate[] = [];
  const skipped = { no_source_rate: 0, missing_user_min: 0, other: 0 };
  let lastOverrideId: string | null = null;
  for (const [, entry] of rateCopyMap) {
    if ("skipReason" in entry) {
      if (entry.skipReason === "no_source_rate") skipped.no_source_rate += 1;
      else if (entry.skipReason === "missing_user_min") skipped.missing_user_min += 1;
      else skipped.other += 1;
      continue;
    }
    rates.push({ date: entry.date, dailyPrice: entry.rate, minStay: entry.minStay });
    if (entry.overrideApplied) lastOverrideId = entry.overrideApplied.id;
  }

  if (rates.length === 0) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "No pushable dates after applying gates and skip reasons",
      skipped
    });
  }

  // 8. Allowlist guard
  const allowlistRaw = process.env.HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS?.trim() ?? "";
  if (allowlistRaw.length > 0) {
    const allowlist = new Set(
      allowlistRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    );
    if (!allowlist.has(String(listing.hostawayId))) {
      const message = `Push refused: Hostaway listing ${listing.hostawayId} is not on the allowlist`;
      const event = await prisma.hostawayPushEvent.create({
        data: {
          tenantId: opts.tenantId,
          listingId: opts.listingId,
          pushedBy: opts.pushedBy,
          dateFrom: fromDateOnly(dateFrom),
          dateTo: fromDateOnly(dateTo),
          dateCount: rates.length,
          status: "blocked-allowlist",
          errorMessage: message,
          payload: { rates: rates.map((r) => ({ date: r.date, dailyPrice: r.dailyPrice, minStay: r.minStay ?? null })) } as Prisma.JsonObject,
          triggerSource: opts.triggerSource,
          overrideId: lastOverrideId
        }
      });
      return summary({
        tenantId: opts.tenantId,
        listingId: opts.listingId,
        hostawayId: listing.hostawayId,
        dateFrom,
        dateTo,
        status: "blocked-allowlist",
        errorMessage: message,
        skipped,
        eventId: event.id,
        dateCount: rates.length
      });
    }
  }

  // 9. Push
  const pushClient = await getHostawayPushClientForTenant({
    tenantId: opts.tenantId,
    hostawayListingId: listing.hostawayId
  });
  try {
    const result = await pushClient.pushCalendarRatesBatch({
      dateFrom,
      dateTo,
      rates
    });
    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: opts.tenantId,
        listingId: opts.listingId,
        pushedBy: opts.pushedBy,
        dateFrom: fromDateOnly(dateFrom),
        dateTo: fromDateOnly(dateTo),
        dateCount: rates.length,
        status: "success",
        errorMessage: null,
        payload: { rates: rates.map((r) => ({ date: r.date, dailyPrice: r.dailyPrice, minStay: r.minStay ?? null })) } as Prisma.JsonObject,
        triggerSource: opts.triggerSource,
        overrideId: lastOverrideId
      }
    });
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "success",
      errorMessage: null,
      skipped,
      pushedCount: result.pushedCount,
      eventId: event.id,
      dateCount: rates.length
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: opts.tenantId,
        listingId: opts.listingId,
        pushedBy: opts.pushedBy,
        dateFrom: fromDateOnly(dateFrom),
        dateTo: fromDateOnly(dateTo),
        dateCount: rates.length,
        status: "failed",
        errorMessage: message,
        payload: { rates: rates.map((r) => ({ date: r.date, dailyPrice: r.dailyPrice, minStay: r.minStay ?? null })) } as Prisma.JsonObject,
        triggerSource: opts.triggerSource,
        overrideId: lastOverrideId
      }
    });
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "failed",
      errorMessage: message,
      skipped,
      eventId: event.id,
      dateCount: rates.length
    });
  }
}

function summary(args: {
  tenantId: string;
  listingId: string;
  hostawayId: string;
  dateFrom: string;
  dateTo: string;
  status: RateCopyPushSummary["status"];
  errorMessage: string | null;
  skipped?: RateCopyPushSummary["skipped"];
  pushedCount?: number;
  eventId?: string | null;
  dateCount?: number;
}): RateCopyPushSummary {
  return {
    tenantId: args.tenantId,
    listingId: args.listingId,
    hostawayId: args.hostawayId,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    dateCount: args.dateCount ?? 0,
    pushedCount: args.pushedCount ?? 0,
    skipped: args.skipped ?? { no_source_rate: 0, missing_user_min: 0, other: 0 },
    status: args.status,
    errorMessage: args.errorMessage,
    eventId: args.eventId ?? null
  };
}

export async function executeRateCopyPushForTenant(args: {
  tenantId: string;
  pushedBy: string;
  triggerSource: "manual" | "scheduled";
}): Promise<RateCopyPushSummary[]> {
  // Find every property-scope pricing_settings row in the tenant where
  // pricingMode === 'rate_copy' AND rateCopyPushEnabled === true.
  const rows = await prisma.pricingSetting.findMany({
    where: { tenantId: args.tenantId, scope: "property", scopeRef: { not: null } }
  });
  const targets: string[] = [];
  for (const row of rows) {
    const parsed = parsePricingSettingsOverride(row.settings);
    if (parsed.pricingMode === "rate_copy" && parsed.rateCopyPushEnabled === true) {
      if (row.scopeRef) targets.push(row.scopeRef);
    }
  }
  const results: RateCopyPushSummary[] = [];
  for (const listingId of targets) {
    results.push(
      await executeRateCopyPush({
        tenantId: args.tenantId,
        listingId,
        pushedBy: args.pushedBy,
        triggerSource: args.triggerSource
      })
    );
  }
  return results;
}
