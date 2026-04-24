import {
  createMarketDataProvider,
  type MarketComparableListing as AirRoiComparableListing,
  type MarketFutureRate as AirRoiFutureRate,
  type MarketIdentity as AirRoiMarket,
  type MarketFilter as AirRoiMarketFilter,
  type MarketSummary as AirRoiMarketSummary,
  type MarketMetricSeriesPoint as AirRoiMetricSeriesPoint
} from "@/lib/pricing/market-data-provider";
import {
  deriveComparableAnnualAnchors,
  type PricingAnchorComparableProfile
} from "@/lib/pricing/market-anchor";
import {
  PricingDemandTier,
  PricingResolvedSettings,
  qualityMultiplierForTier,
  resolveDemandMultiplier,
  resolvePaceMultiplierFromVariance
} from "@/lib/pricing/settings";

export type PricingMarketListing = {
  id: string;
  name: string;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  publicAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  roomType: string | null;
  bedroomsNumber: number | null;
  bathroomsNumber: number | null;
  bedsNumber: number | null;
  personCapacity: number | null;
  guestsIncluded: number | null;
  minNights: number | null;
  cleaningFee: number | null;
  averageReviewRating: number | null;
  pricingSettings: PricingResolvedSettings;
};

export type PricingBreakdownItem = {
  label: string;
  amount: number | null;
  unit: "currency" | "number" | "percent" | "multiplier";
};

export type PricingSuggestedValue = {
  value: number | null;
  source:
    | "manual_override"
    | "market_comparable_daily"
    | "market_comparable_summary"
    | "market_adr_fallback"
    | "insufficient_data";
  breakdown: PricingBreakdownItem[];
};

export type PricingMarketDay = {
  date: string;
  comparableMedianRate: number | null;
  comparableRateCount: number;
  comparisonRates: number[];
  yearlyMedianRate: number | null;
  monthMedianRate: number | null;
  dayOfWeekMedianRate: number | null;
  seasonalityPct: number | null;
  seasonalityMultiplier: number | null;
  dayOfWeekPct: number | null;
  dayOfWeekMultiplier: number | null;
  marketDemandTier: PricingDemandTier;
  marketDemandIndex: -2 | -1 | 0 | 1 | 2;
  demandMultiplier: number;
  marketOccupancy: number | null;
  marketAverageDailyRate: number | null;
  marketFuturePacing: number | null;
  paceMultiplier: number;
  demandBand: 1 | 2 | 3 | 4 | 5;
  breakdown: PricingBreakdownItem[];
};

export type PricingMarketListingContext = {
  listingId: string;
  marketLabel: string | null;
  marketScopeLabel: string | null;
  comparableCount: number;
  comparisonLosNights: number | null;
  yearlyMedianRate: number | null;
  baseSuggested: PricingSuggestedValue;
  minimumSuggested: PricingSuggestedValue;
  anchorBenchmarkComparables: PricingAnchorComparableProfile[];
  days: Map<string, PricingMarketDay>;
};

type ComparableRateSeries = {
  comparable: AirRoiComparableListing;
  ratesByDate: Map<string, AirRoiFutureRate>;
  feeAdjustment: number;
};

type PricingMarketParams = {
  listings: PricingMarketListing[];
  dayKeys: string[];
  forceRefresh?: boolean;
  allowLiveFetch?: boolean;
};

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundTo2((sorted[midpoint - 1] + sorted[midpoint]) / 2);
  }
  return roundTo2(sorted[midpoint] ?? 0);
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function monthKey(dateOnly: string): string {
  return dateOnly.slice(0, 7);
}

function weekdayFromDate(dateOnly: string): number {
  return new Date(`${dateOnly}T00:00:00Z`).getUTCDay();
}

function numericDifferenceScore(subject: number | null, candidate: number | null, exactWeight: number, nearWeight: number): number {
  if (subject === null || candidate === null) return 0;
  const difference = Math.abs(subject - candidate);
  if (difference < 0.01) return exactWeight;
  if (difference <= 1) return nearWeight;
  return 0;
}

function toPercentileRank(value: number | null, distribution: number[]): number | null {
  if (value === null || distribution.length === 0) return null;
  const lessOrEqual = distribution.filter((candidate) => candidate <= value).length;
  return Math.round((lessOrEqual / distribution.length) * 100);
}

