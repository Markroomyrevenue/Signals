/**
 * KeyData trial pricing module.
 *
 * Implements §3.1–§3.5 of the trial spec as a single, testable function:
 *  - Base recommendation (own ADR 0.55 + KeyData P50 0.30 + size 0.15, then quality tier × multiplier, round)
 *  - Data-led minimum: max(base × 0.7, KeyData P20 × similarity-weighted average)
 *  - Effective minimum applied in code = max(recommendedMin, userSetMin)
 *  - Daily rate = base × seasonality × DoW × demand × occupancy × leadTimeFloor × events × pace
 *  - Each multiplier is a pure function with documented bounds and graceful null handling.
 *  - Mode toggle (conservative/standard/aggressive/manual) compresses or extends the ladder per §3.5.
 *
 * The module produces the full breakdown so the comparison agent and the
 * defensibility audit can attribute every disagreement to a specific input.
 *
 * It does NOT touch the existing `pricing-report-assembly.ts` pipeline —
 * non-trial tenants keep their current behaviour exactly. The comparison
 * agent and the backtest harness call this module directly when the
 * tenant is in the trial.
 */

import type {
  KeyDataDayOfWeekIndex,
  KeyDataForwardPace,
  KeyDataMarketBenchmark,
  KeyDataSeasonalityIndex
} from "@/lib/pricing/keydata-provider";

export type TrialMode = "conservative" | "standard" | "aggressive" | "manual";

export type TrialQualityTier = "low_scale" | "mid_scale" | "upscale";

export type TrialSimilarityScore = number; // 0..1

export type TrialDailyInput = {
  /** Listing identity */
  listingId: string;
  bedrooms: number;
  qualityTier: TrialQualityTier;
  /** ISO date "YYYY-MM-DD" */
  date: string;
  /** Days from snapshot date to target date (≥0) */
  daysToCheckIn: number;
  /** Day-of-week, 0=Sun..6=Sat */
  dayOfWeek: number;
  /** Month index 0..11 */
  monthIndex: number;
  /** Trailing 365d own ADR for this listing */
  trailing365dAdr: number | null;
  /** Trailing 365d own occupancy fraction (0-1) */
  trailing365dOccupancy: number | null;
  /**
   * Portfolio-aggregated own-history monthly seasonality index for this
   * month. Per 2026-05-21 spec — seasonality is a market property, not
   * a per-listing property; aggregating across the tenant's listings
   * smooths small-sample artifacts (the wild 3.19 single-listing tail
   * the pre-2026-05-21 per-listing version produced).
   */
  ownSeasonalityIndex: number | null;
  /**
   * Booked nights for this month, portfolio-aggregated across the
   * tenant's listings over the trailing 365-day window. Drives the
   * sample-gated own/KD blend in `blendSeasonality`. `null` is
   * treated as "no sample" → falls back to KD-led blend.
   */
  ownSeasonalitySampleSize: number | null;
  /** Listing's own day-of-week multiplier (subject's own history) */
  ownDoWIndex: number | null;
  /**
   * Trailing-365d sold-night count for this listing. Drives the rung-1
   * confidence (full rung-1 at ≥100 nights, slide to rung 3/4 below
   * SOLD_NIGHTS_FULL_CONFIDENCE, no own weight at all below
   * SOLD_NIGHTS_FLOOR). Added 2026-05-23 for the four-rung base ladder.
   */
  trailing365dSoldNights: number | null;
  /**
   * KeyData trailing-12mo median market occupancy — reference for the
   * rung-1 occupancy-lift ratio. Resolved in agent.ts from
   * `KeyDataTrailingMarketKpis.trailingMedianOccupancy`. When null,
   * `portfolioMedianOccupancy` is used as a fallback.
   */
  marketMedianOccupancy: number | null;
  /**
   * Tenant-portfolio median occupancy fallback — used when KD market
   * occupancy is null (e.g. KD outage). Resolved in agent.ts.
   */
  portfolioMedianOccupancy: number | null;
  /**
   * Rung-3 comparable inheritance anchor — mean of same-`group:`-tag +
   * same-bedrooms siblings' rung-1 anchors. Resolved in agent.ts; null
   * when no cluster exists or no sibling has rich own history. Used
   * as the residual signal when own history is thin.
   */
  compAnchor: number | null;
  /**
   * Manual base-anchor override. When set, REPLACES the computed base
   * entirely (manual_anchor rung). Plumbed for product completeness;
   * intentionally unset on every trial listing today — the trial must
   * measure the engine, not hand-typed numbers.
   */
  manualBaseAnchor: number | null;
  /**
   * Vestigial — the 0.15-weight "size anchor" blend term was retired
   * 2026-05-23. Field kept on the input shape for backward compat with
   * any caller that still populates it; ignored by the new base.
   */
  listingSizeAnchor: number | null;
  /** Manual seasonality monthly adjustment % (e.g. -10..+10) — applied multiplicatively after blend */
  manualSeasonalityAdjPct: number;
  /** Manual day-of-week adjustment % — applied multiplicatively after blend */
  manualDoWAdjPct: number;
  /** Local event adjustment %, already resolved for this date (null if none) */
  localEventAdjPct: number | null;
  /**
   * Cross-sectional demand inputs (2026-05-22 rebuild). The agent
   * resolves these from `cross-sectional-demand.ts` before calling
   * `computeTrialDailyRate`. Set to null deltas + zero sample sizes
   * when no signal is available — the demand multiplier falls back
   * to 1.0 gracefully.
   */
  demandCrossSectional: {
    ownDelta: number | null;
    ownPeerSampleSize: number;
    ownTargetFill: number | null;
    ownPeerMedianFill: number | null;
    kdRevparDelta: number | null;
    kdAdrDelta: number | null;
    kdSupplyDelta: number | null;
    kdEffectiveDelta: number | null;
    kdSupplyGuardTriggered: boolean;
    kdPeerSampleSize: number;
    /**
     * Phase C calendar/holiday demand layer (2026-05-24). Per-cell
     * delta from `holiday-calendar.ts` when the target date is
     * inside a known recurring-holiday window; null otherwise.
     *
     * Horizon handoff is clean: this delta ONLY contributes when
     * BOTH `ownDelta` and `kdEffectiveDelta` are null (Phase B
     * sufficiency gate fired). When pace has data, calendar is
     * IGNORED — no multiplicative double-count.
     */
    calendarFallbackDelta?: number | null;
    /** Optional label for the report (e.g. "Christmas (NI) 2026"). */
    calendarFallbackLabel?: string | null;
  };
  /** Pace multiplier from existing pace logic (1.0 if disabled) */
  paceMultiplier: number;
  /** Current scope occupancy fraction (0-1) */
  scopeOccupancy: number | null;
  /** User-set hard floor (existing minimumPriceOverride) */
  userSetMinimum: number | null;
  /** Rounding step (e.g. 1, 5, 10) */
  roundingIncrement: number;
  /** Mode for this scope */
  mode: TrialMode;
};

export type TrialMarketSnapshot = {
  benchmark: KeyDataMarketBenchmark | null;
  /**
   * 1-bedroom Belfast P50 — used as the denominator for the cross-
   * bedroom size-anchor ratio. When present, listingSizeAnchor is
   * computed as `ownAdr × benchmark.p50 / benchmark1br.p50`, so a
   * 2br on a portfolio with own data closer to 1br rates still gets
   * lifted toward the KD-observed 2br market level.
   */
  benchmark1br: KeyDataMarketBenchmark | null;
  seasonality: KeyDataSeasonalityIndex | null;
  dayOfWeek: KeyDataDayOfWeekIndex | null;
  forwardPace: KeyDataForwardPace | null;
  /**
   * Trailing 52-week market summary. Powers two things:
   *   - The trailing-baseline half of the demand multiplier (we
   *     measure forward dates' lift vs this median, NOT just vs LY).
   *   - The KD-derived monthly seasonality index used by
   *     blendSeasonality.
   */
  trailingMarketKpis: import("@/lib/pricing/keydata-provider").KeyDataTrailingMarketKpis | null;
  /** Quality of the comparable cohort (0..1). Higher = trust KeyData more. */
  benchmarkSimilarity: TrialSimilarityScore;
  /** Trailing-90-day market occupancy distribution: bottom-quartile cutoff. */
  marketOcc25thPct: number | null;
  /** Trailing-90-day market rate-per-occupancy median. */
  marketRpoMedian: number | null;
  /** Trailing-90-day RPO for the target date. */
  marketRpoForDate: number | null;
  /** Forward market occupancy for the target date. */
  marketForwardOccForDate: number | null;
};

