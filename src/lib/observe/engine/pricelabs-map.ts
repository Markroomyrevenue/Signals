/**
 * PriceLabs → common-lever mapping (PURE; no network).
 *
 * Verified field mapping (SIGNALS-OBSERVE-LEARN-SPEC.md §2.1):
 *   GET /v1/listings        → { listings: [...] } with id, name, pms, group(_id),
 *                             no_of_bedrooms, city_name, latitude, longitude,
 *                             base, min, max, recommended_base_price,
 *                             push_enabled, last_date_pushed, last_refreshed_at,
 *                             occupancy_next_{7,30,60}, market_occupancy_next_{7,30,60}
 *   POST /v1/listing_prices → per-listing { data: [{ date, price, min_stay, ... }] }
 *
 * These pure functions are unit-tested against fixture JSON. The adapter
 * (`pricelabs.ts`) does the fetch and delegates every shape decision to here.
 */

import { pick, pickFirst, toBool, toDate, toDateOnly, toNum, toPosInt, toStr } from "./coerce";
import type {
  EngineLevers,
  EngineListing,
  EnginePriceCalendarDay,
  EngineRecentChange,
  EngineSignals
} from "./types";

/** Map one raw PriceLabs listing object to the common `EngineListing`. */
export function mapPriceLabsListing(raw: unknown): EngineListing {
  return {
    engineListingId: toStr(pickFirst(raw, ["id", "listing_id"])) ?? "",
    name: toStr(pickFirst(raw, ["name", "listing_name"])),
    pms: toStr(pick(raw, "pms")),
    groupId: toStr(pickFirst(raw, ["group_id", "group"])),
    city: toStr(pickFirst(raw, ["city_name", "city"])),
    latitude: toNum(pick(raw, "latitude")),
    longitude: toNum(pick(raw, "longitude")),
    bedrooms: toNum(pickFirst(raw, ["no_of_bedrooms", "bedrooms", "number_of_bedrooms"])),
    base: toNum(pick(raw, "base")),
    min: toNum(pick(raw, "min")),
    max: toNum(pick(raw, "max")),
    channel: toStr(pick(raw, "channel")),
    unitCount: toNum(pickFirst(raw, ["number_of_units", "no_of_units"])),
    pushEnabled: toBool(pick(raw, "push_enabled")),
    recommendedBase: toNum(pickFirst(raw, ["recommended_base_price", "recommended_base"])),
    lastRefreshedAt: toDate(pickFirst(raw, ["last_refreshed_at", "last_refreshed"])),
    lastDatePushed: toDateOnly(pick(raw, "last_date_pushed"))
  };
}

/** Map the full `{ listings: [...] }` payload to `EngineListing[]`. */
export function mapPriceLabsListings(payload: unknown): EngineListing[] {
  const list = pick(payload, "listings");
  const arr = Array.isArray(list) ? list : Array.isArray(payload) ? payload : [];
  return arr.map(mapPriceLabsListing).filter((l) => l.engineListingId.length > 0);
}

/** Extract the current common levers from a raw PriceLabs listing object. */
export function mapPriceLabsLevers(raw: unknown): EngineLevers {
  return {
    base: toNum(pick(raw, "base")),
    min: toNum(pick(raw, "min")),
    max: toNum(pick(raw, "max")),
    minStay: toPosInt(pickFirst(raw, ["min_stay", "default_min_stay"]))
  };
}

/** Extract the engine's own demand view + recommended base from a listing object. */
export function mapPriceLabsSignals(raw: unknown): EngineSignals {
  return {
    recommendedBase: toNum(pickFirst(raw, ["recommended_base_price", "recommended_base"])),
    occNext7: toNum(pick(raw, "occupancy_next_7")),
    occNext30: toNum(pick(raw, "occupancy_next_30")),
    occNext60: toNum(pick(raw, "occupancy_next_60")),
    marketOccNext7: toNum(pick(raw, "market_occupancy_next_7")),
    marketOccNext30: toNum(pick(raw, "market_occupancy_next_30")),
    marketOccNext60: toNum(pick(raw, "market_occupancy_next_60"))
  };
}

/**
 * PriceLabs marks a per-date entry as customised/overridden through a handful of
 * possible fields across API versions. Treat any of them being truthy (or a
 * non-empty user/fixed price) as an override.
 */
function priceRowIsOverride(row: unknown): boolean {
  const flag = toBool(pickFirst(row, ["override", "is_override", "customized", "is_customized"]));
  if (flag === true) return true;
  const userPrice = toNum(pickFirst(row, ["user_price", "fixed_price", "manual_price"]));
  return userPrice !== null && userPrice > 0;
}

/**
 * Map a single PriceLabs listing's price-calendar payload (the `data` array on
 * a `POST /listing_prices` response entry) to per-date common rows. Accepts
 * either the listing entry `{ id, data: [...] }` or the bare `data` array.
 */
export function mapPriceLabsPriceCalendar(payload: unknown): EnginePriceCalendarDay[] {
  const data = Array.isArray(payload) ? payload : pick(payload, "data");
  const rows = Array.isArray(data) ? data : [];
  const out: EnginePriceCalendarDay[] = [];
  for (const row of rows) {
    const date = toDateOnly(pick(row, "date"));
    if (!date) continue;
    out.push({
      date,
      price: toNum(pickFirst(row, ["price", "recommended_price"])),
      minStay: toPosInt(pickFirst(row, ["min_stay", "minimum_stay"])),
      isOverride: priceRowIsOverride(row),
      unitNumber: null
    });
  }
  return out;
}