function buildMarketLabel(market: AirRoiMarket | null): string | null {
  if (!market) return null;
  return [market.district, market.locality, market.region].filter(Boolean).join(", ") || market.country;
}

function buildMarketScopeLabel(market: AirRoiMarket | null): string | null {
  if (!market) return null;
  return [market.country, market.region, market.locality, market.district].filter(Boolean).join(" / ");
}

function buildMarketFilter(listing: PricingMarketListing): AirRoiMarketFilter {
  const filter: AirRoiMarketFilter = {
    room_type: { eq: listing.roomType ?? "entire_home" },
    min_nights: { lte: Math.max(7, listing.minNights ?? 2) }
  };

  if (listing.bedroomsNumber !== null) {
    filter.bedrooms = {
      range: [Math.max(0, listing.bedroomsNumber - 1), listing.bedroomsNumber + 1]
    };
  }

  if (listing.bathroomsNumber !== null) {
    filter.baths = {
      range: [Math.max(0.5, listing.bathroomsNumber - 0.5), listing.bathroomsNumber + 0.5]
    };
  }

  if (listing.personCapacity !== null) {
    filter.guests = {
      range: [Math.max(1, listing.personCapacity - 2), listing.personCapacity + 2]
    };
  }

  return filter;
}

function scoreComparable(listing: PricingMarketListing, comparable: AirRoiComparableListing, market: AirRoiMarket | null): number {
  const marketLocalityKey = normalizeKey(market?.locality);
  const marketDistrictKey = normalizeKey(market?.district);
  const localityKey = normalizeKey(comparable.location.locality);
  const districtKey = normalizeKey(comparable.location.district);

  let score = 0;
  if (listing.roomType && comparable.roomType && normalizeKey(listing.roomType) === normalizeKey(comparable.roomType)) {
    score += 8;
  }
  if (marketLocalityKey && localityKey === marketLocalityKey) score += 10;
  if (marketDistrictKey && districtKey === marketDistrictKey) score += 8;
  if (comparable.location.exactLocation) score += 2;
  score += numericDifferenceScore(listing.bedroomsNumber, comparable.propertyDetails.bedrooms, 8, 4);
  score += numericDifferenceScore(listing.bathroomsNumber, comparable.propertyDetails.baths, 6, 3);
  score += numericDifferenceScore(listing.personCapacity, comparable.propertyDetails.guests, 6, 3);
  score += numericDifferenceScore(listing.bedsNumber, comparable.propertyDetails.beds, 3, 1);
  if ((comparable.ratings.ratingOverall ?? 0) >= 4.8) score += 2;
  if ((comparable.ratings.numReviews ?? 0) >= 15) score += 2;
  return score;
}

function comparableFeeAdjustment(comp: AirRoiComparableListing, listing: PricingMarketListing, los: number): number {
  const comparableCleaningFee = comp.pricingInfo.cleaningFee ?? 0;
  const subjectCleaningFee = listing.cleaningFee ?? 0;
  return roundTo2((comparableCleaningFee - subjectCleaningFee) / Math.max(1, los));
}

function buildSeriesByMonth(series: AirRoiMetricSeriesPoint[]): Map<string, AirRoiMetricSeriesPoint> {
  return new Map(series.map((point) => [monthKey(point.date), point]));
}

function approximateLowerQuantile(point: AirRoiMetricSeriesPoint | null): number | null {
  if (!point) return null;
  if (point.p25 === undefined) return point.avg ?? null;
  if (point.p50 === undefined) return point.p25;
  return roundTo2(Math.max(0, point.p25 - (point.p50 - point.p25)));
}

function tierFromDemandIndex(value: number): PricingDemandTier {
  if (value <= -2) return "very_low";
  if (value === -1) return "low";
  if (value === 1) return "high";
  if (value >= 2) return "very_high";
  return "normal";
}

function bandFromDemandIndex(value: number): 1 | 2 | 3 | 4 | 5 {
  if (value <= -2) return 1;
  if (value === -1) return 2;
  if (value === 1) return 4;
  if (value >= 2) return 5;
  return 3;
}

