import assert from "node:assert/strict";
import test from "node:test";

import {
  blendDayOfWeek,
  blendSeasonality,
  computeDemandMultiplier,
  computeLeadTimeFloor,
  computeTrialDailyRate,
  lookupTrialOccupancyMultiplier,
  type TrialDailyInput,
  type TrialMarketSnapshot
} from "./trial-pricing";

// ---------------------------------------------------------------------------
// computeDemandMultiplier (5 tests — 1, 2, 3, 4, 5)
// ---------------------------------------------------------------------------

test("computeDemandMultiplier — both baselines, dominant signal wins, pass-through applies", () => {
  // LY occΔ = 0.05, adrΔ = 0.04 → demandΔ = 0.05 + 0.5*0.04 = 0.07
  // trail12mo occΔ = 0.10, adrΔ = 0.20 → demandΔ = 0.10 + 0.5*0.20 = 0.20  (dominant)
  // raw = 1 + 0.7 * 0.20 = 1.14 (inside the new [0.92, 1.40] clamp)
  const result = computeDemandMultiplier({
    marketForwardOccForDate: 0.50,
    marketForwardOccLY: 0.45,
    marketForwardADRForDate: 208,
    marketForwardADRLY: 200,
    marketTrailingMedianOcc: 0.40,
    marketTrailingMedianAdr: 173.333
  });
  // Allow tiny floating-point drift around the expected ~1.14.
  assert.ok(result.multiplier > 1.13 && result.multiplier < 1.15, `expected ~1.14, got ${result.multiplier}`);
  assert.match(result.reasoning, /dominant=trail12mo/);
  assert.match(result.reasoning, /clamp=/);
});

test("computeDemandMultiplier — ceiling engaged when raw exceeds 1.40", () => {
  // Massive YoY lift → raw > 1.40 → clamped to ceiling.
  // LY occΔ = 0.40, adrΔ = 1.00 → demandΔ = 0.40 + 0.50 = 0.90
  // raw = 1 + 0.7 * 0.90 = 1.63 → clamped to 1.40.
  const result = computeDemandMultiplier({
    marketForwardOccForDate: 0.80,
    marketForwardOccLY: 0.40,
    marketForwardADRForDate: 400,
    marketForwardADRLY: 200,
    marketTrailingMedianOcc: null,
    marketTrailingMedianAdr: null
  });
  assert.equal(result.multiplier, 1.4);
  assert.match(result.reasoning, /CEILING hit|clamp=1\.400/);
});

test("computeDemandMultiplier — floor engaged when raw drops below 0.92", () => {
  // Strong negative signal → raw < 0.92 → clamped to floor.
  // LY occΔ = -0.30, adrΔ = -0.40 → demandΔ = -0.30 + 0.5*-0.40 = -0.50
  // raw = 1 + 0.7 * -0.50 = 0.65 → clamped to 0.92.
  const result = computeDemandMultiplier({
    marketForwardOccForDate: 0.20,
    marketForwardOccLY: 0.50,
    marketForwardADRForDate: 120,
    marketForwardADRLY: 200,
    marketTrailingMedianOcc: null,
    marketTrailingMedianAdr: null
  });
  assert.equal(result.multiplier, 0.92);
  assert.match(result.reasoning, /FLOOR hit|clamp=0\.920/);
});

test("computeDemandMultiplier — null forward inputs return neutral 1.0", () => {
  const result = computeDemandMultiplier({
    marketForwardOccForDate: null,
    marketForwardOccLY: 0.45,
    marketForwardADRForDate: null,
    marketForwardADRLY: 200,
    marketTrailingMedianOcc: 0.40,
    marketTrailingMedianAdr: 175
  });
  assert.equal(result.multiplier, 1.0);
  assert.match(result.reasoning, /no KeyData forward pace/);
});

test("computeDemandMultiplier — only LY available, reasoning reflects single-signal mode", () => {
  // Trail12mo nulled out; LY provides the signal.
  // LY occΔ = 0.08, adrΔ = 0.06 → demandΔ = 0.11, raw = 1 + 0.7 * 0.11 = 1.077.
  const result = computeDemandMultiplier({
    marketForwardOccForDate: 0.50,
    marketForwardOccLY: 0.42,
    marketForwardADRForDate: 212,
    marketForwardADRLY: 200,
    marketTrailingMedianOcc: null,
    marketTrailingMedianAdr: null
  });
  assert.ok(result.multiplier > 1.06 && result.multiplier < 1.09, `expected ~1.077, got ${result.multiplier}`);
  assert.match(result.reasoning, /dominant=LY/);
  // Single signal — no "trail12mo:" prefix in reasoning.
  assert.equal(result.reasoning.includes("trail12mo:"), false);
});

// ---------------------------------------------------------------------------
// blendSeasonality (2 tests — 6, 7)
// ---------------------------------------------------------------------------

