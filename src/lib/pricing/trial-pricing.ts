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
  /** Listing-size signal — see existing buildRecommendedBaseFromHistoryAndMarket */
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
  demandDominantSignal: "LY" | "trail12mo" | "own" | "kd" | "both" | "none";
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

const DOW_FLOOR = 0.85;
const DOW_CEIL = 1.2;

// Demand-multiplier coefficients. Pass-through is the share of a unit
// `demandDelta` that flows into the final multiplier; the result is then
// clamped to [DEMAND_FLOOR, DEMAND_CEIL].
// Raised 0.5 → 0.7 on 2026-05-19 to address the 31-90d trough where
// recommendations sat 20-29% below PriceLabs even when KD demand was
// pointing the right direction — the previous pass-through was capping
// us at the +15% ceiling too easily on event-weighted weeks.
const DEMAND_PASS_THROUGH = 0.7;
// Floor restored 1.0 → 0.92 on 2026-05-22 with the cross-sectional
// rebuild. Rationale: the 2026-05-20 floor=1.0 was to stop the
// forward-vs-trailing comparison dragging prices DOWN on every date
// (structural lead-time emptiness artifact). The cross-sectional
// comparison has no such bias — a date BELOW its same-month peers is
// genuinely below them (weekday in mid-August, post-holiday lull,
// etc.). Restoring downside lets ordinary Mondays sit below average
// (the weekly pattern emerges from demand instead of from a hardcoded
// DoW multiplier, which is now retired). 0.92 matches the original
// 2026-05-19 floor and the OLD DoW floor's downside band.
const DEMAND_FLOOR = 0.92;
// Ceiling raised 1.15 → 1.40 on 2026-05-19 for the same reason — the
// old +15% clamp was binding on the trough cells we most want to lift.
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
const DEMAND_OWN_WEIGHT = 0.5;
const DEMAND_KD_WEIGHT = 0.5;

/**
 * Daily-rate upper clamp, expressed as a multiple of the base price.
 *
 * Two values, picked per cell by whether the night is event-flagged
 * (i.e. covered by a non-zero trial-event adjustment). The default
 * (NORMAL) is the long-standing base × 2.5 — a finite artifact guard
 * that catches multiplier-stack runaways without affecting normal
 * weekly variation.
 *
 * The EVENT_NIGHT value (2026-05-22 evening) was raised to base × 3.5
 * to let genuine event peaks (Fleadh Sat: PL/base = 3.39×) price
 * through the chain. Without this relax, the demand×seasonality×event×
 * occupancy product on Fleadh Thu-Sun cells hit base × 2.5 and the
 * chain was sawn off — the residual delta to PriceLabs was physically
 * blocked. The new clamp lets the chain reach where it wants to go on
 * event-flagged nights, still bounded by a finite artifact guard
 * (anything above 3.5× is almost certainly a configuration error).
 *
 * Non-event nights keep base × 2.5 unchanged.
 *
 * "Event-flagged" = `input.localEventAdjPct !== null && adjPct !== 0`.
 * A night the trial events source explicitly skips (Mon-Wed of Fleadh,
 * post-Fleadh Sun) gets null/0 → falls back to NORMAL.
 */
const NORMAL_NIGHT_RATE_MULTIPLE = 2.5;
const EVENT_NIGHT_RATE_MULTIPLE = 3.5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function roundToIncrement(value: number, increment: number): number {
  if (increment <= 0) return Math.round(value);
  return Math.round(value / increment) * increment;
}

// ---------------------------------------------------------------------------
// 3.1 — base recommendation
// ---------------------------------------------------------------------------
export type TrialBaseInput = {
  trailing365dAdr: number | null;
  marketP50: number | null; // KeyData P50 of similar comparables
  listingSizeAnchor: number | null;
  qualityTier: TrialQualityTier;
  roundingIncrement: number;
};

export type TrialBaseResult = {
  base: number;
  weightsApplied: { own: number; market: number; size: number };
  qualityMultiplier: number;
};

