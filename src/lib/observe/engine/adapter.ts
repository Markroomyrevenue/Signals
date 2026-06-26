/**
 * The engine-agnostic adapter contract (SIGNALS-OBSERVE-LEARN-SPEC.md §2.3).
 *
 * A single interface so all learning logic is engine-blind. Map each engine into
 * this once; everything downstream stays the same when a client switches engine.
 * Every method is READ-ONLY — no method here mutates the engine (the push stage
 * is a separate, later, per-client switch; spec §9). Implementations live in
 * `pricelabs.ts` (verified) and `wheelhouse.ts` (built, dormant until a valid
 * key is supplied).
 */

import type {
  AdapterEngineKind,
  EngineLevers,
  EngineListing,
  EnginePriceCalendarDay,
  EngineRecentChange,
  EngineSignals
} from "./types";

export interface PricingEngineAdapter {
  readonly engine: AdapterEngineKind;

  /** All listings the key scopes to (id, name, geo, beds, base, min, max, channel). */
  listClients(): Promise<EngineListing[]>;

  /** Current common levers for one listing. */
  fetchLevers(engineListingId: string): Promise<EngineLevers>;

  /** Per-date price, min-stay, and override flag from the engine's calendar. */
  fetchPriceCalendar(
    engineListingId: string,
    fromDate: string,
    days: number
  ): Promise<EnginePriceCalendarDay[]>;

  /** The engine's own demand view + its recommended base for one listing. */
  fetchEngineSignals(engineListingId: string): Promise<EngineSignals>;

  /**
   * The engine's recent lever moves. PriceLabs has no event endpoint, so this
   * is derived from `last_refreshed_at` / `last_date_pushed`; Wheelhouse uses
   * `/recent_changes`. Used for change-source inference (spec §6).
   */
  fetchRecentChanges(engineListingId: string): Promise<EngineRecentChange[]>;
}

/** Re-export the common shapes so callers import them from one place. */
export type {
  EngineLevers,
  EngineListing,
  EnginePriceCalendarDay,
  EngineRecentChange,
  EngineSignals
};
