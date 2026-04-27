import type { PricingQualityTier } from "@/lib/pricing/settings";

export type PricingAnchorConfidence = "high" | "medium" | "low";
export type PricingAnchorSource = "system" | "user" | "blended-market";

export type PricingAnchorSubjectProfile = {
  listingId: string;
  listingName: string;
  marketLabel: string | null;
  country: string | null;
  region: string | null;
  locality: string | null;
  district: string | null;
  roomType: string | null;
  bedroomsNumber: number | null;
  personCapacity: number | null;
  propertySize: number | null;
  qualityTier: PricingQualityTier | null;
};

export type PricingAnchorComparableProfile = {
  listingId: string;
  listingName: string;
  country: string | null;
  region: string | null;
  locality: string | null;
  district: string | null;
  exactLocation: boolean | null;
  roomType: string | null;
  bedroomsNumber: number | null;
  personCapacity: number | null;
  propertySize: number | null;
  qualityTier: PricingQualityTier | null;
  annualMedianRate: number | null;
  annualP20Rate: number | null;
  annualP25Rate: number | null;
  annualP75Rate: number | null;
  usableRateCount: number;
};

export type PricingAnchorHistoryObservation = {
  stayDate: string;
  achievedRate: number;
  nightCount: number;
  leadTimeDays: number | null;
  losNights: number | null;
  status?: string | null;
};

export type PricingAnchorFieldExplanation = {
  recommendedLabel: string;
  currentValueLabel: string;
  manualOverrideLabel: string;
  effectiveAnchorLabel: string;
  marketMedianText: string;
  marketRangeText: string;
  comparatorSummaryText: string;
  overrideImpactText: string;
  confidenceLabel: string;
};

export type PricingOwnHistorySignal = {
  ownHistoryBasePrice: number | null;
  ownHistoryConfidence: PricingAnchorConfidence;
  ownHistorySampleSize: number;
  ownHistoryExplanation: string;
  ownHistorySummaryText: string;
  ownHistoryConfidenceLabel: string;
  provisionalRecommendedBasePrice: number | null;
};

export type PricingAnchorContext = {
  rawUserBasePrice: number | null;
  rawUserMinimumPrice: number | null;
  currentBasePrice: number | null;
  currentMinimumPrice: number | null;
  recommendedBasePrice: number | null;
  recommendedMinimumPrice: number | null;
  ownHistoryBasePrice: number | null;
  ownHistoryConfidence: PricingAnchorConfidence;
  ownHistorySampleSize: number;
  ownHistoryExplanation: string;
  ownHistorySummaryText: string;
  ownHistoryConfidenceLabel: string;
  provisionalRecommendedBasePrice: number | null;
  finalRecommendedBasePrice: number | null;
  marketBenchmarkBasePrice: number | null;
  marketBenchmarkMinimumPrice: number | null;
  pricePositionedComparatorCount: number;
  pricePositionedComparatorConfidence: PricingAnchorConfidence;
  pricePositioningSummaryText: string;
  effectiveBasePrice: number | null;
  effectiveMinimumPrice: number | null;
  comparatorCount: number;
  comparatorConfidence: PricingAnchorConfidence;
  pricingAnchorSource: PricingAnchorSource;
  basePriceExplanation: string;
  minimumPriceExplanation: string;
  marketContextSummary: string;
  baseDisplay: PricingAnchorFieldExplanation;
  minimumDisplay: PricingAnchorFieldExplanation;
};

type ComparableAnchorRatesParams = {
  rates: Array<{ rate: number | null; available: boolean | null }>;
  feeAdjustment?: number;
};

type ComparableAnchorDerivation = {
  annualMedianRate: number | null;
  annualP20Rate: number | null;
  annualP25Rate: number | null;
  annualP75Rate: number | null;
  usableRateCount: number;
};

type MarketBenchmarkParams = {
  subject: PricingAnchorSubjectProfile;
  comparables: PricingAnchorComparableProfile[];
  provisionalBasePrice?: number | null;
  displayCurrency?: string;
};

type ComparableBenchmarkCandidate = PricingAnchorComparableProfile & {
  structuralSimilarityScore: number;
  pricePositionSimilarityScore: number;
  similarityScore: number;
  adjustedComparableBase: number;
  adjustedComparableMinimum: number;
};

type MarketBenchmarkResult = {
  marketBenchmarkBasePrice: number | null;
  marketBenchmarkMinimumPrice: number | null;
  comparatorCount: number;
  comparatorConfidence: PricingAnchorConfidence;
  pricePositionedComparatorCount: number;
  pricePositionedComparatorConfidence: PricingAnchorConfidence;
  comparatorCandidates: ComparableBenchmarkCandidate[];
  marketRangeLow: number | null;
  marketRangeHigh: number | null;
  marketMedianComparableBase: number | null;
  pricePositioningSummaryText: string;
};

type OwnHistorySignalParams = {
  observations: PricingAnchorHistoryObservation[];
  targetDates: string[];
  samePeriodStartDate: string;
  samePeriodEndDate: string;
  todayDateOnly: string;
  preferredLosNights: number | null;
  displayCurrency?: string;
};

type RecommendedBaseParams = {
  marketBenchmarkBasePrice: number | null;
  /** Last-resort fallback if no anchor fires — typically the same-month last-year ADR. */
  fallbackBasePrice: number | null;
  roundingIncrement?: number;
  /**
   * Multiplier applied AFTER the anchor blend to reflect property quality
   * tier (low_scale / mid_scale / upscale). Resolved upstream from
   * `qualityMultiplierForTier(settings)`. Default 1 (no adjustment) so
   * legacy callers that don't pass a quality multiplier are unaffected.
   */
  qualityMultiplier?: number;
  /**
   * Listing-size signal. Two listings with the same bedrooms / bathrooms /
   * max-guests in the same portfolio anchor near the same size baseline,
   * supporting the "near-identical apartments → near-identical prices"
   * stability guarantee. Low weight when market benchmark is also present
   * (since benchmark already reflects similar properties); rises when
   * benchmark is missing.
   */
  listingSize?: {
    bedroomsNumber: number | null;
    bathroomsNumber: number | null;
    personCapacity: number | null;
  } | null;
  /**
   * Last-365-day own-bookings ADR for the listing, in display currency.
   * This is the heaviest-weighted anchor — what the listing has actually
   * achieved over the last year is the strongest signal of what it can
   * achieve next year.
   */
  trailing365dAdr?: number | null;
  /**
   * Last-365-day own-bookings occupancy as a fraction in [0, 1]. Mid-range
   * occupancy (~0.4-0.85) is treated as "priced about right" — outliers
   * nudge the recommendation downward (very low occ → reduce) or upward
   * (very high occ → small uplift). Bounded ±10% to avoid overreaction.
   */
  trailing365dOccupancy?: number | null;
};

