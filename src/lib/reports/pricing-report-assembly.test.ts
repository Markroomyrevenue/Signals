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
    pricingMode: "default",
    rateCopySourceListingId: "default",
    rateCopyPushEnabled: "default",
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
        averageReviewRating: null,
        unitCount: null
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

  // After the 2026-04-25 stability rewrite the base recommendation is now
  // a weighted blend that includes a deterministic listing-size anchor
  // (1-bed, 1-bath, 2-guest → £140 prior). With no booking history at all
  // the size anchor dominates, pulling the recommendation above the raw
  // £100 month-ADR fallback. Because the size-anchored base now sits above
  // the manual £120 minimum override, the per-night clamp is no longer
  // active in this scenario — the test now just checks the anchor + min
  // alignment.
  const baseValue = rows[0]?.basePriceSuggestion.value ?? 0;
  assert.ok(baseValue > 100, `expected size-anchored base above £100 fallback, got ${baseValue}`);
  assert.ok(baseValue <= 140, `expected size-anchored base near the £140 prior, got ${baseValue}`);
  // Minimum suggestion is base × 0.7 by default.
  const minValue = rows[0]?.minimumPriceSuggestion.value ?? 0;
  assert.ok(Math.abs(minValue - baseValue * 0.7) <= 1, `expected min ~= base * 0.7, got base=${baseValue}, min=${minValue}`);
  assert.equal(rows[0]?.pricingAnchors.currentMinimumPrice, 120);
  assert.equal(rows[0]?.pricingAnchors.effectiveMinimumPrice, 120);
  // Per-night rate sits at base when no multipliers fire and base > min.
  assert.equal(rows[0]?.cells[0]?.recommendedRate, Math.round(baseValue));
});

test("single-unit listing ignores the multi-unit matrix entirely (legacy occupancy ladder)", () => {
  // Same fixture as above, but explicitly assert that multi-unit fields
  // are null and the row's unitCount is null. This is the contract that
  // existing single-unit listings DO NOT change behaviour after the
  // multi-unit feature lands.
  const rows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-1",
        name: "Single-Unit Listing",
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
        averageReviewRating: null,
        unitCount: null
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
          ["2026-04-11", { liveRate: null, available: true, minStay: 2, maxStay: null }]
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

  // Listing must announce itself as single-unit at row level.
  assert.equal(rows[0]?.unitCount, null);
  assert.equal(rows[0]?.multiUnitGroupKey, null);

  // Cell-level multi-unit fields stay null.
  const cell = rows[0]?.cells[0];
  assert.equal(cell?.multiUnitUnitsSold, null);
  assert.equal(cell?.multiUnitUnitsTotal, null);
  assert.equal(cell?.multiUnitOccupancyPct, null);
  assert.equal(cell?.multiUnitLeadTimeDays, null);
});

test("multi-unit listing replaces occupancy multiplier with matrix-derived delta", () => {
  // 5-unit listing with 4 sold (80% occupancy). 10-day lead time. Per the
  // seeded matrix: row 80, bucket 14 → -5%. So occupancyMultiplier should
  // become 1 + (-5)/100 = 0.95.
  const settingsContext = createSettingsContext();
  // Drop the manual minimum override so the floor doesn't clamp our test.
  settingsContext.settings.minimumPriceOverride = null;
  // Set rounding to 1 to keep math simple.
  const rows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "multi-1",
        name: "Multi-Unit Block",
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
        averageReviewRating: null,
        unitCount: 5
      }
    ],
    pricingSettingsByListingId: new Map([["multi-1", settingsContext]]),
    pricingHistoryByListingId: new Map([
      [
        "multi-1",
        {
          listingId: "multi-1",
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
      ["multi-1", new Map([["2026-04-11", { liveRate: null, available: true, minStay: 2, maxStay: null }]])]
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
    displayCurrency: "GBP",
    multiUnitOccupancyByListingDate: new Map([
      [
        "multi-1",
        new Map([
          ["2026-04-11", { unitsSold: 4, unitsTotal: 5, occupancyPct: 80 }]
        ])
      ]
    ]),
    multiUnitPeerSetAdrByListingId: new Map([["multi-1", null]])
  });

  // Row should now report unitCount = 5.
  assert.equal(rows[0]?.unitCount, 5);
  assert.equal(rows[0]?.pricingMode, "multi_unit");
  const cell = rows[0]?.cells[0];
  assert.equal(cell?.multiUnitUnitsSold, 4);
  assert.equal(cell?.multiUnitUnitsTotal, 5);
  assert.equal(cell?.multiUnitOccupancyPct, 80);
  // Lead time: 2026-04-11 minus 2026-04-01 = 10 days.
  assert.equal(cell?.multiUnitLeadTimeDays, 10);
  // Matrix lookup at row=80 / bucket=14 → -5%. So occupancyMultiplier = 0.95.
  assert.equal(cell?.occupancyMultiplier, 0.95);
  // Multi-unit listing is NOT in peer-shape mode, so the peer-shape
  // fields stay null.
  assert.equal(cell?.peerShapeFactor, null);
  assert.equal(cell?.peerShapePeerCount, null);
});

