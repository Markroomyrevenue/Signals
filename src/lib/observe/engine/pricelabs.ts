/**
 * PriceLabs adapter (verified — SIGNALS-OBSERVE-LEARN-SPEC.md §2.1).
 *
 * Read-only against `https://api.pricelabs.co/v1` with header `X-API-Key`.
 * `GET /listings` is the single source for identity + current levers + the
 * engine's own demand signals, so it is fetched once and memoised; lever/signal
 * lookups read the cache. `POST /listing_prices` drives the per-date calendar.
 * Never logs the key (all errors run through the shared key-safe HTTP helper).
 */

import { engineFetchJson } from "./http";
import {
  mapPriceLabsLevers,
  mapPriceLabsListings,
  mapPriceLabsNeighborhood,
  mapPriceLabsPriceCalendar,
  mapPriceLabsRecentChanges,
  mapPriceLabsSignals,
  type PriceLabsNeighborhood
} from "./pricelabs-map";
import type { PricingEngineAdapter } from "./adapter";
import type {
  EngineLevers,
  EngineListing,
  EnginePriceCalendarDay,
  EngineRecentChange,
  EngineSignals
} from "./types";

const PRICELABS_BASE_URL = process.env.PRICELABS_BASE_URL ?? "https://api.pricelabs.co/v1";
const HEADER_NAME = "X-API-Key";

export type PriceLabsAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

/**
 * The PriceLabs adapter implements the required contract plus the
 * `EngineNeighborhoodReader`-shaped market view (PriceLabs scopes the call by
 * `pms` rather than `channel`, hence the extra argument).
 */
export type PriceLabsAdapter = PricingEngineAdapter & {
  /**
   * `GET /v1/neighborhood_data?listing_id=...&pms=...` mapped to the trimmed
   * percentile-prices + market-occupancy shape. Keys without the market-data
   * entitlement get a 400/404 → the normal `EngineHttpError` (fail fast, no
   * retry) — callers degrade gracefully.
   */
  fetchNeighborhood(engineListingId: string, pms: string): Promise<PriceLabsNeighborhood>;
};

export function createPriceLabsAdapter(options: PriceLabsAdapterOptions): PriceLabsAdapter {
  const baseUrl = (options.baseUrl ?? PRICELABS_BASE_URL).replace(/\/+$/, "");
  const apiKey = options.apiKey;
  const fetchImpl = options.fetchImpl;

  // Raw listing objects keyed by engine listing id, populated on first list.
  let rawById: Map<string, unknown> | null = null;

  async function loadRaw(): Promise<Map<string, unknown>> {
    if (rawById) return rawById;
    const payload = await engineFetchJson<unknown>({
      url: `${baseUrl}/listings`,
      method: "GET",
      headerName: HEADER_NAME,
      apiKey,
      fetchImpl
    });
    const listings = mapPriceLabsListings(payload);
    const rawArr = Array.isArray((payload as { listings?: unknown }).listings)
      ? ((payload as { listings: unknown[] }).listings)
      : Array.isArray(payload)
        ? (payload as unknown[])
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

  /** The `pms` a listing is connected to, needed by `POST /listing_prices`. */
  async function pmsFor(engineListingId: string): Promise<string> {
    const raw = await rawFor(engineListingId);
    const pms = raw && typeof raw === "object" ? (raw as Record<string, unknown>).pms : null;
    return typeof pms === "string" && pms.trim().length > 0 ? pms : "airbnb";
  }

  return {
    engine: "pricelabs",

    async listClients(): Promise<EngineListing[]> {
      await loadRaw();
      return [...(rawById?.values() ?? [])].map((raw) =>
        mapPriceLabsListings({ listings: [raw] })[0]
      );
    },

    async fetchLevers(engineListingId: string): Promise<EngineLevers> {
      return mapPriceLabsLevers(await rawFor(engineListingId));
    },

    async fetchEngineSignals(engineListingId: string): Promise<EngineSignals> {
      return mapPriceLabsSignals(await rawFor(engineListingId));
    },

    async fetchRecentChanges(engineListingId: string): Promise<EngineRecentChange[]> {
      return mapPriceLabsRecentChanges(await rawFor(engineListingId));
    },

    async fetchPriceCalendar(
      engineListingId: string,
      fromDate: string,
      days: number
    ): Promise<EnginePriceCalendarDay[]> {
      const pms = await pmsFor(engineListingId);
      // Body must be WRAPPED: { listings: [...] }. A bare array gets a 200
      // with an empty per-listing data array (found live 2026-07-19 — the
      // proven-by-hand curl used the wrapped shape).
      const payload = await engineFetchJson<unknown>({
        url: `${baseUrl}/listing_prices`,
        method: "POST",
        headerName: HEADER_NAME,
        apiKey,
        body: { listings: [{ id: engineListingId, pms, dateFrom: fromDate, days }] },
        fetchImpl
      });
      // Response is an array of listing entries; take the one for our id.
      const arr = Array.isArray(payload) ? payload : [];
      const entry =
        arr.find((e) => {
          const id = e && typeof e === "object" ? (e as Record<string, unknown>).id : null;
          return String(id) === String(engineListingId);
        }) ?? arr[0];
      return mapPriceLabsPriceCalendar(entry ?? payload);
    },

    async fetchNeighborhood(engineListingId: string, pms: string): Promise<PriceLabsNeighborhood> {
      const payload = await engineFetchJson<unknown>({
        url:
          `${baseUrl}/neighborhood_data` +
          `?listing_id=${encodeURIComponent(engineListingId)}&pms=${encodeURIComponent(pms)}`,
        method: "GET",
        headerName: HEADER_NAME,
        apiKey,
        fetchImpl
      });
      return mapPriceLabsNeighborhood(payload);
    }
  };
}
