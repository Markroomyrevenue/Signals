/**
 * Orchestration: compute peer-fluctuation rates for a target listing and
 * push them to Hostaway. Used by both:
 *   - the daily BullMQ worker (`src/workers/peer-fluctuation-push-worker.ts`)
 *   - the manual `POST /api/pricing/peer-fluctuation/push-now` endpoint
 *
 * Behaviour mirrors `executePushRates` in `src/lib/hostaway/push-service.ts`
 * but with two key differences:
 *   1. The recommendation comes from the peer-fluctuation pipeline directly
 *      (using the user's saved base/min) rather than the multi-stage
 *      market/multipliers pipeline.
 *   2. The gate is `peerFluctuationPushEnabled`, NOT `hostawayPushEnabled`.
 *      The two systems share the underlying push HTTP client but otherwise
 *      do not interact — see BUILD-LOG.md (2026-04-29) decision #1.
 */
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";
import {
  applyPeerFluctuation,
  computePeerFluctuationByDate
} from "@/lib/pricing/peer-fluctuation";
import { loadResolvedPricingSettings } from "@/lib/pricing/settings";
import {
  getHostawayPushClientForTenant,
  HostawayPushError
} from "@/lib/hostaway/push";
import type { Prisma } from "@prisma/client";

/** Default forward window for the daily push: today, today+90.  The 90 day
 *  cap matches what Hostaway's calendar typically holds for active rates. */
export const PEER_FLUCTUATION_FORWARD_WINDOW_DAYS = 90;

/** When the live rates for source listings are older than this, the push-now
 *  endpoint triggers an inline fetchCalendarRates first so that mid-day
 *  re-pushes reflect whatever PriceLabs has just done. */
export const STALE_SOURCE_RATE_THRESHOLD_MINUTES = 30;

export type PeerFluctuationPushResult = {
  listingId: string;
  hostawayId: string | null;
  status: "pushed" | "skipped" | "failed";
  pushedDates: number;
  skippedDates: number;
  skipReasons: Record<string, number>;
  capEngagedDates: number;
  errorMessage: string | null;
  eventId: string | null;
};

export type PeerFluctuationPushSummary = {
  pushed: number;
  skipped: number;
  failed: number;
  results: PeerFluctuationPushResult[];
  errors: string[];
};

/**
 * Push for a single listing. Runs all the pre-flight checks (mode, toggle,
 * base + min, sync state) and either pushes the computed rates to Hostaway
 * or records a 'skipped' audit row with the reason.
 */
