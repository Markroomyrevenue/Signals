/**
 * Engine-agnostic common types for the observe-and-learn layer.
 *
 * All learning logic is engine-blind: PriceLabs and Wheelhouse are each mapped
 * ONCE into these shapes (SIGNALS-OBSERVE-LEARN-SPEC.md §2.3) and everything
 * downstream stays the same when a client switches engine. `hostaway-scan` is
 * the read-only fallback source (Corrie Doon) that reads live Hostaway rates via
 * the existing rate-scanner rather than an engine API.
 */

/** The three observation sources. Only the first two are full engine adapters. */
export type EngineKind = "pricelabs" | "wheelhouse" | "hostaway-scan";

/** Only the two real engine APIs implement the adapter contract. */
export type AdapterEngineKind = "pricelabs" | "wheelhouse";

/** One listing as the engine sees it (identity + current levers + geo/size). */
export type EngineListing = {
  /** The engine's own listing id (PriceLabs `id` / Wheelhouse `listing_id`). */
  engineListingId: string;
  /**
   * The listing id on the connected channel/PMS, when the engine exposes one.
   * Verified live on Wheelhouse (2026-07-18): with `channel=hostaway` the
   * top-level `id` IS the Hostaway listing id (Wheelhouse's internal id is the
   * separate `wheelhouse_id`), so this equals `engineListingId` there. Optional
   * so engines without the concept (PriceLabs, whose `id` already is the PMS
   * id) need not populate it.
   */
  channelListingId?: string | null;
  name: string | null;
  /** The PMS the engine has the listing connected to (e.g. "hostaway"). */
  pms: string | null;
  /** Group / cluster id the engine assigns, when present. */
  groupId: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  bedrooms: number | null;
  base: number | null;
  min: number | null;
  max: number | null;
  /** Booking channel, when the engine scopes by channel (Wheelhouse). */
  channel: string | null;
  /** Number of active units (Wheelhouse multi-unit listings); 1 when single. */
  unitCount: number | null;
  pushEnabled: boolean | null;
  recommendedBase: number | null;
  lastRefreshedAt: Date | null;
  lastDatePushed: string | null;
};

/** The current common levers for one listing. */
export type EngineLevers = {
  base: number | null;
  min: number | null;
  max: number | null;
  minStay: number | null;
};

/** One per-date row of the engine's price calendar. */
export type EnginePriceCalendarDay = {
  date: string; // yyyy-mm-dd
  price: number | null;
  minStay: number | null;
  isOverride: boolean;
  /** Multi-unit engines emit one row per unit; null for single-unit. */
  unitNumber: number | null;
};

/** The engine's own demand view + its recommended base. */
export type EngineSignals = {
  recommendedBase: number | null;
  occNext7: number | null;
  occNext30: number | null;
  occNext60: number | null;
  marketOccNext7: number | null;
  marketOccNext30: number | null;
  marketOccNext60: number | null;
};

/** One "the engine moved a lever" event derived from the engine's own timing. */
export type EngineRecentChange = {
  at: Date;
  lever: string;
};

/**
 * One row of the engine's base-price model history (Wheelhouse
 * `GET /listings/{id}/base_price_history`; field shapes verified live
 * 2026-07-18). All values nullable — the model omits fields on some days.
 */
export type EngineBasePriceHistoryRow = {
  modelDate: string; // yyyy-mm-dd
  /** The model's untouched recommendation before user adjustment. */
  rawRecommendation: number | null;
  /** The recommendation after the user's adjustment multiplier. */
  recommendation: number | null;
  /** The user's adjustment multiplier (1 = untouched). */
  adjustment: number | null;
  /** A user-fixed base price, when the user has pinned one. */
  fixed: number | null;
  anchorPrice: number | null;
  anchorWeight: number | null;
  /** The base price actually in effect on the model date. */
  effectiveBasePrice: number | null;
};

