import assert from "node:assert/strict";

import { DEFAULT_PRICING_SETTINGS, type PricingResolvedSettingsContext, type PricingResolvedSettingsSources } from "../src/lib/pricing/settings";
import {
  buildPricingCalendarRows,
  buildPropertyDeepDiveRows
} from "../src/lib/reports/pricing-report-assembly";
import {
  deriveCityFromListing,
  inferBedroomCount,
  listingAreaProfile,
  resolvePricingCalendarMarketData
} from "../src/lib/reports/pricing-domain";
import type { PricingCalendarResponse } from "../src/lib/reports/pricing-calendar-types";
import {
  buildCalendarDayOfWeekAdjustments,
  buildCalendarMonthAdjustments,
  buildCalendarPropertyDraft,
  calendarCellSelectionKey,
  isCalendarPropertyDraftDirty,
  normalizeCalendarSettingsForm,
  pricingCalendarCoverageMessage
} from "../app/components/revenue-dashboard/calendar-utils";

function buildDefaultSources(): PricingResolvedSettingsSources {
  return {
    basePriceOverride: "default",
    minimumPriceOverride: "default",
    qualityTier: "default",
    qualityMultipliers: "default",
    minimumPriceFactor: "default",
    minimumPriceGap: "default",
    seasonalitySensitivityMode: "default",
    seasonalitySensitivityFactors: "default",
    seasonalityManualAdjustment: "default",
    seasonalityMonthlyAdjustments: "default",
    seasonalityBounds: "default",
    dayOfWeekSensitivityMode: "default",
    dayOfWeekSensitivityFactors: "default",
    dayOfWeekManualAdjustment: "default",
    dayOfWeekAdjustments: "default",
    dayOfWeekBounds: "default",
    demandSensitivityMode: "default",
    demandSensitivityLevel: "default",
    demandSensitivityFactors: "default",
    demandManualAdjustment: "default",
    demandMultipliers: "default",
    occupancyScope: "default",
    occupancyPressureMode: "default",
    paceEnabled: "default",
    paceMultipliers: "default",
    maximumPriceMultiplier: "default",
    localEvents: "default",
    lastMinuteAdjustments: "default",
    gapNightAdjustments: "default",
    lastYearBenchmarkFloorPct: "default",
    minimumNightStay: "default",
    roundingIncrement: "default"
  };
}

function buildDefaultSettingsContext(listingId: string): PricingResolvedSettingsContext {
  return {
    listingId,
    resolvedGroupName: null,
    resolvedGroupKey: null,
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      seasonalityMonthlyAdjustments: DEFAULT_PRICING_SETTINGS.seasonalityMonthlyAdjustments.map((entry) => ({ ...entry })),
      dayOfWeekAdjustments: DEFAULT_PRICING_SETTINGS.dayOfWeekAdjustments.map((entry) => ({ ...entry })),
      localEvents: [],
      lastMinuteAdjustments: [],
      gapNightAdjustments: []
    },
    sources: buildDefaultSources()
  };
}

