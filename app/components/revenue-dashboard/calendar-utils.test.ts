import assert from "node:assert/strict";
import test from "node:test";

import { buildEffectivePricingAnchors } from "@/lib/pricing/market-anchor";
import type { PricingCalendarResponse } from "@/lib/reports/pricing-calendar-types";

import {
  buildCachedCalendarReportReloadOptions,
  buildCalendarAnchorFieldState,
  buildCalendarPropertyDraft
} from "./calendar-utils";

function createRow(pricingAnchors: PricingCalendarResponse["rows"][number]["pricingAnchors"]): PricingCalendarResponse["rows"][number] {
  return {
    listingId: "listing-1",
    listingName: "Shoreditch Loft",
    unitCount: null,
    multiUnitGroupKey: null,
    pricingMode: "standard",
    marketLabel: "Shoreditch",
    marketScopeLabel: "United Kingdom / England / London / Shoreditch",
    comparableCount: 6,
    comparisonLosNights: 3,
    marketDataStatus: "cached_market_data",
    marketDataMessage: "Using the stored market snapshot with comparable pricing context for this listing.",
    basePriceSuggestion: {
      value: pricingAnchors.recommendedBasePrice,
      source: "market_comparable_daily",
      breakdown: []
    },
    minimumPriceSuggestion: {
      value: pricingAnchors.recommendedMinimumPrice,
      source: "market_comparable_daily",
      breakdown: []
    },
    pricingAnchors,
    settings: {
      resolvedGroupName: null,
      qualityTier: "mid_scale",
      occupancyScope: "portfolio",
      seasonalitySensitivityMode: "recommended",
      dayOfWeekSensitivityMode: "recommended",
      demandSensitivityMode: "recommended",
      paceEnabled: true,
      hostawayPushEnabled: false,
      sources: {
        basePriceOverride: pricingAnchors.rawUserBasePrice !== null ? "property" : "default",
        minimumPriceOverride: pricingAnchors.rawUserMinimumPrice !== null ? "property" : "default",
        qualityTier: "default",
        minimumPriceFactor: "default",
        seasonalitySensitivityMode: "default",
        dayOfWeekSensitivityMode: "default",
        demandSensitivityMode: "default",
        occupancyScope: "default",
        paceEnabled: "default",
        roundingIncrement: "default"
      }
    },
    cells: []
  };
}

function createPricingAnchors(overrides: Partial<Parameters<typeof buildEffectivePricingAnchors>[0]> = {}) {
  return buildEffectivePricingAnchors({
    subject: {
      listingId: "listing-1",
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
      qualityTier: "mid_scale"
    },
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

test("builds distinct UI state for recommended, current, manual, and effective anchors", () => {
  const row = createRow(
    createPricingAnchors({
      rawUserBasePrice: 200,
      rawUserMinimumPrice: 170
    })
  );

  const baseState = buildCalendarAnchorFieldState(row, "base", "GBP");
  const minimumState = buildCalendarAnchorFieldState(row, "minimum", "GBP");

  assert.equal(baseState.recommendedLabel, "Recommended base price");
  assert.equal(baseState.currentValueLabel, "Current base price");
  assert.equal(baseState.manualOverrideLabel, "Your manual base price");
  assert.equal(baseState.effectiveAnchorLabel, "Effective market-adjusted base");
  assert.equal(baseState.sourceLabel, "Blended with market");
  assert.equal(baseState.currentValue, "£200");
  assert.equal(baseState.manualValue, "£200");
  assert.equal(baseState.effectiveValue, "£209");
  assert.equal(minimumState.currentValue, "£170");
  assert.equal(minimumState.effectiveValue, "£176");
});

test("preloads editable fields with the current saved base and minimum prices", () => {
  const row = createRow(
    createPricingAnchors({
      rawUserBasePrice: 220,
      rawUserMinimumPrice: 180
    })
  );

  const draft = buildCalendarPropertyDraft(row);

  assert.equal(draft.basePriceOverride, "220");
  assert.equal(draft.minimumPriceOverride, "180");
});

test("preloads current recommended values when no property override exists", () => {
  const row = createRow(createPricingAnchors());

  const draft = buildCalendarPropertyDraft(row);

  assert.equal(draft.basePriceOverride, "235");
  assert.equal(draft.minimumPriceOverride, "195");
});

test("cached calendar reload options never request a live market refresh", () => {
  const reloadOptions = buildCachedCalendarReportReloadOptions();

  assert.deepEqual(reloadOptions, {
    ignoreClientCache: true,
    suppressLoadingState: true
  });
  assert.equal(Object.prototype.hasOwnProperty.call(reloadOptions, "forceMarketRefresh"), false);
});
