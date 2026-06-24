/**
 * Avantio gateway that satisfies the existing `HostawayGateway` contract.
 *
 * Every downstream consumer of sync output (NightFact, Pace, Pricing,
 * Reports) reads `HostawayListing` / `HostawayReservation` shapes — so
 * the only thing the Avantio integration needs is a gateway that
 * produces those shapes. Nothing else in the engine has to change.
 *
 * Paging contract:
 *   - The engine treats every gateway as page-based for listings and
 *     either page- or cursor-based for reservations. Avantio uses
 *     opaque cursors via `pagination_cursor`, so the gateway keeps
 *     closure-held cursor state and resets it when the engine signals
 *     "page 1, no afterId" (the start of a fresh iteration).
 *   - We never reuse the engine's `afterId` value; we treat its presence
 *     as "continue with the cursor I stored last time."
 */

import { createAvantioClient, type AvantioClient } from "@/lib/avantio/client";
import { accommodationToListing, bookingToReservation } from "@/lib/avantio/normalize";
import type {
  FetchReservationsArgs,
  HostawayCalendarRate,
  HostawayGateway,
  HostawayListing,
  HostawayPageResult,
  HostawayReservation
} from "@/lib/hostaway/types";

export type CreateAvantioGatewayOptions = {
  baseUrl: string;
  apiKey: string;
  /** Optional pre-built client (for tests). When omitted, one is created. */
  client?: AvantioClient;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function createAvantioGateway(options: CreateAvantioGatewayOptions): HostawayGateway {
  const client = options.client ?? createAvantioClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });

  // Closure-held cursors. The Hostaway gateway contract has no formal
  // "fresh page" signal beyond the page index, so we use page<=1 (or
  // undefined) to mean "start over" and any higher value to mean
  // "continue with whatever cursor I last stored."
  let listingCursor: string | null = null;
  let listingPageStarted = false;
  let reservationCursor: string | null = null;
  let reservationPageStarted = false;

  function unwrapList(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (isRecord(value)) {
      const inner = (value as Record<string, unknown>).data;
      if (Array.isArray(inner)) return inner;
    }
    return [];
  }

  async function fetchListings(page = 1): Promise<HostawayPageResult<HostawayListing>> {
    if (page <= 1) {
      listingCursor = null;
      listingPageStarted = false;
    }
    if (page > 1 && !listingPageStarted) {
      // Engine asked for page>1 without ever calling page=1 — defensive reset.
      listingCursor = null;
    }
    listingPageStarted = true;

    const summary = await client.listAccommodations({ cursor: listingCursor, size: 100 });
    listingCursor = summary.nextCursor;

    const detailed: HostawayListing[] = [];
    for (const item of summary.items) {
      if (!isRecord(item)) continue;
      const id = asString(item.id);
      if (!id) continue;
      try {
        const detailResponse = await client.getAccommodation(id);
        // Avantio's detail endpoint OMITS the id from the body (verified
        // live 2026-06-24 — detail.data has every field EXCEPT `id`), so
        // inject it from the request URL before normalising. Without this
        // every listing failed accommodationToListing's id guard and
        // silently fell back to the slimmer summary shape.
        const baseDetail = isRecord(detailResponse?.data)
          ? (detailResponse.data as Record<string, unknown>)
          : item;
        const detailWithId: Record<string, unknown> = { ...baseDetail, id };
        detailed.push(accommodationToListing(detailWithId));
      } catch (error) {
        // Don't kill the whole portfolio for one bad accommodation — fall
        // back to the summary shape so the listing still surfaces in the
        // sync run, and log enough to debug afterwards.
        console.error(
          `[avantio.fetchListings] failed to hydrate accommodation ${id}; using summary fallback`,
          error instanceof Error ? error.message : error
        );
        detailed.push(accommodationToListing({ ...item, id }));
      }
    }

    return {
      items: detailed,
      page,
      hasMore: listingCursor !== null
    };
  }

  async function fetchReservations(
    args: FetchReservationsArgs = {}
  ): Promise<HostawayPageResult<HostawayReservation>> {
    const pageHint = args.page ?? 1;
    const isFreshStart = pageHint <= 1 && !args.afterId;

    if (isFreshStart) {
      reservationCursor = null;
      reservationPageStarted = false;
    }
    if (!isFreshStart && !reservationPageStarted) {
      // Engine asked us to continue without a cursor in hand — start fresh.
      reservationCursor = null;
    }
    reservationPageStarted = true;

    const filters: Record<string, string> = {};
    if (args.dateRange) {
      filters.arrivalDate_from = args.dateRange.from;
      filters.arrivalDate_to = args.dateRange.to;
    }
    const updatedFrom = args.latestActivityStart ?? args.updatedSince;
    if (updatedFrom) filters.updatedAt_from = updatedFrom;
    if (args.latestActivityEnd) filters.updatedAt_to = args.latestActivityEnd;

    const summary = await client.listBookings({
      cursor: reservationCursor,
      size: 50, // bookings endpoint caps at 50; the client also clamps defensively
      filters
    });
    reservationCursor = summary.nextCursor;

    const detailed: HostawayReservation[] = [];
    for (const item of summary.items) {
      if (!isRecord(item)) continue;
      const id = asString(item.id);
      if (!id) continue;
      try {
        const detailResponse = await client.getBooking(id);
        // Same defensive id-injection as fetchListings — Avantio's
        // detail-by-id endpoints don't echo the id in the body.
        const baseDetail = isRecord(detailResponse?.data)
          ? (detailResponse.data as Record<string, unknown>)
          : item;
        const detailWithId: Record<string, unknown> = { ...baseDetail, id };
        detailed.push(bookingToReservation(detailWithId));
      } catch (error) {
        console.error(
          `[avantio.fetchReservations] failed to hydrate booking ${id}`,
          error instanceof Error ? error.message : error
        );
        // Skip bad bookings rather than corrupting the sync — they'll
        // re-appear on the next delta and have another chance.
      }
    }

    return {
      items: detailed,
      page: pageHint,
      hasMore: reservationCursor !== null
    };
  }

  // Calendar/pricing is Phase 1. The engine's CORE sync path doesn't use
  // fetchCalendarRates — only the EXTENDED sync does. Returning [] keeps
  // EXTENDED runs no-op-safe for an Avantio tenant until the Phase 1
  // rate + availability + occupation-rule merge is wired.
  // TODO Phase 1: combine client.getRate / .getAvailabilities / .getOccupationRule
  // into a per-day HostawayCalendarRate stream over [dateFrom, dateTo].
  async function fetchCalendarRates(
    _listingId: string,
    _dateFrom: string,
    _dateTo: string
  ): Promise<HostawayCalendarRate[]> {
    return [];
  }

  async function fetchAccountName(): Promise<string | null> {
    try {
      const response = await client.whoami();
      const company = isRecord(response?.data?.company) ? response.data!.company : null;
      return company ? asString(company.name) ?? null : null;
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
