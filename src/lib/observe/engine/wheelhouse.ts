/**
 * Wheelhouse adapter (built, DORMANT — SIGNALS-OBSERVE-LEARN-SPEC.md §2.2).
 *
 * Read-only against `https://api.usewheelhouse.com/ss_api/v1` with header
 * `X-Integration-Api-Key`. Read keys allow GET/HEAD/OPTIONS + non-mutating POST;
 * PUT/DELETE → 403 (we never issue them). Rate limit 20 req/min → the shared
 * HTTP helper backs off with jitter. Most listing-scoped calls need both
 * `listing_id` and `channel`, taken from `GET /listings`.
 *
 * The Corrie Doon key returns 401 (re-tested 2026-06-26), so this adapter stays
 * dormant: the registry routes Corrie Doon to the Hostaway-scan fallback and the
 * connectivity check surfaces a clear "Wheelhouse key invalid (401)" status
 * rather than crashing. The moment a valid read key is supplied, the registry
 * can switch Corrie Doon to engine-direct with zero code change here.
 */

import { engineFetchJson } from "./http";
import {
  mapWheelhouseLevers,
  mapWheelhouseListings,
  mapWheelhousePriceCalendar,
  mapWheelhouseRecentChanges,
  mapWheelhouseSignals
} from "./wheelhouse-map";
import type { PricingEngineAdapter } from "./adapter";
import type {
  EngineLevers,
  EngineListing,
  EnginePriceCalendarDay,
  EngineRecentChange,
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

export function createWheelhouseAdapter(options: WheelhouseAdapterOptions): PricingEngineAdapter {
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
      const payload = await engineFetchJson<unknown>({
        url:
          `${baseUrl}/listings/${encodeURIComponent(engineListingId)}/price_calendar` +
          `${channel}${sep}start_date=${fromDate}&days=${days}`,
        method: "GET",
        headerName: HEADER_NAME,
        apiKey,
        baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
        fetchImpl
      });
      return mapWheelhousePriceCalendar(payload);
    }
  };
}
