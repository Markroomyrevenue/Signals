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
 * ## 2026-05-22 evening — per-night, per-tenant rewrite
 *
 * The 2026-05-22 mid-morning Fleadh lever was a single flat +40% across
 * the whole week, shared by both tenants. The available-nights fix
 * (later same day) gave the first clean per-night view and the picture
 * is split four ways:
 *
 *   1. Mon–Wed of Fleadh week aren't event-driven — demand multiplier
 *      sits near 1.0 (LF Mon-Tue 0.955-0.957, SB Mon-Tue 1.116-1.001).
 *      KD OTA + own portfolio fill peer-medians say those mid-week
 *      nights are ordinary, not festival. A +40% event there over-fires.
 *   2. The opening Sunday 02-Aug also reads ordinary (demand 1.117 LF
 *      / 1.133 SB) — Fleadh hasn't started yet on the lead-in night.
 *   3. Thu-Sun pin the demand multiplier at its 1.40 ceiling on both
 *      tenants on EVERY available cell. With the +40% event, the
 *      chain hits the base × 2.5 daily-rate clamp. The remaining
 *      residual to PL is the base-price gap — particularly on LF
 *      where PL/base reaches 3.39× on Sat 08-08.
 *   4. SB and LF need very different adjustments: SB's demand signal
 *      now catches Fleadh natively (cross-sectional 2026-05-22 PM),
 *      so +40% on top overshoots on most peak nights; LF needs the
 *      full cap to close the residual after the base-price drag.
 *
 * So this file now holds PER-TENANT, PER-NIGHT adjustments. Each
 * adjustment is a single-date event (range [date, date]) so the
 * shared `eventAdjustmentForDate` helper picks exactly the right one.
 * Nights with 0% adjustment have NO entry — the helper returns null
 * → `localEventAdjPct: null` → `eventMult = 1.0` in computeTrialDailyRate.
 *
 * ### Sizing arithmetic (from Phase A diagnostic, 2026-05-22 evening)
 *
 * Each peak night's adjustment was sized by:
 *   chain_without_event = current_chain / 1.4
 *   adj_needed = (PL / chain_without_event) - 1, capped at +60%
 *
 * | Tenant | Date  | DoW | base | chain w/o ev | PL  | PL/chain | chosen |
 * |---|---|---|---|---|---|---|---|
 * | LF | 08-06 | Thu | 145 | 251 | 326 | 1.30 | **+30%** → ~PL |
 * | LF | 08-07 | Fri | 138 | 241 | 405 | 1.68 | **+60%** (cap) — residual ~-5% |
 * | LF | 08-08 | Sat | 137 | 242 | 463 | 1.91 | **+60%** (cap) — residual ~-16% (BASE-PRICE PROBLEM) |
 * | LF | 08-09 | Sun | 152 | 261 | 287 | 1.10 | **0%** — chain w/o ev lands ~-9% (within ±10%) |
 * | SB | 08-06 | Thu | 161 | 302 | 355 | 1.18 | **+15%** → ~-2% |
 * | SB | 08-07 | Fri | 156 | 290 | 425 | 1.47 | **+50%** → ~+2% |
 * | SB | 08-08 | Sat | 157 | 283 | 350 | 1.24 | **+25%** → ~+1% |
 * | SB | 08-09 | Sun | 146 | 278 | 245 | 0.88 | **0%** — chain w/o ev still overshoots by +13% (PL drops post-Fleadh; can't tune without touching demand) |
 *
 * Mon-Wed (08-03 / 08-04 / 08-05) and the lead-in Sun (08-02) carry
 * NO event for either tenant. LF on those nights will under-price PL
 * by ~38-40% — that is the LF base-price residual to flag for the
 * next session. Do not paper over it with the event lever.
 *
 * ## 2026-05-23 — LF event re-sizing on the four-rung-ladder base
 *
 * The four-rung base ladder (computeTrialBase rewrite, same date) lifted
 * the LF Castle Buildings 1-bed base from £132 (mean) up to £155-£171
 * (mean ~£160) — closing the base-price problem flagged in the 2026-05-22
 * sizing table above. The Thu/Fri Fleadh events sized against the OLD
 * base are now over-firing on LF (Thu +24% over PL, Fri +13% over PL on
 * the highest-base apt). Re-sized against the new chains:
 *
 * | Date  | DoW | old size | new chain (apt avg) | PL  | old delta | new size | new delta target |
 * |---|---|---|---|---|---|---|---|
 * | LF 08-06 | Thu | +30% | ~£373 (over by +15%) | £323 | +15%  | **+15%** | ~-1% (median) |
 * | LF 08-07 | Fri | +60% | ~£459 (over by +6%)  | £434 | +6%   | **+50%** | ~-1% (median) |
 * | LF 08-08 | Sat | +60% | ~£456 (under by -9%) | £500 | -9%   | **+60%** (cap held) | -9% (no change — still under) |
 * | LF 08-09 | Sun | 0%   | ~£287 (over by +1%)  | £283 | +1%   | **0%** | +1% (no change) |
 *
 * SB sizings carry over unchanged — SB base barely moved (£144 → £144-£156)
 * and SB Thu 08-06 currently lands -1.9% vs PL on the only available cell.
 * Fri/Sat SB cells are mostly booked so cannot be re-calibrated from data;
 * keeping prior sizes preserves the calibration arithmetic from 2026-05-22.
 */

import type { PricingLocalEvent } from "@/lib/pricing/settings";
import type { TrialTenantInfo } from "@/lib/pricing/trial-tenants";

/** Hard upper bound on any single trial event's adjustment, as artifact guard. */
export const TRIAL_EVENT_ADJUSTMENT_PCT_CAP = 60;

/** Build a single-date event helper — DRY for the per-night entries below. */
function nightEvent(args: { id: string; name: string; date: string; adjustmentPct: number }): PricingLocalEvent {
  return {
    id: args.id,
    name: args.name,
    startDate: args.date,
    endDate: args.date,
    adjustmentPct: args.adjustmentPct,
    dateSelectionMode: "range"
  };
}

const FLEADH_2026_LITTLE_FEATHER: PricingLocalEvent[] = [
  // Mon-Wed + Sun-02 + Sun-09: no entry → 0% lift. With the 2026-05-23
  // four-rung-ladder base lift, LF Mon-Wed nights are no longer the
  // -38% base-price problem they were on 2026-05-22.
  // Re-sized 2026-05-23 PM on the new £155-£171 LF base (see file
  // header for the per-day chain-vs-PL table).
  nightEvent({ id: "trial-fleadh-2026-lf-thu", name: "Fleadh Cheoil 2026 — Thu 06-Aug (LF)", date: "2026-08-06", adjustmentPct: 15 }),
  nightEvent({ id: "trial-fleadh-2026-lf-fri", name: "Fleadh Cheoil 2026 — Fri 07-Aug (LF)", date: "2026-08-07", adjustmentPct: 50 }),
  nightEvent({ id: "trial-fleadh-2026-lf-sat", name: "Fleadh Cheoil 2026 — Sat 08-Aug (LF)", date: "2026-08-08", adjustmentPct: 60 })
  // Sun 09-Aug: no entry; chain without event lands +1% on PL on the new
  // base — well within ±10%, no event needed.
];

const FLEADH_2026_STAY_BELFAST: PricingLocalEvent[] = [
  // Mon-Wed + Sun-02 + Sun-09: no entry. SB Mon-Wed land ~-15 to -2% vs PL
  // (within or close to ±20%). Sun-09 overshoots +13% but can't be
  // tuned without touching demand (spec forbids); accepted residual.
  nightEvent({ id: "trial-fleadh-2026-sb-thu", name: "Fleadh Cheoil 2026 — Thu 06-Aug (SB)", date: "2026-08-06", adjustmentPct: 15 }),
  nightEvent({ id: "trial-fleadh-2026-sb-fri", name: "Fleadh Cheoil 2026 — Fri 07-Aug (SB)", date: "2026-08-07", adjustmentPct: 50 }),
  nightEvent({ id: "trial-fleadh-2026-sb-sat", name: "Fleadh Cheoil 2026 — Sat 08-Aug (SB)", date: "2026-08-08", adjustmentPct: 25 })
];

/**
 * Resolve trial-only events for a given trial tenant. Returns an empty
 * array for tenants not in the trial. Each event is a single-date
 * entry (range [date, date]) so the shared `eventAdjustmentForDate`
 * helper picks exactly one (or none) per target date.
 *
 * Any event with `Math.abs(adjustmentPct) > TRIAL_EVENT_ADJUSTMENT_PCT_CAP`
 * is dropped at runtime with a console.warn — the cap is a structural
 * guard against a fat-finger config (e.g. typing 400 instead of 40).
 */
export function getTrialLocalEventsForTenant(tenant: TrialTenantInfo): PricingLocalEvent[] {
  let events: PricingLocalEvent[];
  if (tenant.slug.startsWith("little-feather")) {
    events = FLEADH_2026_LITTLE_FEATHER;
  } else if (tenant.slug.startsWith("stay-belfast")) {
    events = FLEADH_2026_STAY_BELFAST;
  } else {
    events = [];
  }
  return events.filter((event) => {
    if (Math.abs(event.adjustmentPct) > TRIAL_EVENT_ADJUSTMENT_PCT_CAP) {
      console.warn(
        `[trial-events] dropping event "${event.name}" — adjustmentPct=${event.adjustmentPct} exceeds the ±${TRIAL_EVENT_ADJUSTMENT_PCT_CAP}% trial cap`
      );
      return false;
    }
    return true;
  });
}
