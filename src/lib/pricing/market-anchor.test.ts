import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEffectivePricingAnchors,
  buildRecommendedBaseFromHistoryAndMarket,
  deriveComparableAnnualAnchors,
  deriveOwnHistoryBaseSignal,
  getComparableMarketBenchmark,
  type PricingAnchorComparableProfile,
  type PricingAnchorHistoryObservation,
  type PricingAnchorSubjectProfile
} from "./market-anchor";

function createSubject(overrides: Partial<PricingAnchorSubjectProfile> = {}): PricingAnchorSubjectProfile {
  return {
    listingId: "subject-1",
    listingName: "Shoreditch Loft",
    marketLabel: "Shoreditch",
    country: "United Kingdom",
    region: "England",
    locality: "London",
    district: "Shoreditch",
    roomType: "entire_home",
    bedroomsNumber: 2,
    personCapacity: 5,
    propertySize: 72,
    qualityTier: "mid_scale",
    ...overrides
  };
}

function createComparable(overrides: Partial<PricingAnchorComparableProfile> = {}): PricingAnchorComparableProfile {
  return {
    listingId: "comp-1",
    listingName: "Comparable Home",
    country: "United Kingdom",
    region: "England",
    locality: "London",
    district: "Shoreditch",
    exactLocation: true,
    roomType: "entire_home",
    bedroomsNumber: 2,
    personCapacity: 4,
    propertySize: 68,
    qualityTier: "mid_scale",
    annualMedianRate: 235,
    annualP20Rate: 195,
    annualP25Rate: 205,
    annualP75Rate: 255,
    usableRateCount: 30,
    ...overrides
  };
}

function createHistoryObservation(overrides: Partial<PricingAnchorHistoryObservation> = {}): PricingAnchorHistoryObservation {
  return {
    stayDate: "2025-04-10",
    achievedRate: 200,
    nightCount: 1,
    leadTimeDays: 35,
    losNights: 3,
    status: "booked",
    ...overrides
  };
}

function createEffectiveAnchors(overrides: Partial<Parameters<typeof buildEffectivePricingAnchors>[0]> = {}) {
  return buildEffectivePricingAnchors({
    subject: createSubject(),
    rawUserBasePrice: null,
    rawUserMinimumPrice: null,
    recommendedBasePrice: 235,
    recommendedMinimumPrice: 195,
    ownHistoryBasePrice: 230,
    ownHistoryConfidence: "high",
    ownHistorySampleSize: 42,
    ownHistoryExplanation: "Anchored to your home's achieved booking rates.",
    ownHistorySummaryText: "Based on 42 qualifying short-stay booked nights from similar periods.",
    ownHistoryConfidenceLabel: "High confidence",
    provisionalRecommendedBasePrice: 230,
    finalRecommendedBasePrice: 235,
    marketBenchmarkBasePrice: 235,
    marketBenchmarkMinimumPrice: 195,
    comparatorCount: 18,
    comparatorConfidence: "high",
    pricePositionedComparatorCount: 12,
    pricePositionedComparatorConfidence: "high",
    pricePositioningSummaryText: "Comparables are reranked toward the same price tier.",
    marketRangeLow: 220,
    marketRangeHigh: 255,
    marketMedianComparableBase: 235,
    displayCurrency: "GBP",
    ...overrides
  });
}

test("own-history base signal uses qualifying short-stay bookings and excludes long stays, cancelled rows, and zero-value rows", () => {
  const signal = deriveOwnHistoryBaseSignal({
    observations: [
      createHistoryObservation({ stayDate: "2025-04-05", achievedRate: 210, losNights: 3 }),
      createHistoryObservation({ stayDate: "2025-04-06", achievedRate: 220, losNights: 2 }),
      createHistoryObservation({ stayDate: "2025-04-07", achievedRate: 0, losNights: 2 }),
      createHistoryObservation({ stayDate: "2025-04-08", achievedRate: 260, losNights: 15 }),
      createHistoryObservation({ stayDate: "2025-04-09", achievedRate: 230, losNights: 4, status: "cancelled" })
    ],
    targetDates: ["2026-04-04", "2026-04-05"],
    samePeriodStartDate: "2025-04-01",
    samePeriodEndDate: "2025-04-30",
    todayDateOnly: "2026-03-01",
    preferredLosNights: 2,
    displayCurrency: "GBP"
  });

  assert.equal(signal.ownHistorySampleSize, 2);
  assert.equal(signal.ownHistoryBasePrice, 211.11);
  assert.match(signal.ownHistoryExplanation, /14 nights/i);
});