/** One observation of a stay date's calendar at a point in time. */
export type EngineCalendarObservation = {
  observedAt: string; // ISO timestamp
  price: number | null;
  /** Multi-unit engines observe per unit; null when single-unit. */
  unitNumber: number | null;
};

/**
 * How one stay date's calendar looked over time (Wheelhouse
 * `GET /listings/{id}/calendar_day_history`, which returns `posted_prices[]`
 * + `calendar_snapshots[]` for a single `stay_date`; verified live 2026-07-18).
 */
export type EngineCalendarDaySnapshot = {
  stayDate: string; // yyyy-mm-dd
  /** The most recently observed calendar price for the stay date. */
  price: number | null;
  /** Calendar observations over time, oldest first (per unit for multi-unit). */
  history: EngineCalendarObservation[];
  /** Prices the engine actually posted to the channel, oldest first. */
  posted: Array<{ observedAt: string; price: number | null }>;
};

/** The last price the engine posted to the channel for one stay date (+unit). */
export type EngineLastPostedPrice = {
  stayDate: string; // yyyy-mm-dd
  price: number | null;
  /** Multi-unit engines post per unit; null when single-unit. */
  unitNumber: number | null;
};

/**
 * One reservation as the engine sees it (Wheelhouse
 * `GET /listings/{id}/reservations`; verified live 2026-07-18). Mappers keep
 * this trimmed and deliberately drop guest PII (confirmation codes, comments).
 */
export type EngineReservationRow = {
  id: string;
  checkIn: string | null; // yyyy-mm-dd (engine `start_date`)
  checkOut: string | null; // yyyy-mm-dd (engine `end_date`)
  status: string | null;
  /** When the guest booked (engine `booked_at`). */
  bookedAt: string | null;
  /** When the engine first saw the reservation (engine `created_at`). */
  createdAt: string | null;
  totalPrice: number | null;
  nightlySubtotal: number | null;
  currency: string | null;
  numGuests: number | null;
  /** Booking source/channel name (e.g. "bookingcom"). */
  sourceName: string | null;
  raw?: unknown;
};

/**
 * One day of the engine's neighborhood/market view. A single shape covers both
 * the pricing and the occupancy endpoints — each fills its own fields and
 * leaves the other side null.
 */
export type EngineNeighborhoodDay = {
  date: string; // yyyy-mm-dd
  medianPrice: number | null;
  lowPrice: number | null;
  highPrice: number | null;
  /** How many neighborhood listings the day's stats are drawn from. */
  listingsCount: number | null;
  occupancy: number | null; // 0..1
  /** Occupancy adjusted for the engine's blocked/owner-stay filtering. */
  adjustedOccupancy: number | null; // 0..1
  raw?: unknown;
};

/**
 * Optional capability: engines that expose their model / posting / booking
 * history for warm-starting recommendations. All read-only. Adapters that
 * support it implement this ALONGSIDE `PricingEngineAdapter` — the required
 * adapter contract is unchanged.
 */
export interface EngineHistoryReader {
  fetchBasePriceHistory(
    engineListingId: string,
    startDate?: string,
    endDate?: string
  ): Promise<EngineBasePriceHistoryRow[]>;

  /**
   * How one stay date's calendar evolved. Wheelhouse requires a `stay_date`;
   * when omitted the adapter defaults to today (UTC).
   */
  fetchCalendarSnapshots(
    engineListingId: string,
    stayDate?: string
  ): Promise<EngineCalendarDaySnapshot[]>;

  fetchLastPostedPrices(engineListingId: string): Promise<EngineLastPostedPrice[]>;

  fetchReservations(
    engineListingId: string,
    startDate?: string,
    endDate?: string
  ): Promise<EngineReservationRow[]>;
}

/** Optional capability: engines that expose a neighborhood/market view. */
export interface EngineNeighborhoodReader {
  fetchNeighborhoodPricing(engineListingId: string): Promise<EngineNeighborhoodDay[]>;
  fetchNeighborhoodOccupancy(engineListingId: string): Promise<EngineNeighborhoodDay[]>;
}