export type TrialMultiplierBreakdown = {
  base: number;
  recommendedMinimum: number;
  effectiveMinimum: number;
  seasonality: number;
  seasonalityBlend: { ownWeight: number; marketWeight: number; manualPct: number };
  /** True when the blended seasonality was clamped down to SEASONALITY_CEIL. */
  seasonalityCeilingHit: boolean;
  seasonalityFloorHit: boolean;
  /** Raw inputs to the seasonality blend — null when the source wasn't available. */
  seasonalityOwn: number | null;
  seasonalityKd: number | null;
  /**
   * Portfolio-aggregated own-history booked-night count for this month
   * — drives the sample-gated own/KD weighting (added 2026-05-21).
   * `null` when the source wasn't available (manual mode, or no own
   * seasonality input).
   */
  seasonalityOwnSampleSize: number | null;
  /** True when the own sample met SEASONALITY_OWN_SAMPLE_GATE → own-led weights. */
  seasonalityOwnSampleAboveGate: boolean;
  dayOfWeek: number;
  dayOfWeekBlend: { ownWeight: number; marketWeight: number; manualPct: number };
  dayOfWeekCeilingHit: boolean;
  dayOfWeekFloorHit: boolean;
  dayOfWeekOwn: number | null;
  dayOfWeekKd: number | null;
  demand: number;
  demandReasoning: string;
  /**
   * Surfaced for the 31-90d trough diagnostic. The "LY" and
   * "trail12mo" values are retained in the union for backward
   * compatibility on snapshot rows written before the respective
   * rewrites; current rebuild (2026-05-22 cross-sectional) emits
   * "own" / "kd" / "both" / "none".
   */
  demandDominantSignal: "LY" | "trail12mo" | "own" | "kd" | "both" | "none" | "calendar";
  demandRawDelta: number | null;
  demandPassThrough: number;
  demandCeilingHit: boolean;
  demandFloorHit: boolean;
  // 2026-05-22 cross-sectional rebuild — per-side inputs to the demand
  // blend, surfaced so the trough report can attribute "this lift came
  // from own / kd / both".
  demandOwnDelta: number | null;
  demandOwnPeerSampleSize: number;
  demandOwnTargetFill: number | null;
  demandOwnPeerMedianFill: number | null;
  demandKdRevparDelta: number | null;
  demandKdAdrDelta: number | null;
  demandKdSupplyDelta: number | null;
  demandKdEffectiveDelta: number | null;
  demandKdSupplyGuardTriggered: boolean;
  demandKdPeerSampleSize: number;
  demandOwnWeight: number;
  demandKdWeight: number;
  occupancy: number;
  occupancyBucketMin: number;
  occupancyBucketMax: number;
  leadTimeFloor: number;
  leadTimeGate: { propertyOccLow: boolean; marketOccLow: boolean; marketRpoBelowMedian: boolean; engaged: boolean };
  events: number;
  pace: number;
  ladderMode: TrialMode;
};

export type TrialDailyResult = {
  recommendedRate: number;
  recommendedRateBeforeClamp: number;
  recommendedMinimum: number;
  effectiveMinimum: number;
  base: number;
  breakdown: TrialMultiplierBreakdown;
  notes: string[];
};

const QUALITY_TIER_MULTIPLIER: Record<TrialQualityTier, number> = {
  low_scale: 0.95,
  mid_scale: 1.0,
  upscale: 1.1
};

// Bounds per §3.3.
const SEASONALITY_FLOOR = 0.75;
// Ceiling raised 1.50 → 1.80 on 2026-05-21. Per
// TONIGHT-SEASONALITY-FIX-2026-05-21.md: with portfolio-aggregated
// own-history (which removes the wild 3.19 single-listing artifact
// from the 60/40-era data) a higher ceiling is safe and lets genuine
// summer signal land. Not uncapped — a portfolio-aggregated index
// above 1.80 still warrants a clamp as an artifact guard.
const SEASONALITY_CEIL = 1.8;

// Seasonality blend — sample-gated own/KD weighting (2026-05-21).
// Replaces the previous fixed 60/40 own/KD blend, which let flat
// KeyData seasonality (mean 1.06 across the Belfast trough) dilute
// genuine own-history summer signal (mean 1.16) down to 1.12. Per
// the standing principle in DECISIONS.md ("when our own booked data
// has a dense enough sample size we should be using it; KeyData is
// fallback"), own-history leads when its monthly sample backs it.
//
// Threshold is per-month booked-night count, portfolio-aggregated
// across the trial tenant's listings (see
// loadOwnHistoryPortfolioSeasonality in
// src/lib/agents/pricing-comparison/agent.ts). Calibrated against
// Belfast trough months: 30 nights/month over a 365-day window is
// roughly one paid stay per listing per month for a 10-listing
// portfolio, dense enough to be stable.
const SEASONALITY_OWN_SAMPLE_GATE = 30;
const SEASONALITY_WEIGHTS_OWN_LED = { own: 0.85, market: 0.15 } as const;
const SEASONALITY_WEIGHTS_OWN_SPARSE = { own: 0.4, market: 0.6 } as const;

// blendDayOfWeek clamp band. The upper bound (DOW_CEIL) must continue
// to match the upstream cap in dow-multiplier.ts (DOW_LEARNED_MAX) —
// otherwise a tenant whose data lands at the upstream cap gets
// re-clamped downstream and loses signal.
//
// History:
//   - 1.20 → 1.35 on 2026-05-27 AM to match the original [0.85, 1.35]
//     upstream cap (SB had raw Sat above 1.35 and the 1.20 downstream
//     cut half the signal).
//   - 0.85 / 1.35 → 0.75 / 1.50 on 2026-05-27 PM to track the
//     widened upstream cap. SB Mon-Thu at the old 0.85 floor still
//     read +12.7% over PL post-AM-ship → data wants lower; SB Sat
//     at 1.35 still read -27.2% under PL → data wants higher. The
//     listing's min/max price overrides are the customer-facing
//     safety; these are the engine's outer artifact guards.
//   - DOW_FLOOR 0.75 → 0 on 2026-05-27 PM (FLOOR REMOVAL). Per Mark's
//     standing principle ("min-price override is the customer-facing
//     safety; internal engine floors should not actively bind"), the
//     downstream DoW floor is removed. The listing's per-tenant
//     `minimumPriceOverride` clamps the FINAL rate; this multiplier-
//     level floor was a redundant artefact guard. `floorHit` reporting
//     is kept on the breakdown shape for backward compat but is now
//     effectively dead (raw is always positive). The upstream
//     dow-multiplier.ts cap [DOW_LEARNED_MIN, DOW_LEARNED_MAX] still
//     bounds the LEARNED-per-tenant DoW table before it reaches this
//     function; this constant is the DOWNSTREAM bound at blend time.
//     DOW_CEIL retained — the ceiling is symmetric with the demand
//     ceiling, both stay as artefact guards.
const DOW_FLOOR = 0;
const DOW_CEIL = 1.50;

// Demand-multiplier coefficients. Pass-through is the share of a unit
// `demandDelta` that flows into the final multiplier; the result is then
// clamped to [DEMAND_FLOOR, DEMAND_CEIL].
//
// History:
//   - Raised 0.5 → 0.7 on 2026-05-19 to address the 31-90d trough where
//     recommendations sat 20-29% below PL even when KD demand was
//     pointing the right direction — the previous pass-through was
//     capping us at the +15% ceiling too easily on event-weighted weeks.
//   - Reduced 0.7 → 0.5 on 2026-05-27 alongside the DoW-multiplier
//     reinstatement and per-DoW curve partition — the 0.5 muted the
//     contaminated own-pace blend so neither source dominated.
//   - 2026-05-27 PM — DEPRECATED: own-pace removed from the demand
//     multiplier (it was redundant with the occupancy multiplier and
//     the only source of RM-improvement bias). With KD as the sole
//     demand input, the muting is no longer needed; `KD_PASS_THROUGH`
//     (below, = 1.0) replaces this. The constant is kept temporarily
//     for backward-compat with the breakdown shape (`demandPassThrough`
//     field) and to make the rollback easier if signal-quality on
//     KD-only proves insufficient. Cleanup pass will remove.
/** @deprecated 2026-05-27 PM — superseded by KD_PASS_THROUGH=1.0. */
const DEMAND_PASS_THROUGH = 0.5;

/**
 * Full pass-through on the KD demand signal (2026-05-27 PM).
 *
 * adr_unbooked (the KD primary metric since 2026-05-27 AM) is the
 * market's calendar asking-rate — independent of booking volume,
 * uncontaminated by RM-improvement bias, the cleanest demand signal
 * we have. With own-pace removed from the demand multiplier in this
 * ship, the 50/50 muting that was needed to balance the contaminated
 * pace against KD is no longer needed.
 *
 * 1.0 means: adr_unbooked +25% above peer median → raw demand
 * multiplier 1.25 (clamped at DEMAND_CEIL=1.40). adr_unbooked -25%
 * below → raw 0.75 (NO floor binding post-2026-05-27 PM removal — the
 * listing's per-tenant minimum-price override is the customer-facing
 * safety on rate descent). The booking-window corroborator bonus
 * (max +0.10) is added pre-pass-through, so a corroborated +25% lift
 * can reach raw 1.35 (still inside the ceiling).
 *
 * DEMAND_CEIL (1.40) remains as the upper artefact guard. DEMAND_FLOOR
 * is REMOVED (set to 0) per Mark's standing principle that engine
 * constants are outer guards and the listing's min/max-price overrides
 * are the customer-facing safety — a multiplier-level floor was
 * redundant once min-price-override is wired and the KD 48h fallback
 * (`keydata-fallback.ts`, shipped 2026-05-27 PM) covers outage-class
 * glitches.
 */
