/**
 * Guesty gateway that satisfies the existing `HostawayGateway` contract.
 * Read-only: Signals never writes prices or anything else to Guesty.
 *
 * Paging contract (mirrors the Avantio gateway):
 *  - Listings are engine-page-based → mapped directly to Guesty's
 *    limit/skip offsets (page N → skip (N−1)×100).
 *  - Reservations run in TWO engine modes:
 *      backfill (dateRange) — page-based, mapped to limit/skip.
 *      delta (latestActivityStart/End) — the engine always sends page=1
 *      plus the last item id as `afterId`; we keep a closure-held offset
 *      and advance it ourselves, resetting on a fresh start (page ≤ 1
 *      and no afterId).
 *
 * Multi-unit (MTL) handling: Guesty models a multi-unit as a parent
 * listing (type MTL) with sub-unit listings (type MTL_CHILD). Signals'
 * model is one Listing row with unit_count = N (see
 * reference-multi-unit-listings), so:
 *  - MTL_CHILD listings are EXCLUDED from the synced listing set and a
 *    childId → parentId map is kept for the reservation pass (bookings
 *    on a Guesty multi-unit are assigned to sub-units).
 *  - MTL parents get unitCount from the calendar allotment of a nearby
 *    date (authoritative unit count; one extra GET per MTL parent),
 *    falling back to the number of children seen in the listing pull.
 *  - Reservations whose listingId is a known child are remapped to the
 *    parent so nights pool on the multi-unit row, exactly like Hostaway
 *    multi-units.
 */

import { addDays, format } from "date-fns";

import { createGuestyClient, type GuestyClient, type GuestyTokenProvider } from "@/lib/guesty/client";
import {
  guestyListingToHostawayListing,
  guestyReservationToHostawayReservation
} from "@/lib/guesty/normalize";
import type {
  FetchReservationsArgs,
  HostawayCalendarRate,
  HostawayGateway,
  HostawayListing,
  HostawayPageResult,
  HostawayReservation
} from "@/lib/hostaway/types";

export type CreateGuestyGatewayOptions = {
  tokenProvider: GuestyTokenProvider;
  /** Optional pre-built client (for tests). */
  client?: GuestyClient;
};

const PAGE_SIZE = 100;

/**
 * Projection for the reservations pull — everything the normalizer reads,
 * nothing more. Keeps 730 days of backfill payloads manageable while the
 * stored raw JSON still carries every field we base numbers on (the
 * Phase-5 spot-check compares DB rows against exactly this shape).
 */
const RESERVATION_FIELDS = [
  "status",
  "source",
  "confirmationCode",
  "listingId",
  "checkIn",
  "checkOut",
  "checkInDateLocalized",
  "checkOutDateLocalized",
  "nightsCount",
  "guestsCount",
  "createdAt",
  "confirmedAt",
  "canceledAt",
  "lastUpdatedAt",
  "money"
].join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function hasMoreFromBody(
  body: { results?: unknown[]; count?: number },
  skip: number,
  received: number
): boolean {
  if (typeof body.count === "number") {
    return skip + received < body.count;
  }
  // Defensive fallback when count is absent: a full page implies more.
  return received === PAGE_SIZE;
}

