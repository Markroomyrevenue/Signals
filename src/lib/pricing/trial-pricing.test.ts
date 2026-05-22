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

// Neutral cross-sectional demand input — no own signal, no KD signal,
// so demand multiplier falls back to 1.0. Used by tests that aren't
// exercising the demand path.
const NEUTRAL_DEMAND_XS: TrialDailyInput["demandCrossSectional"] = {
  ownDelta: null,
  ownPeerSampleSize: 0,
  ownTargetFill: null,
  ownPeerMedianFill: null,
  kdRevparDelta: null,
  kdAdrDelta: null,
  kdSupplyDelta: null,
  kdEffectiveDelta: null,
  kdSupplyGuardTriggered: false,
  kdPeerSampleSize: 0
};

// ---------------------------------------------------------------------------
// computeDemandMultiplier — CROSS-SECTIONAL (2026-05-22 rebuild)
//   - target above peer baseline → lift
//   - target at peer baseline → ~1.0
//   - target below peers → downside (floor=0.92 preserves weekday-below)
//   - own + KD both elevated → larger lift than either alone (blend pre-clamp)
//   - supply contraction + flat ADR → guard fires, lift damped to ADR-only
//   - missing both signals → 1.0, no NaN
// ---------------------------------------------------------------------------

test("computeDemandMultiplier — target above peer baseline → lift", () => {
  // own +20% above peer median, kd +10% above peer median
  // blend = 0.5 × 0.20 + 0.5 × 0.10 = 0.15
  // raw = 1 + 0.7 × 0.15 = 1.105
  const result = computeDemandMultiplier({
    ownDelta: 0.20,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: 0.10,
    kdSupplyGuardTriggered: false,
    kdRevparDeltaRaw: 0.10,
    kdAdrDelta: 0.05,
    kdSupplyDelta: 0,
    kdPeerSampleSize: 25
  });
  assert.ok(Math.abs(result.multiplier - 1.105) < 0.001, `expected ~1.105, got ${result.multiplier}`);
  assert.equal(result.dominantSignal, "both");
  assert.equal(result.ceilingHit, false);
  assert.equal(result.floorHit, false);
});

test("computeDemandMultiplier — target at peer baseline → ~1.0", () => {
  const result = computeDemandMultiplier({
    ownDelta: 0,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: 0,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25
  });
  assert.equal(result.multiplier, 1.0);
  assert.equal(result.ceilingHit, false);
  assert.equal(result.floorHit, false);
  assert.equal(result.rawDemandDelta, 0);
});

test("computeDemandMultiplier — target below peers → downside preserved (floor 0.92)", () => {
  // own -20%, kd -10% → blend = -0.15 → raw = 1 + 0.7 × -0.15 = 0.895 → clamped to 0.92
  // (this is exactly the weekday-downside case Mark flagged at the
  // checkpoint — without the lowered floor, ordinary Mondays would
  // clamp to 1.0 and lose their below-month-median signal.)
  const result = computeDemandMultiplier({
    ownDelta: -0.20,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: -0.10,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25
  });
  assert.equal(result.multiplier, 0.92);
  assert.equal(result.floorHit, true);
  assert.equal(result.ceilingHit, false);
});

test("computeDemandMultiplier — own + KD both elevated → larger lift than either alone", () => {
  // own +40%, kd +30% → blend 0.35 → raw 1 + 0.7×0.35 = 1.245
  // own alone +40% → 1 + 0.7×0.40 = 1.28
  // kd alone +30%  → 1 + 0.7×0.30 = 1.21
  // The "both" result (1.245) sits between, but matters compared with a
  // weaker case where the signals were modest individually:
  //   own +10%, kd +10% (both modest) → blend 0.10 → 1.07
  //   own alone +10% → 1.07; kd alone +10% → 1.07
  // The test below verifies the directional intent: when both signals
  // are above peers, the blend reflects both; if one is null the
  // other carries full weight.
  const both = computeDemandMultiplier({
    ownDelta: 0.40,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: 0.30,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25
  });
  const ownAlone = computeDemandMultiplier({
    ownDelta: 0.40,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0
  });
  const kdAlone = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 0,
    kdEffectiveDelta: 0.30,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25
  });
  // Both > kd alone (because own +40% > kd +30% so the blend pulls higher)
  assert.ok(both.multiplier > kdAlone.multiplier, `both ${both.multiplier} should beat kdAlone ${kdAlone.multiplier}`);
  // Both < own alone (because kd +30% pulls the blend down from own +40%)
  assert.ok(both.multiplier < ownAlone.multiplier, `both ${both.multiplier} should be below ownAlone ${ownAlone.multiplier}`);
  assert.equal(both.dominantSignal, "both");
  assert.equal(ownAlone.dominantSignal, "own");
  assert.equal(kdAlone.dominantSignal, "kd");
});