export async function pushPeerFluctuationForListing(args: {
  tenantId: string;
  listingId: string;
  triggeredBy: string;
  triggerSource: "scheduled" | "manual";
  todayDateOnly?: string;
}): Promise<PeerFluctuationPushResult> {
  const today = args.todayDateOnly ?? toDateOnly(new Date());
  const forwardEnd = toDateOnly(
    addUtcDays(fromDateOnly(today), PEER_FLUCTUATION_FORWARD_WINDOW_DAYS)
  );

  const listing = await prisma.listing.findFirst({
    where: { id: args.listingId, tenantId: args.tenantId },
    select: { id: true, hostawayId: true, tags: true }
  });
  if (!listing) {
    return makeSkipped(args, null, "listing not found", today, forwardEnd);
  }

  const settingsMap = await loadResolvedPricingSettings({
    tenantId: args.tenantId,
    listings: [{ listingId: listing.id, tags: listing.tags }]
  });
  const settings = settingsMap.get(listing.id)?.settings ?? null;
  if (!settings) {
    return makeSkipped(args, listing.hostawayId, "settings not found", today, forwardEnd);
  }

  if (settings.pricingMode !== "peer_fluctuation") {
    return makeSkipped(
      args,
      listing.hostawayId,
      "pricingMode is not peer_fluctuation",
      today,
      forwardEnd
    );
  }
  if (!settings.peerFluctuationPushEnabled) {
    return makeSkipped(args, listing.hostawayId, "push toggle OFF", today, forwardEnd);
  }
  if (settings.basePriceOverride === null) {
    return makeSkipped(args, listing.hostawayId, "awaiting base price", today, forwardEnd);
  }
  if (settings.minimumPriceOverride === null) {
    return makeSkipped(args, listing.hostawayId, "awaiting minimum price", today, forwardEnd);
  }

  // Source pool exclusion: every other peer-fluctuation listing in the tenant.
  const excludeListings = await prisma.pricingSetting.findMany({
    where: {
      tenantId: args.tenantId,
      scope: "property"
    },
    select: { scopeRef: true, settings: true }
  });
  const excludePeerFluctuationListingIds: string[] = [];
  for (const row of excludeListings) {
    if (!row.scopeRef) continue;
    const settingsObj = row.settings;
    if (
      typeof settingsObj === "object" &&
      settingsObj !== null &&
      !Array.isArray(settingsObj) &&
      (settingsObj as Record<string, unknown>).pricingMode === "peer_fluctuation"
    ) {
      excludePeerFluctuationListingIds.push(row.scopeRef);
    }
  }

  const factorMap = await computePeerFluctuationByDate({
    tenantId: args.tenantId,
    subjectListingId: listing.id,
    fromDate: today,
    toDate: forwardEnd,
    prisma,
    excludePeerFluctuationListingIds,
    todayDateOnly: today
  });

  type Pushable = { date: string; rate: number };
  const pushable: Pushable[] = [];
  const skipReasons: Record<string, number> = {};
  let capEngagedDates = 0;

  for (const [dateKey, entry] of factorMap.entries()) {
    if ("skipReason" in entry) {
      skipReasons[entry.skipReason] = (skipReasons[entry.skipReason] ?? 0) + 1;
      continue;
    }
    if (entry.capEngaged) capEngagedDates += 1;
    const applied = applyPeerFluctuation({
      fluctuation: entry,
      userBase: settings.basePriceOverride,
      userMin: settings.minimumPriceOverride,
      roundingIncrement: settings.roundingIncrement
    });
    if (applied.skipped || applied.finalRate === null) {
      const reason = applied.skipped ? applied.skipReason : "no_target_base";
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
      continue;
    }
    pushable.push({ date: dateKey, rate: applied.finalRate });
  }

  const previewPayload = {
    listingId: listing.id,
    hostawayId: listing.hostawayId,
    dateFrom: today,
    dateTo: forwardEnd,
    count: pushable.length,
    capEngagedDates,
    skipReasons,
    dates: pushable
  };

  if (pushable.length === 0) {
    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: args.tenantId,
        listingId: listing.id,
        pushedBy: args.triggeredBy,
        dateFrom: fromDateOnly(today),
        dateTo: fromDateOnly(forwardEnd),
        dateCount: 0,
        status: "skipped",
        errorMessage:
          "No pushable dates (every date had insufficient sources or missing data)",
        payload: toJson(previewPayload),
        triggerSource: args.triggerSource
      },
      select: { id: true }
    });
    return {
      listingId: listing.id,
      hostawayId: listing.hostawayId,
      status: "skipped",
      pushedDates: 0,
      skippedDates: Object.values(skipReasons).reduce((a, b) => a + b, 0),
      skipReasons,
      capEngagedDates,
      errorMessage: null,
      eventId: event.id
    };
  }

  const allowlistRaw = process.env.HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS?.trim() ?? "";
  if (allowlistRaw.length > 0) {
    const allowlist = new Set(
      allowlistRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    );
    if (!allowlist.has(String(listing.hostawayId))) {
      const message = `Push refused: Hostaway listing ${listing.hostawayId} is not on the HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS allowlist`;
      const event = await prisma.hostawayPushEvent.create({
        data: {
          tenantId: args.tenantId,
          listingId: listing.id,
          pushedBy: args.triggeredBy,
          dateFrom: fromDateOnly(today),
          dateTo: fromDateOnly(forwardEnd),
          dateCount: 0,
          status: "blocked-allowlist",
          errorMessage: message,
          payload: toJson(previewPayload),
          triggerSource: args.triggerSource
        },
        select: { id: true }
      });
      return {
        listingId: listing.id,
        hostawayId: listing.hostawayId,
        status: "skipped",
        pushedDates: 0,
        skippedDates: pushable.length,
        skipReasons: { ...skipReasons, blocked_allowlist: pushable.length },
        capEngagedDates,
        errorMessage: message,
        eventId: event.id
      };
    }
  }

  const pushClient = await getHostawayPushClientForTenant({
    tenantId: args.tenantId,
    hostawayListingId: listing.hostawayId
  });

  try {
    const result = await pushClient.pushCalendarRatesBatch({
      dateFrom: today,
      dateTo: forwardEnd,
      rates: pushable.map((p) => ({ date: p.date, dailyPrice: p.rate }))
    });

    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: args.tenantId,
        listingId: listing.id,
        pushedBy: args.triggeredBy,
        dateFrom: fromDateOnly(today),
        dateTo: fromDateOnly(forwardEnd),
        dateCount: result.pushedCount,
        status: "success",
        errorMessage: null,
        payload: toJson(previewPayload),
        triggerSource: args.triggerSource
      },
      select: { id: true }
    });
    return {
      listingId: listing.id,
      hostawayId: listing.hostawayId,
      status: "pushed",
      pushedDates: result.pushedCount,
      skippedDates: Object.values(skipReasons).reduce((a, b) => a + b, 0),
      skipReasons,
      capEngagedDates,
      errorMessage: null,
      eventId: event.id
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Push failed";
    const responseBody =
      error instanceof HostawayPushError ? error.responseBody.slice(0, 1000) : undefined;
    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: args.tenantId,
        listingId: listing.id,
        pushedBy: args.triggeredBy,
        dateFrom: fromDateOnly(today),
        dateTo: fromDateOnly(forwardEnd),
        dateCount: 0,
        status: "failed",
        errorMessage: responseBody ? `${message} :: ${responseBody}` : message,
        payload: toJson(previewPayload),
        triggerSource: args.triggerSource
      },
      select: { id: true }
    });
    return {
      listingId: listing.id,
      hostawayId: listing.hostawayId,
      status: "failed",
      pushedDates: 0,
      skippedDates: pushable.length,
      skipReasons: { ...skipReasons, push_failed: pushable.length },
      capEngagedDates,
      errorMessage: message,
      eventId: event.id
    };
  }
}

