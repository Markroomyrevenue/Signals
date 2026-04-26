import assert from "node:assert/strict";
import test from "node:test";

import { buildSignalSuggestions, type SignalHistoryContext } from "./signal-suggestions";

const emptyHistory: SignalHistoryContext = {
  lastYearRateCutThatBooked: null,
  recentHeldRateThatBooked: null,
  portfolioOccupancyAtHorizon: null,
  listingOccupancyAtHorizon: null,
  priceComparisonAtHorizon: null
};

test("buildSignalSuggestions cites a same-listing rate-cut precedent for low occupancy", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_14_under_50"],
    severity: "high",
    daysToImpact: 8,
    listingName: "Marina Studio",
    history: {
      ...emptyHistory,
      lastYearRateCutThatBooked: { dropPct: 10.4, bookedAfterCutDays: 6, monthLabel: "26 Apr" }
    }
  });

  assert.ok(suggestions.length >= 1);
  assert.ok(/dropped this listing's rate ~10%/.test(suggestions[0]));
});

test("buildSignalSuggestions never recommends tightening or loosening minimum stay", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_30_under_30"],
    severity: "high",
    daysToImpact: 22,
    listingName: "Garden Loft",
    history: emptyHistory
  });

  const text = suggestions.join(" | ").toLowerCase();
  assert.ok(!text.includes("minimum stay"));
  assert.ok(!text.includes("min stay"));
  assert.ok(!text.includes("tightening"));
  assert.ok(!text.includes("loosening"));
});

test("buildSignalSuggestions falls back when no history is available", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_7_under_60"],
    severity: "high",
    daysToImpact: 3,
    listingName: "Marina Studio",
    history: emptyHistory
  });

  assert.equal(suggestions.length, 1);
  assert.ok(suggestions[0].includes("Review near-term rates"));
});

test("buildSignalSuggestions hints market-wide softness when portfolio is also low", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_14_under_50"],
    severity: "medium",
    daysToImpact: 10,
    listingName: "Marina Studio",
    history: {
      ...emptyHistory,
      portfolioOccupancyAtHorizon: 42,
      listingOccupancyAtHorizon: 41
    }
  });

  const text = suggestions.join(" | ");
  assert.ok(text.includes("market-wide"));
});

test("buildSignalSuggestions caps at three suggestions even when many patterns match", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_14_under_50", "pace_month_revenue_20"],
    severity: "high",
    daysToImpact: 5,
    listingName: "Marina Studio",
    history: {
      lastYearRateCutThatBooked: { dropPct: 12, bookedAfterCutDays: 4, monthLabel: "5 May" },
      recentHeldRateThatBooked: { peerListingName: "Harbour Loft" },
      portfolioOccupancyAtHorizon: 40,
      listingOccupancyAtHorizon: 30,
      priceComparisonAtHorizon: { dateLabel: "Sat 9 May", currentRate: 200, recommendedRate: 170, currency: "GBP" }
    }
  });

  assert.ok(suggestions.length <= 3);
});

test("buildSignalSuggestions: recommended below current by >5% suggests dropping rate", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_14_under_50"],
    severity: "medium",
    daysToImpact: 7,
    listingName: "Marina Studio",
    history: {
      ...emptyHistory,
      priceComparisonAtHorizon: { dateLabel: "Sat 9 May", currentRate: 200, recommendedRate: 170, currency: "GBP" }
    }
  });

  const text = suggestions.join(" | ");
  assert.ok(text.includes("Recommended rate for Sat 9 May"));
  assert.ok(text.includes("Dropping to recommended may book the gap"));
});

test("buildSignalSuggestions: recommended above current by >5% suggests revenue left on table", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["pace_month_revenue_20"],
    severity: "high",
    daysToImpact: 25,
    listingName: "Garden Loft",
    history: {
      ...emptyHistory,
      priceComparisonAtHorizon: { dateLabel: "Fri 22 May", currentRate: 100, recommendedRate: 120, currency: "GBP" }
    }
  });

  const text = suggestions.join(" | ");
  assert.ok(text.includes("Recommended rate for Fri 22 May"));
  assert.ok(text.includes("leaving revenue on the table"));
});

test("buildSignalSuggestions: recommended within ±5% emits no price suggestion", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_14_under_50"],
    severity: "medium",
    daysToImpact: 7,
    listingName: "Marina Studio",
    history: {
      ...emptyHistory,
      priceComparisonAtHorizon: { dateLabel: "Sat 9 May", currentRate: 200, recommendedRate: 205, currency: "GBP" }
    }
  });

  const text = suggestions.join(" | ");
  assert.ok(!text.includes("Recommended rate"));
});

test("buildSignalSuggestions: missing price comparison falls back without erroring", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_14_under_50"],
    severity: "medium",
    daysToImpact: 7,
    listingName: "Marina Studio",
    history: { ...emptyHistory, priceComparisonAtHorizon: null }
  });

  assert.ok(suggestions.length >= 1);
  const text = suggestions.join(" | ");
  assert.ok(!text.includes("Recommended rate"));
});

test("buildSignalSuggestions: zero or negative current rate ignored (defensive)", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_14_under_50"],
    severity: "medium",
    daysToImpact: 7,
    listingName: "Marina Studio",
    history: {
      ...emptyHistory,
      priceComparisonAtHorizon: { dateLabel: "Sat 9 May", currentRate: 0, recommendedRate: 170, currency: "GBP" }
    }
  });

  const text = suggestions.join(" | ");
  assert.ok(!text.includes("Recommended rate"));
});