export function computeTrialBase(input: TrialBaseInput): TrialBaseResult | null {
  const own = input.trailing365dAdr ?? null;
  const mkt = input.marketP50 ?? null;
  const size = input.listingSizeAnchor ?? null;

  let weights: { own: number; market: number; size: number };
  let blended: number | null;

  if (mkt !== null && own !== null && size !== null) {
    weights = { own: 0.55, market: 0.3, size: 0.15 };
    blended = own * weights.own + mkt * weights.market + size * weights.size;
  } else if (mkt === null && own !== null && size !== null) {
    // §3.1 fallback: own 0.7, size 0.3
    weights = { own: 0.7, market: 0, size: 0.3 };
    blended = own * weights.own + size * weights.size;
  } else if (own !== null) {
    weights = { own: 1, market: 0, size: 0 };
    blended = own;
  } else if (mkt !== null) {
    weights = { own: 0, market: 1, size: 0 };
    blended = mkt;
  } else if (size !== null) {
    weights = { own: 0, market: 0, size: 1 };
    blended = size;
  } else {
    return null;
  }
  if (!Number.isFinite(blended) || blended <= 0) return null;

  const qualityMultiplier = QUALITY_TIER_MULTIPLIER[input.qualityTier] ?? 1.0;
  const adjusted = blended * qualityMultiplier;
  const base = roundToIncrement(adjusted, input.roundingIncrement);
  return { base, weightsApplied: weights, qualityMultiplier };
}