function run(): void {
  assert.equal(
    deriveCityFromListing({
      name: "The Nook",
      city: null,
      address: null,
      publicAddress: null,
      tags: ["market: bath"],
      timezone: "Europe/London",
      bedroomsNumber: null
    }),
    "Bath"
  );

  assert.equal(
    deriveCityFromListing({
      name: "Dockside Apartment",
      city: null,
      address: "12 Example Street, Glasgow, Scotland, G2 1AA",
      publicAddress: null,
      tags: [],
      timezone: "Europe/London",
      bedroomsNumber: null
    }),
    "Glasgow"
  );

  assert.equal(
    deriveCityFromListing({
      name: "Fallback Listing",
      city: null,
      address: null,
      publicAddress: null,
      tags: [],
      timezone: "Europe/Edinburgh",
      bedroomsNumber: null
    }),
    "Edinburgh"
  );

  assert.equal(
    inferBedroomCount({
      name: "Two bedroom townhouse",
      city: null,
      address: null,
      publicAddress: null,
      tags: [],
      timezone: "Europe/London",
      bedroomsNumber: null
    }),
    2
  );

  assert.equal(
    inferBedroomCount({
      name: "Studio loft",
      city: null,
      address: null,
      publicAddress: null,
      tags: ["three bedrooms", "beds: 1"],
      timezone: "Europe/London",
      bedroomsNumber: null
    }),
    3
  );

  assert.deepEqual(
    listingAreaProfile({
      name: "Area profile test",
      city: "St Andrews",
      address: null,
      publicAddress: null,
      tags: [],
      timezone: "Europe/London",
      bedroomsNumber: 1
    }),
    { areaKey: "st_andrews", areaLabel: "St Andrews" }
  );

  assert.deepEqual(
    resolvePricingCalendarMarketData({
      hasMarketContext: false,
      hasResolvableLocation: true,
      basePriceValue: null
    }),
    {
      status: "needs_setup",
      message: "No stored market snapshot or historical fallback is available for this listing yet. Add a manual base price to guide recommendations while the cache catches up."
    }
  );

  const normalizedSettings = normalizeCalendarSettingsForm({
    qualityTier: "wrong",
    occupancyPressureMode: "wild",
    demandSensitivityMode: "more_sensitive",
    demandSensitivityLevel: null,
    basePriceOverride: "",
    minimumPriceOverride: null,
    seasonalityMonthlyAdjustments: [{ month: 2, adjustmentPct: 14 }],
    dayOfWeekAdjustments: [{ weekday: 5, adjustmentPct: 9 }]
  });

  assert.equal(normalizedSettings.qualityTier, "mid_scale");
  assert.equal(normalizedSettings.occupancyPressureMode, "recommended");
  assert.equal(normalizedSettings.demandSensitivityLevel, 4);
  assert.equal(normalizedSettings.basePriceOverride, undefined);
  assert.equal(normalizedSettings.minimumPriceOverride, undefined);
  assert.equal(normalizedSettings.seasonalityMonthlyAdjustments.length, 12);
  assert.equal(
    normalizedSettings.seasonalityMonthlyAdjustments.find((entry: { month: number }) => entry.month === 2)?.adjustmentPct,
    14
  );
  assert.equal(normalizedSettings.dayOfWeekAdjustments.length, 7);
  assert.equal(
    normalizedSettings.dayOfWeekAdjustments.find((entry: { weekday: number }) => entry.weekday === 5)?.adjustmentPct,
    9
  );

  assert.equal(buildCalendarMonthAdjustments([{ month: 99, adjustmentPct: 22 }]).every((entry) => entry.adjustmentPct === 0), true);
  assert.equal(
    buildCalendarDayOfWeekAdjustments([{ weekday: 1, adjustmentPct: 5 }]).find((entry) => entry.weekday === 1)?.adjustmentPct,
    5
  );

  const row = {
    listingId: "listing-1",
    settings: {
      qualityTier: "mid_scale",
      sources: {
        ...buildDefaultSources(),
        basePriceOverride: "property",
        minimumPriceOverride: "property"
      }
    },
    basePriceSuggestion: {
      value: 150
    },
    minimumPriceSuggestion: {
      value: 99
    },
    pricingAnchors: {
      currentBasePrice: 150,
      currentMinimumPrice: 99
    }
  } as unknown as PricingCalendarResponse["rows"][number];

  const draft = buildCalendarPropertyDraft(row);
  assert.deepEqual(draft, {
    qualityTier: "mid_scale",
    basePriceOverride: "150",
    minimumPriceOverride: "99"
  });
  assert.equal(isCalendarPropertyDraftDirty(row, draft), false);
  assert.equal(
    isCalendarPropertyDraftDirty(row, {
      ...draft,
      minimumPriceOverride: "109"
    }),
    true
  );

  assert.equal(calendarCellSelectionKey("listing-1", "2026-04-11"), "listing-1::2026-04-11");

  const fallbackCoverage = pricingCalendarCoverageMessage({
    month: {
      start: "2026-04-01",
      end: "2026-04-30",
      label: "April 2026"
    },
    rows: [],
    days: [],
    meta: {
      displayCurrency: "GBP",
      comparisonScope: {
        totalListings: 3,
        appliedListings: 3,
        activeBeforeDate: null
      },
      marketData: {
        mode: "stored",
        totalRows: 3,
        rowsWithCachedMarketData: 1,
        rowsUsingFallbackPricing: 2,
        rowsNeedingSetup: 0
      }
    }
  } as PricingCalendarResponse);
  assert.deepEqual(fallbackCoverage, {
    tone: "warning",
    message: "2 listings are using backup pricing because local market context is not ready yet."
  });

  const deepDiveRows = buildPropertyDeepDiveRows({
    scopedListingIds: ["listing-1"],
    listingMetadata: [
      {
        id: "listing-1",
        name: "Pier View Apartment",
        timezone: "Europe/London",
        tags: ["group: coastal"],
        country: null,
        state: null,
        city: "Bath",
        address: null,
        publicAddress: null,
        latitude: null,
        longitude: null,
        roomType: null,
        bedroomsNumber: 1,
        bathroomsNumber: null,
        bedsNumber: null,
        personCapacity: null,
        guestsIncluded: null,
        minNights: 2,
        cleaningFee: null,
        averageReviewRating: null,
        unitCount: null
      }
    ],
    listingNameById: new Map([["listing-1", "Pier View Apartment"]]),
    currentTotals: new Map(),
    referenceTotals: new Map(),
    paceStatusReferenceTotals: new Map(),
    lyStayedTotals: new Map(),
    liveRateByListing: new Map(),
    liveRateByListingDate: new Map(),
    currentByListingDaily: new Map(),
    currentShortStayTotals: new Map([
      [
        "listing-1",
        {
          nights: 1,
          revenueIncl: 100,
          fees: 0,
          inventoryNights: 10
        }
      ]
    ]),
    lyStayedShortStayTotals: new Map([
      [
        "listing-1",
        {
          nights: 8,
          revenueIncl: 800,
          fees: 0,
          inventoryNights: 10
        }
      ]
    ]),
    includeFees: false,
    periodMode: "future",
    periodStart: new Date("2026-06-20T00:00:00.000Z"),
    periodEnd: new Date("2026-06-30T00:00:00.000Z"),
    today: new Date("2026-06-10T00:00:00.000Z"),
    daysUntilPeriodStart: 10
  });

  assert.equal(deepDiveRows.length, 1);
  assert.equal(deepDiveRows[0]?.pricing.anchorSource, "listing_history");
  assert.equal(deepDiveRows[0]?.pricing.anchorRate, 100);
  assert.equal(deepDiveRows[0]?.pricing.adjustmentPct, -15);
  assert.equal(deepDiveRows[0]?.pricing.recommendedRate, 85);

  const calendarRows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-setup",
        name: "Needs Setup Listing",
        timezone: "",
        tags: [],
        country: null,
        state: null,
        city: null,
        address: null,
        publicAddress: null,
        latitude: null,
        longitude: null,
        roomType: null,
        bedroomsNumber: null,
        bathroomsNumber: null,
        bedsNumber: null,
        personCapacity: null,
        guestsIncluded: null,
        minNights: null,
        cleaningFee: null,
        averageReviewRating: null,
        unitCount: null
      }
    ],
    pricingSettingsByListingId: new Map([["listing-setup", buildDefaultSettingsContext("listing-setup")]]),
    pricingHistoryByListingId: new Map(),
    marketContexts: new Map(),
    calendarCellsByListingDate: new Map(),
    bookedNightRatesByListingDate: new Map(),
    monthDays: [new Date("2026-04-11T00:00:00.000Z")],
    occupancyMaps: {
      portfolioOccupancyByDate: new Map(),
      groupOccupancyByGroupDate: new Map(),
      propertyOccupancyByListingDate: new Map()
    },
    todayDateOnlyValue: "2026-04-01",
    lastYearMonthStartDateOnly: "2025-04-01",
    lastYearMonthEndDateOnly: "2025-04-30",
    displayCurrency: "GBP"
  });

  assert.equal(calendarRows.length, 1);
  assert.equal(calendarRows[0]?.marketDataStatus, "needs_setup");
  assert.equal(calendarRows[0]?.basePriceSuggestion.value, null);
  assert.equal(calendarRows[0]?.settings.occupancyScope, "portfolio");
  assert.equal(calendarRows[0]?.cells[0]?.state, "unavailable");
  assert.equal(calendarRows[0]?.cells[0]?.effectiveOccupancyScope, "portfolio");
  assert.equal(calendarRows[0]?.cells[0]?.recommendedRate, null);

  const manualBaseSettingsContext = buildDefaultSettingsContext("listing-manual");
  manualBaseSettingsContext.settings.basePriceOverride = 220;
  manualBaseSettingsContext.sources.basePriceOverride = "property";

  const manualBaseRows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-manual",
        name: "Manual Base Listing",
        timezone: "",
        tags: [],
        country: null,
        state: null,
        city: null,
        address: null,
        publicAddress: null,
        latitude: null,
        longitude: null,
        roomType: null,
        bedroomsNumber: null,
        bathroomsNumber: null,
        bedsNumber: null,
        personCapacity: null,
        guestsIncluded: null,
        minNights: null,
        cleaningFee: null,
        averageReviewRating: null,
        unitCount: null
      }
    ],
    pricingSettingsByListingId: new Map([["listing-manual", manualBaseSettingsContext]]),
    pricingHistoryByListingId: new Map(),
    marketContexts: new Map(),
    calendarCellsByListingDate: new Map([
      [
        "listing-manual",
        new Map([
          [
            "2026-04-11",
            {
              liveRate: null,
              available: true,
              minStay: 2,
              maxStay: null
            }
          ]
        ])
      ]
    ]),
    bookedNightRatesByListingDate: new Map(),
    monthDays: [new Date("2026-04-11T00:00:00.000Z")],
    occupancyMaps: {
      portfolioOccupancyByDate: new Map(),
      groupOccupancyByGroupDate: new Map(),
      propertyOccupancyByListingDate: new Map()
    },
    todayDateOnlyValue: "2026-04-01",
    lastYearMonthStartDateOnly: "2025-04-01",
    lastYearMonthEndDateOnly: "2025-04-30",
    displayCurrency: "GBP"
  });

  assert.equal(manualBaseRows[0]?.marketDataStatus, "fallback_pricing");
  assert.equal(manualBaseRows[0]?.basePriceSuggestion.value, null);
  assert.equal(manualBaseRows[0]?.pricingAnchors.currentBasePrice, 220);
  assert.equal(manualBaseRows[0]?.minimumPriceSuggestion.value, null);
  assert.equal(manualBaseRows[0]?.cells[0]?.recommendedRate, 220);

  const groupedSettingsContext = buildDefaultSettingsContext("listing-grouped");
  groupedSettingsContext.resolvedGroupName = "Coastal";
  groupedSettingsContext.resolvedGroupKey = "group:coastal";

  const occupancyScopedRows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-grouped",
        name: "Grouped Listing",
        timezone: "",
        tags: ["group:coastal"],
        country: null,
        state: null,
        city: "Ayr",
        address: null,
        publicAddress: null,
        latitude: null,
        longitude: null,
        roomType: null,
        bedroomsNumber: 1,
        bathroomsNumber: null,
        bedsNumber: null,
        personCapacity: null,
        guestsIncluded: null,
        minNights: null,
        cleaningFee: null,
        averageReviewRating: null,
        unitCount: null
      }
    ],
    pricingSettingsByListingId: new Map([["listing-grouped", groupedSettingsContext]]),
    pricingHistoryByListingId: new Map(),
    marketContexts: new Map([
      [
        "listing-grouped",
        {
          listingId: "listing-grouped",
          marketLabel: "Ayr",
          marketScopeLabel: "Ayr",
          comparableCount: 6,
          comparisonLosNights: 2,
          yearlyMedianRate: 160,
          baseSuggested: {
            value: 150,
            source: "manual_override",
            breakdown: []
          },
          minimumSuggested: {
            value: 100,
            source: "manual_override",
            breakdown: []
          },
          anchorBenchmarkComparables: [],
          days: new Map([
            [
              "2026-04-11",
              {
                date: "2026-04-11",
                comparableMedianRate: 170,
                marketOccupancy: 72,
                marketAverageDailyRate: 168,
                marketFuturePacing: null,
                yearlyMedianRate: 165,
                monthMedianRate: 168,
                dayOfWeekMedianRate: 170,
                seasonalityPct: 0,
                seasonalityMultiplier: 1,
                dayOfWeekPct: 0,
                dayOfWeekMultiplier: 1,
                marketDemandTier: "normal",
                marketDemandIndex: 0,
                demandMultiplier: 1,
                paceMultiplier: 1,
                comparisonRates: [165, 170, 175],
                comparableRateCount: 3,
                demandBand: 3,
                breakdown: []
              }
            ]
          ])
        }
      ]
    ]),
    calendarCellsByListingDate: new Map([
      [
        "listing-grouped",
        new Map([
          [
            "2026-04-11",
            {
              liveRate: 149,
              available: true,
              minStay: 2,
              maxStay: null
            }
          ]
        ])
      ]
    ]),
    bookedNightRatesByListingDate: new Map(),
    monthDays: [new Date("2026-04-11T00:00:00.000Z")],
    occupancyMaps: {
      portfolioOccupancyByDate: new Map([["2026-04-11", { soldUnits: 1, sellableUnits: 10 }]]),
      groupOccupancyByGroupDate: new Map([["group:coastal", new Map([["2026-04-11", { soldUnits: 7, sellableUnits: 10 }]])]]),
      propertyOccupancyByListingDate: new Map([["listing-grouped", new Map([["2026-04-11", { soldUnits: 0, sellableUnits: 10 }]])]])
    },
    todayDateOnlyValue: "2026-04-01",
    lastYearMonthStartDateOnly: "2025-04-01",
    lastYearMonthEndDateOnly: "2025-04-30",
    displayCurrency: "GBP"
  });

  assert.equal(occupancyScopedRows[0]?.settings.occupancyScope, "group");
  assert.equal(occupancyScopedRows[0]?.cells[0]?.effectiveOccupancyScope, "group");
  assert.equal(occupancyScopedRows[0]?.cells[0]?.dailyOccupancyPct, 70);
  assert.equal(occupancyScopedRows[0]?.cells[0]?.occupancyMultiplier, 1.02);
}

run();
console.log("Hardening helper checks passed.");