export function createGuestyGateway(options: CreateGuestyGatewayOptions): HostawayGateway {
  const client = options.client ?? createGuestyClient({ tokenProvider: options.tokenProvider });

  // childId → parentId for MTL sub-units, populated during the listings
  // pass (the engine always syncs listings before reservations in a run,
  // on this same gateway instance).
  const mtlChildToParent = new Map<string, string>();

  // Closure-held offset for the engine's delta mode (page=1 + afterId).
  let reservationSkip = 0;

  async function unitCountForMtlParent(listingId: string, childCount: number): Promise<number | null> {
    // Allotment on a near-future date is the authoritative unit count for a
    // Guesty multi-unit ("Multi-unit calendar availability is determined by
    // unit allotment"). Booked units don't show in allotment, so take the
    // max over a 14-day window to approach the true total; fall back to the
    // child count from the listings pull.
    try {
      const start = format(addDays(new Date(), 1), "yyyy-MM-dd");
      const end = format(addDays(new Date(), 14), "yyyy-MM-dd");
      const body = await client.getCalendar(listingId, start, end);
      const days = Array.isArray(body?.data?.days) ? body.data.days : Array.isArray(body?.days) ? body.days : [];
      let maxAllotment = 0;
      for (const day of days) {
        if (!isRecord(day)) continue;
        const allotment = typeof day.allotment === "number" ? day.allotment : 0;
        if (allotment > maxAllotment) maxAllotment = allotment;
      }
      const best = Math.max(maxAllotment, childCount);
      return best >= 2 ? best : childCount >= 2 ? childCount : null;
    } catch (error) {
      console.error(
        `[guesty.fetchListings] allotment lookup failed for MTL ${listingId}; falling back to child count ${childCount}`,
        error instanceof Error ? error.message : error
      );
      return childCount >= 2 ? childCount : null;
    }
  }

  async function fetchListings(page = 1): Promise<HostawayPageResult<HostawayListing>> {
    const skip = (Math.max(page, 1) - 1) * PAGE_SIZE;
    const body = await client.listListings({ limit: PAGE_SIZE, skip });
    const rows = Array.isArray(body.results) ? body.results : [];

    // First pass: register MTL children and count them per parent.
    const childCountByParent = new Map<string, number>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const type = asString(row.type)?.toUpperCase();
      if (type !== "MTL_CHILD") continue;
      const childId = asString(row._id);
      const mtl = isRecord(row.mtl) ? row.mtl : {};
      const parentId = asString(mtl.p) ?? asString(row.parentId);
      if (childId && parentId) {
        mtlChildToParent.set(childId, parentId);
        childCountByParent.set(parentId, (childCountByParent.get(parentId) ?? 0) + 1);
      }
    }

    const items: HostawayListing[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = asString(row._id);
      if (!id) continue;
      const type = asString(row.type)?.toUpperCase();
      if (type === "MTL_CHILD") continue; // folded into the parent row

      let unitCount: number | null = null;
      if (type === "MTL") {
        unitCount = await unitCountForMtlParent(id, childCountByParent.get(id) ?? 0);
      }
      items.push(guestyListingToHostawayListing(row, { unitCount }));
    }

    return {
      items,
      page,
      hasMore: hasMoreFromBody(body, skip, rows.length)
    };
  }

  async function fetchReservations(
    args: FetchReservationsArgs = {}
  ): Promise<HostawayPageResult<HostawayReservation>> {
    const pageHint = args.page ?? 1;
    const deltaMode =
      typeof args.latestActivityStart === "string" || typeof args.latestActivityEnd === "string";

    let skip: number;
    if (deltaMode) {
      const isFreshStart = pageHint <= 1 && !args.afterId;
      if (isFreshStart) reservationSkip = 0;
      skip = reservationSkip;
    } else {
      skip = (Math.max(pageHint, 1) - 1) * PAGE_SIZE;
    }

    // Delta pulls filter on lastUpdatedAt (everything that changed since
    // the watermark, including cancellations); the no-watermark backfill
    // filters on the localized check-in date over the
    // SYNC_DAYS_BACK/SYNC_DAYS_FORWARD window the engine passes down.
    const filters: unknown[] = [];
    if (deltaMode) {
      filters.push({
        operator: "$between",
        field: "lastUpdatedAt",
        from: `${args.latestActivityStart ?? "1970-01-01"}T00:00:00.000Z`,
        to: `${args.latestActivityEnd ?? format(addDays(new Date(), 1), "yyyy-MM-dd")}T23:59:59.999Z`
      });
    } else if (args.dateRange) {
      filters.push({
        operator: "$between",
        field: "checkInDateLocalized",
        from: args.dateRange.from,
        to: args.dateRange.to
      });
    }

    const body = await client.listReservations({
      limit: PAGE_SIZE,
      skip,
      filters: filters.length > 0 ? JSON.stringify(filters) : undefined,
      fields: RESERVATION_FIELDS,
      sort: "_id" // stable order so limit/skip pagination doesn't drop rows
    });
    const rows = Array.isArray(body.results) ? body.results : [];

    if (deltaMode) {
      reservationSkip = skip + rows.length;
    }

    const items: HostawayReservation[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      try {
        const reservation = guestyReservationToHostawayReservation(row);
        // Bookings on a multi-unit are assigned to MTL_CHILD sub-units;
        // pool them onto the parent row (Signals' multi-unit model).
        const parentId = mtlChildToParent.get(reservation.listingMapId);
        items.push(parentId ? { ...reservation, listingMapId: parentId } : reservation);
      } catch (error) {
        console.error(
          "[guesty.fetchReservations] skipping malformed reservation",
          error instanceof Error ? error.message : error
        );
        // Skip bad rows rather than corrupting the sync — they resurface
        // on the next delta and get another chance.
      }
    }

    return {
      items,
      page: pageHint,
      hasMore: hasMoreFromBody(body, skip, rows.length)
    };
  }

  async function fetchCalendarRates(
    listingId: string,
    dateFrom: string,
    dateTo: string
  ): Promise<HostawayCalendarRate[]> {
    // The engine asks for ~455 days in one span; chunk to stay well within
    // whatever range limit the calendar endpoint enforces.
    const CHUNK_DAYS = 180;
    const out: HostawayCalendarRate[] = [];
    let cursor = new Date(`${dateFrom}T00:00:00Z`);
    const end = new Date(`${dateTo}T00:00:00Z`);

    while (cursor <= end) {
      const chunkEnd = addDays(cursor, CHUNK_DAYS - 1) < end ? addDays(cursor, CHUNK_DAYS - 1) : end;
      const body = await client.getCalendar(
        listingId,
        format(cursor, "yyyy-MM-dd"),
        format(chunkEnd, "yyyy-MM-dd")
      );
      const days = Array.isArray(body?.data?.days) ? body.data.days : Array.isArray(body?.days) ? body.days : [];
      for (const day of days) {
        if (!isRecord(day)) continue;
        const date = asString(day.date);
        const price = typeof day.price === "number" && Number.isFinite(day.price) ? day.price : 0;
        if (!date) continue;
        const status = asString(day.status)?.toLowerCase();
        const allotment = typeof day.allotment === "number" ? day.allotment : undefined;
        // Single units: bookable when status says available. Multi-units:
        // "availability is determined by unit allotment, not its status
        // field" (Guesty docs) — any remaining allotment means bookable.
        const available = allotment !== undefined && allotment > 0 ? true : status === "available";
        out.push({
          date,
          available,
          minStay: typeof day.minNights === "number" ? day.minNights : undefined,
          rate: price,
          currency: asString(day.currency) ?? "GBP",
          raw: day
        });
      }
      cursor = addDays(chunkEnd, 1);
    }

    return out;
  }

  async function fetchAccountName(): Promise<string | null> {
    try {
      const account = await client.getAccount();
      return asString(account?.name) ?? null;
    } catch {
      return null;
    }
  }

  return {
    fetchListings,
    fetchReservations,
    fetchCalendarRates,
    fetchAccountName
  };
}