// ---------------------------------------------------------------------------
// 3.2 — minimum price (data-led)
// ---------------------------------------------------------------------------
export function computeTrialMinimum(opts: {
  base: number;
  marketP20: number | null;
  benchmarkSimilarity: TrialSimilarityScore;
  userSetMinimum: number | null;
  roundingIncrement: number;
}): { recommendedMinimum: number; effectiveMinimum: number } {
  const baseFloor = opts.base * 0.7;
  const marketFloor =
    opts.marketP20 !== null && Number.isFinite(opts.marketP20) && opts.marketP20 > 0
      ? opts.marketP20 * clamp(opts.benchmarkSimilarity, 0, 1)
      : 0;
  const recommendedRaw = Math.max(baseFloor, marketFloor);
  const recommendedMinimum = roundToIncrement(recommendedRaw, opts.roundingIncrement);
  const userFloor = opts.userSetMinimum ?? 0;
  // §3.2: user override only RAISES the floor, never lowers it.
  const effectiveMinimum = Math.max(recommendedMinimum, userFloor);
  return { recommendedMinimum, effectiveMinimum };
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
}): {
  multiplier: number;
  reasoning: string;
  /** Which side(s) drove the lift. */
  dominantSignal: "own" | "kd" | "both" | "none";
  /** Blended demand delta before pass-through + clamp. */
  rawDemandDelta: number | null;
  ownWeight: number;
  kdWeight: number;
  ceilingHit: boolean;
  floorHit: boolean;
} {
  const ownOk = opts.ownDelta !== null && Number.isFinite(opts.ownDelta);
  const kdOk = opts.kdEffectiveDelta !== null && Number.isFinite(opts.kdEffectiveDelta);

  if (!ownOk && !kdOk) {
    const reason = `no cross-sectional signal (own peer n=${opts.ownPeerSampleSize}, kd peer n=${opts.kdPeerSampleSize}) — multiplier=1.0`;
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

  // Linear blend before clamp so both-signals-elevated produces a
  // larger lift than either-signal-alone (the spec's compounding
  // requirement). Either-only case falls through to that signal at
  // full weight.
  let ownWeight = 0;
  let kdWeight = 0;
  let blendedDelta = 0;
  let dominant: "own" | "kd" | "both" = "none" as never;
  if (ownOk && kdOk) {
    ownWeight = DEMAND_OWN_WEIGHT;
    kdWeight = DEMAND_KD_WEIGHT;
    blendedDelta = (opts.ownDelta as number) * ownWeight + (opts.kdEffectiveDelta as number) * kdWeight;
    dominant = "both";
  } else if (ownOk) {
    ownWeight = 1;
    blendedDelta = opts.ownDelta as number;
    dominant = "own";
  } else if (kdOk) {
    kdWeight = 1;
    blendedDelta = opts.kdEffectiveDelta as number;
    dominant = "kd";
  }

  const raw = 1 + DEMAND_PASS_THROUGH * blendedDelta;
  const clamped = clamp(raw, DEMAND_FLOOR, DEMAND_CEIL);
  const ceilingHit = raw > DEMAND_CEIL;
  const floorHit = raw < DEMAND_FLOOR;

  // Build the reasoning string. Structure mirrors the old version so
  // log-scrapers and Mark's eye keep working.
  const ownPart = ownOk
    ? `own peerΔ=${((opts.ownDelta as number) * 100).toFixed(1)}% (n=${opts.ownPeerSampleSize}` +
      `${opts.ownTargetFill !== null && opts.ownTargetFill !== undefined ? `, fill=${((opts.ownTargetFill as number) * 100).toFixed(1)}%` : ""}` +
      `${opts.ownPeerMedianFill !== null && opts.ownPeerMedianFill !== undefined ? ` vs peerMed=${((opts.ownPeerMedianFill as number) * 100).toFixed(1)}%` : ""}` +
      `)`
    : `own n/a (peer n=${opts.ownPeerSampleSize})`;
  const kdPart = kdOk
    ? `kd peerΔ=${((opts.kdEffectiveDelta as number) * 100).toFixed(1)}%` +
      `${opts.kdSupplyGuardTriggered ? ` (SUPPLY-GUARD damped; raw RPAΔ=${opts.kdRevparDeltaRaw !== null && opts.kdRevparDeltaRaw !== undefined ? ((opts.kdRevparDeltaRaw as number) * 100).toFixed(1) + "%" : "?"})` : ""}` +
      ` (n=${opts.kdPeerSampleSize}` +
      `${opts.kdAdrDelta !== null && opts.kdAdrDelta !== undefined ? `, adrΔ=${((opts.kdAdrDelta as number) * 100).toFixed(1)}%` : ""}` +
      `${opts.kdSupplyDelta !== null && opts.kdSupplyDelta !== undefined ? `, supplyΔ=${((opts.kdSupplyDelta as number) * 100).toFixed(1)}%` : ""}` +
      `)`
    : `kd n/a (peer n=${opts.kdPeerSampleSize})`;

  const reasoning =
    `${ownPart} | ${kdPart} → blendΔ=${blendedDelta.toFixed(3)} (w_own=${ownWeight.toFixed(2)}/w_kd=${kdWeight.toFixed(2)}) → ` +
    `raw=${raw.toFixed(3)} → clamp=${clamped.toFixed(3)}` +
    `${ceilingHit ? " (CEILING hit)" : floorHit ? " (FLOOR hit)" : ""}`;

  return {
    multiplier: clamped,
    reasoning,
    dominantSignal: dominant,
    rawDemandDelta: blendedDelta,
    ownWeight,
    kdWeight,
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
    marketP50: market.benchmark?.p50 ?? null,
    listingSizeAnchor: input.listingSizeAnchor,
    qualityTier: input.qualityTier,
    roundingIncrement: input.roundingIncrement
  });
  if (!baseResult) {
    notes.push("base could not be computed — no own ADR, no market P50, no size anchor");
    return null;
  }
  const base = baseResult.base;

  const min = computeTrialMinimum({
    base,
    marketP20: market.benchmark?.p20 ?? null,
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
    const eventMult = input.localEventAdjPct === null ? 1.0 : 1 + input.localEventAdjPct / 100;
    const beforeClamp = base * seasonality.multiplier * dow.multiplier * eventMult * input.paceMultiplier;
    // Manual mode honours the per-night event clamp relax too (a manual
    // tenant with a Fleadh-class event still needs the headroom).
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
  // Day-of-week automatic multiplier RETIRED 2026-05-22. Cross-sectional
  // demand now absorbs weekly variation natively (Saturdays sit above
  // month median, Mondays below — see DEMAND_FLOOR=0.92 for downside
  // preservation). Passing nulls neutralises the automatic blend; only
  // the manual `manualDoWAdjPct` override (default 0) still flows.
  const dow = blendDayOfWeek({
    ownDoWIndex: null,
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
    kdPeerSampleSize: xs.kdPeerSampleSize
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

  const eventMult = input.localEventAdjPct === null ? 1.0 : 1 + input.localEventAdjPct / 100;

  const beforeClamp =
    base *
    seasonality.multiplier *
    dow.multiplier *
    demand.multiplier *
    occ.multiplier *
    eventMult *
    input.paceMultiplier;

  // Event-flagged nights get a relaxed upper clamp (base × 3.5 instead
  // of base × 2.5) so a genuine event peak can price through the
  // chain. Non-event nights keep the long-standing base × 2.5 — see
  // NORMAL_/EVENT_NIGHT_RATE_MULTIPLE comments at the top.
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
