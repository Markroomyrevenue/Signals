/**
 * Wheelhouse → common-lever mapping (PURE; no network).
 *
 * From the published RM API (SIGNALS-OBSERVE-LEARN-SPEC.md §2.2), with field
 * shapes verified against the LIVE API on 2026-07-18 (Coorie Doon read key,
 * listing 407381, channel=hostaway) for /listings, base_price_history,
 * calendar_day_history, last_posted_prices, reservations, and
 * neighborhood/{pricing,occupancy}. Multi-unit listings emit one row per
 * `unit_number` wherever units appear (price calendar, calendar snapshots,
 * last posted prices).
 */

import { pick, pickFirst, toBool, toDate, toDateOnly, toNum, toPosInt, toStr } from "./coerce";
import type {
  EngineBasePriceHistoryRow,
  EngineCalendarDaySnapshot,
  EngineCalendarObservation,
  EngineLastPostedPrice,
  EngineLevers,
  EngineListing,
  EngineNeighborhoodDay,
  EnginePriceCalendarDay,
  EngineRecentChange,
  EngineReservationRow,
  EngineSignals
} from "./types";

/**
 * Live `GET /listings` (verified 2026-07-18, Coorie Doon key) nests the current
 * levers under `listing_preferences` (`base_price`, `min_price`, `minimum_stay`,
 * `automatic_rate_posting_enabled`) and geo under `location`. The flat aliases
 * are kept first so older/other payload shapes still map.
 */
function listingPrefs(raw: unknown): unknown {
  return pick(raw, "listing_preferences");
}

