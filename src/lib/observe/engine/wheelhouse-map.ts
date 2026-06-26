/**
 * Wheelhouse → common-lever mapping (PURE; no network).
 *
 * From the published RM API (SIGNALS-OBSERVE-LEARN-SPEC.md §2.2). Built so Corrie
 * Doon can be upgraded to engine-direct the moment a valid `X-Integration-Api-Key`
 * read key is supplied — until then the adapter is dormant (key 401s) and Corrie
 * Doon runs on the Hostaway-scan fallback. Multi-unit listings emit one
 * price-calendar row per `unit_number`.
 */

import { pick, pickFirst, toBool, toDate, toDateOnly, toNum, toPosInt, toStr } from "./coerce";
import type {
  EngineLevers,
  EngineListing,
  EnginePriceCalendarDay,
  EngineRecentChange,
  EngineSignals
} from "./types";

/** Map one raw Wheelhouse listing object to the common `EngineListing`. */
export function mapWheelhouseListing(raw: unknown): EngineListing {
  return {
    engineListingId: toStr(pickFirst(raw, ["listing_id", "id"])) ?? "",
    name: toStr(pickFirst(raw, ["name", "listing_name", "title"])),
    pms: toStr(pickFirst(raw, ["pms", "source", "channel_manager"])),
    groupId: toStr(pickFirst(raw, ["group_id", "cluster_id"])),
    city: toStr(pickFirst(raw, ["city", "city_name"])),
    latitude: toNum(pick(raw, "latitude")),
    longitude: toNum(pick(raw, "longitude")),
    bedrooms: toNum(pickFirst(raw, ["number_of_bedrooms", "bedrooms", "no_of_bedrooms"])),
    base: toNum(pickFirst(raw, ["base_price", "base"])),
    min: toNum(pickFirst(raw, ["min_price", "min", "minimum_price"])),
    max: toNum(pickFirst(raw, ["max_price", "max", "maximum_price"])),
    channel: toStr(pick(raw, "channel")),
    unitCount: toNum(pickFirst(raw, ["number_of_active_units", "active_units", "unit_count"])),
    pushEnabled: toBool(pickFirst(raw, ["sync_enabled", "push_enabled", "is_synced"])),
    recommendedBase: toNum(pickFirst(raw, ["recommended_base_price", "recommended_base"])),
    lastRefreshedAt: toDate(pickFirst(raw, ["last_refreshed_at", "updated_at", "last_synced_at"])),
    lastDatePushed: toDateOnly(pickFirst(raw, ["last_date_pushed", "last_posted_date"]))
  };
}

/** Map a `GET /listings` payload (array, or `{ listings|data: [...] }`) to listings. */
export function mapWheelhouseListings(payload: unknown): EngineListing[] {
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(pick(payload, "listings"))
      ? (pick(payload, "listings") as unknown[])
      : Array.isArray(pick(payload, "data"))
        ? (pick(payload, "data") as unknown[])
        : [];
  return arr.map(mapWheelhouseListing).filter((l) => l.engineListingId.length > 0);
}

/** Extract the current common levers from a raw Wheelhouse listing object. */
export function mapWheelhouseLevers(raw: unknown): EngineLevers {
  return {
    base: toNum(pickFirst(raw, ["base_price", "base"])),
    min: toNum(pickFirst(raw, ["min_price", "min", "minimum_price"])),
    max: toNum(pickFirst(raw, ["max_price", "max", "maximum_price"])),
    minStay: toPosInt(pickFirst(raw, ["min_stay", "default_min_stay", "minimum_stay"]))
  };
}

/** Wheelhouse demand/recommended signals (occupancy not exposed the same way). */
export function mapWheelhouseSignals(raw: unknown): EngineSignals {
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

function priceRowIsOverride(row: unknown): boolean {
  const flag = toBool(pickFirst(row, ["is_customized", "override", "is_override", "customized"]));
  if (flag === true) return true;
  const userPrice = toNum(pickFirst(row, ["user_price", "fixed_price", "manual_price"]));
  return userPrice !== null && userPrice > 0;
}

/**
 * Map a Wheelhouse `price_calendar` payload to per-date rows. Multi-unit
 * listings return one row per unit (`unit_number`) — preserved on each row so
 * downstream learning can pool occupancy across units (spec §2.2).
 */
export function mapWheelhousePriceCalendar(payload: unknown): EnginePriceCalendarDay[] {
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(pick(payload, "price_calendar"))
      ? (pick(payload, "price_calendar") as unknown[])
      : Array.isArray(pick(payload, "data"))
        ? (pick(payload, "data") as unknown[])
        : [];
  const out: EnginePriceCalendarDay[] = [];
  for (const row of arr) {
    const date = toDateOnly(pick(row, "date"));
    if (!date) continue;
    out.push({
      date,
      price: toNum(pickFirst(row, ["price", "recommended_price", "posted_price"])),
      minStay: toPosInt(pickFirst(row, ["min_stay", "minimum_stay"])),
      isOverride: priceRowIsOverride(row),
      unitNumber: toNum(pickFirst(row, ["unit_number", "unit"]))
    });
  }
  return out;
}

/** Map a Wheelhouse `recent_changes` payload to common change events. */
export function mapWheelhouseRecentChanges(payload: unknown): EngineRecentChange[] {
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(pick(payload, "recent_changes"))
      ? (pick(payload, "recent_changes") as unknown[])
      : Array.isArray(pick(payload, "data"))
        ? (pick(payload, "data") as unknown[])
        : [];
  const out: EngineRecentChange[] = [];
  for (const row of arr) {
    const at = toDate(pickFirst(row, ["timestamp", "changed_at", "date", "created_at"]));
    if (!at) continue;
    out.push({ at, lever: toStr(pickFirst(row, ["field", "lever", "type", "change_type"])) ?? "price" });
  }
  return out;
}