test("same-period-last-year weighting influences the own-history base materially", () => {
  const signal = deriveOwnHistoryBaseSignal({
    observations: [
      ...Array.from({ length: 10 }, (_, index) => createHistoryObservation({ stayDate: `2025-04-${String(index + 1).padStart(2, "0")}`, achievedRate: 240 })),
      ...Array.from({ length: 10 }, (_, index) => createHistoryObservation({ stayDate: `2025-01-${String(index + 1).padStart(2, "0")}`, achievedRate: 120 }))
    ],
    targetDates: ["2026-04-10", "2026-04-11", "2026-04-12"],
    samePeriodStartDate: "2025-04-01",
    samePeriodEndDate: "2025-04-30",
    todayDateOnly: "2026-03-01",
    preferredLosNights: 3,
    displayCurrency: "GBP"
  });

  assert.ok((signal.ownHistoryBasePrice ?? 0) > 180);
});

test("weekday and seasonal effects influence the own-history base", () => {
  const signal = deriveOwnHistoryBaseSignal({
    observations: [
      ...["2025-02-01", "2025-02-08", "2025-02-15"].map((date) => createHistoryObservation({ stayDate: date, achievedRate: 230 })),
      ...["2025-04-05", "2025-04-12", "2025-04-19"].map((date) => createHistoryObservation({ stayDate: date, achievedRate: 220 })),
      ...["2025-04-07", "2025-04-14", "2025-04-21"].map((date) => createHistoryObservation({ stayDate: date, achievedRate: 120 }))
    ],
    targetDates: ["2026-04-04", "2026-04-05", "2026-04-11", "2026-04-12"],
    samePeriodStartDate: "2025-03-01",
    samePeriodEndDate: "2025-03-31",
    todayDateOnly: "2026-03-01",
    preferredLosNights: 3,
    displayCurrency: "GBP"
  });

  assert.ok((signal.ownHistoryBasePrice ?? 0) >= 190);
});

test("quality-tier multiplier moves the recommended base price", () => {
  // 2026-04-26: changing a property's quality tier MUST change the price
  // (previously the formula ignored quality entirely). Identical inputs
  // with different quality multipliers should produce visibly different
  // recommendations.
  const sharedInputs = {
    marketBenchmarkBasePrice: 200,
    fallbackBasePrice: 200,
    trailing365dAdr: 200,
    trailing365dOccupancy: 0.7,
    listingSize: { bedroomsNumber: 2, bathroomsNumber: 1, personCapacity: 4 }
  };
  const lowScale = buildRecommendedBaseFromHistoryAndMarket({ ...sharedInputs, qualityMultiplier: 0.95 });
  const midScale = buildRecommendedBaseFromHistoryAndMarket({ ...sharedInputs, qualityMultiplier: 1 });
  const upscale = buildRecommendedBaseFromHistoryAndMarket({ ...sharedInputs, qualityMultiplier: 1.1 });

  const low = lowScale.finalRecommendedBasePrice ?? 0;
  const mid = midScale.finalRecommendedBasePrice ?? 0;
  const high = upscale.finalRecommendedBasePrice ?? 0;
  assert.ok(low < mid, `low_scale (${low}) should be below mid_scale (${mid})`);
  assert.ok(mid < high, `upscale (${high}) should be above mid_scale (${mid})`);
});

test("price-positioned comparator filtering keeps the market benchmark in the subject's price tier", () => {
  const comparables = [
    198, 202, 205, 208, 210, 212, 360
  ].map((rate, index) =>
    createComparable({
      listingId: `comp-${index + 1}`,
      annualMedianRate: rate,
      annualP20Rate: Math.round(rate * 0.82)
    })
  );
  const benchmark = getComparableMarketBenchmark({
    subject: createSubject(),
    comparables,
    provisionalBasePrice: 205
  });

  assert.equal(benchmark.pricePositionedComparatorCount, 6);
  assert.equal(benchmark.comparatorCount, 6);
  assert.equal(benchmark.marketBenchmarkBasePrice, 220.48);
  assert.ok(!benchmark.comparatorCandidates.some((candidate) => candidate.annualMedianRate === 360));
});