const KD_PASS_THROUGH = 1.0;
// Demand multiplier outer artefact guards.
//
// History:
//   - Floor restored 1.0 → 0.92 on 2026-05-22 with the cross-sectional
//     rebuild. Rationale at the time: the 2026-05-20 floor=1.0 was to
//     stop the forward-vs-trailing comparison dragging prices DOWN on
//     every date (structural lead-time emptiness artifact). The
//     cross-sectional comparison has no such bias — a date BELOW its
//     same-month peers is genuinely below them.
//   - Ceiling raised 1.15 → 1.40 on 2026-05-19 — the old +15% clamp
//     was binding on the trough cells we most want to lift.
//   - Floor lowered 0.92 → 0.80 on 2026-05-27 PM after the
//     cap-widening verification surfaced demand floor as the dominant
//     binding constraint: 52.2% of 31-90d trough cells (5028 / 9636)
//     were pinned at the 0.92 floor on today's report — meaning the
//     pace + KD signal collectively said "this date is materially
//     below curve" and was being held UP by the artefact guard.
//   - Floor REMOVED 0.80 → 0 on 2026-05-27 PM (later same day). Per
//     Mark's standing principle: the customer-facing safety against
//     undesirable rate descent is the per-listing `minimumPriceOverride`
//     setting (production-side, untouched), which clamps the FINAL
//     daily rate. The demand-multiplier-level floor was a redundant
//     internal artefact guard. The just-shipped KD 48h fallback
//     (`keydata-fallback.ts`) covers outage-class KD glitches — a
//     real KD outage now reads the last-known-good signal, not a
//     spurious 1.0-or-bust. In-band KD noise (e.g. a single cell with
//     adr_unbooked -50% on a real day) is intentionally allowed to
//     produce a low demand multiplier; the per-listing minimum is
//     the right place to truncate downside, not a global constant.
//     `floorHit` reporting is kept on the breakdown shape for
//     backward compat but is now effectively dead (raw is always
//     positive). Ceiling unchanged.
//   - Ceiling held at 1.40: only 0.7% of trough cells hit the
//     ceiling on today's report — the upper bound is not binding,
//     so widening it doesn't materially change anything. Not
//     touched this run; revisit only if ceiling-hit % climbs.
const DEMAND_FLOOR = 0;
const DEMAND_CEIL = 1.4;

// Cross-sectional demand blend weights and gates (2026-05-22).
//
// The demand multiplier is now a weighted blend of two cross-sectional
// signals — each measuring a target date's deviation from its same-
// calendar-month peer dates, observed at the current snapshot:
//   - Own portfolio fill (nights-on-books / supply) — the tenant's
//     actual fill curve; cancels Mark's RM offset because we compare
//     the portfolio to itself across dates.
//   - KeyData market RPA — the Belfast OTA-wide RevPAR-adjusted signal
//     decomposed into occ/ADR/supply for the supply guard.
//
// Equal weighting on both sources at full sample. Own portfolio has
// fewer peers (~30 dates of the same month) but is the right shape
// for our customers; KD has the same peer count but a much larger
// underlying sample (~200 listings per peer date). Both signals
// being above peers should produce a larger lift than either alone
// — this happens naturally with the linear blend before clamp.
//
// 2026-05-27 PM — DEPRECATED. Own-pace removed from the demand
// multiplier (redundant with the occupancy multiplier; only source of
// RM-improvement bias). KD is now the sole demand input at full
// pass-through (`KD_PASS_THROUGH`). Constants kept temporarily for
// the breakdown shape's backward-compat and to make rollback easier;
// cleanup pass will remove them.
/** @deprecated 2026-05-27 PM — own-pace removed from demand multiplier. */
const DEMAND_OWN_WEIGHT = 0.5;
/** @deprecated 2026-05-27 PM — KD is now the sole demand input at full pass-through. */
const DEMAND_KD_WEIGHT = 0.5;

/**
 * Daily-rate upper clamp, expressed as a multiple of the base price.
 *
 * Two values, picked per cell by whether the night is event-flagged
 * (i.e. covered by a non-zero trial-event adjustment).
 *
 * Per Mark's standing principle: the listing's per-tenant maximum-
 * price override (`settings.maximumPriceOverride` on the production
 * path) is the customer-facing safety on the ceiling. These constants
 * are the engine's OUTER ARTIFACT GUARDS — wide enough that the
 * data-led chain (base × seasonality × DoW × demand × occupancy ×
 * event × pace) can land at PriceLabs-grade peaks (PL prices ~4×
 * base on truly hot nights), narrow enough that a single mis-firing
 * signal can't run unbounded. The chain math itself IS the
 * corroboration mechanism — to reach 4×, multiple multipliers must
 * compound simultaneously (each is independently bounded), so a
 * widened outer clamp doesn't expose us to a single-signal failure
 * mode.
 *
 * History:
 *   - NORMAL was the long-standing base × 2.5 since trial start.
 *   - EVENT raised 2.5 → 3.5 on 2026-05-22 PM so Fleadh Sat (PL/base
 *     = 3.39×) could price through.
 *   - NORMAL 2.5 → 4.0 and EVENT 3.5 → 5.0 on 2026-05-27 PM after
 *     PL was observed at ~4× base on non-event hot nights and we
 *     could not match it; the chain was being clipped at 2.5 even
 *     with every multiplier pointing up.
 *
 * "Event-flagged" = `input.localEventAdjPct !== null && adjPct !== 0`.
 * A night the trial events source explicitly skips (Mon-Wed of Fleadh,
 * post-Fleadh Sun) gets null/0 → falls back to NORMAL.
 */
const NORMAL_NIGHT_RATE_MULTIPLE = 4.0;
const EVENT_NIGHT_RATE_MULTIPLE = 5.0;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function roundToIncrement(value: number, increment: number): number {
  if (increment <= 0) return Math.round(value);
  return Math.round(value / increment) * increment;
}

// ---------------------------------------------------------------------------
// 3.1 — base recommendation (2026-05-23 four-rung redesign)
//
// Replaces the 2026-04-28 0.55/0.30/0.15 own/KD/size blend. The old
// blend had two opposite failure modes — it dragged genuine winners
// DOWN by re-recommending their (under-priced) own ADR (Castle
// Buildings 1-beds: own £127 at 84% occ → re-recommended £132 vs PL
// £165), and propped genuine weak listings UP via the 30% KeyData
// market median weight (Templemore: own £107 / PL £108 → blended
// £134). The diagnostic confirmed both modes (BUILD-LOG
// 2026-05-23). Root cause: the base never read occupancy.
//
// The four-rung ladder reads occupancy and slides between four
// signals by confidence:
//
//   Rung 1 — Rich own history (`soldNights >= SOLD_NIGHTS_FULL_CONFIDENCE`):
//     Occupancy-adjusted own ADR. ownAdr is scaled by the ratio
//     `trailing365dOccupancy / marketMedianOccupancy`, clamped to a
//     gentle band, BUT only when ownAdr sits in the "modestly below
//     market" band [CHEAP_THRESHOLD × kdP50, kdP50]:
//       - ownAdr < CHEAP_THRESHOLD × kdP50  → genuinely cheap product
//         (Templemore: own/KD = 0.58); trust own, no lift.
//       - ownAdr ≥ kdP50                    → at or above market; trust
//         own, no lift.
//       - otherwise → apply the occupancy lift (Castle Buildings 1-beds).
//
//   Rung 2 — Thin own history (`SOLD_NIGHTS_FLOOR ≤ soldNights <
//     SOLD_NIGHTS_FULL_CONFIDENCE`):
//     Confidence = soldNights / SOLD_NIGHTS_FULL_CONFIDENCE. The
//     listing's own rung-1 anchor gets that weight; the residual
//     weight goes to rung 3 (if a comp anchor is available) or rung 4.
//     As bookings accumulate, weight slides toward own automatically.
//
//   Rung 3 — Comparable inheritance (any soldNights, comp anchor present):
//     `compAnchor` is computed in `agent.ts` from same-`group:`-tag +
//     same-bedrooms siblings with rich own history; their mean rung-1
//     anchor. Used as the residual signal when own is thin (rung 2).
//
//   Rung 4 — No own, no comps (`soldNights < SOLD_NIGHTS_FLOOR` AND
//     no compAnchor):
//     KeyData market P50 for the listing's bedroom band. Lowest
//     confidence; honest fallback.
//
// Manual anchor (`manualBaseAnchor`) sits BESIDE the ladder. When set,
// REPLACES the computed base entirely — for genuine no-data /
// private-knowledge cases. Plumbed but unset on every trial listing
// today; the trial measures the engine, not hand-typed numbers.
//
// Size anchor as a blend term is GONE. The diagnostic confirmed it
// added no independent information (it was just ownAdr × a KD bedroom
// ratio). Size is now a matching dimension in rungs 3 and 4 instead.
// ---------------------------------------------------------------------------

/** Sold-night thresholds for the rung-1 / rung-2 confidence slide. */
export const SOLD_NIGHTS_FULL_CONFIDENCE = 100;
/** Below this, ownAdr carries zero weight; rung 3 or 4 takes over fully. */
export const SOLD_NIGHTS_FLOOR = 20;
/**
 * `ownAdr < CHEAP_THRESHOLD × kdP50` → listing is in a fundamentally
 * cheaper segment than the bedroom band median (e.g. smaller / lower-
 * spec property). Trust own; do NOT apply the occupancy lift.
 * Calibrated against Templemore (own/KD = 0.58 → trust own = £107).
 */
const OWN_ADR_CHEAP_THRESHOLD = 0.70;
/**
 * Occupancy-lift mechanics. The factor is `1 + (occRatio - 1) × SLOPE`
 * clamped to [MIN_FACTOR, MAX_FACTOR].
 *   - SLOPE 0.20 + MAX 1.25 lifts Castle Buildings 1-beds (occRatio
 *     ≈ 2.18) by ~24% — from own £127 to ~£157, closing most of the
 *     gap to PL £165 without over-correcting SB Fitzrovia (occRatio
 *     ≈ 1.7 → ~17% lift, lands +3% to +7% over PL £150-153).
 *   - MIN 0.92 lets a low-occupancy listing in the modestly-below
 *     band get a small downward nudge (capped) — symmetric with the
 *     demand multiplier floor.
 *   - `marketMedianOccupancy` is the KD trailing-12mo market median;
 *     when null, falls back to the tenant's portfolio-median
 *     occupancy (passed in via input).
 */
