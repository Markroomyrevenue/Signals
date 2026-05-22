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
   * Surfaced for the 31-90d trough diagnostic. After the 2026-05-20
   * rewrite this is always "trail12mo" (the RevPAR-adj within-year
   * baseline) or "none". "LY" is retained in the union for backward-
   * compatibility on snapshot rows written before this date.
   */
  demandDominantSignal: "LY" | "trail12mo" | "none";
  demandRawDelta: number | null;
  demandPassThrough: number;
  demandCeilingHit: boolean;
  demandFloorHit: boolean;
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
// Floor raised 0.92 → 1.0 on 2026-05-20. Demand is now an upside-only
// signal — it can lift, never drag. Downside is owned deliberately by
// the occupancy ladder (§3.3) and the 3-gated lead-time floor (§3.4),
// both of which already short the price when the property + market are
// unambiguously soft. The previous 0.92 floor was binding on 58.3% of
// 31-90d trough cells, pulling prices DOWN on a noisy OTA forward-
// occupancy reading at mid-range lead time — see diagnostics-2026-05-20.
const DEMAND_FLOOR = 1.0;
// Ceiling raised 1.15 → 1.40 on 2026-05-19 for the same reason — the
// old +15% clamp was binding on the trough cells we most want to lift.
const DEMAND_CEIL = 1.4;

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
 * Demand multiplier — RevPAR-adjusted, within-year baseline only.
 *
 * 2026-05-20 rewrite — was: max-amplitude across LY-same-week and
 * trailing-12mo, each using (occ - baseline_occ) + 0.5 × adrΔ.
 *
 * The LY baseline is dropped because supply expands ahead of known
 * events: forward-vs-LY occupancy reads a genuine spike as soft
 * (Fleadh 2026 vs 2025 same-week: occ -23pp, within-year RevPAR +52%
 * vs the non-event August baseline — same date, opposite signal).
 *
 * The metric switches from occΔ + 0.5 × adrΔ to RevPAR-adj, because
 * supply dilution masks the spike in occupancy alone — KeyData's
 * outlier-filtered RevPAR is the one signal that cleanly catches it
 * (see Task 3 of trial-reports/diagnostics-2026-05-20.md).
 *
 * Result: demandDelta = (forwardRevparAdj / trailing12moMedianRevparAdj) - 1,
 * then raw = 1 + DEMAND_PASS_THROUGH × demandDelta, clamped to
 * [DEMAND_FLOOR=1.0, DEMAND_CEIL=1.40].
 *
 * Graceful fallback to 1.0 whenever forward RevPAR-adj or the
 * trailing-12mo median is unavailable / non-positive / NaN. The LY
 * and occ/adr fields are kept on the input as informational context
 * for the reasoning string but no longer drive the multiplier.
 */