/** Map one raw Wheelhouse listing object to the common `EngineListing`. */
export function mapWheelhouseListing(raw: unknown): EngineListing {
  const prefs = listingPrefs(raw);
  const location = pick(raw, "location");
  return {
    engineListingId: toStr(pickFirst(raw, ["listing_id", "id"])) ?? "",
    // Verified live 2026-07-18: the top-level `id` is the CHANNEL's listing id
    // (with channel=hostaway it is the Hostaway id, e.g. 407381 ↔ Wheelhouse's
    // own `wheelhouse_id` 62500081). `channel_ids` only carries the wheelhouse
    // id, so `id` is the one field pairing a listing back to the PMS.
    channelListingId: toStr(pick(raw, "id")),
    name: toStr(pickFirst(raw, ["name", "listing_name", "title"])),
    pms: toStr(pickFirst(raw, ["pms", "source", "channel_manager"])),
    groupId: toStr(pickFirst(raw, ["group_id", "cluster_id"])),
    city: toStr(pickFirst(raw, ["city", "city_name"])),
    latitude: toNum(pick(raw, "latitude")) ?? toNum(pick(location, "latitude")),
    longitude: toNum(pick(raw, "longitude")) ?? toNum(pick(location, "longitude")),
    bedrooms: toNum(pickFirst(raw, ["number_of_bedrooms", "bedrooms", "no_of_bedrooms", "num_bedrooms"])),
    base: toNum(pickFirst(raw, ["base_price", "base"])) ?? toNum(pick(prefs, "base_price")),
    min: toNum(pickFirst(raw, ["min_price", "min", "minimum_price"])) ?? toNum(pick(prefs, "min_price")),
    max: toNum(pickFirst(raw, ["max_price", "max", "maximum_price"])) ?? toNum(pick(prefs, "max_price")),
    channel: toStr(pick(raw, "channel")),
    unitCount: toNum(pickFirst(raw, ["number_of_active_units", "active_units", "unit_count"])),
    pushEnabled:
      toBool(pickFirst(raw, ["sync_enabled", "push_enabled", "is_synced"])) ??
      toBool(pick(prefs, "automatic_rate_posting_enabled")),
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
  const prefs = listingPrefs(raw);
  return {
    base: toNum(pickFirst(raw, ["base_price", "base"])) ?? toNum(pick(prefs, "base_price")),
    min: toNum(pickFirst(raw, ["min_price", "min", "minimum_price"])) ?? toNum(pick(prefs, "min_price")),
    max: toNum(pickFirst(raw, ["max_price", "max", "maximum_price"])) ?? toNum(pick(prefs, "max_price")),
    minStay:
      toPosInt(pickFirst(raw, ["min_stay", "default_min_stay", "minimum_stay", "base_min_night_stay"])) ??
      toPosInt(pick(prefs, "minimum_stay"))
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

/** Unwrap a bare array or a `{ <key>: [...] }` envelope to rows. */
function envelopeArray(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    const value = pick(payload, key);
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Map a `GET /listings/{id}/base_price_history` payload (bare array; verified
 * live 2026-07-18) to model-history rows. Rows without a model date drop.
 */
export function mapWheelhouseBasePriceHistory(payload: unknown): EngineBasePriceHistoryRow[] {
  const out: EngineBasePriceHistoryRow[] = [];
  for (const row of envelopeArray(payload, ["base_price_history", "data"])) {
    const modelDate = toDateOnly(pickFirst(row, ["model_date", "date"]));
    if (!modelDate) continue;
    out.push({
      modelDate,
      rawRecommendation: toNum(pick(row, "raw_recommendation")),
      recommendation: toNum(pick(row, "recommendation")),
      adjustment: toNum(pick(row, "adjustment")),
      fixed: toNum(pick(row, "fixed")),
      anchorPrice: toNum(pick(row, "anchor_price")),
      anchorWeight: toNum(pick(row, "anchor_weight")),
      effectiveBasePrice: toNum(pick(row, "effective_base_price"))
    });
  }
  return out;
}

/** Chronological sort key for an ISO timestamp string (unparseable → epoch 0). */
function observedAtMs(observedAt: string): number {
  const d = toDate(observedAt);
  return d ? d.getTime() : 0;
}

/**
 * Map a `GET /listings/{id}/calendar_day_history` payload to day snapshots.
 * The live endpoint (verified 2026-07-18) returns ONE object per requested
 * `stay_date` — `{ stay_date, posted_prices: [{posted_at, posted_price}],
 * calendar_snapshots: [{created_at, price, unit_number, ...}] }` — but a bare
 * array of such objects is also accepted. Multi-unit listings snapshot per
 * `unit_number`; preserved on each history entry. The headline `price` is the
 * most recently observed calendar price.
 */
export function mapWheelhouseCalendarDayHistory(payload: unknown): EngineCalendarDaySnapshot[] {
  const objs = Array.isArray(payload) ? payload : payload !== null && payload !== undefined ? [payload] : [];
  const out: EngineCalendarDaySnapshot[] = [];
  for (const obj of objs) {
    const stayDate = toDateOnly(pick(obj, "stay_date"));
    if (!stayDate) continue;

    const history: EngineCalendarObservation[] = [];
    for (const snap of envelopeArray(pick(obj, "calendar_snapshots"), [])) {
      const observedAt = toStr(pickFirst(snap, ["created_at", "observed_at", "timestamp"]));
      if (!observedAt) continue;
      history.push({
        observedAt,
        price: toNum(pick(snap, "price")),
        unitNumber: toNum(pickFirst(snap, ["unit_number", "unit"]))
      });
    }
    history.sort((a, b) => observedAtMs(a.observedAt) - observedAtMs(b.observedAt));

    const posted: EngineCalendarDaySnapshot["posted"] = [];
    for (const row of envelopeArray(pick(obj, "posted_prices"), [])) {
      const observedAt = toStr(pickFirst(row, ["posted_at", "timestamp"]));
      if (!observedAt) continue;
      posted.push({ observedAt, price: toNum(pickFirst(row, ["posted_price", "price"])) });
    }
    posted.sort((a, b) => observedAtMs(a.observedAt) - observedAtMs(b.observedAt));

    const latest = history.length > 0 ? history[history.length - 1] : null;
    out.push({ stayDate, price: latest ? latest.price : null, history, posted });
  }
  return out;
}

/**
 * Map a `GET /listings/{id}/last_posted_prices` payload (bare array of
 * `{ stay_date, unit_number, last_posted_price }`; verified live 2026-07-18)
 * to per-date/per-unit rows.
 */
export function mapWheelhouseLastPostedPrices(payload: unknown): EngineLastPostedPrice[] {
  const out: EngineLastPostedPrice[] = [];
  for (const row of envelopeArray(payload, ["last_posted_prices", "data"])) {
    const stayDate = toDateOnly(pickFirst(row, ["stay_date", "date"]));
    if (!stayDate) continue;
    out.push({
      stayDate,
      price: toNum(pickFirst(row, ["last_posted_price", "price"])),
      unitNumber: toNum(pickFirst(row, ["unit_number", "unit"]))
    });
  }
  return out;
}

/**
 * Map a `GET /listings/{id}/reservations` payload (bare array; verified live
 * 2026-07-18) to trimmed reservation rows. Guest PII (confirmation code,
 * comments) is deliberately NOT carried through — `raw` stays unset.
 */
export function mapWheelhouseReservations(payload: unknown): EngineReservationRow[] {
  const out: EngineReservationRow[] = [];
  for (const row of envelopeArray(payload, ["reservations", "data"])) {
    const id = toStr(pickFirst(row, ["id", "reservation_id"]));
    if (!id) continue;
    out.push({
      id,
      checkIn: toDateOnly(pickFirst(row, ["start_date", "check_in"])),
      checkOut: toDateOnly(pickFirst(row, ["end_date", "check_out"])),
      status: toStr(pick(row, "status")),
      bookedAt: toStr(pick(row, "booked_at")),
      createdAt: toStr(pick(row, "created_at")),
      totalPrice: toNum(pick(row, "total_price")),
      nightlySubtotal: toNum(pick(row, "nightly_subtotal")),
      currency: toStr(pick(row, "currency")),
      numGuests: toNum(pick(row, "num_guests")),
      sourceName: toStr(pick(row, "source_name"))
    });
  }
  return out;
}

/**
 * Map a `GET /listings/{id}/neighborhood/pricing` payload
 * (`{ data: [{ stay_date, median_price, low_price, high_price,
 * listings_count }], currency }`; verified live 2026-07-18) to neighborhood
 * days. Occupancy fields stay null — that is the sibling endpoint.
 */
export function mapWheelhouseNeighborhoodPricing(payload: unknown): EngineNeighborhoodDay[] {
  const out: EngineNeighborhoodDay[] = [];
  for (const row of envelopeArray(payload, ["data", "neighborhood_pricing"])) {
    const date = toDateOnly(pickFirst(row, ["stay_date", "date"]));
    if (!date) continue;
    out.push({
      date,
      medianPrice: toNum(pick(row, "median_price")),
      lowPrice: toNum(pick(row, "low_price")),
      highPrice: toNum(pick(row, "high_price")),
      listingsCount: toNum(pick(row, "listings_count")),
      occupancy: null,
      adjustedOccupancy: null
    });
  }
  return out;
}

/**
 * Map a `GET /listings/{id}/neighborhood/occupancy` payload
 * (`{ data: [{ stay_date, occupancy, adjusted_occupancy, ... }] }`; verified
 * live 2026-07-18) to neighborhood days. Price fields stay null.
 */
export function mapWheelhouseNeighborhoodOccupancy(payload: unknown): EngineNeighborhoodDay[] {
  const out: EngineNeighborhoodDay[] = [];
  for (const row of envelopeArray(payload, ["data", "neighborhood_occupancy"])) {
    const date = toDateOnly(pickFirst(row, ["stay_date", "date"]));
    if (!date) continue;
    out.push({
      date,
      medianPrice: null,
      lowPrice: null,
      highPrice: null,
      listingsCount: null,
      occupancy: toNum(pick(row, "occupancy")),
      adjustedOccupancy: toNum(pick(row, "adjusted_occupancy"))
    });
  }
  return out;
}