type RecommendedBaseResult = {
  finalRecommendedBasePrice: number | null;
};

type EffectiveAnchorParams = {
  subject: PricingAnchorSubjectProfile;
  rawUserBasePrice: number | null;
  rawUserMinimumPrice: number | null;
  recommendedBasePrice: number | null;
  recommendedMinimumPrice: number | null;
  ownHistoryBasePrice: number | null;
  ownHistoryConfidence: PricingAnchorConfidence;
  ownHistorySampleSize: number;
  ownHistoryExplanation: string;
  ownHistorySummaryText: string;
  ownHistoryConfidenceLabel: string;
  provisionalRecommendedBasePrice: number | null;
  finalRecommendedBasePrice: number | null;
  marketBenchmarkBasePrice: number | null;
  marketBenchmarkMinimumPrice: number | null;
  comparatorCount: number;
  comparatorConfidence: PricingAnchorConfidence;
  pricePositionedComparatorCount: number;
  pricePositionedComparatorConfidence: PricingAnchorConfidence;
  pricePositioningSummaryText: string;
  marketRangeLow: number | null;
  marketRangeHigh: number | null;
  marketMedianComparableBase: number | null;
  displayCurrency?: string;
};

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function addDaysToDateOnly(dateOnly: string, offsetDays: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function quarterFromMonth(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

function monthFromDateOnly(dateOnly: string): number {
  return Number(dateOnly.slice(5, 7));
}

function weekdayFromDateOnly(dateOnly: string): number {
  return new Date(`${dateOnly}T00:00:00Z`).getUTCDay();
}

function daysBetweenDateOnly(fromDateOnly: string, toDateOnly: string): number {
  return Math.round(
    (new Date(`${toDateOnly}T00:00:00Z`).getTime() - new Date(`${fromDateOnly}T00:00:00Z`).getTime()) / (24 * 60 * 60 * 1000)
  );
}

function sumWeights(items: Array<{ weight: number }>): number {
  return items.reduce((sum, item) => sum + item.weight, 0);
}

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return roundTo2(sorted[0] ?? 0);

  const position = clamp(percentile, 0, 1) * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? sorted[0] ?? 0;
  const upper = sorted[upperIndex] ?? sorted[sorted.length - 1] ?? lower;
  if (lowerIndex === upperIndex) return roundTo2(lower);
  return roundTo2(lower + (upper - lower) * (position - lowerIndex));
}

function weightedQuantile(items: Array<{ value: number; weight: number }>, percentile: number): number | null {
  const filtered = items
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
    .sort((left, right) => left.value - right.value);
  if (filtered.length === 0) return null;

  const totalWeight = filtered.reduce((sum, item) => sum + item.weight, 0);
  const target = totalWeight * clamp(percentile, 0, 1);
  let runningWeight = 0;

  for (const item of filtered) {
    runningWeight += item.weight;
    if (runningWeight >= target) {
      return roundTo2(item.value);
    }
  }

  return roundTo2(filtered[filtered.length - 1]?.value ?? 0);
}

function removeRateOutliers(values: number[]): number[] {
  if (values.length < 5) return [...values];

  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  if (q1 === null || q3 === null) return [...values];

  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr <= 0) return [...values];

  const lowerBound = q1 - iqr * 1.5;
  const upperBound = q3 + iqr * 1.5;
  const filtered = values.filter((value) => value >= lowerBound && value <= upperBound);
  return filtered.length >= Math.max(4, Math.floor(values.length * 0.6)) ? filtered : [...values];
}

function removeWeightedObservationOutliers(
  observations: PricingAnchorHistoryObservation[]
): PricingAnchorHistoryObservation[] {
  const expandedRates = observations.flatMap((observation) =>
    Array.from({ length: Math.max(1, Math.round(observation.nightCount)) }, () => observation.achievedRate)
  );
  const filteredRates = new Set(removeRateOutliers(expandedRates).map((value) => roundTo2(value)));
  if (filteredRates.size === 0) return observations;
  return observations.filter((observation) => filteredRates.has(roundTo2(observation.achievedRate)));
}

function leadTimeBucketId(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (value <= 7) return "0-7";
  if (value <= 30) return "8-30";
  if (value <= 90) return "31-90";
  return "91+";
}

function losBucketId(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0 || value > 14) return null;
  if (value <= 2) return "1-2";
  if (value <= 4) return "3-4";
  if (value <= 7) return "5-7";
  return "8-14";
}

function weightedMedianFromObservations(observations: PricingAnchorHistoryObservation[]): number | null {
  return weightedQuantile(
    observations.map((observation) => ({
      value: observation.achievedRate,
      weight: Math.max(1, observation.nightCount)
    })),
    0.5
  );
}

function observationWeightSum(observations: PricingAnchorHistoryObservation[]): number {
  return observations.reduce((sum, observation) => sum + Math.max(1, observation.nightCount), 0);
}

function applyPreferredLosBucket(
  observations: PricingAnchorHistoryObservation[],
  preferredLosNights: number | null
): PricingAnchorHistoryObservation[] {
  const preferredBucket = losBucketId(preferredLosNights);
  if (!preferredBucket) return observations;

  const matched = observations.filter((observation) => losBucketId(observation.losNights) === preferredBucket);
  return observationWeightSum(matched) >= Math.max(6, Math.round(observationWeightSum(observations) * 0.2))
    ? matched
    : observations;
}

