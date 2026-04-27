import type { PrismaClient } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { CUSTOM_GROUP_TAG_PREFIX, customGroupKey, customGroupNamesFromTags } from "@/lib/pricing/settings";

/**
 * Per-date occupancy snapshot for a single multi-unit listing (or a group of
 * them after aggregation). The pricing pipeline uses this to look up the
 * lead-time × occupancy matrix adjustment for each cell.
 *
 * `unitsTotal` reflects the listing's `unit_count` column (or, when group
 * aggregation kicks in, the sum across the group). `unitsSold` is the count
 * of non-cancelled reservations overlapping the date in question.
 */
export type MultiUnitOccupancyCell = {
  unitsSold: number;
  unitsTotal: number;
  occupancyPct: number;
};

/**
 * Multi-unit listing input for the pure aggregation helper. We accept
 * pre-loaded data so tests can exercise the aggregation logic without
 * needing a Prisma instance.
 */
export type MultiUnitOccupancyListingInput = {
  listingId: string;
  tags: string[];
  unitCount: number | null;
  /**
   * Reservations overlapping the analysis window. Each reservation is
   * already filtered to non-cancelled / non-no-show statuses (the loader
   * does that filtering at SQL time).
   *
   * `arrivalDate` is inclusive; `departureDate` is exclusive (matches the
   * Prisma `reservations` table semantics — guests check out on the
   * departure date so the night spans `[arrival, departure)`).
   */
  reservations: Array<{
    arrivalDate: string;
    departureDate: string;
  }>;
};

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "no-show", "no_show"]);

/**
 * Helper exposed for tests / callers that already have raw status strings.
 */
export function isCancelledReservationStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return CANCELLED_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Pure aggregation helper. Returns a map of `listingId → (dateOnly →
 * MultiUnitOccupancyCell)`.
 *
 * Group-aware aggregation rules:
 *   - Single-unit listings (`unitCount === null` or < 2) are skipped — they
 *     do not appear in the output map at all. Callers fall back to the
 *     existing single-unit pricing path for these.
 *   - When two or more multi-unit listings in the input share the same
 *     custom group tag (`group:<name>`), their `unitsSold` and `unitsTotal`
 *     SUM across the group for each date and every listing in the group
 *     receives the same `occupancyPct`. This is the "shared portfolio"
 *     model: rooms in the same building should never compete with each
 *     other on price.
 *   - If a multi-unit listing has zero or many group tags, only the FIRST
 *     non-empty tag is honoured for grouping. Listings with no group tag
 *     stand alone.
 *   - Dates returned span `[fromDate, toDate]` inclusive.
 */
export function computeMultiUnitOccupancyByDateFromInputs(params: {
  listings: MultiUnitOccupancyListingInput[];
  fromDate: string;
  toDate: string;
}): Map<string, Map<string, MultiUnitOccupancyCell>> {
  const { listings, fromDate, toDate } = params;
  const result = new Map<string, Map<string, MultiUnitOccupancyCell>>();
  if (listings.length === 0) return result;

  // Filter down to multi-unit listings only. Single-unit listings should
  // not be returned — the calling pipeline branches on `unitCount` and
  // routes single-unit listings through the existing occupancy multiplier.
  const multiUnitListings = listings.filter(
    (listing) => listing.unitCount !== null && Number.isFinite(listing.unitCount) && listing.unitCount >= 2
  ) as Array<MultiUnitOccupancyListingInput & { unitCount: number }>;
  if (multiUnitListings.length === 0) return result;

  // Build the date list once and reuse for every listing/group.
  const dateKeys: string[] = [];
  const fromDateMs = fromDateOnly(fromDate).getTime();
  const toDateMs = fromDateOnly(toDate).getTime();
  for (
    let cursor = fromDateOnly(fromDate);
    cursor.getTime() <= toDateMs && cursor.getTime() >= fromDateMs;
    cursor = addUtcDays(cursor, 1)
  ) {
    dateKeys.push(toDateOnly(cursor));
  }

  // Per-listing per-date raw sold count from the listing's own
  // reservations.
  const perListingSoldByDate = new Map<string, Map<string, number>>();
  for (const listing of multiUnitListings) {
    const soldByDate = new Map<string, number>();
    for (const reservation of listing.reservations) {
      // Guests check out on `departureDate`, so the booked nights span
      // `[arrival, departure)`.
      let cursor = fromDateOnly(reservation.arrivalDate);
      const stop = fromDateOnly(reservation.departureDate);
      while (cursor < stop) {
        const dateKey = toDateOnly(cursor);
        if (dateKey >= fromDate && dateKey <= toDate) {
          soldByDate.set(dateKey, (soldByDate.get(dateKey) ?? 0) + 1);
        }
        cursor = addUtcDays(cursor, 1);
      }
    }
    perListingSoldByDate.set(listing.listingId, soldByDate);
  }

  // Determine each listing's group key (or null if not grouped). We use the
  // first custom group tag in the listing's tags array — matching how
  // `resolveListingPricingGroupName` chooses a group at the settings
  // resolver level.
  const listingGroupKeyById = new Map<string, string | null>();
  for (const listing of multiUnitListings) {
    const groupNames = customGroupNamesFromTags(listing.tags);
    listingGroupKeyById.set(listing.listingId, groupNames.length > 0 ? customGroupKey(groupNames[0]!) : null);
  }

  // Build per-group totals. Listings without a group form a singleton group
  // keyed by their listing id (prefixed so it can't collide with a real
  // custom group key).
  const SINGLE_PREFIX = "__single__:";
  const groupMembers = new Map<string, Array<MultiUnitOccupancyListingInput & { unitCount: number }>>();
  for (const listing of multiUnitListings) {
    const rawGroupKey = listingGroupKeyById.get(listing.listingId) ?? null;
    const groupKey = rawGroupKey ?? `${SINGLE_PREFIX}${listing.listingId}`;
    const members = groupMembers.get(groupKey) ?? [];
    members.push(listing);
    groupMembers.set(groupKey, members);
  }

  for (const [, members] of groupMembers.entries()) {
    const aggregateUnitsTotal = members.reduce((sum, member) => sum + member.unitCount, 0);

    for (const dateKey of dateKeys) {
      let aggregateSold = 0;
      for (const member of members) {
        const soldByDate = perListingSoldByDate.get(member.listingId);
        const sold = soldByDate?.get(dateKey) ?? 0;
        // Cap each listing's sold count at its own unit count — defensive
        // against accidental reservation duplicates.
        aggregateSold += Math.min(sold, member.unitCount);
      }

      const occupancyPct =
        aggregateUnitsTotal > 0 ? Math.round((aggregateSold / aggregateUnitsTotal) * 1000) / 10 : 0;

      const cell: MultiUnitOccupancyCell = {
        unitsSold: aggregateSold,
        unitsTotal: aggregateUnitsTotal,
        occupancyPct
      };

      for (const member of members) {
        const dateMap = result.get(member.listingId) ?? new Map<string, MultiUnitOccupancyCell>();
        dateMap.set(dateKey, cell);
        result.set(member.listingId, dateMap);
      }
    }
  }

  return result;
}