test("final recommended base price is produced from trailing-ADR and market benchmark deterministically", () => {
  // Calling the function twice with identical inputs must produce identical
  // outputs (no randomness / no I/O). The result should sit in a sensible
  // band between the trailing-ADR (250) and market (200) inputs.
  const inputs = {
    marketBenchmarkBasePrice: 200,
    fallbackBasePrice: 200,
    trailing365dAdr: 250,
    trailing365dOccupancy: 0.7
  };
  const first = buildRecommendedBaseFromHistoryAndMarket(inputs);
  const second = buildRecommendedBaseFromHistoryAndMarket(inputs);

  assert.equal(first.finalRecommendedBasePrice, second.finalRecommendedBasePrice);
  assert.ok((first.finalRecommendedBasePrice ?? 0) >= 200);
  assert.ok((first.finalRecommendedBasePrice ?? 0) <= 250);
});

test("two listings with identical size and similar trailing ADR get near-identical base prices", () => {
  // Stability requirement: near-identical apartments in the same portfolio
  // should produce near-identical recommendations. Two 2-bed/1-bath/4-guest
  // listings where one has a ~5% noisier trailing-ADR.
  const sharedSize = { bedroomsNumber: 2, bathroomsNumber: 1, personCapacity: 4 };
  const apartmentA = buildRecommendedBaseFromHistoryAndMarket({
    marketBenchmarkBasePrice: null,
    fallbackBasePrice: 195,
    listingSize: sharedSize,
    trailing365dAdr: 200,
    trailing365dOccupancy: 0.7
  });
  const apartmentB = buildRecommendedBaseFromHistoryAndMarket({
    marketBenchmarkBasePrice: null,
    fallbackBasePrice: 205,
    listingSize: sharedSize,
    trailing365dAdr: 210,
    trailing365dOccupancy: 0.7
  });

  const a = apartmentA.finalRecommendedBasePrice ?? 0;
  const b = apartmentB.finalRecommendedBasePrice ?? 0;
  assert.ok(a > 0 && b > 0);
  assert.ok(Math.abs(a - b) <= 12, `expected near-identical apartments to differ by <= £12, got ${Math.abs(a - b).toFixed(2)}`);
});

test("size anchor alone is enough to produce a deterministic recommendation when other signals are missing", () => {
  const result = buildRecommendedBaseFromHistoryAndMarket({
    marketBenchmarkBasePrice: null,
    fallbackBasePrice: null,
    listingSize: { bedroomsNumber: 2, bathroomsNumber: 1, personCapacity: 4 }
  });

  // 80 + 2*40 + 1*20 + (4-2)*10 = 200. With size as the only signal the
  // weighted blend collapses to the size value.
  assert.ok((result.finalRecommendedBasePrice ?? 0) > 0);
  assert.equal(result.finalRecommendedBasePrice, 200);
});

test("low trailing-365d occupancy nudges the recommendation downward", () => {
  const sharedInputs = {
    marketBenchmarkBasePrice: null,
    fallbackBasePrice: null,
    listingSize: { bedroomsNumber: 2, bathroomsNumber: 1, personCapacity: 4 },
    trailing365dAdr: 250
  };
  const lowOcc = buildRecommendedBaseFromHistoryAndMarket({
    ...sharedInputs,
    trailing365dOccupancy: 0.2
  });
  const goodOcc = buildRecommendedBaseFromHistoryAndMarket({
    ...sharedInputs,
    trailing365dOccupancy: 0.7
  });

  assert.ok(
    (lowOcc.finalRecommendedBasePrice ?? 0) < (goodOcc.finalRecommendedBasePrice ?? 0),
    "low occupancy should reduce the recommendation"
  );
});