test("blendSeasonality — own + KD both present blends 0.6/0.4", () => {
  // ownIndex=1.20, marketIndex=1.10, sampleOk → 0.6*1.20 + 0.4*1.10 = 0.72 + 0.44 = 1.16
  const result = blendSeasonality({
    ownSeasonalityIndex: 1.20,
    marketSeasonalityIndex: 1.10,
    ownSampleSizeOk: true,
    manualAdjPct: 0
  });
  assert.ok(Math.abs(result.multiplier - 1.16) < 0.0001, `expected 1.16, got ${result.multiplier}`);
  assert.equal(result.ownWeight, 0.6);
  assert.equal(result.marketWeight, 0.4);
  // Inside [0.75, 1.5] structural bounds.
  assert.ok(result.multiplier >= 0.75 && result.multiplier <= 1.5);
});

test("blendSeasonality — own missing falls back to KD at full weight", () => {
  const result = blendSeasonality({
    ownSeasonalityIndex: null,
    marketSeasonalityIndex: 1.10,
    ownSampleSizeOk: false,
    manualAdjPct: 0
  });
  assert.equal(result.multiplier, 1.10);
  assert.equal(result.ownWeight, 0);
  assert.equal(result.marketWeight, 1);
});

// ---------------------------------------------------------------------------
// blendDayOfWeek (2 tests — 8a, 8b)
// ---------------------------------------------------------------------------

test("blendDayOfWeek — own + KD both present blends 0.5/0.5", () => {
  // ownIndex=1.10, marketIndex=1.05 → 0.5*1.10 + 0.5*1.05 = 1.075
  const result = blendDayOfWeek({
    ownDoWIndex: 1.10,
    marketDoWIndex: 1.05,
    manualAdjPct: 0
  });
  assert.ok(Math.abs(result.multiplier - 1.075) < 0.0001, `expected 1.075, got ${result.multiplier}`);
  assert.equal(result.ownWeight, 0.5);
  assert.equal(result.marketWeight, 0.5);
});

test("blendDayOfWeek — own missing falls back to KD", () => {
  const result = blendDayOfWeek({
    ownDoWIndex: null,
    marketDoWIndex: 1.05,
    manualAdjPct: 0
  });
  assert.equal(result.multiplier, 1.05);
  assert.equal(result.ownWeight, 0);
  assert.equal(result.marketWeight, 1);
});

// ---------------------------------------------------------------------------
// lookupTrialOccupancyMultiplier (4 modes — test 9)
// ---------------------------------------------------------------------------

test("lookupTrialOccupancyMultiplier — each mode picks its own multiplier shape", () => {
  // 55% occupancy → standard ladder hits the 51-60 bucket (mult 1.00).
  // conservative compresses by 0.667 → (1.00 - 1) * 0.667 + 1 = 1.0 (neutral bucket unchanged)
  // aggressive expands by 1.25 → 1.0 unchanged either (neutral bucket).
  // manual → always 1.0.

  // Pick a bucket where the math differs more visibly — 85% → 81-90 band (standard 1.08).
  const standard85 = lookupTrialOccupancyMultiplier(0.85, "standard");
  assert.equal(standard85.multiplier, 1.08);
  assert.equal(standard85.bucketMin, 80);
  assert.equal(standard85.bucketMax, 90);

  const conservative85 = lookupTrialOccupancyMultiplier(0.85, "conservative");
  // 1 + (1.08 - 1) * 0.667 = 1 + 0.05336 = 1.05336
  assert.ok(Math.abs(conservative85.multiplier - 1.05336) < 0.001, `expected ~1.053, got ${conservative85.multiplier}`);

  const aggressive85 = lookupTrialOccupancyMultiplier(0.85, "aggressive");
  // 1 + (1.08 - 1) * 1.25 = 1 + 0.10 = 1.10
  assert.ok(Math.abs(aggressive85.multiplier - 1.10) < 0.0001, `expected 1.10, got ${aggressive85.multiplier}`);

  const manual85 = lookupTrialOccupancyMultiplier(0.85, "manual");
  assert.equal(manual85.multiplier, 1.0);
  assert.equal(manual85.bucketMin, 0);
  assert.equal(manual85.bucketMax, 100);
});

// ---------------------------------------------------------------------------
// computeLeadTimeFloor (2 tests — 10, 11)
// ---------------------------------------------------------------------------