const OCCUPANCY_LIFT_SLOPE = 0.20;
const OCCUPANCY_LIFT_MAX_FACTOR = 1.25;
const OCCUPANCY_LIFT_MIN_FACTOR = 0.92;

export type TrialBaseRung = "manual_anchor" | "rich_own" | "thin_own_blend" | "comp_inherit" | "kd_market" | "none";

export type TrialBaseInput = {
  trailing365dAdr: number | null;
  /** Trailing 365d sold-night count for the listing (rung selector). */
  trailing365dSoldNights: number | null;
  /** Trailing 365d occupancy fraction for the listing (rung-1 lift driver). */
  trailing365dOccupancy: number | null;
  /** KeyData market P50 for the listing's bedroom band. */
  marketP50: number | null;
  /**
   * KeyData trailing-12mo median occupancy for the market. Reference
   * point for the occupancy-lift ratio. When null, the caller passes
   * `portfolioMedianOccupancy` instead (or null if neither exists).
   */
  marketMedianOccupancy: number | null;
  /**
   * Tenant-portfolio median occupancy fallback when KD market occupancy
   * is null (cross-tenant outage). Logged for the diagnostic.
   */
  portfolioMedianOccupancy: number | null;
  /**
   * Rung 3 comp anchor — mean of same-`group:`-tag + same-bedrooms
   * siblings' rung-1 anchors. Resolved in `agent.ts`; null when no
   * cluster exists or no sibling has rich own history.
   */
  compAnchor: number | null;
  /**
   * Manual anchor override. When set, REPLACES the computed base
   * entirely (manual anchor rung). Default null; intentionally unset
   * on all trial listings — the trial measures the engine, not hand-
   * typed numbers.
   */
  manualBaseAnchor: number | null;
  qualityTier: TrialQualityTier;
  roundingIncrement: number;
};

export type TrialBaseResult = {
  base: number;
  /** Which rung produced the base. */
  rung: TrialBaseRung;
  /** Confidence weights placed on each rung's signal in the final blend. */
  weightsApplied: { ownAnchor: number; compAnchor: number; kdAnchor: number };
  /** Occupancy-lift factor applied to ownAdr (1.0 when no lift). */
  occupancyFactorApplied: number;
  /** Quality-tier multiplier applied at the end. */
  qualityMultiplier: number;
  /** True when marketMedianOccupancy was null and we fell back to portfolio. */
  fellBackToPortfolioOccupancy: boolean;
};

export function computeRung1OccupancyAdjustedOwnAdr(opts: {
  ownAdr: number;
  ownOccupancy: number | null;
  kdP50: number | null;
  marketMedianOccupancy: number | null;
  portfolioMedianOccupancy: number | null;
  /**
   * Comp-bounded lift ceiling (2026-05-25 over-base fix). When set,
   * the in-band occupancy lift is capped at `max(ownAdr, compAnchor)` —
   * the lift can push UP TO the comparable level but never past it.
   * Null = no comp set available → existing lift cap (factor clamp) only.
   *
   * Why: the lift treats any in-band listing with above-market occupancy
   * as underpriced and lifts it — but a budget listing genuinely
   * selling at its right price (high occupancy / low rate) gets
   * lifted past what its comparable listings achieve. Castle Buildings
   * (premium 1-bed comps £155-171) can still be lifted; City Gate
   * (budget 2-bed comps lower than the 2br KD P50) cannot be lifted
   * past its comp level.
   *
   * The comp is the same rung-3 comp anchor agent.ts pre-computes
   * (group: tag siblings; fallback to same-tenant + same-bedrooms
   * mean rung-1) — single source of truth.
   */
  compAnchor?: number | null;
}): { value: number; occupancyFactor: number; fellBackToPortfolio: boolean; compBounded: boolean } {
  // 1. No KD P50 → can't classify; trust own with no lift.
  if (opts.kdP50 === null || opts.kdP50 <= 0) {
    return { value: opts.ownAdr, occupancyFactor: 1.0, fellBackToPortfolio: false, compBounded: false };
  }
  // 2. Cheap segment — trust own, no lift.
  if (opts.ownAdr < opts.kdP50 * OWN_ADR_CHEAP_THRESHOLD) {
    return { value: opts.ownAdr, occupancyFactor: 1.0, fellBackToPortfolio: false, compBounded: false };
  }
  // 3. At or above market — trust own, no lift.
  if (opts.ownAdr >= opts.kdP50) {
    return { value: opts.ownAdr, occupancyFactor: 1.0, fellBackToPortfolio: false, compBounded: false };
  }
  // 4. In the "modestly below market" band — apply occupancy lift.
  const refOcc = opts.marketMedianOccupancy ?? opts.portfolioMedianOccupancy ?? null;
  const fellBackToPortfolio = opts.marketMedianOccupancy === null && opts.portfolioMedianOccupancy !== null;
  if (refOcc === null || refOcc <= 0 || opts.ownOccupancy === null || opts.ownOccupancy <= 0) {
    return { value: opts.ownAdr, occupancyFactor: 1.0, fellBackToPortfolio, compBounded: false };
  }
  const occRatio = opts.ownOccupancy / refOcc;
  const rawFactor = 1 + (occRatio - 1) * OCCUPANCY_LIFT_SLOPE;
  const factor = clamp(rawFactor, OCCUPANCY_LIFT_MIN_FACTOR, OCCUPANCY_LIFT_MAX_FACTOR);
  let lifted = opts.ownAdr * factor;
  let compBounded = false;
  if (opts.compAnchor !== null && opts.compAnchor !== undefined && Number.isFinite(opts.compAnchor) && opts.compAnchor > 0) {
    // Cap lift at max(own, comp). Lift can push UP to comp; never past.
    // max(own, comp) ensures we never DROP below the listing's own ADR —
    // the cap is upward-only.
    const ceiling = Math.max(opts.ownAdr, opts.compAnchor);
    if (lifted > ceiling) {
      lifted = ceiling;
      compBounded = true;
    }
  }
  return { value: lifted, occupancyFactor: factor, fellBackToPortfolio, compBounded };
}

export function computeTrialBase(input: TrialBaseInput): TrialBaseResult | null {
  // Manual anchor rung — short-circuit before any blending.
  if (input.manualBaseAnchor !== null && Number.isFinite(input.manualBaseAnchor) && input.manualBaseAnchor > 0) {
    const qualityMultiplier = QUALITY_TIER_MULTIPLIER[input.qualityTier] ?? 1.0;
    const adjusted = input.manualBaseAnchor * qualityMultiplier;
    return {
      base: roundToIncrement(adjusted, input.roundingIncrement),
      rung: "manual_anchor",
      weightsApplied: { ownAnchor: 0, compAnchor: 0, kdAnchor: 0 },
      occupancyFactorApplied: 1.0,
      qualityMultiplier,
      fellBackToPortfolioOccupancy: false
    };
  }

  const own = input.trailing365dAdr ?? null;
  const soldNights = input.trailing365dSoldNights ?? 0;
  const kdP50 = input.marketP50 ?? null;
  const comp = input.compAnchor ?? null;

  // Rung 1: occupancy-adjusted own ADR (only computable when ownAdr exists).
  let rung1: number | null = null;
  let occupancyFactor = 1.0;
  let fellBackToPortfolio = false;
  if (own !== null && own > 0) {
    const r = computeRung1OccupancyAdjustedOwnAdr({
      ownAdr: own,
      ownOccupancy: input.trailing365dOccupancy,
      kdP50,
      marketMedianOccupancy: input.marketMedianOccupancy,
      portfolioMedianOccupancy: input.portfolioMedianOccupancy,
      // Comp-bounded lift (2026-05-25). The comp anchor is also used
      // for rung 3 below; here it serves as the lift ceiling so an
      // in-band budget listing isn't lifted past what comparable
      // listings achieve.
      compAnchor: comp
    });
    rung1 = r.value;
    occupancyFactor = r.occupancyFactor;
    fellBackToPortfolio = r.fellBackToPortfolio;
  }

  // Rung 4: KD market P50 as the floor signal.
  const rung4 = kdP50 !== null && kdP50 > 0 ? kdP50 : null;

  // Confidence weight on own (rung 1).
  let ownConfidence: number;
  if (own === null || soldNights < SOLD_NIGHTS_FLOOR) {
    ownConfidence = 0;
  } else if (soldNights >= SOLD_NIGHTS_FULL_CONFIDENCE) {
    ownConfidence = 1;
  } else {
    ownConfidence = (soldNights - SOLD_NIGHTS_FLOOR) / (SOLD_NIGHTS_FULL_CONFIDENCE - SOLD_NIGHTS_FLOOR);
  }
  const residualWeight = 1 - ownConfidence;

  // Build the weighted blend. Residual goes to comp (rung 3) if present,
  // else to KD (rung 4). If neither rung 1 nor rungs 3/4 produce a value,
  // return null — the listing has nothing to anchor on.
  let totalWeight = 0;
  let weightedSum = 0;
  let ownAnchorWeight = 0;
  let compAnchorWeight = 0;
  let kdAnchorWeight = 0;

  if (rung1 !== null && ownConfidence > 0) {
    ownAnchorWeight = ownConfidence;
    weightedSum += rung1 * ownConfidence;
    totalWeight += ownConfidence;
  }
  if (residualWeight > 0) {
    if (comp !== null && comp > 0) {
      compAnchorWeight = residualWeight;
      weightedSum += comp * residualWeight;
      totalWeight += residualWeight;
    } else if (rung4 !== null) {
      kdAnchorWeight = residualWeight;
      weightedSum += rung4 * residualWeight;
      totalWeight += residualWeight;
    }
    // If neither comp nor rung4 fills the residual, the residual weight
    // is silently dropped and ownAnchorWeight carries everything that
    // resolved. Defensive — own at full weight is still a valid blend.
  }

  // Last-resort fallback: no own AND no residual fillers — try rung 4 alone.
  if (totalWeight === 0 && rung4 !== null) {
    kdAnchorWeight = 1;
    weightedSum = rung4;
    totalWeight = 1;
  }
  // Pure-own salvage when residual got dropped: rebalance so own carries 1.0.
  if (totalWeight > 0 && totalWeight < 1 && ownAnchorWeight > 0 && compAnchorWeight === 0 && kdAnchorWeight === 0) {
    ownAnchorWeight = 1;
    weightedSum = rung1 as number;
    totalWeight = 1;
  }

  if (totalWeight <= 0) return null;
  const blended = weightedSum / totalWeight;
  if (!Number.isFinite(blended) || blended <= 0) return null;

  const qualityMultiplier = QUALITY_TIER_MULTIPLIER[input.qualityTier] ?? 1.0;
  const adjusted = blended * qualityMultiplier;
  const base = roundToIncrement(adjusted, input.roundingIncrement);

  // Pick the rung label.
  let rung: TrialBaseRung;
  if (ownAnchorWeight >= 0.99) rung = "rich_own";
  else if (ownAnchorWeight > 0 && (compAnchorWeight > 0 || kdAnchorWeight > 0)) rung = "thin_own_blend";
  else if (compAnchorWeight > 0) rung = "comp_inherit";
  else if (kdAnchorWeight > 0) rung = "kd_market";
  else rung = "none";

  return {
    base,
    rung,
    weightsApplied: { ownAnchor: ownAnchorWeight, compAnchor: compAnchorWeight, kdAnchor: kdAnchorWeight },
    occupancyFactorApplied: occupancyFactor,
    qualityMultiplier,
    fellBackToPortfolioOccupancy: fellBackToPortfolio
  };
}

