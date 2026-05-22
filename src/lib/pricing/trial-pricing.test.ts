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
// computeDemandMultiplier — RevPAR-adj, trailing-12mo baseline only
// ---------------------------------------------------------------------------

test("computeDemandMultiplier — normal non-event date lands near 1.0", () => {
  // RevPAR-adj fwd 58 vs trailing-12mo median 55 → demandΔ = 58/55 - 1 ≈ 0.0545
  // raw = 1 + 0.7 × 0.0545 = 1.0382 → inside [1.0, 1.40] → no clamp.
  const result = computeDemandMultiplier({
    marketForwardRevparAdjForDate: 58,
    marketTrailingMedianRevparAdj: 55
  });
  assert.ok(result.multiplier > 1.03 && result.multiplier < 1.05, `expected ~1.038, got ${result.multiplier}`);
  assert.equal(result.dominantSignal, "trail12mo");
  assert.equal(result.ceilingHit, false);
  assert.equal(result.floorHit, false);
  assert.match(result.reasoning, /RevPARadj fwd=58\.00 vs trail12mo med=55\.00/);
});

test("computeDemandMultiplier — Fleadh-class hot week is lifted well above 1.0", () => {
  // RevPAR-adj fwd 90 vs trailing-12mo median 50 → demandΔ = 90/50 - 1 = 0.80
  // raw = 1 + 0.7 × 0.80 = 1.56 → clamped to DEMAND_CEIL = 1.40.
  const result = computeDemandMultiplier({
    marketForwardRevparAdjForDate: 90,
    marketTrailingMedianRevparAdj: 50
  });
  assert.equal(result.multiplier, 1.4);
  assert.equal(result.ceilingHit, true);
  assert.match(result.reasoning, /CEILING hit/);
});

test("computeDemandMultiplier — demand floor is 1.0 (soft RevPAR cannot pull below)", () => {
  // RevPAR-adj fwd 30 vs trailing-12mo median 60 → demandΔ = -0.5
  // raw = 1 + 0.7 × -0.5 = 0.65 → clamped UP to DEMAND_FLOOR = 1.0.
  const result = computeDemandMultiplier({
    marketForwardRevparAdjForDate: 30,
    marketTrailingMedianRevparAdj: 60
  });
  assert.equal(result.multiplier, 1.0);
  assert.equal(result.floorHit, true);
  assert.match(result.reasoning, /FLOOR hit/);
});

test("computeDemandMultiplier — missing forward RevPAR-adj returns neutral 1.0", () => {
  const result = computeDemandMultiplier({
    marketForwardRevparAdjForDate: null,
    marketTrailingMedianRevparAdj: 55
  });
  assert.equal(result.multiplier, 1.0);
  assert.equal(result.dominantSignal, "none");
  assert.equal(result.rawDemandDelta, null);
  assert.match(result.reasoning, /no forward RevPAR-adj/);
});

test("computeDemandMultiplier — missing trailing-12mo median returns neutral 1.0", () => {
  const result = computeDemandMultiplier({
    marketForwardRevparAdjForDate: 60,
    marketTrailingMedianRevparAdj: null
  });
  assert.equal(result.multiplier, 1.0);
  assert.equal(result.dominantSignal, "none");
  assert.equal(result.rawDemandDelta, null);
  assert.match(result.reasoning, /no trailing-12mo median RevPAR-adj/);
});

test("computeDemandMultiplier — zero trailing median returns 1.0 (no NaN)", () => {
  // baseline = 0 must not produce a division-by-zero NaN.
  const result = computeDemandMultiplier({
    marketForwardRevparAdjForDate: 60,
    marketTrailingMedianRevparAdj: 0
  });
  assert.equal(result.multiplier, 1.0);
  assert.equal(result.dominantSignal, "none");
  assert.equal(Number.isFinite(result.multiplier), true);
});

test("computeDemandMultiplier — LY occupancy stays available for context but does not drive the multiplier", () => {
  // RevPAR-adj fwd 58 vs trail12mo med 55 → demandΔ ≈ 0.0545 → ~1.038
  // The LY occupancy field is wildly negative (forward-vs-LY would say
  // "soft" — supply-dilution pattern) but the multiplier is set by the
  // within-year RevPAR signal alone.
  const result = computeDemandMultiplier({
    marketForwardRevparAdjForDate: 58,
    marketTrailingMedianRevparAdj: 55,
    marketForwardOccForDate: 0.26,
    marketForwardOccLY: 0.50,
    marketForwardADRForDate: 236,
    marketForwardADRLY: 204
  });
  assert.ok(result.multiplier > 1.03 && result.multiplier < 1.05, `expected ~1.038, got ${result.multiplier}`);
  assert.equal(result.dominantSignal, "trail12mo");
  // LY values should appear in the context portion of the reasoning string.
  assert.match(result.reasoning, /occLY=0\.500/);
  assert.match(result.reasoning, /adrLY=204/);
});