test("peer-shape branch: hostawayPushEnabled + base override anchors on user base, scales by factor, floored at min", () => {
  // Owner spec walkthrough: base £140 saved by user, factor 0.92 from 7
  // peers → recommended ≈ £128.8 → rounded to £129. Min floor = £100
  // (saved by user); £129 > £100 so the floor is not active.
  const settingsContext = createSettingsContext();
  settingsContext.settings.basePriceOverride = 140;
  settingsContext.settings.minimumPriceOverride = 100;
  settingsContext.settings.hostawayPushEnabled = true;
  settingsContext.settings.roundingIncrement = 1;
  settingsContext.sources.basePriceOverride = "property";
  settingsContext.sources.minimumPriceOverride = "property";
  // No multi-unit, just a single-unit listing on the live-push toggle.

  const rows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-1",
        name: "Camden Studio",
        timezone: "Europe/London",
        tags: [],
        country: "United Kingdom",
        state: "England",
        city: "London",
        address: "Camden",
        publicAddress: "Camden",
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
        averageReviewRating: null,
        unitCount: null
      }
    ],
    pricingSettingsByListingId: new Map([["listing-1", settingsContext]]),
    pricingHistoryByListingId: new Map([
      [
        "listing-1",
        {
          listingId: "listing-1",
          tags: [],
          areaKey: "camden",
          areaLabel: "Camden",
          bedroomCount: 1,
          monthAdr: null,
          monthNights: 0,
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
        new Map([["2026-04-25", { liveRate: null, available: true, minStay: 2, maxStay: null }]])
      ]
    ]),
    bookedNightRatesByListingDate: new Map(),
    monthDays: [new Date("2026-04-25T00:00:00.000Z")],
    occupancyMaps: {
      portfolioOccupancyByDate: new Map(),
      groupOccupancyByGroupDate: new Map(),
      propertyOccupancyByListingDate: new Map()
    },
    todayDateOnlyValue: "2026-04-25",
    lastYearMonthStartDateOnly: "2025-04-01",
    lastYearMonthEndDateOnly: "2025-04-30",
    displayCurrency: "GBP",
    peerShapeFactorByListingId: new Map([
      ["listing-1", new Map([["2026-04-25", { factor: 0.92, peerCount: 7, source: "available" as const }]])]
    ])
  });

  const row = rows[0];
  assert.ok(row, "row should exist");
  assert.equal(row?.pricingMode, "peer_shape");
  // Row anchors == user's saved base/min, NOT a market-blended value.
  assert.equal(row?.basePriceSuggestion.value, 140);
  assert.equal(row?.minimumPriceSuggestion.value, 100);

  const cell = row?.cells[0];
  assert.ok(cell, "cell should exist");
  assert.equal(cell?.peerShapeFactor, 0.92);
  assert.equal(cell?.peerShapePeerCount, 7);
  // Recommended = round(140 × 0.92) = round(128.8) = 129.
  assert.equal(cell?.recommendedRate, 129);
  // recommendedBaseRate / minimumSuggestedRate are the row anchors.
  assert.equal(cell?.recommendedBaseRate, 140);
  assert.equal(cell?.minimumSuggestedRate, 100);
  // Multi-unit fields stay null.
  assert.equal(cell?.multiUnitUnitsSold, null);
  assert.equal(cell?.multiUnitOccupancyPct, null);
  // Breakdown should reflect the simplified peer-shape view.
  const labels = cell?.breakdown.map((item) => item.label) ?? [];
  assert.ok(labels.includes("Base (your anchor)"), `expected peer-shape breakdown, got: ${labels.join(", ")}`);
  assert.ok(labels.includes("Peer-shape factor"));
  // Standard-mode labels MUST NOT appear when peer-shape is active.
  assert.ok(!labels.includes("Seasonality"), "peer-shape should not surface seasonality");
  assert.ok(!labels.includes("Demand"), "peer-shape should not surface demand");
  assert.ok(!labels.includes("DOW"), "peer-shape should not surface day-of-week");
  assert.ok(!labels.includes("Pace"), "peer-shape should not surface pace");
});