// ---------------------------------------------------------------------------
// 3.2 — minimum price (data-led)
//
// 2026-05-23 — sub-proposal E from the base-price diagnostic:
// the KeyData-P20 × similarity floor is now DISABLED when the listing's
// own ADR sits at or above the market median (ownAdr ≥ kdP50 × 1.05).
// Rationale: when the listing is already calibrated at/above market, the
// KD market floor is irrelevant and was previously pushing 2-bed mins
// ~16% over PL (Castle Buildings 2-beds: our £151 vs PL £130, driven by
// `KD P20 × similarity = 1.0` dominating `base × 0.7`). The 1.05
// hysteresis band prevents session-to-session flip at the boundary.
//
// When ownAdr is below the band (or missing), the old behaviour holds:
// `max(base × 0.7, KD P20 × similarity)`. The user override still only
// RAISES the floor, never lowers it.
// ---------------------------------------------------------------------------

/** Hysteresis: KD-P20 floor disabled only when ownAdr clearly above KD P50. */
const OWN_ADR_AT_OR_ABOVE_MARKET_HYSTERESIS = 1.05;

export function computeTrialMinimum(opts: {
  base: number;
  marketP20: number | null;
  marketP50: number | null;
  trailing365dAdr: number | null;
  benchmarkSimilarity: TrialSimilarityScore;
  userSetMinimum: number | null;
  roundingIncrement: number;
}): { recommendedMinimum: number; effectiveMinimum: number; kdFloorApplied: boolean } {
  const baseFloor = opts.base * 0.7;

  // Sub-proposal E gate: skip the KD-P20 floor when own ADR is clearly
  // at-or-above market — listing's already calibrated, market floor is
  // not protecting anything useful.
  const ownAtOrAboveMarket =
    opts.trailing365dAdr !== null &&
    Number.isFinite(opts.trailing365dAdr) &&
    opts.marketP50 !== null &&
    Number.isFinite(opts.marketP50) &&
    opts.marketP50 > 0 &&
    opts.trailing365dAdr >= opts.marketP50 * OWN_ADR_AT_OR_ABOVE_MARKET_HYSTERESIS;

  const marketFloor =
    !ownAtOrAboveMarket &&
    opts.marketP20 !== null &&
    Number.isFinite(opts.marketP20) &&
    opts.marketP20 > 0
      ? opts.marketP20 * clamp(opts.benchmarkSimilarity, 0, 1)
      : 0;

  const recommendedRaw = Math.max(baseFloor, marketFloor);
  const recommendedMinimum = roundToIncrement(recommendedRaw, opts.roundingIncrement);
  const userFloor = opts.userSetMinimum ?? 0;
  // §3.2: user override only RAISES the floor, never lowers it.
  const effectiveMinimum = Math.max(recommendedMinimum, userFloor);
  return { recommendedMinimum, effectiveMinimum, kdFloorApplied: marketFloor > 0 };
}

// ---------------------------------------------------------------------------
// 3.3 — daily multipliers
// ---------------------------------------------------------------------------

/**
 * Blend portfolio-aggregated own-history monthly index with the KeyData
 * monthly index using a sample-gated weighting (2026-05-21 spec).
 *
 * Weights chosen by `ownSampleSize` (booked nights in that month across
 * the tenant's listings over the trailing window):
 *   - own != null + market != null + sample >= SEASONALITY_OWN_SAMPLE_GATE
 *       → SEASONALITY_WEIGHTS_OWN_LED  (own 0.85 / market 0.15)
 *   - own != null + market != null + sample < gate
 *       → SEASONALITY_WEIGHTS_OWN_SPARSE  (own 0.40 / market 0.60 — KD-heavy fallback)
 *   - only market available → 100% market
 *   - only own available → 100% own (no KD signal to fall back on)
 *   - neither → 1.0 (no seasonality applied)
 *
 * Manual seasonality adjustment is applied multiplicatively AFTER the
 * blend. Final multiplier is clamped to [SEASONALITY_FLOOR,
 * SEASONALITY_CEIL]; clamp-hit flags are computed pre-clamp so the
 * trough diagnostic can show which cells WANTED to go further than the
 * structural bounds.
 */
export function blendSeasonality(opts: {
  ownSeasonalityIndex: number | null;
  marketSeasonalityIndex: number | null;
  /**
   * Booked nights backing the own-history monthly index for this
   * month, portfolio-aggregated across the tenant. `null` is treated
   * as "no sample" → falls back to KD-only (or 1.0 if KD missing too).
   * Replaces the previous boolean `ownSampleSizeOk`.
   */
  ownSampleSize: number | null;
  manualAdjPct: number;
}): {
  multiplier: number;
  ownWeight: number;
  marketWeight: number;
  ceilingHit: boolean;
  floorHit: boolean;
  /** Effective sample size used in the gating decision (0 when null). */
  ownSampleSize: number;
  /** True when sample met the SEASONALITY_OWN_SAMPLE_GATE threshold. */
  ownSampleAboveGate: boolean;
} {
  let mult = 1.0;
  let ownWeight = 0;
  let marketWeight = 0;
  const effectiveSample = opts.ownSampleSize ?? 0;
  const sampleAboveGate = effectiveSample >= SEASONALITY_OWN_SAMPLE_GATE;
  if (opts.ownSeasonalityIndex !== null && opts.marketSeasonalityIndex !== null) {
    const weights = sampleAboveGate ? SEASONALITY_WEIGHTS_OWN_LED : SEASONALITY_WEIGHTS_OWN_SPARSE;
    ownWeight = weights.own;
    marketWeight = weights.market;
    mult = opts.ownSeasonalityIndex * ownWeight + opts.marketSeasonalityIndex * marketWeight;
  } else if (opts.marketSeasonalityIndex !== null) {
    ownWeight = 0;
    marketWeight = 1;
    mult = opts.marketSeasonalityIndex;
  } else if (opts.ownSeasonalityIndex !== null) {
    ownWeight = 1;
    marketWeight = 0;
    mult = opts.ownSeasonalityIndex;
  }
  // Apply manual adjustment after the blend, multiplicatively.
  if (Number.isFinite(opts.manualAdjPct) && opts.manualAdjPct !== 0) {
    mult = mult * (1 + opts.manualAdjPct / 100);
  }
  // Track clamp hits BEFORE clamping so the trough diagnostic can show
  // which cells wanted to go further than the structural bounds allow.
  const ceilingHit = mult > SEASONALITY_CEIL;
  const floorHit = mult < SEASONALITY_FLOOR;
  return {
    multiplier: clamp(mult, SEASONALITY_FLOOR, SEASONALITY_CEIL),
    ownWeight,
    marketWeight,
    ceilingHit,
    floorHit,
    ownSampleSize: effectiveSample,
    ownSampleAboveGate: sampleAboveGate
  };
}

