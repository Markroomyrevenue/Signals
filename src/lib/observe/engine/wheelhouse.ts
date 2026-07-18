/**
 * Wheelhouse adapter (built, DORMANT — SIGNALS-OBSERVE-LEARN-SPEC.md §2.2).
 *
 * Read-only against `https://api.usewheelhouse.com/ss_api/v1` with header
 * `X-Integration-Api-Key`. Read keys allow GET/HEAD/OPTIONS + non-mutating POST;
 * PUT/DELETE → 403 (we never issue them). Rate limit 20 req/min → the shared
 * HTTP helper backs off with jitter. Most listing-scoped calls need both
 * `listing_id` and `channel`, taken from `GET /listings`.
 *
 * 2026-07-18: the Coorie Doon read key WORKS (GET /listings → 200, 48 listings;
 * earlier 401s were a stale key). Verified live: with `channel=hostaway` the
 * top-level listing `id` IS the Hostaway listing id (Wheelhouse's internal id
 * is `wheelhouse_id`), so `engineListingId` maps straight onto
 * `Listing.hostawayId`. Besides the required contract this adapter implements
 * the optional `EngineHistoryReader` + `EngineNeighborhoodReader` capabilities
 * (base-price model history, calendar-day history, last posted prices,
 * reservations, neighborhood pricing/occupancy) — all GET, all mapped by pure
 * fixture-tested functions in `wheelhouse-map.ts`.
 */

import { engineFetchJson } from "./http";
import {
  mapWheelhouseBasePriceHistory,
  mapWheelhouseCalendarDayHistory,
  mapWheelhouseLastPostedPrices,
  mapWheelhouseLevers,
  mapWheelhouseListings,
  mapWheelhouseNeighborhoodOccupancy,
  mapWheelhouseNeighborhoodPricing,
  mapWheelhousePriceCalendar,
  mapWheelhouseRecentChanges,
  mapWheelhouseReservations,
  mapWheelhouseSignals
} from "./wheelhouse-map";
import type { PricingEngineAdapter } from "./adapter";
import type {
  EngineBasePriceHistoryRow,
  EngineCalendarDaySnapshot,
  EngineHistoryReader,
  EngineLastPostedPrice,
  EngineLevers,
  EngineListing,
  EngineNeighborhoodDay,
  EngineNeighborhoodReader,
  EnginePriceCalendarDay,
  EngineRecentChange,
  EngineReservationRow,
  EngineSignals
} from "./types";

const WHEELHOUSE_BASE_URL =
  process.env.WHEELHOUSE_BASE_URL ?? "https://api.usewheelhouse.com/ss_api/v1";
const HEADER_NAME = "X-Integration-Api-Key";
/** Wheelhouse caps reads at 20 req/min — give the backoff more room than PriceLabs. */
const WHEELHOUSE_BASE_DELAY_MS = 3500;

export type WheelhouseAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/**
 * The Wheelhouse adapter implements the required contract PLUS the optional
 * history + neighborhood read capabilities (recs warm-start / market
 * enrichment). Still 100% read-only.
 */
export type WheelhouseAdapter = PricingEngineAdapter & EngineHistoryReader & EngineNeighborhoodReader;