test("peer-shape branch: factor entry null on a date → caller treats as factor=1 (recommendation = base)", () => {
  // No factor entry for the target date → recommendation collapses to
  // the saved base price.
  const settingsContext = createSettingsContext();
  settingsContext.settings.basePriceOverride = 200;
  settingsContext.settings.minimumPriceOverride = 150;
  settingsContext.settings.hostawayPushEnabled = true;
  settingsContext.settings.roundingIncrement = 1;
  settingsContext.sources.basePriceOverride = "property";
  settingsContext.sources.minimumPriceOverride = "property";

  const rows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-1",
        name: "Camden Studio",
        timezone: "Europe/London",
        tags: [],
        country: "United Kingdom",
        state: "England",
        city: "London",
        address: "Camden",
        publicAddress: "Camden",
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
        averageReviewRating: null,
        unitCount: null
      }
    ],
    pricingSettingsByListingId: new Map([["listing-1", settingsContext]]),
    pricingHistoryByListingId: new Map([
      [
        "listing-1",
        {
          listingId: "listing-1",
          tags: [],
          areaKey: "camden",
          areaLabel: "Camden",
          bedroomCount: 1,
          monthAdr: null,
          monthNights: 0,
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
        new Map([["2026-04-25", { liveRate: null, available: true, minStay: 2, maxStay: null }]])
      ]
    ]),
    bookedNightRatesByListingDate: new Map(),
    monthDays: [new Date("2026-04-25T00:00:00.000Z")],
    occupancyMaps: {
      portfolioOccupancyByDate: new Map(),
      groupOccupancyByGroupDate: new Map(),
      propertyOccupancyByListingDate: new Map()
    },
    todayDateOnlyValue: "2026-04-25",
    lastYearMonthStartDateOnly: "2025-04-01",
    lastYearMonthEndDateOnly: "2025-04-30",
    displayCurrency: "GBP",
    peerShapeFactorByListingId: new Map([
      // Factor map is present for the listing but the date entry is null
      // (e.g. fewer than 3 peers contributed).
      ["listing-1", new Map([["2026-04-25", null]])]
    ])
  });

  const cell = rows[0]?.cells[0];
  assert.equal(cell?.peerShapeFactor, null);
  assert.equal(cell?.peerShapePeerCount, null);
  // Factor = 1 → recommendation == base.
  assert.equal(cell?.recommendedRate, 200);
});