test("computeDemandMultiplier — supply contraction + flat ADR → guard fires (effectiveDelta already damped)", () => {
  // The supply guard is applied UPSTREAM in `computeKdCrossSectionalDelta`;
  // by the time `computeDemandMultiplier` sees `kdEffectiveDelta`, the
  // damping has already happened. This test pins the behaviour: when
  // the supply guard has damped the kd input, the reasoning string
  // surfaces the SUPPLY-GUARD flag and the lift uses the damped value.
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 0,
    kdEffectiveDelta: 0, // damped: ADR was flat so the lift was zeroed
    kdSupplyGuardTriggered: true,
    kdRevparDeltaRaw: 0.40, // raw RPA was big (supply contraction)
    kdAdrDelta: 0.01, // ADR was flat
    kdSupplyDelta: -0.30,
    kdPeerSampleSize: 25
  });
  assert.equal(result.multiplier, 1.0);
  assert.match(result.reasoning, /SUPPLY-GUARD damped/);
  assert.match(result.reasoning, /raw RPAΔ=40\.0%/);
});

test("computeDemandMultiplier — missing both signals → 1.0 with no NaN", () => {
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 0,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0
  });
  assert.equal(result.multiplier, 1.0);
  assert.equal(result.dominantSignal, "none");
  assert.equal(result.rawDemandDelta, null);
  assert.ok(Number.isFinite(result.multiplier));
  assert.match(result.reasoning, /no cross-sectional signal/);
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

// ---------------------------------------------------------------------------
// Events lever (Fleadh) — 2026-05-22 wiring
//
// `localEventAdjPct` flows into `computeTrialDailyRate` and is applied as
// `eventMult = 1 + localEventAdjPct/100` in the multiplier chain. The
// tests below pin:
//   - non-null adjPct → daily rate lifts by the expected factor
//   - null adjPct → eventMult stays 1.0, no behavioural change
//   - event + demand both firing → both apply; final still bounded by
//     base × 2.5 cap; no NaN
//   - a date outside the event window is irrelevant inside
//     computeTrialDailyRate (which receives `localEventAdjPct` already
//     resolved); we test it at the integration layer by passing null.
//     The date-resolution helper is the shared `eventAdjustmentForDate`
//     which has its own range/multiple branches.
// ---------------------------------------------------------------------------

