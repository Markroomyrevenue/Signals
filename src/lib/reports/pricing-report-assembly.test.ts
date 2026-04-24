import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PRICING_SETTINGS,
  type PricingResolvedSettingsContext,
  type PricingResolvedSettingsSources
} from "@/lib/pricing/settings";

import { buildPricingCalendarRows } from "./pricing-report-assembly";

function createSettingsSources(): PricingResolvedSettingsSources {
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

function createSettingsContext(): PricingResolvedSettingsContext {
  return {
    listingId: "listing-1",
    resolvedGroupName: null,
    resolvedGroupKey: null,
    settings: {
      ...structuredClone(DEFAULT_PRICING_SETTINGS),
      minimumPriceOverride: 120
    },
    sources: {
      ...createSettingsSources(),
      minimumPriceOverride: "property"
    }
  };
}

test("final recommendation still clamps against the effective minimum price", () => {
  const rows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-1",
        name: "Clamp Test Listing",
        timezone: "Europe/London",
        tags: [],
        country: "United Kingdom",
        state: "England",
        city: "London",
        address: "Shoreditch",
        publicAddress: "Shoreditch",
        latitude: null,
        longitude: null,
        roomType: "entire_home",
        bedroomsNumber: 1,
        bathroomsNumber: 1,
        bedsNumber: 1,
        personCapacity: 2,
        guestsIncluded: 2,
        minNights: 2,
        cleaningFee: null,
        averageReviewRating: null
      }
    ],
    pricingSettingsByListingId: new Map([["listing-1", createSettingsContext()]]),
    pricingHistoryByListingId: new Map([
      [
        "listing-1",
        {
          listingId: "listing-1",
          tags: [],
          areaKey: "shoreditch",
          areaLabel: "Shoreditch",
          bedroomCount: 1,
          monthAdr: 100,
          monthNights: 12,
          weekdayAdrByWeekday: new Map(),
          weekdayNightsByWeekday: new Map(),
          historicalAnchorObservations: [],
          currentMonthShortStayOccupancy: null,
          referenceMonthShortStayOccupancy: null
        }
      ]
    ]),
    marketContexts: new Map(),
    calendarCellsByListingDate: new Map([
      [
        "listing-1",
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

  assert.equal(rows[0]?.basePriceSuggestion.value, 100);
  assert.equal(rows[0]?.minimumPriceSuggestion.value, 70);
  assert.equal(rows[0]?.pricingAnchors.currentMinimumPrice, 120);
  assert.equal(rows[0]?.pricingAnchors.effectiveMinimumPrice, 120);
  assert.equal(rows[0]?.cells[0]?.recommendedBaseRate, 100);
  assert.equal(rows[0]?.cells[0]?.recommendedRate, 120);
});