function confidenceFromScore(score: number): PricingAnchorConfidence {
  if (score >= 0.72) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function weightSignals(
  signals: Array<{ value: number | null; weight: number }>
): number | null {
  const usableSignals = signals.filter((signal) => signal.value !== null && signal.weight > 0) as Array<{
    value: number;
    weight: number;
  }>;
  if (usableSignals.length === 0) return null;
  const totalWeight = sumWeights(usableSignals);
  if (totalWeight <= 0) return null;
  return roundTo2(
    usableSignals.reduce((sum, signal) => sum + signal.value * signal.weight, 0) / totalWeight
  );
}

function pricePositionSimilarity(provisionalBasePrice: number | null, comparableMedianRate: number | null): number {
  if (
    provisionalBasePrice === null ||
    comparableMedianRate === null ||
    !Number.isFinite(provisionalBasePrice) ||
    !Number.isFinite(comparableMedianRate) ||
    provisionalBasePrice <= 0 ||
    comparableMedianRate <= 0
  ) {
    return 0;
  }

  const deviation = Math.abs(comparableMedianRate - provisionalBasePrice) / provisionalBasePrice;
  if (deviation <= 0.1) return 1;
  if (deviation <= 0.2) return 0.82;
  if (deviation <= 0.35) return 0.45;
  if (deviation <= 0.5) return 0.2;
  return 0.08;
}

function safeRatioAdjustment(subject: number | null, comparable: number | null, exponent: number, min: number, max: number): number {
  if (
    subject === null ||
    comparable === null ||
    !Number.isFinite(subject) ||
    !Number.isFinite(comparable) ||
    subject <= 0 ||
    comparable <= 0
  ) {
    return 1;
  }

  return roundTo2(clamp(Math.pow(subject / comparable, exponent), min, max));
}

function qualityTierDelta(subject: PricingQualityTier | null, comparable: PricingQualityTier | null): number | null {
  if (!subject || !comparable) return null;

  const tierValue: Record<PricingQualityTier, number> = {
    low_scale: 0,
    mid_scale: 1,
    upscale: 2
  };

  return tierValue[subject] - tierValue[comparable];
}

function qualityAdjustment(subject: PricingQualityTier | null, comparable: PricingQualityTier | null): number {
  const delta = qualityTierDelta(subject, comparable);
  if (delta === null) return 1;
  return roundTo2(clamp(1 + delta * 0.05, 0.9, 1.1));
}

function availableSimilarityWeights(
  subject: PricingAnchorSubjectProfile,
  comparable: PricingAnchorComparableProfile,
  provisionalBasePrice: number | null = null
): Array<{ weight: number; value: number }> {
  const weights: Array<{ weight: number; value: number }> = [];

  const districtMatch =
    normalizeKey(subject.district) && normalizeKey(subject.district) === normalizeKey(comparable.district)
      ? 1
      : normalizeKey(subject.locality) && normalizeKey(subject.locality) === normalizeKey(comparable.locality)
        ? 0.82
        : normalizeKey(subject.region) && normalizeKey(subject.region) === normalizeKey(comparable.region)
          ? 0.62
          : normalizeKey(subject.country) && normalizeKey(subject.country) === normalizeKey(comparable.country)
            ? 0.35
            : 0;
  if (districtMatch > 0 || subject.country || comparable.country) {
    weights.push({ weight: 0.3, value: districtMatch });
  }

  const roomTypeSubject = normalizeKey(subject.roomType);
  const roomTypeComparable = normalizeKey(comparable.roomType);
  if (roomTypeSubject || roomTypeComparable) {
    weights.push({ weight: 0.18, value: roomTypeSubject && roomTypeSubject === roomTypeComparable ? 1 : 0 });
  }

  if (subject.bedroomsNumber !== null && comparable.bedroomsNumber !== null) {
    const difference = Math.abs(subject.bedroomsNumber - comparable.bedroomsNumber);
    weights.push({
      weight: 0.12,
      value: difference === 0 ? 1 : difference === 1 ? 0.75 : difference === 2 ? 0.35 : 0
    });
  }

  if (subject.personCapacity !== null && comparable.personCapacity !== null) {
    const difference = Math.abs(subject.personCapacity - comparable.personCapacity);
    weights.push({
      weight: 0.1,
      value: difference === 0 ? 1 : difference <= 1 ? 0.82 : difference <= 2 ? 0.6 : difference <= 4 ? 0.25 : 0
    });
  }

  if (subject.propertySize !== null && comparable.propertySize !== null) {
    const ratio = Math.min(subject.propertySize, comparable.propertySize) / Math.max(subject.propertySize, comparable.propertySize);
    weights.push({ weight: 0.08, value: roundTo2(clamp(ratio, 0, 1)) });
  }

  const qualityDelta = qualityTierDelta(subject.qualityTier, comparable.qualityTier);
  if (qualityDelta !== null) {
    weights.push({
      weight: 0.07,
      value: qualityDelta === 0 ? 1 : Math.abs(qualityDelta) === 1 ? 0.6 : 0.25
    });
  }

  const pricePositionScore = pricePositionSimilarity(provisionalBasePrice, comparable.annualMedianRate);
  if (pricePositionScore > 0) {
    weights.push({
      weight: 0.15,
      value: pricePositionScore
    });
  }

  return weights;
}

function similarityScore(
  subject: PricingAnchorSubjectProfile,
  comparable: PricingAnchorComparableProfile,
  provisionalBasePrice: number | null = null
): number {
  const weights = availableSimilarityWeights(subject, comparable, provisionalBasePrice);
  if (weights.length === 0) return 0;

  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return 0;

  const weightedScore = weights.reduce((sum, item) => sum + item.weight * item.value, 0);
  return roundTo2(weightedScore / totalWeight);
}

export function deriveComparableAnnualAnchors(params: ComparableAnchorRatesParams): ComparableAnchorDerivation {
  const usableRates = params.rates
    .flatMap((item) => {
      if (item.available !== true || item.rate === null || !Number.isFinite(item.rate) || item.rate <= 0) return [];
      const adjustedRate = roundTo2(item.rate + (params.feeAdjustment ?? 0));
      return adjustedRate > 0 ? [adjustedRate] : [];
    });

  const trimmedRates = removeRateOutliers(usableRates);
  return {
    // Median is used for the base anchor because it is the most stable center point for a property's yearly rate curve.
    annualMedianRate: quantile(trimmedRates, 0.5),
    // P20 is used for the minimum benchmark because it captures a defensible low bound without overreacting to one-off troughs.
    annualP20Rate: quantile(trimmedRates, 0.2),
    annualP25Rate: quantile(trimmedRates, 0.25),
    annualP75Rate: quantile(trimmedRates, 0.75),
    usableRateCount: trimmedRates.length
  };
}

export function deriveOwnHistoryBaseSignal(params: OwnHistorySignalParams): PricingOwnHistorySignal {
  const currency = params.displayCurrency ?? "GBP";
  const qualifyingObservations = removeWeightedObservationOutliers(
    params.observations.filter(
      (observation) =>
        Number.isFinite(observation.achievedRate) &&
        observation.achievedRate > 0 &&
        Number.isFinite(observation.nightCount) &&
        observation.nightCount > 0 &&
        observation.losNights !== null &&
        observation.losNights > 0 &&
        observation.losNights <= 14 &&
        !["cancelled", "canceled", "no_show", "no-show"].includes(normalizeKey(observation.status))
    )
  );
  const losMatchedObservations = applyPreferredLosBucket(qualifyingObservations, params.preferredLosNights);
  const samePeriodRows = losMatchedObservations.filter(
    (observation) =>
      observation.stayDate >= addDaysToDateOnly(params.samePeriodStartDate, -21) &&
      observation.stayDate <= addDaysToDateOnly(params.samePeriodEndDate, 21)
  );

  const targetWeekdayCounts = new Map<number, number>();
  for (const dateOnly of params.targetDates) {
    const weekday = weekdayFromDateOnly(dateOnly);
    targetWeekdayCounts.set(weekday, (targetWeekdayCounts.get(weekday) ?? 0) + 1);
  }
  const sameWeekdayMedian = weightSignals(
    Array.from(targetWeekdayCounts.entries()).map(([weekday, count]) => ({
      value: weightedMedianFromObservations(
        losMatchedObservations.filter((observation) => weekdayFromDateOnly(observation.stayDate) === weekday)
      ),
      weight: count
    }))
  );

  const targetQuarter = quarterFromMonth(monthFromDateOnly(params.targetDates[0] ?? params.samePeriodStartDate));
  const seasonalRows = losMatchedObservations.filter(
    (observation) => quarterFromMonth(monthFromDateOnly(observation.stayDate)) === targetQuarter
  );

  const targetLeadTimeDays =
    params.targetDates.length > 0
      ? Math.max(
          0,
          Math.round(
            params.targetDates.reduce((sum, dateOnly) => sum + daysBetweenDateOnly(params.todayDateOnly, dateOnly), 0) / params.targetDates.length
          )
        )
      : null;
  const targetLeadTimeBucket = leadTimeBucketId(targetLeadTimeDays);
  const leadTimeRows = losMatchedObservations.filter(
    (observation) => leadTimeBucketId(observation.leadTimeDays) === targetLeadTimeBucket
  );
  const recentRows = losMatchedObservations.filter(
    (observation) =>
      observation.stayDate >= addDaysToDateOnly(params.todayDateOnly, -120) &&
      observation.stayDate < params.todayDateOnly
  );

  const samePeriodMedian = weightedMedianFromObservations(samePeriodRows);
  const seasonalMedian = weightedMedianFromObservations(seasonalRows);
  const leadTimeMedian = weightedMedianFromObservations(leadTimeRows);
  const recentMedian = weightedMedianFromObservations(recentRows);
  const ownHistoryBasePrice = weightSignals([
    { value: samePeriodMedian, weight: 0.4 },
    { value: sameWeekdayMedian, weight: 0.2 },
    { value: seasonalMedian, weight: 0.2 },
    { value: leadTimeMedian, weight: 0.1 },
    { value: recentMedian, weight: 0.1 }
  ]);
  const ownHistorySampleSize = observationWeightSum(losMatchedObservations);
  const distinctWeekdays = new Set(losMatchedObservations.map((observation) => weekdayFromDateOnly(observation.stayDate))).size;
  const distinctQuarters = new Set(
    losMatchedObservations.map((observation) => quarterFromMonth(monthFromDateOnly(observation.stayDate)))
  ).size;
  const leadTimeCoverage =
    losMatchedObservations.length > 0
      ? losMatchedObservations.filter((observation) => observation.leadTimeDays !== null).length / losMatchedObservations.length
      : 0;
  const sampleScore =
    ownHistorySampleSize >= 60 ? 1 : ownHistorySampleSize >= 30 ? 0.75 : ownHistorySampleSize >= 15 ? 0.5 : ownHistorySampleSize >= 8 ? 0.3 : 0.12;
  const weekdayCoverageScore =
    distinctWeekdays >= 6 ? 1 : distinctWeekdays >= 4 ? 0.68 : distinctWeekdays >= 2 ? 0.4 : 0.18;
  const seasonCoverageScore =
    distinctQuarters >= 3 ? 1 : distinctQuarters >= 2 ? 0.65 : distinctQuarters >= 1 ? 0.32 : 0;
  const recencyScore =
    observationWeightSum(recentRows) >= 14 ? 1 : observationWeightSum(recentRows) >= 7 ? 0.65 : observationWeightSum(recentRows) >= 3 ? 0.35 : 0.12;
  const samePeriodScore =
    observationWeightSum(samePeriodRows) >= 14 ? 1 : observationWeightSum(samePeriodRows) >= 7 ? 0.65 : observationWeightSum(samePeriodRows) >= 3 ? 0.35 : 0.12;
  const historyConfidenceScore = roundTo2(
    sampleScore * 0.35 +
      weekdayCoverageScore * 0.15 +
      seasonCoverageScore * 0.15 +
      recencyScore * 0.15 +
      samePeriodScore * 0.1 +
      leadTimeCoverage * 0.1
  );
  const ownHistoryConfidence = ownHistoryBasePrice !== null ? confidenceFromScore(historyConfidenceScore) : "low";
  const ownHistoryConfidenceLabel = confidenceLabel(ownHistoryConfidence);
  const ownHistorySummaryText =
    ownHistoryBasePrice !== null
      ? `Based on ${ownHistorySampleSize} qualifying short-stay booked night${ownHistorySampleSize === 1 ? "" : "s"} from similar periods, weekday mix, seasonality, and recent achieved pricing. Long stays over 14 nights are excluded.`
      : "Historic short-stay performance is still too thin to anchor the recommended base price confidently.";
  const ownHistoryExplanation =
    ownHistoryBasePrice !== null
      ? `This recommendation is anchored to your home's historic achieved booking rates for similar periods, then checked against nearby comparable homes. Long-stay bookings over 14 nights are excluded because they are often heavily discounted.`
      : "There is not enough qualifying short-stay booking history yet to make the property's own historic performance a strong base-price signal.";

  return {
    ownHistoryBasePrice,
    ownHistoryConfidence,
    ownHistorySampleSize,
    ownHistoryExplanation,
    ownHistorySummaryText,
    ownHistoryConfidenceLabel,
    provisionalRecommendedBasePrice: ownHistoryBasePrice
  };
}

/**
 * Builds the recommended nightly base price for a listing.
 *
 * Owner constraints:
 *   - 2026-04-25: near-identical apartments in the same portfolio must
 *     produce near-identical recommendations.
 *   - 2026-04-26: drop the "own-history base" anchor entirely (it tracked
 *     same-period achieved nightly rate and was creating noise relative
 *     to a simple trailing-ADR signal).
 *   - 2026-04-26: changing a property's quality tier MUST move the price
 *     (previously the formula ignored quality entirely).
 *
 * The recommendation is now built from a weighted blend of THREE
 * deterministic anchors, then multiplied by a quality-tier factor. None
 * of the inputs depend on AirROI or any live external service.
 *
 *   1. Last-year ADR (HEAVIEST — weight 0.55 when present)
 *      = `trailing365dAdr`, optionally nudged ±10% by occupancy:
 *        occ < 0.4 → ×0.9 (overpriced, room to drop)
 *        occ > 0.85 → ×1.1 (underpriced, room to push)
 *      What the listing has actually achieved over 365 days is the
 *      strongest single signal of what it can achieve next year.
 *
 *   2. Market benchmark (weight 0.30 when present)
 *      = `marketBenchmarkBasePrice` from cached comparable comps. Pulls
 *      the price toward what nearby similar properties are achieving.
 *      Cached data only — no AirROI calls.
 *
 *   3. Size anchor (weight 0.15 when other anchors present, rises to 0.45
 *      when the market benchmark is missing)
 *      = a flat-rate floor derived from bedrooms / bathrooms / max guests.
 *      Two identically-sized listings always get the same size anchor.
 *      Kept at low weight because the market benchmark already reflects
 *      similar-size properties when comparables are available; size acts
 *      as a stability floor for the "near-identical apartments" guarantee
 *      AND as a fallback when comparables are thin.
 *
 *   4. Last-resort fallback (`fallbackBasePrice`, weight 1.0 when nothing
 *      else fires) — typically the same-month last-year ADR. Only used
 *      when all three anchors above are missing.
 *
 * After blending, the result is multiplied by `qualityMultiplier` (default
 * 1) so changing a listing's quality tier from low_scale to upscale
 * actually moves the recommended price.
 *
 * The blend × quality is then rounded to the configured rounding
 * increment. The minimum price (computed downstream) is `base × 0.7`
 * (i.e. -30%).
 *
 * Determinism: same inputs → same output. The function does no I/O and
 * does not call any external API.
 */
export function buildRecommendedBaseFromHistoryAndMarket(
  params: RecommendedBaseParams
): RecommendedBaseResult {
  const sizeAnchor = computeSizeAnchorBasePrice(params.listingSize ?? null);
  const trailingAdrAnchor = applyOccupancyNudge(
    sanitisePositive(params.trailing365dAdr ?? null),
    params.trailing365dOccupancy ?? null
  );
  const marketBenchmark = sanitisePositive(params.marketBenchmarkBasePrice);
  const fallback = sanitisePositive(params.fallbackBasePrice);

  const signals: Array<{ value: number; weight: number }> = [];

  if (trailingAdrAnchor !== null) {
    signals.push({ value: trailingAdrAnchor, weight: 0.55 });
  }

  if (marketBenchmark !== null) {
    signals.push({ value: marketBenchmark, weight: 0.3 });
  }

  if (sizeAnchor !== null) {
    // Modest weight when market benchmark is present (size is implicit in
    // comparable selection); rises when market benchmark is missing so the
    // recommendation still has structural grounding.
    const sizeWeight = marketBenchmark === null ? 0.45 : 0.15;
    signals.push({ value: sizeAnchor, weight: sizeWeight });
  }

  // Legacy last-resort fallback only fires when every primary anchor is
  // unavailable. Otherwise it would dilute the new three-anchor blend.
  if (signals.length === 0 && fallback !== null) {
    signals.push({ value: fallback, weight: 1 });
  }

  let finalRecommendedBasePrice: number | null = null;

  if (signals.length > 0) {
    const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
    if (totalWeight > 0) {
      finalRecommendedBasePrice = roundTo2(
        signals.reduce((sum, signal) => sum + signal.value * signal.weight, 0) / totalWeight
      );
    }
  }

  // Apply quality-tier multiplier (default 1 = no adjustment). low_scale
  // properties get nudged down, upscale up; the actual factors come from
  // pricing_settings.qualityMultipliers.
  const qualityMultiplier = sanitisePositive(params.qualityMultiplier ?? 1) ?? 1;
  if (finalRecommendedBasePrice !== null && qualityMultiplier !== 1) {
    finalRecommendedBasePrice = roundTo2(finalRecommendedBasePrice * qualityMultiplier);
  }

  if (
    finalRecommendedBasePrice !== null &&
    params.roundingIncrement !== undefined &&
    Number.isFinite(params.roundingIncrement) &&
    params.roundingIncrement > 1
  ) {
    finalRecommendedBasePrice = roundTo2(
      Math.round(finalRecommendedBasePrice / params.roundingIncrement) * params.roundingIncrement
    );
  }

  return {
    finalRecommendedBasePrice
  };
}

/**
 * Translates listing structural attributes into a deterministic baseline
 * nightly rate. The numbers are intentionally conservative: this is a
 * *prior*, not a target. It only acts as a stability anchor so two
 * identically-sized listings in the same portfolio do not drift apart on
 * pure noise from booking history.
 *
 * Values are calibrated to roughly match a UK mid-market short-stay
 * portfolio in the GBP 80–250/night band. They get blended with stronger
 * own-history and market signals at much higher weight, so the absolute
 * numbers here only matter when *no* other signal is available — in which
 * case getting a roughly-right number out is still better than `null`.
 */
export function computeSizeAnchorBasePrice(
  listingSize: { bedroomsNumber: number | null; bathroomsNumber: number | null; personCapacity: number | null } | null
): number | null {
  if (!listingSize) return null;
  const bedrooms = sanitisePositive(listingSize.bedroomsNumber);
  const bathrooms = sanitisePositive(listingSize.bathroomsNumber);
  const guests = sanitisePositive(listingSize.personCapacity);

  if (bedrooms === null && bathrooms === null && guests === null) {
    return null;
  }

  // Base £80 + £40 per bedroom + £20 per bathroom + £10 per guest beyond 2.
  // Capped at a sensible upper bound so a malformed listing record cannot
  // push the recommendation into the stratosphere.
  const bedroomComponent = (bedrooms ?? 1) * 40;
  const bathroomComponent = (bathrooms ?? 1) * 20;
  const guestComponent = Math.max(0, (guests ?? 2) - 2) * 10;
  const raw = 80 + bedroomComponent + bathroomComponent + guestComponent;

  return roundTo2(clamp(raw, 50, 600));
}

/**
 * Nudges an ADR signal modestly based on trailing occupancy: very low
 * occupancy reduces the rate (the listing is overpriced), very high
 * occupancy slightly increases it (room to push). Bounded ±10% so it
 * cannot dominate the blend.
 */
function applyOccupancyNudge(rate: number | null, occupancy: number | null): number | null {
  if (rate === null) return null;
  if (occupancy === null || !Number.isFinite(occupancy)) return rate;

  if (occupancy < 0.4) return roundTo2(rate * 0.9);
  if (occupancy > 0.85) return roundTo2(rate * 1.1);
  return rate;
}

function sanitisePositive(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function getComparableMarketBenchmark(params: MarketBenchmarkParams): MarketBenchmarkResult {
  const currency = params.displayCurrency ?? "GBP";
  const structuralCandidates = params.comparables
    .flatMap((comparable) => {
      if (
        comparable.annualMedianRate === null ||
        comparable.annualP20Rate === null ||
        comparable.usableRateCount < 14
      ) {
        return [];
      }

      const structuralSimilarity = similarityScore(params.subject, comparable);
      if (structuralSimilarity <= 0) return [];
      const combinedSimilarity = similarityScore(params.subject, comparable, params.provisionalBasePrice ?? null);
      const priceSimilarity = pricePositionSimilarity(params.provisionalBasePrice ?? null, comparable.annualMedianRate);

      const bedroomAdjustment = safeRatioAdjustment(params.subject.bedroomsNumber, comparable.bedroomsNumber, 0.35, 0.85, 1.2);
      const capacityAdjustment = safeRatioAdjustment(params.subject.personCapacity, comparable.personCapacity, 0.2, 0.9, 1.15);
      const sizeAdjustment = safeRatioAdjustment(params.subject.propertySize, comparable.propertySize, 0.15, 0.9, 1.1);
      const qualityFactor = qualityAdjustment(params.subject.qualityTier, comparable.qualityTier);

      const combinedFactor = roundTo2(bedroomAdjustment * capacityAdjustment * sizeAdjustment * qualityFactor);

      return [
        {
          ...comparable,
          structuralSimilarityScore: structuralSimilarity,
          pricePositionSimilarityScore: priceSimilarity,
          similarityScore: combinedSimilarity,
          adjustedComparableBase: roundTo2(comparable.annualMedianRate * combinedFactor),
          adjustedComparableMinimum: roundTo2(comparable.annualP20Rate * combinedFactor)
        } satisfies ComparableBenchmarkCandidate
      ];
    })
    .sort((left, right) => {
      if (right.similarityScore !== left.similarityScore) return right.similarityScore - left.similarityScore;
      return right.usableRateCount - left.usableRateCount;
    });

  const provisionalBasePrice = params.provisionalBasePrice ?? null;
  const pricePositionedCandidates =
    provisionalBasePrice !== null
      ? structuralCandidates.filter((candidate) => {
          if (!candidate.annualMedianRate || provisionalBasePrice <= 0) return false;
          return Math.abs(candidate.annualMedianRate - provisionalBasePrice) / provisionalBasePrice <= 0.2;
        })
      : [];
  const comparatorCandidates =
    pricePositionedCandidates.length >= Math.max(6, Math.min(10, Math.floor(structuralCandidates.length * 0.4)))
      ? pricePositionedCandidates
      : structuralCandidates;

  const weightedBaseValues = comparatorCandidates.map((candidate) => ({
    value: candidate.adjustedComparableBase,
    weight: candidate.similarityScore
  }));
  const weightedMinimumValues = comparatorCandidates.map((candidate) => ({
    value: candidate.adjustedComparableMinimum,
    weight: candidate.similarityScore
  }));
  const marketBenchmarkBasePrice = weightedQuantile(weightedBaseValues, 0.5);
  const weightedMinimum = weightedQuantile(weightedMinimumValues, 0.5);
  const marketBenchmarkMinimumPrice =
    marketBenchmarkBasePrice !== null && weightedMinimum !== null
      ? roundTo2(Math.min(weightedMinimum, marketBenchmarkBasePrice * 0.95))
      : weightedMinimum;

  const averageSimilarity =
    comparatorCandidates.length > 0
      ? roundTo2(
          comparatorCandidates.reduce((sum, candidate) => sum + candidate.similarityScore, 0) / comparatorCandidates.length
        )
      : 0;
  const averagePricePositionSimilarity =
    pricePositionedCandidates.length > 0
      ? roundTo2(
          pricePositionedCandidates.reduce((sum, candidate) => sum + candidate.similarityScore, 0) / pricePositionedCandidates.length
        )
      : 0;

  const comparatorConfidence: PricingAnchorConfidence =
    comparatorCandidates.length >= 15 && averageSimilarity >= 0.68
      ? "high"
      : comparatorCandidates.length >= 8 && averageSimilarity >= 0.5
        ? "medium"
        : "low";
  const pricePositionedComparatorConfidence: PricingAnchorConfidence =
    pricePositionedCandidates.length >= 8 && averagePricePositionSimilarity >= 0.58
      ? "high"
      : pricePositionedCandidates.length >= 4 && averagePricePositionSimilarity >= 0.42
        ? "medium"
        : "low";

  return {
    marketBenchmarkBasePrice,
    marketBenchmarkMinimumPrice,
    comparatorCount: comparatorCandidates.length,
    comparatorConfidence,
    pricePositionedComparatorCount: pricePositionedCandidates.length,
    pricePositionedComparatorConfidence,
    comparatorCandidates,
    marketRangeLow: weightedQuantile(weightedBaseValues, 0.25),
    marketRangeHigh: weightedQuantile(weightedBaseValues, 0.75),
    marketMedianComparableBase: marketBenchmarkBasePrice,
    pricePositioningSummaryText:
      provisionalBasePrice !== null
        ? pricePositionedCandidates.length > 0
          ? `Cached comparables are reranked toward homes whose annual median rates sit near ${formatCurrency(provisionalBasePrice, currency)}. ${pricePositionedCandidates.length} comparables land within the target price band.`
          : `No cached comparables sit close to the provisional base of ${formatCurrency(provisionalBasePrice, currency)}, so the broader structural comparator pool is being used.`
        : "Price-tier reranking is inactive because the property's own historic signal is still too thin."
  };
}

function deviationBlend(userValue: number | null, benchmarkValue: number | null): { userWeight: number; marketWeight: number; deviation: number | null } {
  if (
    userValue === null ||
    benchmarkValue === null ||
    !Number.isFinite(userValue) ||
    !Number.isFinite(benchmarkValue) ||
    benchmarkValue <= 0
  ) {
    return { userWeight: 1, marketWeight: 0, deviation: null };
  }

  const deviation = Math.abs(userValue - benchmarkValue) / benchmarkValue;
  if (deviation <= 0.1) return { userWeight: 1, marketWeight: 0, deviation };
  if (deviation <= 0.25) return { userWeight: 0.75, marketWeight: 0.25, deviation };
  if (deviation <= 0.4) return { userWeight: 0.6, marketWeight: 0.4, deviation };
  return { userWeight: 0.4, marketWeight: 0.6, deviation };
}

function confidenceMarketWeight(confidence: PricingAnchorConfidence): number {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.6;
  return 0;
}

function blendWithMarket(userValue: number | null, benchmarkValue: number | null, confidence: PricingAnchorConfidence): number | null {
  if (userValue === null) return null;

  const blend = deviationBlend(userValue, benchmarkValue);
  const scaledMarketWeight = blend.marketWeight * confidenceMarketWeight(confidence);
  const scaledUserWeight = 1 - scaledMarketWeight;
  if (benchmarkValue === null || scaledMarketWeight <= 0) return roundTo2(userValue);
  return roundTo2(userValue * scaledUserWeight + benchmarkValue * scaledMarketWeight);
}

function formatCurrency(value: number | null, currency = "GBP"): string {
  if (value === null || !Number.isFinite(value)) return "—";

  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(Math.round(value));
  } catch {
    return `${currency} ${Math.round(value).toLocaleString("en-GB")}`;
  }
}

function confidenceLabel(value: PricingAnchorConfidence): string {
  if (value === "high") return "High confidence";
  if (value === "medium") return "Medium confidence";
  return "Low confidence";
}

function comparatorSummaryText(subject: PricingAnchorSubjectProfile, comparatorCount: number): string {
  const bedroomLabel = subject.bedroomsNumber !== null ? `${subject.bedroomsNumber}-bedroom` : "similar";
  const locality = subject.district ?? subject.locality ?? subject.marketLabel ?? "nearby";
  const matchedFields = [
    subject.marketLabel || subject.country || subject.region || subject.locality || subject.district ? "area" : null,
    subject.roomType ? "property type" : null,
    subject.bedroomsNumber !== null ? "bedrooms" : null,
    subject.personCapacity !== null ? "guest capacity" : null,
    subject.propertySize !== null ? "size" : null,
    subject.qualityTier ? "quality tier" : null
  ].filter((value): value is string => Boolean(value));

  return matchedFields.length > 0
    ? `Based on ${comparatorCount} comparable ${bedroomLabel} homes in ${locality}, matched by ${matchedFields.slice(0, 4).join(", ")}.`
    : `Based on ${comparatorCount} comparable ${bedroomLabel} homes in ${locality}.`;
}

function overrideImpactText(
  rawUserValue: number | null,
  effectiveValue: number | null,
  benchmarkValue: number | null,
  confidence: PricingAnchorConfidence,
  noun: "base" | "minimum",
  currency: string
): string {
  if (rawUserValue === null) {
    return noun === "base"
      ? "Future recommendations use the system recommended base price."
      : "Future recommendations use the system recommended minimum floor.";
  }

  if (benchmarkValue === null || confidence === "low" || effectiveValue === null || Math.abs(effectiveValue - rawUserValue) < 0.01) {
    return noun === "base"
      ? `You've set a manual base price of ${formatCurrency(rawUserValue, currency)}. Market evidence is limited or close to your value, so future recommendations use it directly.`
      : `You've set a manual minimum price of ${formatCurrency(rawUserValue, currency)}. Market evidence is limited or close to your value, so the floor is used directly.`;
  }

  return noun === "base"
    ? `You've set a manual base price of ${formatCurrency(rawUserValue, currency)}. Similar homes benchmark near ${formatCurrency(benchmarkValue, currency)}, so future recommendations use an effective market-adjusted base of ${formatCurrency(effectiveValue, currency)}.`
    : `You've set a manual minimum price of ${formatCurrency(rawUserValue, currency)}. Comparable homes support a floor near ${formatCurrency(benchmarkValue, currency)}, so future recommendations use an effective market-adjusted minimum of ${formatCurrency(effectiveValue, currency)}.`;
}

function buildFieldExplanation(params: {
  noun: "base" | "minimum";
  rawUserValue: number | null;
  effectiveValue: number | null;
  benchmarkValue: number | null;
  comparatorCount: number;
  comparatorConfidence: PricingAnchorConfidence;
  marketMedianComparableBase: number | null;
  marketRangeLow: number | null;
  marketRangeHigh: number | null;
  subject: PricingAnchorSubjectProfile;
  currency: string;
}): PricingAnchorFieldExplanation {
  const recommendedLabel = params.noun === "base" ? "Recommended base price" : "Recommended minimum price";
  const currentValueLabel = params.noun === "base" ? "Current base price" : "Current minimum price";
  const manualOverrideLabel = params.noun === "base" ? "Your manual base price" : "Your manual minimum price";
  const effectiveAnchorLabel =
    params.noun === "base" ? "Effective market-adjusted base" : "Effective market-adjusted minimum";
  const medianSource = params.noun === "base" ? params.marketMedianComparableBase : params.benchmarkValue;
  const marketMedianText =
    params.comparatorCount > 0 && medianSource !== null
      ? params.noun === "base"
        ? `The typical nightly base for comparable homes is ${formatCurrency(medianSource, params.currency)}, adjusted to this home's shape using cached market data.`
        : `The defensible lower floor for comparable homes is about ${formatCurrency(medianSource, params.currency)} per night.`
      : params.noun === "base"
        ? "There is not enough comparator evidence to produce a strong market-centred base benchmark yet."
        : "There is not enough comparator evidence to produce a strong market-aligned minimum floor yet.";
  const marketRangeText =
    params.marketRangeLow !== null && params.marketRangeHigh !== null
      ? `Most comparable homes sit between ${formatCurrency(params.marketRangeLow, params.currency)} and ${formatCurrency(params.marketRangeHigh, params.currency)}.`
      : "Comparable range is limited because the cached comparator set is thin.";

  return {
    recommendedLabel,
    currentValueLabel,
    manualOverrideLabel,
    effectiveAnchorLabel,
    marketMedianText,
    marketRangeText,
    comparatorSummaryText: comparatorSummaryText(params.subject, params.comparatorCount),
    // The UI keeps these strings short and deterministic so users can see the market evidence
    // behind a recommendation without reading through the underlying benchmark math.
    overrideImpactText: overrideImpactText(
      params.rawUserValue,
      params.effectiveValue,
      params.benchmarkValue,
      params.comparatorConfidence,
      params.noun,
      params.currency
    ),
    confidenceLabel: confidenceLabel(params.comparatorConfidence)
  };
}

export function buildEffectivePricingAnchors(params: EffectiveAnchorParams): PricingAnchorContext {
  const currency = params.displayCurrency ?? "GBP";
  // "Current" is the value saved on the property today and shown in the editable field.
  // "Raw user" keeps the literal property override separate so we can explain when the engine
  // still uses a market-adjusted effective anchor behind the scenes.
  const currentBasePrice = params.rawUserBasePrice ?? params.recommendedBasePrice;
  const currentMinimumPrice = params.rawUserMinimumPrice ?? params.recommendedMinimumPrice;
  // Effective anchors are the inputs that feed the unchanged downstream daily pricing formula.
  const effectiveBasePrice =
    params.rawUserBasePrice !== null
      ? blendWithMarket(params.rawUserBasePrice, params.marketBenchmarkBasePrice, params.comparatorConfidence)
      : params.recommendedBasePrice;
  const effectiveMinimumPrice =
    params.rawUserMinimumPrice !== null
      ? blendWithMarket(params.rawUserMinimumPrice, params.marketBenchmarkMinimumPrice, params.comparatorConfidence)
      : params.recommendedMinimumPrice;
  const pricingAnchorSource: PricingAnchorSource =
    params.rawUserBasePrice === null && params.rawUserMinimumPrice === null
      ? "system"
      : (effectiveBasePrice !== null &&
            params.rawUserBasePrice !== null &&
            Math.abs(effectiveBasePrice - params.rawUserBasePrice) >= 0.01) ||
          (effectiveMinimumPrice !== null &&
            params.rawUserMinimumPrice !== null &&
            Math.abs(effectiveMinimumPrice - params.rawUserMinimumPrice) >= 0.01)
        ? "blended-market"
        : "user";

  const baseDisplay = buildFieldExplanation({
    noun: "base",
    rawUserValue: params.rawUserBasePrice,
    effectiveValue: effectiveBasePrice,
    benchmarkValue: params.marketBenchmarkBasePrice,
    comparatorCount: params.comparatorCount,
    comparatorConfidence: params.comparatorConfidence,
    marketMedianComparableBase: params.marketMedianComparableBase,
    marketRangeLow: params.marketRangeLow,
    marketRangeHigh: params.marketRangeHigh,
    subject: params.subject,
    currency
  });
  const minimumDisplay = buildFieldExplanation({
    noun: "minimum",
    rawUserValue: params.rawUserMinimumPrice,
    effectiveValue: effectiveMinimumPrice,
    benchmarkValue: params.marketBenchmarkMinimumPrice,
    comparatorCount: params.comparatorCount,
    comparatorConfidence: params.comparatorConfidence,
    marketMedianComparableBase: params.marketMedianComparableBase,
    marketRangeLow: params.marketRangeLow,
    marketRangeHigh: params.marketRangeHigh,
    subject: params.subject,
    currency
  });

  return {
    rawUserBasePrice: params.rawUserBasePrice,
    rawUserMinimumPrice: params.rawUserMinimumPrice,
    currentBasePrice,
    currentMinimumPrice,
    recommendedBasePrice: params.recommendedBasePrice,
    recommendedMinimumPrice: params.recommendedMinimumPrice,
    ownHistoryBasePrice: params.ownHistoryBasePrice,
    ownHistoryConfidence: params.ownHistoryConfidence,
    ownHistorySampleSize: params.ownHistorySampleSize,
    ownHistoryExplanation: params.ownHistoryExplanation,
    ownHistorySummaryText: params.ownHistorySummaryText,
    ownHistoryConfidenceLabel: params.ownHistoryConfidenceLabel,
    provisionalRecommendedBasePrice: params.provisionalRecommendedBasePrice,
    finalRecommendedBasePrice: params.finalRecommendedBasePrice,
    marketBenchmarkBasePrice: params.marketBenchmarkBasePrice,
    marketBenchmarkMinimumPrice: params.marketBenchmarkMinimumPrice,
    pricePositionedComparatorCount: params.pricePositionedComparatorCount,
    pricePositionedComparatorConfidence: params.pricePositionedComparatorConfidence,
    pricePositioningSummaryText: params.pricePositioningSummaryText,
    effectiveBasePrice,
    effectiveMinimumPrice,
    comparatorCount: params.comparatorCount,
    comparatorConfidence: params.comparatorConfidence,
    pricingAnchorSource,
    basePriceExplanation: baseDisplay.overrideImpactText,
    minimumPriceExplanation: minimumDisplay.overrideImpactText,
    marketContextSummary:
      params.ownHistoryBasePrice !== null || params.comparatorCount > 0
        ? [
            params.ownHistoryBasePrice !== null ? params.ownHistoryExplanation : null,
            params.comparatorCount > 0 ? baseDisplay.comparatorSummaryText : null,
            params.comparatorCount > 0 ? baseDisplay.marketMedianText : null,
            params.comparatorCount > 0 ? baseDisplay.marketRangeText : null
          ]
            .filter((value): value is string => Boolean(value))
            .join(" ")
        : "Market context is limited, so the pricing engine is relying more heavily on the current saved anchors.",
    baseDisplay,
    minimumDisplay
  };
}