/**
 * Push for every fully-configured peer-fluctuation listing in the tenant.
 * Returns aggregate counts plus per-listing details.
 */
export async function pushPeerFluctuationForTenant(args: {
  tenantId: string;
  triggeredBy: string;
  triggerSource: "scheduled" | "manual";
  todayDateOnly?: string;
}): Promise<PeerFluctuationPushSummary> {
  const propertyRows = await prisma.pricingSetting.findMany({
    where: { tenantId: args.tenantId, scope: "property" },
    select: { scopeRef: true, settings: true }
  });
  const targetIds: string[] = [];
  for (const row of propertyRows) {
    if (!row.scopeRef) continue;
    const settingsObj = row.settings;
    if (
      typeof settingsObj === "object" &&
      settingsObj !== null &&
      !Array.isArray(settingsObj) &&
      (settingsObj as Record<string, unknown>).pricingMode === "peer_fluctuation"
    ) {
      targetIds.push(row.scopeRef);
    }
  }

  const results: PeerFluctuationPushResult[] = [];
  const errors: string[] = [];
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  for (const listingId of targetIds) {
    try {
      const r = await pushPeerFluctuationForListing({
        tenantId: args.tenantId,
        listingId,
        triggeredBy: args.triggeredBy,
        triggerSource: args.triggerSource,
        todayDateOnly: args.todayDateOnly
      });
      results.push(r);
      if (r.status === "pushed") pushed += 1;
      else if (r.status === "skipped") skipped += 1;
      else failed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(`listing ${listingId}: ${message}`);
      failed += 1;
    }
  }

  return { pushed, skipped, failed, results, errors };
}

function makeSkipped(
  args: { tenantId: string; listingId: string; triggeredBy: string; triggerSource: "scheduled" | "manual" },
  hostawayId: string | null,
  reason: string,
  fromDate: string,
  toDate: string
): PeerFluctuationPushResult {
  // Best-effort audit row even for skip-with-reason; failure to write
  // shouldn't block the response.
  void prisma.hostawayPushEvent
    .create({
      data: {
        tenantId: args.tenantId,
        listingId: args.listingId,
        pushedBy: args.triggeredBy,
        dateFrom: fromDateOnly(fromDate),
        dateTo: fromDateOnly(toDate),
        dateCount: 0,
        status: "skipped",
        errorMessage: reason,
        payload: toJson({ skipReason: reason }),
        triggerSource: args.triggerSource
      },
      select: { id: true }
    })
    .catch(() => undefined);
  return {
    listingId: args.listingId,
    hostawayId,
    status: "skipped",
    pushedDates: 0,
    skippedDates: 0,
    skipReasons: { [reason]: 1 },
    capEngagedDates: 0,
    errorMessage: reason,
    eventId: null
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