function resolveDemandIndex(params: {
  occupancyPoint: AirRoiMetricSeriesPoint | null;
  comparableMedianRate: number | null;
  monthMedianRate: number | null;
  availableRatio: number | null;
}): -2 | -1 | 0 | 1 | 2 {
  let score = 0;
  const occupancyPoint = params.occupancyPoint;

  if (occupancyPoint && Number.isFinite(occupancyPoint.avg)) {
    const lowerQuantile = approximateLowerQuantile(occupancyPoint);
    if (lowerQuantile !== null && occupancyPoint.avg <= lowerQuantile) score -= 1.5;
    else if (occupancyPoint.p25 !== undefined && occupancyPoint.avg <= occupancyPoint.p25) score -= 1;
    else if (occupancyPoint.p90 !== undefined && occupancyPoint.avg >= occupancyPoint.p90) score += 1.5;
    else if (occupancyPoint.p75 !== undefined && occupancyPoint.avg >= occupancyPoint.p75) score += 1;
  }

  if (
    params.comparableMedianRate !== null &&
    params.monthMedianRate !== null &&
    params.monthMedianRate > 0
  ) {
    const dailyRatio = params.comparableMedianRate / params.monthMedianRate;
    if (dailyRatio >= 1.1) score += 0.5;
    else if (dailyRatio <= 0.9) score -= 0.5;
  }

  if (params.availableRatio !== null) {
    if (params.availableRatio <= 0.35) score += 0.5;
    else if (params.availableRatio >= 0.75) score -= 0.5;
  }

  return clamp(Math.round(score), -2, 2) as -2 | -1 | 0 | 1 | 2;
}