export function blendDayOfWeek(opts: {
  ownDoWIndex: number | null;
  marketDoWIndex: number | null;
  manualAdjPct: number;
}): { multiplier: number; ownWeight: number; marketWeight: number; ceilingHit: boolean; floorHit: boolean } {
  let mult = 1.0;
  let ownWeight = 0;
  let marketWeight = 0;
  if (opts.ownDoWIndex !== null && opts.marketDoWIndex !== null) {
    ownWeight = 0.5;
    marketWeight = 0.5;
    mult = opts.ownDoWIndex * 0.5 + opts.marketDoWIndex * 0.5;
  } else if (opts.marketDoWIndex !== null) {
    ownWeight = 0;
    marketWeight = 1;
    mult = opts.marketDoWIndex;
  } else if (opts.ownDoWIndex !== null) {
    ownWeight = 1;
    marketWeight = 0;
    mult = opts.ownDoWIndex;
  }
  if (Number.isFinite(opts.manualAdjPct) && opts.manualAdjPct !== 0) {
    mult = mult * (1 + opts.manualAdjPct / 100);
  }
  const ceilingHit = mult > DOW_CEIL;
  const floorHit = mult < DOW_FLOOR;
  return { multiplier: clamp(mult, DOW_FLOOR, DOW_CEIL), ownWeight, marketWeight, ceilingHit, floorHit };
}

/**
 * Demand multiplier — CROSS-SECTIONAL (2026-05-22 rewrite).
 *
 * Compares the target date to its same-calendar-month peer dates,
 * observed at the current snapshot. Two sources blended:
 *   - Own portfolio fill (`ownDelta`): target_fill / peer_median_fill - 1
 *   - KeyData market RPA (`kdEffectiveDelta`): target_rpa / peer_rpa - 1,
 *     damped by the supply guard when supply contracts >20% AND ADR
 *     is flat/down.
 *
 * Blend = OWN_WEIGHT × ownDelta + KD_WEIGHT × kdEffectiveDelta when
 * both available. When one is missing, the other carries full weight.
 * When both are missing → 1.0 with reasoning.
 *
 * Cross-sectional cancels the structural forward-still-filling-vs-
 * settled bias that floor-pinned the previous temporal demand signal
 * on 100% of forward dates. It also absorbs day-of-week variation
 * (Saturday naturally sits above its month median, Monday below),
 * which is why the automatic DoW multiplier is retired in parallel
 * with this rebuild.
 *
 * Floor lowered to 0.92 so weekday downside (Mon ~-8% vs month median)
 * is preserved — the old 1.0 floor would clamp ordinary Mondays back
 * to par.
 *
 * Graceful fallback to 1.0 when no signal is available, with a clear
 * reasoning string. No NaN under any input combination.
 */
export function computeDemandMultiplier(opts: {
  /** Own portfolio cross-sectional delta (target_fill / peer_median_fill - 1). */
  ownDelta: number | null;
  /** Number of peer dates contributing to the own baseline. */
  ownPeerSampleSize: number;
  /** Target fill rate. Informational. */
  ownTargetFill?: number | null;
  ownPeerMedianFill?: number | null;
  /** KeyData cross-sectional delta AFTER the supply guard. */
  kdEffectiveDelta: number | null;
  /** True when the supply guard fired (supply<-20% AND ADR flat/down). */
  kdSupplyGuardTriggered: boolean;
  /** Raw (pre-guard) RPA delta. Informational. */
  kdRevparDeltaRaw?: number | null;
  /** Raw ADR delta. Informational + used in reasoning. */
  kdAdrDelta?: number | null;
  /** Raw supply delta. Informational + reasoning. */
  kdSupplyDelta?: number | null;
  kdPeerSampleSize: number;
  /**
   * Phase C (2026-05-24): calendar/holiday demand delta. ONLY used
   * when BOTH pace signals are null (sufficiency gate fired) — the
   * calendar layer replaces the missing pace signal, never compounds
   * on top of an existing one. Null on non-holiday dates → falls
   * through to neutral 1.0.
   */
  calendarFallbackDelta?: number | null;
  /** Optional label for the calendar fallback (e.g. "Christmas (NI) 2026"). */
  calendarFallbackLabel?: string | null;
}): {
  multiplier: number;
  reasoning: string;
  /** Which side(s) drove the lift. */
  dominantSignal: "own" | "kd" | "both" | "none" | "calendar";
  /** Blended demand delta before pass-through + clamp. */
  rawDemandDelta: number | null;
  ownWeight: number;
  kdWeight: number;
  ceilingHit: boolean;
  floorHit: boolean;
} {
  // 2026-05-27 PM CONSOLIDATION: own-pace removed from the demand
  // multiplier. KD is the sole demand input. `ownDelta` etc. still
  // accepted on the opts (unused) for backward compat — the
  // booking-curve module + own pace are now dead code on the demand
  // path; cleanup pass will remove.
  const kdOk = opts.kdEffectiveDelta !== null && Number.isFinite(opts.kdEffectiveDelta);

  if (!kdOk) {
    // Calendar-holiday fallback (Phase C 2026-05-24): when KD is gated
    // out / missing, fall back to the calendar layer if this cell is
    // a known holiday date. Calendar fallback uses KD_PASS_THROUGH too
    // (full pass on the clean signal — same principle as the KD path).
    const calOk =
      opts.calendarFallbackDelta !== null &&
      opts.calendarFallbackDelta !== undefined &&
      Number.isFinite(opts.calendarFallbackDelta);
    if (calOk) {
      const calDelta = opts.calendarFallbackDelta as number;
      const raw = 1 + KD_PASS_THROUGH * calDelta;
      const clamped = clamp(raw, DEMAND_FLOOR, DEMAND_CEIL);
      const label = opts.calendarFallbackLabel ? opts.calendarFallbackLabel : "holiday";
      return {
        multiplier: clamped,
        reasoning:
          `kd gated out (peer n=${opts.kdPeerSampleSize}) → ` +
          `calendar fallback "${label}" Δ=${(calDelta * 100).toFixed(1)}% → raw=${raw.toFixed(3)} → clamp=${clamped.toFixed(3)}`,
        dominantSignal: "calendar",
        rawDemandDelta: calDelta,
        ownWeight: 0,
        kdWeight: 0,
        ceilingHit: raw > DEMAND_CEIL,
        floorHit: raw < DEMAND_FLOOR
      };
    }
    const reason = `no kd signal (peer n=${opts.kdPeerSampleSize}) — multiplier=1.0`;
    return {
      multiplier: 1.0,
      reasoning: reason,
      dominantSignal: "none",
      rawDemandDelta: null,
      ownWeight: 0,
      kdWeight: 0,
      ceilingHit: false,
      floorHit: false
    };
  }

  // KD-only path with full pass-through (2026-05-27 PM). The KD
  // effective delta already includes the booking-window corroborator
  // bonus AND any supply-guard damping (computed upstream in
  // computeKdCrossSectionalDelta). Here we just apply the
  // pass-through and the outer artefact-guard clamp.
  const blendedDelta = opts.kdEffectiveDelta as number;
  const raw = 1 + KD_PASS_THROUGH * blendedDelta;
  const clamped = clamp(raw, DEMAND_FLOOR, DEMAND_CEIL);
  const ceilingHit = raw > DEMAND_CEIL;
  const floorHit = raw < DEMAND_FLOOR;

  // Reasoning string is KD-only post-consolidation; own-pace fields
  // dropped. Surfaces: adr_unbooked peerΔ (carried in revparDelta name
  // for back-compat), supply-guard status, supply-guard bypass status,
  // adrΔ + supplyΔ for context, raw → clamp result.
  const kdPart =
    `kd peerΔ=${((opts.kdEffectiveDelta as number) * 100).toFixed(1)}%` +
    `${opts.kdSupplyGuardTriggered ? ` (SUPPLY-GUARD damped; raw adr_unbookedΔ=${opts.kdRevparDeltaRaw !== null && opts.kdRevparDeltaRaw !== undefined ? ((opts.kdRevparDeltaRaw as number) * 100).toFixed(1) + "%" : "?"})` : ""}` +
    ` (n=${opts.kdPeerSampleSize}` +
    `${opts.kdAdrDelta !== null && opts.kdAdrDelta !== undefined ? `, adrΔ=${((opts.kdAdrDelta as number) * 100).toFixed(1)}%` : ""}` +
    `${opts.kdSupplyDelta !== null && opts.kdSupplyDelta !== undefined ? `, supplyΔ=${((opts.kdSupplyDelta as number) * 100).toFixed(1)}%` : ""}` +
    `)`;

  const reasoning =
    `${kdPart} → raw=${raw.toFixed(3)} (pass-through=${KD_PASS_THROUGH.toFixed(2)}) → clamp=${clamped.toFixed(3)}` +
    `${ceilingHit ? " (CEILING hit)" : floorHit ? " (FLOOR hit)" : ""}`;

  return {
    multiplier: clamped,
    reasoning,
    dominantSignal: "kd",
    rawDemandDelta: blendedDelta,
    ownWeight: 0,
    kdWeight: 1,
    ceilingHit,
    floorHit
  };
}

const OCCUPANCY_LADDER_TRIAL_STANDARD: ReadonlyArray<{ maxPct: number; multiplier: number }> = [
  { maxPct: 10, multiplier: 0.88 },
  { maxPct: 20, multiplier: 0.9 },
  { maxPct: 30, multiplier: 0.92 },
  { maxPct: 40, multiplier: 0.94 },
  { maxPct: 50, multiplier: 0.96 },
  { maxPct: 60, multiplier: 1.0 },
  { maxPct: 70, multiplier: 1.02 },
  { maxPct: 80, multiplier: 1.05 },
  { maxPct: 90, multiplier: 1.08 },
  { maxPct: 100, multiplier: 1.12 }
];