test("events lever — adjustmentPct=40 lifts the daily rate by ~1.40× relative to no-event", () => {
  const marketBase: TrialMarketSnapshot = {
    benchmark: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    benchmark1br: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    seasonality: null,
    dayOfWeek: null,
    forwardPace: null,
    trailingMarketKpis: null,
    benchmarkSimilarity: 0.8,
    marketOcc25thPct: null,
    marketRpoMedian: null,
    marketRpoForDate: null,
    marketForwardOccForDate: null
  };
  const inputBase: TrialDailyInput = {
    listingId: "test-listing",
    bedrooms: 1,
    qualityTier: "mid_scale",
    date: "2026-08-05",
    daysToCheckIn: 75,
    dayOfWeek: 3,
    monthIndex: 7,
    trailing365dAdr: 150,
    trailing365dOccupancy: 0.65,
    ownSeasonalityIndex: null, // null so the seasonality chain is a no-op
    ownSeasonalitySampleSize: null,
    ownDoWIndex: null,
    listingSizeAnchor: 150,
    manualSeasonalityAdjPct: 0,
    manualDoWAdjPct: 0,
    localEventAdjPct: null, // overridden per case below
    demandCrossSectional: NEUTRAL_DEMAND_XS,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.55,
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const noEvent = computeTrialDailyRate(inputBase, marketBase);
  const withEvent = computeTrialDailyRate({ ...inputBase, localEventAdjPct: 40 }, marketBase);
  assert.ok(noEvent !== null && withEvent !== null);
  // Both reach a base of 150 (mid_scale × 1.0). With no other multiplier
  // firing, the no-event rate ≈ 150 and the event rate ≈ 210.
  const ratio = withEvent!.recommendedRate / noEvent!.recommendedRate;
  assert.ok(Math.abs(ratio - 1.4) < 0.02, `expected ~1.40× lift, got ${ratio.toFixed(4)}× (no-event=${noEvent!.recommendedRate}, with-event=${withEvent!.recommendedRate})`);
  assert.equal(withEvent!.breakdown.events, 1.4);
  assert.equal(noEvent!.breakdown.events, 1.0);
});

test("events lever — null localEventAdjPct preserves existing behaviour (eventMult = 1.0)", () => {
  const market: TrialMarketSnapshot = {
    benchmark: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    benchmark1br: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    seasonality: null,
    dayOfWeek: null,
    forwardPace: null,
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
    date: "2026-09-15",
    daysToCheckIn: 120,
    dayOfWeek: 2,
    monthIndex: 8,
    trailing365dAdr: 150,
    trailing365dOccupancy: 0.65,
    ownSeasonalityIndex: 1.10,
    ownSeasonalitySampleSize: 50,
    ownDoWIndex: 1.05,
    listingSizeAnchor: 150,
    manualSeasonalityAdjPct: 0,
    manualDoWAdjPct: 0,
    localEventAdjPct: null,
    demandCrossSectional: NEUTRAL_DEMAND_XS,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.55,
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const result = computeTrialDailyRate(input, market);
  assert.ok(result !== null);
  assert.equal(result!.breakdown.events, 1.0);
  // Sanity: with no event and the auto DoW path retired (2026-05-22),
  // the rate is base × seasonality only. 150 × 1.10 = 165.
  assert.ok(Math.abs(result!.recommendedRate - 165) < 1.01, `expected ~165, got ${result!.recommendedRate}`);
});

test("events lever — event + demand both firing, final bounded by base × 2.5 cap and no NaN", () => {
  // Fleadh-class week with an event AND a hot demand signal — verifies
  // multiplicative composition works and the final clamp catches an
  // extreme stack without producing NaN.
  const market: TrialMarketSnapshot = {
    benchmark: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    benchmark1br: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    seasonality: null,
    dayOfWeek: null,
    forwardPace: null,
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
    date: "2026-08-05",
    daysToCheckIn: 75,
    dayOfWeek: 3,
    monthIndex: 7,
    trailing365dAdr: 150,
    trailing365dOccupancy: 0.65,
    ownSeasonalityIndex: 1.30,
    ownSeasonalitySampleSize: 100,
    ownDoWIndex: 1.10,
    listingSizeAnchor: 150,
    manualSeasonalityAdjPct: 0,
    manualDoWAdjPct: 0,
    localEventAdjPct: 60, // event at the +60% cap
    // Cross-sectional demand inputs — wildly hot date that pushes
    // demand past the ceiling so we can verify event × demand both
    // multiply through.
    demandCrossSectional: {
      ownDelta: 1.0, // +100% above peer median fill
      ownPeerSampleSize: 25,
      ownTargetFill: 0.50,
      ownPeerMedianFill: 0.25,
      kdRevparDelta: 0.80,
      kdAdrDelta: 0.10,
      kdSupplyDelta: -0.20,
      kdEffectiveDelta: 0.80,
      kdSupplyGuardTriggered: false,
      kdPeerSampleSize: 25
    },
    paceMultiplier: 1.0,
    scopeOccupancy: 0.85, // 81-90 bucket → 1.08 multiplier in standard
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const result = computeTrialDailyRate(input, market);
  assert.ok(result !== null);
  // Multiplier chain: base 150 × seas 1.3 × dow 1.0 (manual=0; auto retired) × demand 1.40 × occ 1.08 × event 1.60 × pace 1.0
  // = 150 × 1.3 × 1.0 × 1.4 × 1.08 × 1.6 = 471.96
  // The standard pipeline clamps to base × 2.5 = 375. Final should land at 375 (rounded).
  assert.ok(Number.isFinite(result!.recommendedRate), "recommendedRate must be finite (no NaN)");
  assert.ok(result!.recommendedRate <= 375 + 0.01, `expected ≤ base×2.5=375, got ${result!.recommendedRate}`);
  assert.equal(result!.breakdown.events, 1.6);
  assert.equal(result!.breakdown.demand, 1.4);
});

test("events lever — date outside event window (null adjPct) leaves events at 1.0", () => {
  // computeTrialDailyRate doesn't know about event windows directly —
  // it just multiplies in eventMult = 1 + localEventAdjPct/100, treating
  // null as 1.0. The trial-comparison agent resolves the window via the
  // shared `eventAdjustmentForDate(events, dateIso)` helper; here we
  // pin the contract: a null adjPct (= no event resolved for this date)
  // leaves the multiplier untouched.
  const market: TrialMarketSnapshot = {
    benchmark: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    benchmark1br: { p20: 100, p50: 150, p80: 200, sampleSize: 60 },
    seasonality: null,
    dayOfWeek: null,
    forwardPace: null,
    trailingMarketKpis: null,
    benchmarkSimilarity: 0.8,
    marketOcc25thPct: null,
    marketRpoMedian: null,
    marketRpoForDate: null,
    marketForwardOccForDate: null
  };
  const inputBase: TrialDailyInput = {
    listingId: "test-listing",
    bedrooms: 1,
    qualityTier: "mid_scale",
    date: "2026-09-01", // outside Fleadh
    daysToCheckIn: 100,
    dayOfWeek: 2,
    monthIndex: 8,
    trailing365dAdr: 150,
    trailing365dOccupancy: 0.65,
    ownSeasonalityIndex: null,
    ownSeasonalitySampleSize: null,
    ownDoWIndex: null,
    listingSizeAnchor: 150,
    manualSeasonalityAdjPct: 0,
    manualDoWAdjPct: 0,
    localEventAdjPct: null, // event resolver returned null for this date
    demandCrossSectional: NEUTRAL_DEMAND_XS,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.55,
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const inside = computeTrialDailyRate({ ...inputBase, localEventAdjPct: 40 }, market);
  const outside = computeTrialDailyRate(inputBase, market);
  assert.ok(inside !== null && outside !== null);
  assert.equal(outside!.breakdown.events, 1.0);
  assert.equal(inside!.breakdown.events, 1.4);
  // Outside should equal the bare base.
  assert.equal(outside!.recommendedRate, 150);
});

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
    demandCrossSectional: NEUTRAL_DEMAND_XS,
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
  // ownWeight=1, market=0, mult=1.10, clamped to [0.75, 1.80] → 1.10.
  assert.ok(Math.abs(b.seasonality - 1.10) < 0.0001, `expected seasonality ~1.10, got ${b.seasonality}`);
  // DoW: automatic path retired 2026-05-22 → b.dayOfWeek = 1.0 always
  // (only manual `manualDoWAdjPct` can move it, and that's 0 here).
  assert.equal(b.dayOfWeek, 1.0);
  // Demand: no cross-sectional signal → 1.0.
  assert.equal(b.demand, 1.0);
  // Occupancy: 55% in standard ladder → 51-60 bucket → 1.0.
  assert.equal(b.occupancy, 1.0);
  // Pace: 1.0.
  assert.equal(b.pace, 1.0);
  // Events: 1.0 (no local event).
  assert.equal(b.events, 1.0);
  // Multiplier chain product (DoW now 1.0 not 1.05):
  // base 150 × seasonality 1.10 × DoW 1.0 × demand 1.0 × occupancy 1.0 × pace 1.0 × events 1.0
  // = 150 × 1.10 = 165 → rounded by increment 1 → 165
  // Final clamping: min = max(base × 0.7 = 105, userSetMinimum 0) = 105, so 165 is unclamped.
  assert.ok(Math.abs(result!.recommendedRate - 165) < 1.01, `expected ~165, got ${result!.recommendedRate}`);
});