export function createWheelhouseAdapter(options: WheelhouseAdapterOptions): WheelhouseAdapter {
  const baseUrl = (options.baseUrl ?? WHEELHOUSE_BASE_URL).replace(/\/+$/, "");
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl;

  let rawById: Map<string, unknown> | null = null;

  async function loadRaw(): Promise<Map<string, unknown>> {
    if (rawById) return rawById;
    const payload = await engineFetchJson<unknown>({
      url: `${baseUrl}/listings`,
      method: "GET",
      headerName: HEADER_NAME,
      apiKey,
      baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
      fetchImpl
    });
    const listings = mapWheelhouseListings(payload);
    const rawArr = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { listings?: unknown[] }).listings)
        ? ((payload as { listings: unknown[] }).listings)
        : Array.isArray((payload as { data?: unknown[] }).data)
          ? ((payload as { data: unknown[] }).data)
          : [];
    const map = new Map<string, unknown>();
    for (let i = 0; i < listings.length; i += 1) {
      map.set(listings[i].engineListingId, rawArr[i]);
    }
    rawById = map;
    return map;
  }

  async function rawFor(engineListingId: string): Promise<unknown> {
    const map = await loadRaw();
    return map.get(engineListingId) ?? null;
  }

  /** The `channel` a listing is scoped to, required by listing-scoped calls. */
  async function channelParam(engineListingId: string): Promise<string> {
    const raw = await rawFor(engineListingId);
    const channel = raw && typeof raw === "object" ? (raw as Record<string, unknown>).channel : null;
    return typeof channel === "string" && channel.trim().length > 0
      ? `?channel=${encodeURIComponent(channel)}`
      : "";
  }

  /** Build a listing-scoped query string: `channel` first, then any extras. */
  async function listingQuery(
    engineListingId: string,
    params: Record<string, string | undefined> = {}
  ): Promise<string> {
    const channel = await channelParam(engineListingId); // "?channel=x" or ""
    const extras = Object.entries(params)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
    if (extras.length === 0) return channel;
    return channel ? `${channel}&${extras.join("&")}` : `?${extras.join("&")}`;
  }

  /** One read-only GET, with the shared 20 req/min-friendly backoff spacing. */
  function getJson(path: string): Promise<unknown> {
    return engineFetchJson<unknown>({
      url: `${baseUrl}${path}`,
      method: "GET",
      headerName: HEADER_NAME,
      apiKey,
      baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
      fetchImpl
    });
  }

  return {
    engine: "wheelhouse",

    async listClients(): Promise<EngineListing[]> {
      await loadRaw();
      return [...(rawById?.values() ?? [])].map((raw) => mapWheelhouseListings([raw])[0]);
    },

    async fetchLevers(engineListingId: string): Promise<EngineLevers> {
      return mapWheelhouseLevers(await rawFor(engineListingId));
    },

    async fetchEngineSignals(engineListingId: string): Promise<EngineSignals> {
      return mapWheelhouseSignals(await rawFor(engineListingId));
    },

    async fetchRecentChanges(engineListingId: string): Promise<EngineRecentChange[]> {
      const qs = await channelParam(engineListingId);
      const payload = await engineFetchJson<unknown>({
        url: `${baseUrl}/listings/${encodeURIComponent(engineListingId)}/recent_changes${qs}`,
        method: "GET",
        headerName: HEADER_NAME,
        apiKey,
        baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
        fetchImpl
      });
      return mapWheelhouseRecentChanges(payload);
    },

    async fetchPriceCalendar(
      engineListingId: string,
      fromDate: string,
      days: number
    ): Promise<EnginePriceCalendarDay[]> {
      const channel = await channelParam(engineListingId);
      const sep = channel ? "&" : "?";
      // The API takes start_date + end_date; a `days` param is ignored and
      // start_date alone returns an empty array (found live 2026-07-19).
      const endDate = new Date(Date.parse(`${fromDate}T00:00:00Z`) + Math.max(0, days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const payload = await engineFetchJson<unknown>({
        url:
          `${baseUrl}/listings/${encodeURIComponent(engineListingId)}/price_calendar` +
          `${channel}${sep}start_date=${fromDate}&end_date=${endDate}`,
        method: "GET",
        headerName: HEADER_NAME,
        apiKey,
        baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
        fetchImpl
      });
      return mapWheelhousePriceCalendar(payload);
    },

    // ---- EngineHistoryReader (read-only; verified live 2026-07-18) ----------

    async fetchBasePriceHistory(
      engineListingId: string,
      startDate?: string,
      endDate?: string
    ): Promise<EngineBasePriceHistoryRow[]> {
      const qs = await listingQuery(engineListingId, { start_date: startDate, end_date: endDate });
      const payload = await getJson(
        `/listings/${encodeURIComponent(engineListingId)}/base_price_history${qs}`
      );
      return mapWheelhouseBasePriceHistory(payload);
    },

    async fetchCalendarSnapshots(
      engineListingId: string,
      stayDate?: string
    ): Promise<EngineCalendarDaySnapshot[]> {
      // The RM API path is `calendar_day_history` and REQUIRES a stay_date —
      // default to today (UTC) so the optional-capability signature holds.
      const day = stayDate ?? new Date().toISOString().slice(0, 10);
      const qs = await listingQuery(engineListingId, { stay_date: day });
      const payload = await getJson(
        `/listings/${encodeURIComponent(engineListingId)}/calendar_day_history${qs}`
      );
      return mapWheelhouseCalendarDayHistory(payload);
    },

    async fetchLastPostedPrices(engineListingId: string): Promise<EngineLastPostedPrice[]> {
      const qs = await listingQuery(engineListingId);
      const payload = await getJson(
        `/listings/${encodeURIComponent(engineListingId)}/last_posted_prices${qs}`
      );
      return mapWheelhouseLastPostedPrices(payload);
    },

    async fetchReservations(
      engineListingId: string,
      startDate?: string,
      endDate?: string
    ): Promise<EngineReservationRow[]> {
      const qs = await listingQuery(engineListingId, { start_date: startDate, end_date: endDate });
      const payload = await getJson(
        `/listings/${encodeURIComponent(engineListingId)}/reservations${qs}`
      );
      return mapWheelhouseReservations(payload);
    },

    // ---- EngineNeighborhoodReader (read-only; verified live 2026-07-18) -----

    async fetchNeighborhoodPricing(engineListingId: string): Promise<EngineNeighborhoodDay[]> {
      const qs = await listingQuery(engineListingId);
      const payload = await getJson(
        `/listings/${encodeURIComponent(engineListingId)}/neighborhood/pricing${qs}`
      );
      return mapWheelhouseNeighborhoodPricing(payload);
    },

    async fetchNeighborhoodOccupancy(engineListingId: string): Promise<EngineNeighborhoodDay[]> {
      const qs = await listingQuery(engineListingId);
      const payload = await getJson(
        `/listings/${encodeURIComponent(engineListingId)}/neighborhood/occupancy${qs}`
      );
      return mapWheelhouseNeighborhoodOccupancy(payload);
    }
  };
}