function compressLadder(
  ladder: ReadonlyArray<{ maxPct: number; multiplier: number }>,
  factor: number
): ReadonlyArray<{ maxPct: number; multiplier: number }> {
  return ladder.map(({ maxPct, multiplier }) => ({
    maxPct,
    multiplier: 1 + (multiplier - 1) * factor
  }));
}

export function lookupTrialOccupancyMultiplier(
  occupancyPct: number | null,
  mode: TrialMode
): { multiplier: number; bucketMin: number; bucketMax: number } {
  if (occupancyPct === null) return { multiplier: 1.0, bucketMin: 0, bucketMax: 100 };
  if (mode === "manual") return { multiplier: 1.0, bucketMin: 0, bucketMax: 100 };
  const ladder =
    mode === "conservative"
      ? compressLadder(OCCUPANCY_LADDER_TRIAL_STANDARD, 0.667) // -8% to +8% from -12%/+12%
      : mode === "aggressive"
        ? compressLadder(OCCUPANCY_LADDER_TRIAL_STANDARD, 1.25) // -15%/+15%
        : OCCUPANCY_LADDER_TRIAL_STANDARD;
  const occ = clamp(occupancyPct * 100, 0, 100);
  let prevMax = 0;
  for (const rung of ladder) {
    if (occ <= rung.maxPct) return { multiplier: rung.multiplier, bucketMin: prevMax, bucketMax: rung.maxPct };
    prevMax = rung.maxPct;
  }
  const last = ladder[ladder.length - 1];
  return { multiplier: last.multiplier, bucketMin: prevMax, bucketMax: 100 };
}

export function computeLeadTimeFloor(opts: {
  daysToCheckIn: number;
  base: number;
  recommendedMinimum: number;
  scopeOccupancy: number | null;
  marketForwardOccForDate: number | null;
  marketOcc25thPct: number | null;
  marketRpoForDate: number | null;
  marketRpoMedian: number | null;
  mode: TrialMode;
}): { floor: number; gate: { propertyOccLow: boolean; marketOccLow: boolean; marketRpoBelowMedian: boolean; engaged: boolean } } {
  const PROPERTY_BOTTOM_QUARTILE = 0.25;
  const propertyOccLow = opts.scopeOccupancy !== null && opts.scopeOccupancy <= PROPERTY_BOTTOM_QUARTILE;
  const marketOccLow =
    opts.marketForwardOccForDate !== null &&
    opts.marketOcc25thPct !== null &&
    opts.marketForwardOccForDate <= opts.marketOcc25thPct;
  const marketRpoBelowMedian =
    opts.marketRpoForDate !== null && opts.marketRpoMedian !== null && opts.marketRpoForDate <= opts.marketRpoMedian;

  const allConditionsMet = propertyOccLow && marketOccLow && marketRpoBelowMedian;

  let floor = opts.recommendedMinimum;
  let engaged = false;

  if (opts.daysToCheckIn > 14) {
    floor = opts.recommendedMinimum;
  } else if (opts.daysToCheckIn >= 7 && opts.daysToCheckIn <= 14) {
    if (allConditionsMet) {
      const cap =
        opts.mode === "conservative" ? opts.base * 0.9 : opts.mode === "aggressive" ? opts.base * 0.85 : opts.base * 0.85;
      floor = Math.max(opts.recommendedMinimum, cap);
      engaged = true;
    } else {
      floor = opts.recommendedMinimum;
    }
  } else {
    // 0-6 days
    if (allConditionsMet) {
      const cap =
        opts.mode === "conservative" ? opts.base * 0.9 : opts.mode === "aggressive" ? opts.base * 0.75 : opts.base * 0.8;
      floor = Math.max(opts.recommendedMinimum, cap);
      engaged = true;
    } else {
      floor = opts.recommendedMinimum;
    }
  }

  return {
    floor,
    gate: { propertyOccLow, marketOccLow, marketRpoBelowMedian, engaged }
  };
}