test("own-history and market-anchor preparation stays entirely on cached in-memory inputs", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as typeof globalThis.fetch;

  try {
    const signal = deriveOwnHistoryBaseSignal({
      observations: [
        createHistoryObservation({ stayDate: "2025-04-05", achievedRate: 210, losNights: 2 }),
        createHistoryObservation({ stayDate: "2025-04-06", achievedRate: 220, losNights: 2 })
      ],
      targetDates: ["2026-04-04", "2026-04-05"],
      samePeriodStartDate: "2025-04-01",
      samePeriodEndDate: "2025-04-30",
      todayDateOnly: "2026-03-01",
      preferredLosNights: 2,
      displayCurrency: "GBP"
    });
    const benchmark = getComparableMarketBenchmark({
      subject: createSubject(),
      comparables: [createComparable()],
      provisionalBasePrice: signal.provisionalRecommendedBasePrice
    });

    assert.equal(signal.ownHistorySampleSize, 2);
    assert.equal(benchmark.comparatorCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps existing behaviour when there is no manual override", () => {
  const anchors = createEffectiveAnchors();

  assert.equal(anchors.pricingAnchorSource, "system");
  assert.equal(anchors.currentBasePrice, 235);
  assert.equal(anchors.currentMinimumPrice, 195);
  assert.equal(anchors.effectiveBasePrice, 235);
  assert.equal(anchors.effectiveMinimumPrice, 195);
});

test("uses raw manual overrides directly when they stay close to the market benchmark", () => {
  const anchors = createEffectiveAnchors({
    rawUserBasePrice: 248,
    rawUserMinimumPrice: 205
  });

  assert.equal(anchors.pricingAnchorSource, "user");
  assert.equal(anchors.effectiveBasePrice, 248);
  assert.equal(anchors.effectiveMinimumPrice, 205);
});

test("blends a materially low manual base toward market at high confidence", () => {
  const anchors = createEffectiveAnchors({
    rawUserBasePrice: 200
  });

  assert.equal(anchors.pricingAnchorSource, "blended-market");
  assert.equal(anchors.effectiveBasePrice, 208.75);
  assert.match(anchors.basePriceExplanation, /effective market-adjusted base/i);
});

test("blends a materially high manual base toward market at high confidence", () => {
  const anchors = createEffectiveAnchors({
    rawUserBasePrice: 360
  });

  assert.equal(anchors.effectiveBasePrice, 285);
});

test("blends a materially low manual minimum toward market at high confidence", () => {
  const anchors = createEffectiveAnchors({
    rawUserMinimumPrice: 120
  });

  assert.equal(anchors.effectiveMinimumPrice, 150);
});

test("blends a materially high manual minimum toward market at high confidence", () => {
  const anchors = createEffectiveAnchors({
    rawUserMinimumPrice: 260
  });

  assert.equal(anchors.effectiveMinimumPrice, 234);
});

test("falls back to the raw user value when comparator confidence is low", () => {
  const anchors = createEffectiveAnchors({
    rawUserBasePrice: 160,
    comparatorCount: 4,
    comparatorConfidence: "low"
  });

  assert.equal(anchors.pricingAnchorSource, "user");
  assert.equal(anchors.effectiveBasePrice, 160);
});

test("handles missing size, capacity, and quality fields with neutral structural adjustments", () => {
  const benchmark = getComparableMarketBenchmark({
    subject: createSubject({
      personCapacity: null,
      propertySize: null,
      qualityTier: null
    }),
    comparables: [
      createComparable({
        personCapacity: null,
        propertySize: null,
        qualityTier: null,
        annualMedianRate: 210,
        annualP20Rate: 175
      })
    ]
  });

  assert.equal(benchmark.comparatorCount, 1);
  assert.equal(benchmark.marketBenchmarkBasePrice, 210);
  assert.equal(benchmark.marketBenchmarkMinimumPrice, 175);
});

test("removes obvious outlier nightly rates before deriving comparable annual anchors", () => {
  const anchors = deriveComparableAnnualAnchors({
    rates: [100, 105, 110, 115, 120, 1000].map((rate) => ({
      rate,
      available: true
    }))
  });

  assert.equal(anchors.usableRateCount, 5);
  assert.equal(anchors.annualMedianRate, 110);
  assert.equal(anchors.annualP20Rate, 104);
});

test("keeps the minimum benchmark below the base benchmark", () => {
  const benchmark = getComparableMarketBenchmark({
    subject: createSubject({
      personCapacity: 4,
      propertySize: 68
    }),
    comparables: [
      createComparable({
        personCapacity: 4,
        propertySize: 68,
        annualMedianRate: 200,
        annualP20Rate: 250
      })
    ]
  });

  assert.equal(benchmark.marketBenchmarkBasePrice, 200);
  assert.equal(benchmark.marketBenchmarkMinimumPrice, 190);
});

test("builds deterministic explanation payloads from cached comparator context", () => {
  const anchors = createEffectiveAnchors({
    rawUserBasePrice: 200,
    rawUserMinimumPrice: 170
  });

  assert.equal(anchors.baseDisplay.recommendedLabel, "Recommended base price");
  assert.equal(anchors.minimumDisplay.currentValueLabel, "Current minimum price");
  assert.match(anchors.marketContextSummary, /Based on 18 comparable 2-bedroom homes in Shoreditch/i);
  assert.match(anchors.marketContextSummary, /typical nightly base/i);
});
