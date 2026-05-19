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
  /** Listing's own monthly seasonality multiplier (subject's own history) */
  ownSeasonalityIndex: number | null;
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
  dayOfWeek: number;
  dayOfWeekBlend: { ownWeight: number; marketWeight: number; manualPct: number };
  demand: number;
  demandReasoning: string;
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
const SEASONALITY_CEIL = 1.5;
const DOW_FLOOR = 0.85;
const DOW_CEIL = 1.2;

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

export function blendSeasonality(opts: {
  ownSeasonalityIndex: number | null;
  marketSeasonalityIndex: number | null;
  ownSampleSizeOk: boolean;
  manualAdjPct: number;
}): { multiplier: number; ownWeight: number; marketWeight: number } {
  let mult = 1.0;
  let ownWeight = 0;
  let marketWeight = 0;
  if (opts.ownSampleSizeOk && opts.ownSeasonalityIndex !== null && opts.marketSeasonalityIndex !== null) {
    ownWeight = 0.6;
    marketWeight = 0.4;
    mult = opts.ownSeasonalityIndex * ownWeight + opts.marketSeasonalityIndex * marketWeight;
  } else if (opts.marketSeasonalityIndex !== null) {
    // Per spec: "If own-history sample for a given month has fewer than 25 booked
    // nights, weight collapses to 1.0 × keyDataMarketSeasonalityIndex."
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
  return { multiplier: clamp(mult, SEASONALITY_FLOOR, SEASONALITY_CEIL), ownWeight, marketWeight };
}

export function blendDayOfWeek(opts: {
  ownDoWIndex: number | null;
  marketDoWIndex: number | null;
  manualAdjPct: number;
}): { multiplier: number; ownWeight: number; marketWeight: number } {
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
  return { multiplier: clamp(mult, DOW_FLOOR, DOW_CEIL), ownWeight, marketWeight };
}

export function computeDemandMultiplier(opts: {
  marketForwardOccForDate: number | null;
  marketForwardOccLY: number | null;
  marketForwardADRForDate: number | null;
  marketForwardADRLY: number | null;
  /**
   * Trailing 52-week market median occupancy (0-1). Used as a second
   * baseline so a forward date can be measured against a stable
   * yearly average in addition to LY-same-week. The demand multiplier
   * picks the STRONGER (max signed) lift across the two baselines so
   * we catch event-driven dates AND structurally hot markets.
   */
  marketTrailingMedianOcc?: number | null;
  /** Trailing 52-week market median ADR (£). */
  marketTrailingMedianAdr?: number | null;
}): { multiplier: number; reasoning: string } {
  const occ = opts.marketForwardOccForDate;
  const adr = opts.marketForwardADRForDate;
  if (occ === null || adr === null) {
    return { multiplier: 1.0, reasoning: "no KeyData forward pace — multiplier=1.0" };
  }
  // Compute up to two lift signals; use whichever has more amplitude.
  // Each lift is: (occ - baseline_occ) + 0.5 × (adr / baseline_adr - 1)
  type Signal = { name: string; occDelta: number; adrDelta: number; demandDelta: number };
  const signals: Signal[] = [];
  if (opts.marketForwardOccLY !== null && opts.marketForwardADRLY !== null && (opts.marketForwardADRLY ?? 0) > 0) {
    const occDelta = occ - (opts.marketForwardOccLY ?? 0);
    const adrDelta = adr / (opts.marketForwardADRLY ?? 1) - 1;
    signals.push({ name: "LY", occDelta, adrDelta, demandDelta: occDelta + 0.5 * adrDelta });
  }
  if (opts.marketTrailingMedianOcc !== null && opts.marketTrailingMedianOcc !== undefined &&
      opts.marketTrailingMedianAdr !== null && opts.marketTrailingMedianAdr !== undefined && opts.marketTrailingMedianAdr > 0) {
    const occDelta = occ - opts.marketTrailingMedianOcc;
    const adrDelta = adr / opts.marketTrailingMedianAdr - 1;
    signals.push({ name: "trail12mo", occDelta, adrDelta, demandDelta: occDelta + 0.5 * adrDelta });
  }
  if (signals.length === 0) {
    return { multiplier: 1.0, reasoning: "no demand baseline available — multiplier=1.0" };
  }
  // Pick the signal with the largest absolute demandDelta so we don't
  // suppress a real spike just because the other baseline disagrees.
  const dominant = signals.reduce((a, b) => (Math.abs(b.demandDelta) > Math.abs(a.demandDelta) ? b : a));
  const raw = 1 + 0.5 * dominant.demandDelta;
  const clamped = clamp(raw, 0.92, 1.15);
  const reasoning = signals
    .map((s) => `${s.name}: occΔ=${s.occDelta.toFixed(3)}, adrΔ=${s.adrDelta.toFixed(3)}, demandΔ=${s.demandDelta.toFixed(3)}`)
    .join(" | ") + ` → dominant=${dominant.name} → raw=${raw.toFixed(3)} → clamp=${clamped.toFixed(3)}`;
  return { multiplier: clamped, reasoning };
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
      ownSampleSizeOk: false,
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
        dayOfWeek: dow.multiplier,
        dayOfWeekBlend: { ownWeight: 0, marketWeight: 0, manualPct: input.manualDoWAdjPct },
        demand: 1.0,
        demandReasoning: "manual mode",
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

  // Standard / conservative / aggressive: full pipeline
  const ownSampleSizeOk = (input.trailing365dOccupancy ?? 0) >= 0.07; // ~25 nights / 365 ≈ 7%
  // Seasonality source preference: KD-derived monthly index from
  // trailing-12mo weekly aggregation (always present when KD is wired);
  // fall back to the legacy seasonality field if not.
  const marketSeasonalityIndex =
    market.trailingMarketKpis?.seasonalityByMonth[input.monthIndex] ??
    market.seasonality?.months[input.monthIndex] ??
    null;
  const seasonality = blendSeasonality({
    ownSeasonalityIndex: input.ownSeasonalityIndex,
    marketSeasonalityIndex,
    ownSampleSizeOk,
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
    marketForwardOccForDate: fwdForDate?.forwardOccupancy ?? null,
    marketForwardOccLY: fwdLY?.forwardOccupancyLY ?? null,
    marketForwardADRForDate: fwdForDate?.forwardADR ?? null,
    marketForwardADRLY: fwdLY?.forwardADRLY ?? null,
    marketTrailingMedianOcc: market.trailingMarketKpis?.trailingMedianOccupancy ?? null,
    marketTrailingMedianAdr: market.trailingMarketKpis?.trailingMedianAdr ?? null
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
      dayOfWeek: dow.multiplier,
      dayOfWeekBlend: {
        ownWeight: dow.ownWeight,
        marketWeight: dow.marketWeight,
        manualPct: input.manualDoWAdjPct
      },
      demand: demand.multiplier,
      demandReasoning: demand.reasoning,
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