/**
 * Loads multi-unit occupancy data from the live DB. Multi-tenant safe:
 * every query filters by `tenantId` and we never trust `listingIds` alone.
 *
 * Inputs:
 *   - `listingInputs` — caller-provided rows describing each listing's
 *     `tags` and `unitCount`. Single-unit rows are accepted but skipped
 *     internally; the caller does not need to pre-filter.
 *   - `fromDate` / `toDate` — inclusive ISO date range (`YYYY-MM-DD`) of
 *     dates we want occupancy for.
 *
 * The function selects reservations whose stay window overlaps the
 * `[fromDate, toDate]` interval (`arrival <= toDate AND departure >
 * fromDate`) AND have a non-cancelled status. This mirrors the standard
 * "nights overlapping date" query across the codebase.
 */
export async function computeMultiUnitOccupancyByDate(params: {
  tenantId: string;
  listingInputs: Array<{
    listingId: string;
    tags: string[];
    unitCount: number | null;
  }>;
  fromDate: string;
  toDate: string;
  prisma: PrismaClient;
}): Promise<Map<string, Map<string, MultiUnitOccupancyCell>>> {
  const multiUnitInputs = params.listingInputs.filter(
    (input) => input.unitCount !== null && Number.isFinite(input.unitCount) && input.unitCount >= 2
  );
  if (multiUnitInputs.length === 0) {
    return new Map();
  }

  const listingIds = multiUnitInputs.map((input) => input.listingId);
  const fromDateAsDate = fromDateOnly(params.fromDate);
  // Departure is exclusive in the schema, so a reservation covering the
  // last-date-in-window has `departure > toDate`. We add one day to the
  // upper bound on the arrival side so a reservation arriving on toDate is
  // still picked up.
  const toDateNextDay = addUtcDays(fromDateOnly(params.toDate), 1);

  const reservations = await params.prisma.reservation.findMany({
    where: {
      tenantId: params.tenantId,
      listingId: { in: listingIds },
      arrival: { lt: toDateNextDay },
      departure: { gt: fromDateAsDate },
      status: { notIn: ["cancelled", "canceled", "no_show", "no-show"] }
    },
    select: {
      listingId: true,
      arrival: true,
      departure: true
    }
  });

  // Group reservations by listing id so we can pass a tidy bundle to the
  // pure aggregator.
  const reservationsByListingId = new Map<string, Array<{ arrivalDate: string; departureDate: string }>>();
  for (const reservation of reservations) {
    const list = reservationsByListingId.get(reservation.listingId) ?? [];
    list.push({
      arrivalDate: toDateOnly(reservation.arrival),
      departureDate: toDateOnly(reservation.departure)
    });
    reservationsByListingId.set(reservation.listingId, list);
  }

  const aggregatorInputs: MultiUnitOccupancyListingInput[] = multiUnitInputs.map((input) => ({
    listingId: input.listingId,
    tags: input.tags,
    unitCount: input.unitCount,
    reservations: reservationsByListingId.get(input.listingId) ?? []
  }));

  return computeMultiUnitOccupancyByDateFromInputs({
    listings: aggregatorInputs,
    fromDate: params.fromDate,
    toDate: params.toDate
  });
}

/**
 * Re-export so callers can detect a multi-unit group key without importing
 * settings.ts internals.
 */
export const MULTI_UNIT_GROUP_TAG_PREFIX = CUSTOM_GROUP_TAG_PREFIX;
