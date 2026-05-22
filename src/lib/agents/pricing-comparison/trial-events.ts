/**
 * Trial-scoped local events source for the KeyData comparison agent.
 *
 * **Important:** this is a DIFFERENT source from `settings.localEvents`
 * on purpose. `settings.localEvents` is consumed by the production
 * pricing path (`pricing-report-assembly.ts` → `buildPricingCalendarRows`
 * → which feeds the calendar UI's `recommendedRate` AND the
 * `executePushRates` push-service that writes to Hostaway for any
 * listing with `hostawayPushEnabled === true`). Loading Fleadh into
 * `settings.localEvents` would therefore change the rate pushed to
 * Hostaway for any listing on the Belfast trial tenants that has push
 * enabled (today: only `hostawayId=513515` per the 2026-04-28 decision
 * log, but the architecture would propagate Fleadh to any future
 * push-enabled listing automatically — exactly what the spec asks
 * us to avoid).
 *
 * The trial comparison agent uses THIS file, not `settings.localEvents`,
 * so the events here are visible only inside `runComparisonForTenant`
 * and the trial report. They cannot reach a Hostaway write under any
 * code path.
 *
 * Tunable values live as named constants at the top so a future tuning
 * session can adjust them without re-discovering the trace.
 *
 * 2026-05-22: Mark approved a Fleadh lift of +40% per Step A diagnostic.
 *   - Engine demand-multiplier is pinned at the floor (1.0) on 100% of
 *     Fleadh-week cells — KD OTA forward RevPAR-adj reads early-Aug as
 *     SOFT (supply dilution). So the event lever carries the whole
 *     Fleadh lift, NOT a residual on top of partially-firing demand.
 *   - Pre-change Fleadh-week gap vs PL: LF -42.98%, SB -25.09%. With
 *     +40% on top of the existing seasonality (LF ~1.20, SB ~1.35) +
 *     occupancy (~1.0) stack, expected post-change:
 *       LF: -43% → ~-20% (still partly base-shaped; not over-correcting)
 *       SB: -25% → ~+5%  (lands within ±10% PL, no overshoot)
 *   - Capped at +60% per the spec's artifact guard.
 */

import type { PricingLocalEvent } from "@/lib/pricing/settings";
import type { TrialTenantInfo } from "@/lib/pricing/trial-tenants";

/** Hard upper bound on any single trial event's adjustment, as artifact guard. */
export const TRIAL_EVENT_ADJUSTMENT_PCT_CAP = 60;

/**
 * Fleadh Cheoil 2026 — the All-Ireland Traditional Music Festival,
 * Belfast 2026-08-02 to 2026-08-09. ~1M visitors expected; OTA forward
 * occupancy is structurally event-blind at 60-90 days lead time because
 * supply expands ahead of the event, diluting the occupancy %. The
 * within-year RevPAR-adj would catch it, but the demand multiplier's
 * trailing-12mo baseline is taken across all of Belfast which averages
 * down the spike. A curated event lift is the right mechanism here
 * (see DECISIONS.md 2026-05-20 "Build a proper events feature").
 *
 * `adjustmentPct: 40` chosen 2026-05-22 from the Step A diagnostic —
 * see file header for the arithmetic.
 */
const FLEADH_2026: PricingLocalEvent = {
  id: "trial-fleadh-2026",
  name: "Fleadh Cheoil 2026 (Belfast)",
  startDate: "2026-08-02",
  endDate: "2026-08-09",
  adjustmentPct: 40,
  dateSelectionMode: "range"
};

/**
 * All Belfast trial events. Today: Fleadh only — per the spec, no other
 * event is loaded in this session.
 *
 * Both Belfast trial tenants (Stay Belfast Apartments, Little Feather
 * Management) receive the same event list. If the trial later wants
 * per-tenant divergence (e.g. a Stay-Belfast-only event), refactor to a
 * `Map<tenantId, PricingLocalEvent[]>` keyed on the trial-tenant info.
 */
const BELFAST_TRIAL_EVENTS: PricingLocalEvent[] = [FLEADH_2026];

/**
 * Resolve trial-only events for a given trial tenant. Returns an empty
 * array for any caller that isn't a Belfast trial tenant — defensive,
 * since the comparison agent only runs against trial tenants in the
 * first place. Apply each event's `adjustmentPct` via the shared
 * `eventAdjustmentForDate(events, dateIso)` helper.
 *
 * Any event with `Math.abs(adjustmentPct) > TRIAL_EVENT_ADJUSTMENT_PCT_CAP`
 * is dropped at runtime with a console.warn — the cap is a structural
 * guard against a fat-finger config (e.g. typing 400 instead of 40)
 * affecting downstream tomorrow.
 */
export function getTrialLocalEventsForTenant(_tenant: TrialTenantInfo): PricingLocalEvent[] {
  return BELFAST_TRIAL_EVENTS.filter((event) => {
    if (Math.abs(event.adjustmentPct) > TRIAL_EVENT_ADJUSTMENT_PCT_CAP) {
      console.warn(
        `[trial-events] dropping event "${event.name}" — adjustmentPct=${event.adjustmentPct} exceeds the ±${TRIAL_EVENT_ADJUSTMENT_PCT_CAP}% trial cap`
      );
      return false;
    }
    return true;
  });
}
