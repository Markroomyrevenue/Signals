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