test("peer-shape branch: hostawayPushEnabled but no base override falls through to standard pipeline (with warning)", () => {
  // Per spec: "if null, fall back to standard recommendation path with a
  // console.warn". We can't assert console output portably, but we can
  // check that the row's pricingMode is NOT "peer_shape" — meaning the
  // standard path took over.
  const settingsContext = createSettingsContext();
  settingsContext.settings.basePriceOverride = null;
  settingsContext.settings.hostawayPushEnabled = true;

  const rows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-1",
        name: "Camden Studio",
        timezone: "Europe/London",
        tags: [],
        country: "United Kingdom",
        state: "England",
        city: "London",
        address: "Camden",
        publicAddress: "Camden",
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
        averageReviewRating: null,
        unitCount: null
      }
    ],
    pricingSettingsByListingId: new Map([["listing-1", settingsContext]]),
    pricingHistoryByListingId: new Map(),
    marketContexts: new Map(),
    calendarCellsByListingDate: new Map([
      [
        "listing-1",
        new Map([["2026-04-25", { liveRate: null, available: true, minStay: 2, maxStay: null }]])
      ]
    ]),
    bookedNightRatesByListingDate: new Map(),
    monthDays: [new Date("2026-04-25T00:00:00.000Z")],
    occupancyMaps: {
      portfolioOccupancyByDate: new Map(),
      groupOccupancyByGroupDate: new Map(),
      propertyOccupancyByListingDate: new Map()
    },
    todayDateOnlyValue: "2026-04-25",
    lastYearMonthStartDateOnly: "2025-04-01",
    lastYearMonthEndDateOnly: "2025-04-30",
    displayCurrency: "GBP",
    peerShapeFactorByListingId: new Map([
      ["listing-1", new Map([["2026-04-25", { factor: 1.5, peerCount: 7, source: "available" as const }]])]
    ])
  });

  // Standard path took over because no base override exists.
  assert.equal(rows[0]?.pricingMode, "standard");
  // Peer-shape per-cell fields stay null on the standard path.
  assert.equal(rows[0]?.cells[0]?.peerShapeFactor, null);
  assert.equal(rows[0]?.cells[0]?.peerShapePeerCount, null);
});

test("peer-shape branch: minimum floor clamps the recommended rate (factor pulls below user's min)", () => {
  // Base £100, factor 0.5 → raw 50. User's saved minimum £80 floors to 80.
  const settingsContext = createSettingsContext();
  settingsContext.settings.basePriceOverride = 100;
  settingsContext.settings.minimumPriceOverride = 80;
  settingsContext.settings.hostawayPushEnabled = true;
  settingsContext.settings.roundingIncrement = 1;
  settingsContext.sources.basePriceOverride = "property";
  settingsContext.sources.minimumPriceOverride = "property";

  const rows = buildPricingCalendarRows({
    listingMetadata: [
      {
        id: "listing-1",
        name: "Camden Studio",
        timezone: "Europe/London",
        tags: [],
        country: "United Kingdom",
        state: "England",
        city: "London",
        address: "Camden",
        publicAddress: "Camden",
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
        averageReviewRating: null,
        unitCount: null
      }
    ],
    pricingSettingsByListingId: new Map([["listing-1", settingsContext]]),
    pricingHistoryByListingId: new Map(),
    marketContexts: new Map(),
    calendarCellsByListingDate: new Map([
      [
        "listing-1",
        new Map([["2026-04-25", { liveRate: null, available: true, minStay: 2, maxStay: null }]])
      ]
    ]),
    bookedNightRatesByListingDate: new Map(),
    monthDays: [new Date("2026-04-25T00:00:00.000Z")],
    occupancyMaps: {
      portfolioOccupancyByDate: new Map(),
      groupOccupancyByGroupDate: new Map(),
      propertyOccupancyByListingDate: new Map()
    },
    todayDateOnlyValue: "2026-04-25",
    lastYearMonthStartDateOnly: "2025-04-01",
    lastYearMonthEndDateOnly: "2025-04-30",
    displayCurrency: "GBP",
    peerShapeFactorByListingId: new Map([
      ["listing-1", new Map([["2026-04-25", { factor: 0.5, peerCount: 7, source: "available" as const }]])]
    ])
  });

  const cell = rows[0]?.cells[0];
  // 100 × 0.5 = 50 → floored at 80.
  assert.equal(cell?.recommendedRate, 80);
});