// ---------------------------------------------------------------------------
// blendSeasonality — sample-gated own/KD weighting (2026-05-21 spec)
//   - ownSampleSize >= 30 (gate): own-led 0.85 / 0.15
//   - ownSampleSize  < 30       : KD-heavy fallback 0.40 / 0.60
//   - market only               : 1.0 × KD
//   - own only                  : 1.0 × own
//   - high own value            : clamped at SEASONALITY_CEIL (1.80)
// ---------------------------------------------------------------------------

test("blendSeasonality — own + KD with sample above the gate → own-led 0.85/0.15 weighting", () => {
  // ownIndex=1.20, marketIndex=1.10, ownSampleSize=50 (>= 30 gate)
  // → 0.85*1.20 + 0.15*1.10 = 1.02 + 0.165 = 1.185
  const result = blendSeasonality({
    ownSeasonalityIndex: 1.20,
    marketSeasonalityIndex: 1.10,
    ownSampleSize: 50,
    manualAdjPct: 0
  });
  assert.ok(Math.abs(result.multiplier - 1.185) < 0.0001, `expected 1.185, got ${result.multiplier}`);
  assert.equal(result.ownWeight, 0.85);
  assert.equal(result.marketWeight, 0.15);
  assert.equal(result.ownSampleSize, 50);
  assert.equal(result.ownSampleAboveGate, true);
  // Inside [0.75, 1.80] structural bounds.
  assert.ok(result.multiplier >= 0.75 && result.multiplier <= 1.80);
});

test("blendSeasonality — own + KD with sample below the gate → KD-heavy fallback 0.40/0.60", () => {
  // ownIndex=1.20, marketIndex=1.10, ownSampleSize=10 (< 30 gate)
  // → 0.40*1.20 + 0.60*1.10 = 0.48 + 0.66 = 1.14
  const result = blendSeasonality({
    ownSeasonalityIndex: 1.20,
    marketSeasonalityIndex: 1.10,
    ownSampleSize: 10,
    manualAdjPct: 0
  });
  assert.ok(Math.abs(result.multiplier - 1.14) < 0.0001, `expected 1.14, got ${result.multiplier}`);
  assert.equal(result.ownWeight, 0.4);
  assert.equal(result.marketWeight, 0.6);
  assert.equal(result.ownSampleSize, 10);
  assert.equal(result.ownSampleAboveGate, false);
});

test("blendSeasonality — no own history (sample null + own null) → KD alone with no NaN", () => {
  const result = blendSeasonality({
    ownSeasonalityIndex: null,
    marketSeasonalityIndex: 1.10,
    ownSampleSize: null,
    manualAdjPct: 0
  });
  assert.equal(result.multiplier, 1.10);
  assert.equal(result.ownWeight, 0);
  assert.equal(result.marketWeight, 1);
  assert.equal(result.ownSampleSize, 0);
  assert.equal(result.ownSampleAboveGate, false);
  assert.ok(Number.isFinite(result.multiplier));
});

test("blendSeasonality — own only (no KD) falls through to own at full weight", () => {
  const result = blendSeasonality({
    ownSeasonalityIndex: 1.30,
    marketSeasonalityIndex: null,
    ownSampleSize: 100,
    manualAdjPct: 0
  });
  assert.equal(result.multiplier, 1.30);
  assert.equal(result.ownWeight, 1);
  assert.equal(result.marketWeight, 0);
});

test("blendSeasonality — a high own index is clamped at the new 1.80 ceiling", () => {
  // ownIndex=2.50, marketIndex=1.50, ownSampleSize=120 (own-led)
  // raw = 0.85*2.50 + 0.15*1.50 = 2.125 + 0.225 = 2.35 → clamped to 1.80
  const result = blendSeasonality({
    ownSeasonalityIndex: 2.50,
    marketSeasonalityIndex: 1.50,
    ownSampleSize: 120,
    manualAdjPct: 0
  });
  assert.equal(result.multiplier, 1.80);
  assert.equal(result.ceilingHit, true);
  assert.equal(result.floorHit, false);
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
    trailing365dOccupancy: 0.65,
    ownSeasonalityIndex: 1.10, // July lift
    ownSeasonalitySampleSize: 60, // above SEASONALITY_OWN_SAMPLE_GATE=30 → own-led weights when KD present
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