// ---------------------------------------------------------------------------
// 3.5 — top-level orchestrator
// ---------------------------------------------------------------------------
export function computeTrialDailyRate(input: TrialDailyInput, market: TrialMarketSnapshot): TrialDailyResult | null {
  const notes: string[] = [];

  const baseResult = computeTrialBase({
    trailing365dAdr: input.trailing365dAdr,
    trailing365dSoldNights: input.trailing365dSoldNights,
    trailing365dOccupancy: input.trailing365dOccupancy,
    marketP50: market.benchmark?.p50 ?? null,
    marketMedianOccupancy: input.marketMedianOccupancy,
    portfolioMedianOccupancy: input.portfolioMedianOccupancy,
    compAnchor: input.compAnchor,
    manualBaseAnchor: input.manualBaseAnchor,
    qualityTier: input.qualityTier,
    roundingIncrement: input.roundingIncrement
  });
  if (!baseResult) {
    notes.push("base could not be computed — no own ADR, no comp anchor, no KD market P50");
    return null;
  }
  const base = baseResult.base;

  const min = computeTrialMinimum({
    base,
    marketP20: market.benchmark?.p20 ?? null,
    marketP50: market.benchmark?.p50 ?? null,
    trailing365dAdr: input.trailing365dAdr,
    benchmarkSimilarity: market.benchmarkSimilarity,
    userSetMinimum: input.userSetMinimum,
    roundingIncrement: input.roundingIncrement
  });

  // Manual mode: skip multipliers entirely except manual seasonality / DoW
  if (input.mode === "manual") {
    const seasonality = blendSeasonality({
      ownSeasonalityIndex: null,
      marketSeasonalityIndex: null,
      ownSampleSize: null,
      manualAdjPct: input.manualSeasonalityAdjPct
    });
    const dow = blendDayOfWeek({
      ownDoWIndex: null,
      marketDoWIndex: null,
      manualAdjPct: input.manualDoWAdjPct
    });
    // 2026-05-27 PM CONSOLIDATION: events multiplier removed from the
    // trial chain (constant 1.0). The cap-flagging logic still reads
    // localEventAdjPct so the relaxed 5.0× event-night cap applies on
    // event-flagged dates — preserves Fleadh-class headroom should the
    // data-led demand signal want to price through. eventAdjustmentForDate
    // helper in events.ts and trial-events.ts contents UNTOUCHED — only
    // the rate-lift contribution is removed; the lever can be reinstated
    // by a one-line revert if signal-quality on KD-only proves
    // insufficient for events.
    const eventMult = 1.0;
    const beforeClamp = base * seasonality.multiplier * dow.multiplier * eventMult * input.paceMultiplier;
    // Cap-flagging is decoupled from rate-lift: read localEventAdjPct as
    // a read-only membership check to pick the event-flagged cap.
    const isEventFlagged = input.localEventAdjPct !== null && Math.abs(input.localEventAdjPct) > 0;
    const upperCapMultiple = isEventFlagged ? EVENT_NIGHT_RATE_MULTIPLE : NORMAL_NIGHT_RATE_MULTIPLE;
    const clamped = clamp(beforeClamp, min.effectiveMinimum, Math.max(min.effectiveMinimum, base * upperCapMultiple));
    const finalRate = roundToIncrement(clamped, input.roundingIncrement);
    return {
      recommendedRate: finalRate,
      recommendedRateBeforeClamp: roundToIncrement(beforeClamp, input.roundingIncrement),
      recommendedMinimum: min.recommendedMinimum,
      effectiveMinimum: min.effectiveMinimum,
      base,
      breakdown: {
        base,
        recommendedMinimum: min.recommendedMinimum,
        effectiveMinimum: min.effectiveMinimum,
        seasonality: seasonality.multiplier,
        seasonalityBlend: { ownWeight: 0, marketWeight: 0, manualPct: input.manualSeasonalityAdjPct },
        seasonalityCeilingHit: seasonality.ceilingHit,
        seasonalityFloorHit: seasonality.floorHit,
        seasonalityOwn: null,
        seasonalityKd: null,
        seasonalityOwnSampleSize: null,
        seasonalityOwnSampleAboveGate: false,
        dayOfWeek: dow.multiplier,
        dayOfWeekBlend: { ownWeight: 0, marketWeight: 0, manualPct: input.manualDoWAdjPct },
        dayOfWeekCeilingHit: dow.ceilingHit,
        dayOfWeekFloorHit: dow.floorHit,
        dayOfWeekOwn: null,
        dayOfWeekKd: null,
        demand: 1.0,
        demandReasoning: "manual mode",
        demandDominantSignal: "none",
        demandRawDelta: null,
        demandPassThrough: DEMAND_PASS_THROUGH,
        demandCeilingHit: false,
        demandFloorHit: false,
        demandOwnDelta: null,
        demandOwnPeerSampleSize: 0,
        demandOwnTargetFill: null,
        demandOwnPeerMedianFill: null,
        demandKdRevparDelta: null,
        demandKdAdrDelta: null,
        demandKdSupplyDelta: null,
        demandKdEffectiveDelta: null,
        demandKdSupplyGuardTriggered: false,
        demandKdPeerSampleSize: 0,
        demandOwnWeight: 0,
        demandKdWeight: 0,
        occupancy: 1.0,
        occupancyBucketMin: 0,
        occupancyBucketMax: 100,
        leadTimeFloor: min.effectiveMinimum,
        leadTimeGate: { propertyOccLow: false, marketOccLow: false, marketRpoBelowMedian: false, engaged: false },
        events: eventMult,
        pace: input.paceMultiplier,
        ladderMode: "manual"
      },
      notes
    };
  }

  // Standard / conservative / aggressive: full pipeline.
  // Seasonality source preference: KD-derived monthly index from
  // trailing-12mo weekly aggregation (always present when KD is wired);
  // fall back to the legacy seasonality field if not.
  const marketSeasonalityIndex =
    market.trailingMarketKpis?.seasonalityByMonth[input.monthIndex] ??
    market.seasonality?.months[input.monthIndex] ??
    null;
  // Per 2026-05-21 spec: own sample is the portfolio-aggregated booked-
  // night count FOR THE TARGET MONTH (not the listing's full-year
  // occupancy fraction the pre-2026-05-21 gate used). Sample-gated
  // weighting inside blendSeasonality picks own-led / KD-led / own-only
  // / KD-only based on this count.
  const seasonality = blendSeasonality({
    ownSeasonalityIndex: input.ownSeasonalityIndex,
    marketSeasonalityIndex,
    ownSampleSize: input.ownSeasonalitySampleSize,
    manualAdjPct: input.manualSeasonalityAdjPct
  });
  // Day-of-week multiplier REINSTATED 2026-05-27 as a LEARNED per-tenant
  // multiplier. Agent.ts pre-computes the 7-number table (own with KD
  // fallback) via `dow-multiplier.ts` and passes the resolved value
  // for the target's DoW as `input.ownDoWIndex`. The retirement on
  // 2026-05-22 left the wiring intact but null'd the input; reverting
  // to feed the learned value lights the slot back up. Market
  // (`getCityDayOfWeekIndex`) is still null — KD has no per-day market
  // signal accessible on the OTA trial surface; the fallback inside
  // dow-multiplier.ts is from KD's daily ADR aggregated by DoW
  // (already baked into the resolved value).
  //
  // The cross-sectional pace signal NO LONGER absorbs weekly variation
  // (Phase E partitions the booking curve by DoW so Friday compares
  // to Friday-curve, not all-DoW mean). Clean separation: DoW
  // multiplier carries the rate-LEVEL pattern (Sat premium), pace
  // signal carries deviation from normal pace for THIS DoW.
  const dow = blendDayOfWeek({
    ownDoWIndex: input.ownDoWIndex,
    marketDoWIndex: null,
    manualAdjPct: input.manualDoWAdjPct
  });

  const fwdForDate = market.forwardPace?.perDate.find((p) => p.date === input.date) ?? null;
  const xs = input.demandCrossSectional;
  const demand = computeDemandMultiplier({
    ownDelta: xs.ownDelta,
    ownPeerSampleSize: xs.ownPeerSampleSize,
    ownTargetFill: xs.ownTargetFill,
    ownPeerMedianFill: xs.ownPeerMedianFill,
    kdEffectiveDelta: xs.kdEffectiveDelta,
    kdSupplyGuardTriggered: xs.kdSupplyGuardTriggered,
    kdRevparDeltaRaw: xs.kdRevparDelta,
    kdAdrDelta: xs.kdAdrDelta,
    kdSupplyDelta: xs.kdSupplyDelta,
    kdPeerSampleSize: xs.kdPeerSampleSize,
    // Phase C (2026-05-24): far-future holiday calendar fallback. Only
    // contributes when both pace signals are null; the agent resolves
    // this per cell from the NI holiday-calendar layer.
    calendarFallbackDelta: xs.calendarFallbackDelta ?? null,
    calendarFallbackLabel: xs.calendarFallbackLabel ?? null
  });
  // `fwdForDate` still used by the lead-time gate below for forward-
  // occupancy reads. Cross-sectional demand inputs replace the old
  // forwardRevparAdj × trailing12mo comparison.

  const occ = lookupTrialOccupancyMultiplier(input.scopeOccupancy, input.mode);

  const ltf = computeLeadTimeFloor({
    daysToCheckIn: input.daysToCheckIn,
    base,
    recommendedMinimum: min.effectiveMinimum,
    scopeOccupancy: input.scopeOccupancy,
    marketForwardOccForDate: fwdForDate?.forwardOccupancy ?? null,
    marketOcc25thPct: market.marketOcc25thPct,
    marketRpoForDate: market.marketRpoForDate,
    marketRpoMedian: market.marketRpoMedian,
    mode: input.mode
  });

  // 2026-05-27 PM CONSOLIDATION: events multiplier removed from the
  // trial chain (constant 1.0). Per Mark's spec: if demand signals are
  // strong enough, they should catch events organically — adr_unbooked
  // rises as market raises asking rates on Fleadh week; booking-window
  // narrows as people book earlier for known peaks; the corroborator
  // fires when both agree. The events lever was a manual "we know the
  // answer" override contradicting the data-led principle.
  //
  // The cap-flagging below is decoupled — reads localEventAdjPct as a
  // read-only membership check to pick the event-flagged 5.0× cap, so
  // a data-led chain CAN still price through to PL-grade peaks on
  // event-flagged dates without the lever lifting the rate itself.
  //
  // eventAdjustmentForDate (events.ts) + trial-events.ts contents
  // UNTOUCHED — only the rate-lift contribution is removed. Reinstating
  // the lever is a one-line revert if signal-quality on KD-only proves
  // insufficient for events; today's verification surfaces the gap if
  // it exists.
  const eventMult = 1.0;

  const beforeClamp =
    base *
    seasonality.multiplier *
    dow.multiplier *
    demand.multiplier *
    occ.multiplier *
    eventMult *
    input.paceMultiplier;

  // Cap selection still reads localEventAdjPct as the event-flag —
  // preserves the EVENT_NIGHT_RATE_MULTIPLE (5.0×) headroom on
  // event-flagged dates even though the events lever no longer lifts
  // the rate. Non-event nights keep the NORMAL_NIGHT_RATE_MULTIPLE
  // (4.0×) cap.
  const isEventFlagged = input.localEventAdjPct !== null && Math.abs(input.localEventAdjPct) > 0;
  const upperCapMultiple = isEventFlagged ? EVENT_NIGHT_RATE_MULTIPLE : NORMAL_NIGHT_RATE_MULTIPLE;
  const clamped = clamp(beforeClamp, ltf.floor, Math.max(ltf.floor, base * upperCapMultiple));
  const finalRate = roundToIncrement(clamped, input.roundingIncrement);

  return {
    recommendedRate: finalRate,
    recommendedRateBeforeClamp: roundToIncrement(beforeClamp, input.roundingIncrement),
    recommendedMinimum: min.recommendedMinimum,
    effectiveMinimum: ltf.floor,
    base,
    breakdown: {
      base,
      recommendedMinimum: min.recommendedMinimum,
      effectiveMinimum: ltf.floor,
      seasonality: seasonality.multiplier,
      seasonalityBlend: {
        ownWeight: seasonality.ownWeight,
        marketWeight: seasonality.marketWeight,
        manualPct: input.manualSeasonalityAdjPct
      },
      seasonalityCeilingHit: seasonality.ceilingHit,
      seasonalityFloorHit: seasonality.floorHit,
      seasonalityOwn: input.ownSeasonalityIndex,
      seasonalityKd: marketSeasonalityIndex,
      seasonalityOwnSampleSize: input.ownSeasonalitySampleSize,
      seasonalityOwnSampleAboveGate: seasonality.ownSampleAboveGate,
      dayOfWeek: dow.multiplier,
      dayOfWeekBlend: {
        ownWeight: dow.ownWeight,
        marketWeight: dow.marketWeight,
        manualPct: input.manualDoWAdjPct
      },
      dayOfWeekCeilingHit: dow.ceilingHit,
      dayOfWeekFloorHit: dow.floorHit,
      // dayOfWeek own/kd are null since the automatic DoW path was
      // retired 2026-05-22 — the cross-sectional demand signal owns
      // weekly variation now. Surfaced for backward compat on the
      // breakdown shape.
      dayOfWeekOwn: null,
      dayOfWeekKd: null,
      demand: demand.multiplier,
      demandReasoning: demand.reasoning,
      demandDominantSignal: demand.dominantSignal,
      demandRawDelta: demand.rawDemandDelta,
      demandPassThrough: DEMAND_PASS_THROUGH,
      demandCeilingHit: demand.ceilingHit,
      demandFloorHit: demand.floorHit,
      demandOwnDelta: xs.ownDelta,
      demandOwnPeerSampleSize: xs.ownPeerSampleSize,
      demandOwnTargetFill: xs.ownTargetFill,
      demandOwnPeerMedianFill: xs.ownPeerMedianFill,
      demandKdRevparDelta: xs.kdRevparDelta,
      demandKdAdrDelta: xs.kdAdrDelta,
      demandKdSupplyDelta: xs.kdSupplyDelta,
      demandKdEffectiveDelta: xs.kdEffectiveDelta,
      demandKdSupplyGuardTriggered: xs.kdSupplyGuardTriggered,
      demandKdPeerSampleSize: xs.kdPeerSampleSize,
      demandOwnWeight: demand.ownWeight,
      demandKdWeight: demand.kdWeight,
      occupancy: occ.multiplier,
      occupancyBucketMin: occ.bucketMin,
      occupancyBucketMax: occ.bucketMax,
      leadTimeFloor: ltf.floor,
      leadTimeGate: ltf.gate,
      events: eventMult,
      pace: input.paceMultiplier,
      ladderMode: input.mode
    },
    notes
  };
}
