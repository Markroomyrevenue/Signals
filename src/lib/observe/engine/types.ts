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