/**
 * PriceLabs has no event-stream endpoint, so "the engine moved" is inferred from
 * the listing object's own `last_refreshed_at` / `last_date_pushed` timing
 * (spec §2.1 "engine moved timing"). Returns at most one synthetic change.
 */
export function mapPriceLabsRecentChanges(raw: unknown): EngineRecentChange[] {
  const at = toDate(pickFirst(raw, ["last_refreshed_at", "last_refreshed", "last_date_pushed"]));
  if (!at) return [];
  return [{ at, lever: "price" }];
}

/** One future date of the PriceLabs neighborhood/market view (trimmed). */
export type PriceLabsNeighborhoodDay = {
  date: string; // yyyy-mm-dd
  /** Neighborhood price percentiles for the date, when present. */
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  /** Market occupancy for the date, when present. */
  marketOccupancy: number | null;
};

/** The trimmed neighborhood payload — a few KB, never the raw dump. */
export type PriceLabsNeighborhood = {
  currency: string | null;
  source: string | null;
  days: PriceLabsNeighborhoodDay[];
};

/** A named date→value series pulled out of one neighborhood section. */
type NeighborhoodSeries = { name: string; points: Map<string, number> };

/**
 * Extract named date→value series from one neighborhood section. Documented
 * chart shape: `{ X_values: [dates], Y_values: [{ name, values: [...] }] }`.
 * Defensive fallback (this endpoint is NOT live-probed — entitlement-gated):
 * a plain object keyed by series name → `{ date: value }` map.
 */
function neighborhoodSeries(section: unknown): NeighborhoodSeries[] {
  const out: NeighborhoodSeries[] = [];
  const xValues = pick(section, "X_values");
  const yValues = pick(section, "Y_values");
  if (Array.isArray(xValues) && Array.isArray(yValues)) {
    for (const series of yValues) {
      const name = toStr(pick(series, "name")) ?? "";
      const values = pick(series, "values");
      const points = new Map<string, number>();
      if (Array.isArray(values)) {
        const n = Math.min(xValues.length, values.length);
        for (let i = 0; i < n; i += 1) {
          const date = toDateOnly(xValues[i]);
          const value = toNum(values[i]);
          if (date && value !== null) points.set(date, value);
        }
      }
      if (points.size > 0) out.push({ name, points });
    }
    return out;
  }
  if (section !== null && typeof section === "object") {
    for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const points = new Map<string, number>();
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const date = toDateOnly(key);
        const num = toNum(entry);
        if (date && num !== null) points.set(date, num);
      }
      if (points.size > 0) out.push({ name, points });
    }
  }
  return out;
}

/** First series whose name matches, or null. */
function seriesMatching(series: NeighborhoodSeries[], pattern: RegExp): NeighborhoodSeries | null {
  return series.find((s) => pattern.test(s.name)) ?? null;
}

/**
 * Map a `GET /v1/neighborhood_data` response — `{ status, data: { currency,
 * source, "Future Percentile Prices": ..., "Future Occ/New/Canc": ...,
 * "Market KPI": ... } }` — to the trimmed pure shape: per future date the
 * price percentiles (25/50/75/90 when present) + market occupancy. Built from
 * the documented shape (deliberately not live-probed here); every key access
 * is defensive, so a missing/renamed section just yields nulls.
 */
export function mapPriceLabsNeighborhood(payload: unknown): PriceLabsNeighborhood {
  const data = pick(payload, "data") ?? payload;

  const priceSeries = neighborhoodSeries(pick(data, "Future Percentile Prices"));
  const p25 = seriesMatching(priceSeries, /(^|\D)25(\D|$)/);
  const p50 = seriesMatching(priceSeries, /(^|\D)50(\D|$)/) ?? seriesMatching(priceSeries, /median/i);
  const p75 = seriesMatching(priceSeries, /(^|\D)75(\D|$)/);
  const p90 = seriesMatching(priceSeries, /(^|\D)90(\D|$)/);

  // Occupancy lives in the "Future Occ/New/Canc" section alongside new/cancelled
  // booking counts — match only the occupancy series.
  const occSeries = seriesMatching(neighborhoodSeries(pick(data, "Future Occ/New/Canc")), /occ/i);

  const dates = new Set<string>();
  for (const series of [p25, p50, p75, p90, occSeries]) {
    if (!series) continue;
    for (const date of series.points.keys()) dates.add(date);
  }

  const days: PriceLabsNeighborhoodDay[] = [...dates].sort().map((date) => ({
    date,
    p25: p25?.points.get(date) ?? null,
    p50: p50?.points.get(date) ?? null,
    p75: p75?.points.get(date) ?? null,
    p90: p90?.points.get(date) ?? null,
    marketOccupancy: occSeries?.points.get(date) ?? null
  }));

  return {
    currency: toStr(pick(data, "currency")),
    source: toStr(pick(data, "source")),
    days
  };
}
