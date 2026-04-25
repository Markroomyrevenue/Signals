import assert from "node:assert/strict";
import test from "node:test";

import { buildSignalSuggestions, type SignalHistoryContext } from "./signal-suggestions";

const emptyHistory: SignalHistoryContext = {
  avgLosLast90Days: null,
  typicalMinStay: null,
  lastYearRateCutThatBooked: null,
  recentHeldRateThatBooked: null,
  portfolioOccupancyAtHorizon: null,
  listingOccupancyAtHorizon: null
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

test("buildSignalSuggestions emits LOS-tightening hint when avg LOS exceeds min-stay", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_30_under_30"],
    severity: "high",
    daysToImpact: 22,
    listingName: "Garden Loft",
    history: { ...emptyHistory, avgLosLast90Days: 4.4, typicalMinStay: 2 }
  });

  const text = suggestions.join(" | ");
  assert.ok(text.includes("Tightening the minimum stay"));
});

test("buildSignalSuggestions emits LOS-loosening hint when min-stay exceeds avg LOS", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_7_under_60"],
    severity: "medium",
    daysToImpact: 4,
    listingName: "Garden Loft",
    history: { ...emptyHistory, avgLosLast90Days: 1.8, typicalMinStay: 4 }
  });

  const text = suggestions.join(" | ");
  assert.ok(text.includes("Loosening the minimum stay"));
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

test("buildSignalSuggestions caps at three suggestions even when many patterns match", () => {
  const suggestions = buildSignalSuggestions({
    reasonKeys: ["occ_14_under_50", "pace_month_revenue_20"],
    severity: "high",
    daysToImpact: 5,
    listingName: "Marina Studio",
    history: {
      avgLosLast90Days: 2.1,
      typicalMinStay: 4,
      lastYearRateCutThatBooked: { dropPct: 12, bookedAfterCutDays: 4, monthLabel: "5 May" },
      recentHeldRateThatBooked: { peerListingName: "Harbour Loft" },
      portfolioOccupancyAtHorizon: 40,
      listingOccupancyAtHorizon: 30
    }
  });

  assert.ok(suggestions.length <= 3);
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