export function computeDemandMultiplier(opts: {
  /** Forward RevPAR-adjusted for the target date (KeyData OTA weekly). */
  marketForwardRevparAdjForDate: number | null;
  /** Trailing 52-week median RevPAR-adjusted (the within-year baseline). */
  marketTrailingMedianRevparAdj: number | null;
  /** Informational only — surfaced in reasoning string; NOT a driver. */
  marketForwardOccForDate?: number | null;
  marketForwardOccLY?: number | null;
  marketForwardADRForDate?: number | null;
  marketForwardADRLY?: number | null;
}): {
  multiplier: number;
  reasoning: string;
  /** "trail12mo" when RevPAR-adj baseline fired, "none" otherwise. */
  dominantSignal: "trail12mo" | "none";
  /** demandDelta before pass-through and clamp. null when no baseline. */
  rawDemandDelta: number | null;
  /** True when raw exceeded DEMAND_CEIL and got clamped down. */
  ceilingHit: boolean;
  /** True when raw fell below DEMAND_FLOOR and got clamped up. */
  floorHit: boolean;
} {
  const fwd = opts.marketForwardRevparAdjForDate;
  const baseline = opts.marketTrailingMedianRevparAdj;
  const fwdOk = fwd !== null && fwd !== undefined && Number.isFinite(fwd) && fwd > 0;
  const baselineOk = baseline !== null && baseline !== undefined && Number.isFinite(baseline) && baseline > 0;
  if (!fwdOk || !baselineOk) {
    const reason = !fwdOk && !baselineOk
      ? "no forward and no trailing RevPAR-adj — multiplier=1.0"
      : !fwdOk
        ? "no forward RevPAR-adj — multiplier=1.0"
        : "no trailing-12mo median RevPAR-adj — multiplier=1.0";
    return {
      multiplier: 1.0,
      reasoning: reason,
      dominantSignal: "none",
      rawDemandDelta: null,
      ceilingHit: false,
      floorHit: false
    };
  }
  const demandDelta = (fwd as number) / (baseline as number) - 1;
  const raw = 1 + DEMAND_PASS_THROUGH * demandDelta;
  const clamped = clamp(raw, DEMAND_FLOOR, DEMAND_CEIL);
  const ceilingHit = raw > DEMAND_CEIL;
  const floorHit = raw < DEMAND_FLOOR;

  // Informational context — occupancy / ADR / LY values are NOT used
  // in the multiplier, but help readers eyeball the reasoning when
  // skimming the daily report.
  const contextParts: string[] = [];
  if (opts.marketForwardOccForDate !== null && opts.marketForwardOccForDate !== undefined &&
      Number.isFinite(opts.marketForwardOccForDate)) {
    contextParts.push(`fwdOcc=${(opts.marketForwardOccForDate as number).toFixed(3)}`);
  }
  if (opts.marketForwardOccLY !== null && opts.marketForwardOccLY !== undefined &&
      Number.isFinite(opts.marketForwardOccLY)) {
    contextParts.push(`occLY=${(opts.marketForwardOccLY as number).toFixed(3)}`);
  }
  if (opts.marketForwardADRForDate !== null && opts.marketForwardADRForDate !== undefined &&
      Number.isFinite(opts.marketForwardADRForDate)) {
    contextParts.push(`fwdADR=${(opts.marketForwardADRForDate as number).toFixed(0)}`);
  }
  if (opts.marketForwardADRLY !== null && opts.marketForwardADRLY !== undefined &&
      Number.isFinite(opts.marketForwardADRLY)) {
    contextParts.push(`adrLY=${(opts.marketForwardADRLY as number).toFixed(0)}`);
  }
  const contextSuffix = contextParts.length > 0 ? ` | context: ${contextParts.join(", ")}` : "";

  const reasoning =
    `RevPARadj fwd=${(fwd as number).toFixed(2)} vs trail12mo med=${(baseline as number).toFixed(2)} → ` +
    `demandΔ=${demandDelta.toFixed(3)} → raw=${raw.toFixed(3)} → clamp=${clamped.toFixed(3)}` +
    `${ceilingHit ? " (CEILING hit)" : floorHit ? " (FLOOR hit)" : ""}${contextSuffix}`;
  return {
    multiplier: clamped,
    reasoning,
    dominantSignal: "trail12mo",
    rawDemandDelta: demandDelta,
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
    const clamped = clamp(beforeClamp, min.effectiveMinimum, Math.max(min.effectiveMinimum, base * 2.5));
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
  const dow = blendDayOfWeek({
    ownDoWIndex: input.ownDoWIndex,
    marketDoWIndex: market.dayOfWeek?.days[input.dayOfWeek] ?? null,
    manualAdjPct: input.manualDoWAdjPct
  });

  const fwdForDate = market.forwardPace?.perDate.find((p) => p.date === input.date) ?? null;
  const fwdLY = market.forwardPace?.lastYearComparison.find((p) => p.date === input.date) ?? null;
  const demand = computeDemandMultiplier({
    marketForwardRevparAdjForDate: fwdForDate?.forwardRevparAdj ?? null,
    marketTrailingMedianRevparAdj: market.trailingMarketKpis?.trailingMedianRevparAdj ?? null,
    // Informational context only — preserved for the reasoning string,
    // not used in the multiplier computation after the 2026-05-20 rewrite.
    marketForwardOccForDate: fwdForDate?.forwardOccupancy ?? null,
    marketForwardOccLY: fwdLY?.forwardOccupancyLY ?? null,
    marketForwardADRForDate: fwdForDate?.forwardADR ?? null,
    marketForwardADRLY: fwdLY?.forwardADRLY ?? null
  });

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

  const clamped = clamp(beforeClamp, ltf.floor, Math.max(ltf.floor, base * 2.5));
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
      dayOfWeekOwn: input.ownDoWIndex,
      dayOfWeekKd: market.dayOfWeek?.days[input.dayOfWeek] ?? null,
      demand: demand.multiplier,
      demandReasoning: demand.reasoning,
      demandDominantSignal: demand.dominantSignal,
      demandRawDelta: demand.rawDemandDelta,
      demandPassThrough: DEMAND_PASS_THROUGH,
      demandCeilingHit: demand.ceilingHit,
      demandFloorHit: demand.floorHit,
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