test("computeLeadTimeFloor — all three gating conditions met → engaged at base × 0.80 inside 6 days", () => {
  const result = computeLeadTimeFloor({
    daysToCheckIn: 3,
    base: 200,
    recommendedMinimum: 140, // base × 0.70
    scopeOccupancy: 0.20, // ≤ 0.25 → propertyOccLow = true
    marketForwardOccForDate: 0.25,
    marketOcc25thPct: 0.30, // 0.25 ≤ 0.30 → marketOccLow = true
    marketRpoForDate: 70,
    marketRpoMedian: 80, // 70 ≤ 80 → marketRpoBelowMedian = true
    mode: "standard"
  });
  // floor = max(recommendedMinimum=140, base×0.80=160) = 160
  assert.equal(result.floor, 160);
  assert.equal(result.gate.engaged, true);
  assert.equal(result.gate.propertyOccLow, true);
  assert.equal(result.gate.marketOccLow, true);
  assert.equal(result.gate.marketRpoBelowMedian, true);
});

test("computeLeadTimeFloor — one condition fails → floor reverts to recommendedMinimum", () => {
  const result = computeLeadTimeFloor({
    daysToCheckIn: 3,
    base: 200,
    recommendedMinimum: 140,
    scopeOccupancy: 0.50, // > 0.25 → propertyOccLow = FALSE
    marketForwardOccForDate: 0.25,
    marketOcc25thPct: 0.30,
    marketRpoForDate: 70,
    marketRpoMedian: 80,
    mode: "standard"
  });
  assert.equal(result.floor, 140);
  assert.equal(result.gate.engaged, false);
  assert.equal(result.gate.propertyOccLow, false);
});

// ---------------------------------------------------------------------------
// computeTrialDailyRate — end-to-end fixture (test 12)
// ---------------------------------------------------------------------------

test("computeTrialDailyRate — end-to-end fixture; final rate matches the multiplier-chain product", () => {
  const market: TrialMarketSnapshot = {
    benchmark: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    benchmark1br: { p20: 100, p50: 150, p80: 200, sampleSize: 60 }, // same band so size anchor passes
    seasonality: null, // KD seasonality null in this fixture
    dayOfWeek: null,
    forwardPace: null, // no forward pace → demand multiplier = 1.0
    trailingMarketKpis: null,
    benchmarkSimilarity: 0.8,
    marketOcc25thPct: null,
    marketRpoMedian: null,
    marketRpoForDate: null,
    marketForwardOccForDate: null
  };
  const input: TrialDailyInput = {
    listingId: "test-listing",
    bedrooms: 1,
    qualityTier: "mid_scale",
    date: "2026-07-04",
    daysToCheckIn: 45,
    dayOfWeek: 6, // Saturday
    monthIndex: 6, // July
    trailing365dAdr: 150,
    trailing365dOccupancy: 0.65, // > 0.07 so own sample is OK
    ownSeasonalityIndex: 1.10, // July lift
    ownDoWIndex: 1.05, // Saturday lift
    listingSizeAnchor: 150, // = ownAdr × (p50_this / p50_1br) = 150 × 1 = 150
    manualSeasonalityAdjPct: 0,
    manualDoWAdjPct: 0,
    localEventAdjPct: null,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.55, // 51-60 bucket → multiplier 1.00 in standard
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const result = computeTrialDailyRate(input, market);
  assert.ok(result !== null, "result should not be null");
  const b = result!.breakdown;
  // base = (own 0.55 + market 0.30 + size 0.15) × quality_tier(mid_scale=1.0)
  // = 150*0.55 + 150*0.30 + 150*0.15 = 82.5 + 45 + 22.5 = 150
  // rounded by increment=1 → 150
  assert.equal(b.base, 150);
  // Seasonality: own 1.10, no market → falls back to own (ownWeight=1) → 1.10
  // BUT current code passes marketSeasonalityIndex from trailingMarketKpis (null here) →
  // falls back to seasonality field (also null) → null. With own only and sample OK,
  // ownWeight=1, market=0, mult=1.10, clamped to [0.75, 1.5] → 1.10.
  assert.ok(Math.abs(b.seasonality - 1.10) < 0.0001, `expected seasonality ~1.10, got ${b.seasonality}`);
  // DoW: own=1.05, market=null → falls back to own → 1.05.
  assert.ok(Math.abs(b.dayOfWeek - 1.05) < 0.0001);
  // Demand: no forward-pace data → 1.0.
  assert.equal(b.demand, 1.0);
  // Occupancy: 55% in standard ladder → 51-60 bucket → 1.0.
  assert.equal(b.occupancy, 1.0);
  // Pace: 1.0.
  assert.equal(b.pace, 1.0);
  // Events: 1.0 (no local event).
  assert.equal(b.events, 1.0);
  // Multiplier chain product:
  // base 150 × seasonality 1.10 × DoW 1.05 × demand 1.0 × occupancy 1.0 × pace 1.0 × events 1.0
  // = 150 × 1.155 = 173.25 → rounded by increment 1 → 173
  // Final clamping: min = max(base × 0.7 = 105, userSetMinimum 0) = 105, so 173 is unclamped.
  assert.ok(Math.abs(result!.recommendedRate - 173) < 1.01, `expected ~173, got ${result!.recommendedRate}`);
});