function roundRecommendedPrice(value: number | null, increment: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (increment <= 1) return Math.round(value);
  return Math.round(value / increment) * increment;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const output = new Array<R>(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      output[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return output;
}

export async function buildMarketPricingContexts(
  params: PricingMarketParams
): Promise<Map<string, PricingMarketListingContext>> {
  const liveMarketFetchAllowed = params.allowLiveFetch ?? false;
  const client = createMarketDataProvider({
    forceRefresh: params.forceRefresh ?? false,
    allowLiveFetch: liveMarketFetchAllowed
  });
  if (!client || params.listings.length === 0 || params.dayKeys.length === 0) {
    return new Map<string, PricingMarketListingContext>();
  }

  const lookupCache = new Map<string, Promise<AirRoiMarket | null>>();
  const summaryCache = new Map<string, Promise<AirRoiMarketSummary | null>>();
  const occupancyCache = new Map<string, Promise<AirRoiMetricSeriesPoint[]>>();
  const adrCache = new Map<string, Promise<AirRoiMetricSeriesPoint[]>>();
  const pacingCache = new Map<string, Promise<AirRoiMetricSeriesPoint[]>>();
  const comparableCache = new Map<string, Promise<AirRoiComparableListing[]>>();
  const futureRateCache = new Map<string, Promise<Map<string, AirRoiFutureRate>>>();

  const contexts = await mapWithConcurrency<PricingMarketListing, PricingMarketListingContext | null>(params.listings, 3, async (listing) => {
    try {
      const marketLookupKey =
        listing.latitude !== null && listing.longitude !== null
          ? `${listing.latitude.toFixed(4)}:${listing.longitude.toFixed(4)}`
          : `${normalizeKey(listing.country)}:${normalizeKey(listing.state)}:${normalizeKey(listing.city)}`;

      let marketPromise = lookupCache.get(marketLookupKey);
      if (!marketPromise) {
        if (listing.latitude !== null && listing.longitude !== null) {
          marketPromise = client.lookupMarket({
            latitude: listing.latitude,
            longitude: listing.longitude
          });
        } else if (listing.country && listing.city) {
          marketPromise = Promise.resolve({
            country: listing.country,
            region: listing.state ?? undefined,
            locality: listing.city,
            district: undefined
          } satisfies AirRoiMarket);
        } else {
          marketPromise = Promise.resolve(null);
        }
        lookupCache.set(marketLookupKey, marketPromise);
      }

      const market = await marketPromise;
      if (!market?.country) return null;

      const marketRequest = {
        market: {
          country: market.country,
          region: market.region,
          locality: market.locality,
          district: market.district
        },
        filter: buildMarketFilter(listing),
        num_months: 12,
        currency: "native"
      };

      const marketRequestKey = JSON.stringify(marketRequest);
      let summaryPromise = summaryCache.get(marketRequestKey);
      if (!summaryPromise) {
        summaryPromise = client.getMarketSummary(marketRequest);
        summaryCache.set(marketRequestKey, summaryPromise);
      }

      let occupancyPromise = occupancyCache.get(marketRequestKey);
      if (!occupancyPromise) {
        occupancyPromise = client.getMarketOccupancy(marketRequest);
        occupancyCache.set(marketRequestKey, occupancyPromise);
      }

      let adrPromise = adrCache.get(marketRequestKey);
      if (!adrPromise) {
        adrPromise = client.getMarketAverageDailyRate(marketRequest);
        adrCache.set(marketRequestKey, adrPromise);
      }

      let pacingPromise = pacingCache.get(marketRequestKey);
      if (!pacingPromise) {
        pacingPromise = client.getMarketFuturePacing(marketRequest);
        pacingCache.set(marketRequestKey, pacingPromise);
      }

      const hasCoordinates = listing.latitude !== null && listing.longitude !== null;
      const comparableRequest = {
        latitude: hasCoordinates ? listing.latitude ?? undefined : undefined,
        longitude: hasCoordinates ? listing.longitude ?? undefined : undefined,
        address: hasCoordinates ? undefined : listing.address ?? listing.publicAddress ?? undefined,
        bedrooms: listing.bedroomsNumber ?? undefined,
        baths: listing.bathroomsNumber ?? undefined,
        guests: listing.personCapacity ?? undefined,
        currency: "native"
      };
      const comparableKey = JSON.stringify(comparableRequest);
      let comparablePromise = comparableCache.get(comparableKey);
      if (!comparablePromise) {
        comparablePromise = client.getComparableListings(comparableRequest);
        comparableCache.set(comparableKey, comparablePromise);
      }

      const [summary, occupancySeries, adrSeries, pacingSeries, comparableListings] = await Promise.all([
        summaryPromise,
        occupancyPromise,
        adrPromise,
        pacingPromise,
        comparablePromise
      ]);

      const rankedComparableEntries = comparableListings
        .filter((comparable) => comparable.listingId !== listing.id)
        .map((comparable) => ({
          comparable,
          score: scoreComparable(listing, comparable, market)
        }))
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return (right.comparable.ratings.numReviews ?? 0) - (left.comparable.ratings.numReviews ?? 0);
        })
        .slice(0, 24);
      const rankedComparables = rankedComparableEntries.slice(0, 6).map((entry) => entry.comparable);
      const benchmarkComparables = rankedComparableEntries.slice(0, 18).map((entry) => entry.comparable);

      const candidateMinNights = [
        listing.minNights,
        summary?.minNights ?? null,
        ...rankedComparables.map((comparable) => comparable.bookingSettings.minNights)
      ].flatMap((value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? [value] : []));
      const comparisonLosNights = clamp(Math.round(median(candidateMinNights) ?? 2), 2, 7);

      const comparableSeries = await mapWithConcurrency(rankedComparables, 3, async (comparable) => {
        let futureRatesPromise = futureRateCache.get(comparable.listingId);
        if (!futureRatesPromise) {
          futureRatesPromise = client
            .getListingFutureRates(comparable.listingId, "native")
            .then((rates) => new Map(rates.map((rate) => [rate.date, rate])))
            .catch((error) => {
              const logMessage = liveMarketFetchAllowed
                ? "[pricing] failed to load comparable future rates"
                : "[pricing] comparable future rates unavailable in stored market mode";
              const logMethod = liveMarketFetchAllowed ? console.error : console.warn;
              logMethod(logMessage, {
                comparableListingId: comparable.listingId,
                error: error instanceof Error ? error.message : String(error)
              });
              return new Map<string, AirRoiFutureRate>();
            });
          futureRateCache.set(comparable.listingId, futureRatesPromise);
        }

        return {
          comparable,
          ratesByDate: await futureRatesPromise,
          feeAdjustment: comparableFeeAdjustment(comparable, listing, comparisonLosNights)
        } satisfies ComparableRateSeries;
      });

      const anchorBenchmarkComparables = await mapWithConcurrency(benchmarkComparables, 4, async (comparable) => {
        let futureRatesPromise = futureRateCache.get(comparable.listingId);
        if (!futureRatesPromise) {
          futureRatesPromise = client
            .getListingFutureRates(comparable.listingId, "native")
            .then((rates) => new Map(rates.map((rate) => [rate.date, rate])))
            .catch((error) => {
              const logMessage = liveMarketFetchAllowed
                ? "[pricing] failed to load benchmark comparable future rates"
                : "[pricing] benchmark comparable future rates unavailable in stored market mode";
              const logMethod = liveMarketFetchAllowed ? console.error : console.warn;
              logMethod(logMessage, {
                comparableListingId: comparable.listingId,
                error: error instanceof Error ? error.message : String(error)
              });
              return new Map<string, AirRoiFutureRate>();
            });
          futureRateCache.set(comparable.listingId, futureRatesPromise);
        }

        const feeAdjustment = comparableFeeAdjustment(comparable, listing, comparisonLosNights);
        const ratesByDate = await futureRatesPromise;
        const anchorSummary = deriveComparableAnnualAnchors({
          rates: Array.from(ratesByDate.values()).map((rate) => ({
            rate: rate.rate,
            available: rate.available
          })),
          feeAdjustment
        });

        return {
          listingId: comparable.listingId,
          listingName: comparable.listingName,
          country: comparable.location.country,
          region: comparable.location.region,
          locality: comparable.location.locality,
          district: comparable.location.district,
          exactLocation: comparable.location.exactLocation,
          roomType: comparable.roomType,
          bedroomsNumber: comparable.propertyDetails.bedrooms,
          personCapacity: comparable.propertyDetails.guests,
          propertySize: null,
          qualityTier: null,
          annualMedianRate: anchorSummary.annualMedianRate,
          annualP20Rate: anchorSummary.annualP20Rate,
          annualP25Rate: anchorSummary.annualP25Rate,
          annualP75Rate: anchorSummary.annualP75Rate,
          usableRateCount: anchorSummary.usableRateCount
        } satisfies PricingAnchorComparableProfile;
      });

      const allComparableRates: number[] = [];
      const comparableRatesByMonth = new Map<string, number[]>();
      const comparableRatesByWeekday = new Map<number, number[]>();
      for (const series of comparableSeries) {
        for (const [dateKey, rate] of series.ratesByDate.entries()) {
          if (rate.rate === null) continue;
          const adjustedRate = roundTo2(rate.rate + series.feeAdjustment);
          allComparableRates.push(adjustedRate);
          const monthRates = comparableRatesByMonth.get(monthKey(dateKey)) ?? [];
          monthRates.push(adjustedRate);
          comparableRatesByMonth.set(monthKey(dateKey), monthRates);

          const weekdayRates = comparableRatesByWeekday.get(weekdayFromDate(dateKey)) ?? [];
          weekdayRates.push(adjustedRate);
          comparableRatesByWeekday.set(weekdayFromDate(dateKey), weekdayRates);
        }
      }

      const yearlyMedianRate = median(allComparableRates);
      const summaryComparableRates = comparableSeries
        .map((series) => {
          const baseRate =
            series.comparable.performanceMetrics.ttmAvgRate ??
            series.comparable.performanceMetrics.l90dAvgRate ??
            null;
          if (baseRate === null) return null;
          return roundTo2(baseRate + series.feeAdjustment);
        })
        .filter((value): value is number => value !== null);
      const summaryMedianRate = median(summaryComparableRates);
      const baselineAdr = median(
        adrSeries.map((point) => point.avg).filter((value) => Number.isFinite(value) && value > 0)
      );
      const baseRaw =
        yearlyMedianRate ??
        summaryMedianRate ??
        baselineAdr ??
        summary?.averageDailyRate ??
        null;
      const qualityMultiplier = qualityMultiplierForTier(listing.pricingSettings);
      const computedBasePrice =
        baseRaw !== null ? roundRecommendedPrice(baseRaw * qualityMultiplier, listing.pricingSettings.roundingIncrement) : null;
      const baseSuggestedValue = computedBasePrice;
      const baseSuggestedSource: PricingSuggestedValue["source"] =
        yearlyMedianRate !== null
          ? "market_comparable_daily"
          : summaryMedianRate !== null
            ? "market_comparable_summary"
            : baselineAdr !== null || summary?.averageDailyRate !== null
              ? "market_adr_fallback"
              : "insufficient_data";

      const minimumFactorFloor =
        baseSuggestedValue !== null
          ? roundTo2(baseSuggestedValue * (1 - listing.pricingSettings.minimumPriceAbsoluteGapPct / 100))
          : null;
      const computedMinimumPrice =
        baseSuggestedValue !== null
          ? roundRecommendedPrice(baseSuggestedValue * listing.pricingSettings.minimumPriceFactor, listing.pricingSettings.roundingIncrement)
          : null;
      const minimumSuggestedValue =
        computedMinimumPrice !== null && minimumFactorFloor !== null
          ? roundTo2(Math.min(computedMinimumPrice, minimumFactorFloor))
          : computedMinimumPrice;

      const monthMedianByMonth = new Map<string, number>();
      for (const [monthLabel, values] of comparableRatesByMonth.entries()) {
        const monthMedian = median(values);
        if (monthMedian !== null) {
          monthMedianByMonth.set(monthLabel, monthMedian);
        }
      }

      const dayOfWeekMedianByWeekday = new Map<number, number>();
      for (const [weekday, values] of comparableRatesByWeekday.entries()) {
        const weekdayMedian = median(values);
        if (weekdayMedian !== null) {
          dayOfWeekMedianByWeekday.set(weekday, weekdayMedian);
        }
      }

      const occupancyByMonth = buildSeriesByMonth(occupancySeries);
      const adrByMonth = buildSeriesByMonth(adrSeries);
      const pacingByMonth = buildSeriesByMonth(pacingSeries);
      const pacingMedian = median(
        pacingSeries.map((point) => point.avg).filter((value) => Number.isFinite(value) && value > 0)
      );
      const days = new Map<string, PricingMarketDay>();

      for (const dateKey of params.dayKeys) {
        const distribution = comparableSeries.flatMap((series) => {
          const daily = series.ratesByDate.get(dateKey);
          if (!daily || daily.rate === null) return [];
          return [roundTo2(daily.rate + series.feeAdjustment)];
        });
        const availableRates = comparableSeries.flatMap((series) => {
          const daily = series.ratesByDate.get(dateKey);
          if (!daily || daily.rate === null || !daily.available) return [];
          return [roundTo2(daily.rate + series.feeAdjustment)];
        });
        const comparableMedianRate = median(availableRates.length >= 2 ? availableRates : distribution);
        const monthLabel = monthKey(dateKey);
        const monthMedianRate =
          monthMedianByMonth.get(monthLabel) ??
          (yearlyMedianRate !== null && baselineAdr !== null && baselineAdr > 0 && adrByMonth.get(monthLabel)?.avg
            ? roundTo2(yearlyMedianRate * ((adrByMonth.get(monthLabel)?.avg ?? baselineAdr) / baselineAdr))
            : null);
        const weekdayMedianRate = dayOfWeekMedianByWeekday.get(weekdayFromDate(dateKey)) ?? null;
        const seasonalityPct =
          yearlyMedianRate !== null && monthMedianRate !== null && yearlyMedianRate > 0
            ? roundTo2(((monthMedianRate - yearlyMedianRate) / yearlyMedianRate) * 100)
            : null;
        const seasonalityMultiplier =
          seasonalityPct !== null
            ? roundTo2(
                clamp(
                  1 + (seasonalityPct / 100) * listing.pricingSettings.seasonalitySensitivityFactor,
                  listing.pricingSettings.seasonalityMultiplierFloor,
                  listing.pricingSettings.seasonalityMultiplierCeiling
                )
              )
            : 1;
        const dayOfWeekPct =
          yearlyMedianRate !== null && weekdayMedianRate !== null && yearlyMedianRate > 0
            ? roundTo2(((weekdayMedianRate - yearlyMedianRate) / yearlyMedianRate) * 100)
            : null;
        const dayOfWeekMultiplier =
          dayOfWeekPct !== null
            ? roundTo2(
                clamp(
                  1 + (dayOfWeekPct / 100) * listing.pricingSettings.dayOfWeekSensitivityFactor,
                  listing.pricingSettings.dayOfWeekMultiplierFloor,
                  listing.pricingSettings.dayOfWeekMultiplierCeiling
                )
              )
            : 1;
        const occupancyPoint = occupancyByMonth.get(monthLabel) ?? null;
        const monthFuturePacing = pacingByMonth.get(monthLabel)?.avg ?? null;
        const paceVarianceRatio =
          monthFuturePacing !== null && pacingMedian !== null && pacingMedian > 0
            ? monthFuturePacing / pacingMedian
            : null;
        const paceMultiplier = roundTo2(resolvePaceMultiplierFromVariance(listing.pricingSettings, paceVarianceRatio));
        const availableRatio =
          comparableSeries.length > 0 ? availableRates.length / comparableSeries.length : null;
        const marketDemandIndex = resolveDemandIndex({
          occupancyPoint,
          comparableMedianRate,
          monthMedianRate,
          availableRatio
        });
        const marketDemandTier = tierFromDemandIndex(marketDemandIndex);
        const demandBand = bandFromDemandIndex(marketDemandIndex);
        const demandMultiplier = resolveDemandMultiplier(listing.pricingSettings, marketDemandTier);

        days.set(dateKey, {
          date: dateKey,
          comparableMedianRate,
          comparableRateCount: distribution.length,
          comparisonRates: distribution,
          yearlyMedianRate,
          monthMedianRate,
          dayOfWeekMedianRate: weekdayMedianRate,
          seasonalityPct,
          seasonalityMultiplier,
          dayOfWeekPct,
          dayOfWeekMultiplier,
          marketDemandTier,
          marketDemandIndex,
          demandMultiplier,
          marketOccupancy:
            occupancyPoint && Number.isFinite(occupancyPoint.avg) ? roundTo2(occupancyPoint.avg * 100) : null,
          marketAverageDailyRate:
            adrByMonth.get(monthLabel)?.avg !== undefined ? roundTo2(adrByMonth.get(monthLabel)?.avg ?? 0) : null,
          marketFuturePacing: monthFuturePacing !== null ? roundTo2(monthFuturePacing * 100) : null,
          paceMultiplier,
          demandBand,
          breakdown: [
            { label: "Year median", amount: yearlyMedianRate, unit: "currency" },
            { label: "Month median", amount: monthMedianRate, unit: "currency" },
            { label: "Seasonality", amount: seasonalityMultiplier, unit: "multiplier" },
            { label: "DOW", amount: dayOfWeekMultiplier, unit: "multiplier" },
            { label: "Demand", amount: demandMultiplier, unit: "multiplier" },
            { label: "Pace", amount: paceMultiplier, unit: "multiplier" }
          ]
        });
      }

      return {
        listingId: listing.id,
        marketLabel: buildMarketLabel(market),
        marketScopeLabel: buildMarketScopeLabel(market),
        comparableCount: rankedComparables.length,
        comparisonLosNights,
        yearlyMedianRate,
        baseSuggested: {
          value: baseSuggestedValue,
          source: baseSuggestedSource,
          breakdown: [
            { label: "Market median", amount: baseRaw, unit: "currency" },
            { label: "Quality", amount: qualityMultiplier, unit: "multiplier" },
            { label: "Final", amount: baseSuggestedValue, unit: "currency" }
          ]
        },
        minimumSuggested: {
          value: minimumSuggestedValue,
          source: baseSuggestedSource,
          breakdown: [
            { label: "Base", amount: baseSuggestedValue, unit: "currency" },
            {
              label: "Floor factor",
              amount: listing.pricingSettings.minimumPriceFactor,
              unit: "multiplier"
            },
            { label: "Gap cap", amount: minimumFactorFloor, unit: "currency" },
            { label: "Final", amount: minimumSuggestedValue, unit: "currency" }
          ]
        },
        anchorBenchmarkComparables,
        days
      } satisfies PricingMarketListingContext;
    } catch (error) {
      const logMessage = liveMarketFetchAllowed
        ? "[pricing] failed to build market pricing context"
        : "[pricing] market pricing context unavailable in stored market mode";
      const logMethod = liveMarketFetchAllowed ? console.error : console.warn;
      logMethod(logMessage, {
        listingId: listing.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  });

  const pairs: Array<[string, PricingMarketListingContext]> = [];
  for (const context of contexts) {
    if (!context) continue;
    pairs.push([context.listingId, context]);
  }

  return new Map(pairs);
}

export { roundRecommendedPrice, toPercentileRank };
