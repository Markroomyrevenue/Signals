import assert from "node:assert/strict";
import test from "node:test";

import {
  blendDayOfWeek,
  blendSeasonality,
  computeDemandMultiplier,
  computeLeadTimeFloor,
  computeTrialBase,
  computeTrialDailyRate,
  computeTrialMinimum,
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

// Neutral four-rung base ladder inputs (2026-05-23). Tests that don't
// exercise the base path can spread these into their TrialDailyInput.
// 200 sold nights ≥ SOLD_NIGHTS_FULL_CONFIDENCE → rich-own rung; ownAdr
// is the dominant signal.
const NEUTRAL_LADDER = {
  trailing365dSoldNights: 200,
  marketMedianOccupancy: 0.4,
  portfolioMedianOccupancy: 0.6,
  compAnchor: null,
  manualBaseAnchor: null
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
  // raw = 1 + 0.5 × 0.15 = 1.075  (DEMAND_PASS_THROUGH lowered 0.7 → 0.5 on 2026-05-27)
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
  assert.ok(Math.abs(result.multiplier - 1.075) < 0.001, `expected ~1.075, got ${result.multiplier}`);
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
  // own -40%, kd -30% → blend = -0.35 → raw = 1 + 0.5 × -0.35 = 0.825 → clamped to 0.92
  // (this is exactly the weekday-downside case Mark flagged at the
  // checkpoint — without the lowered floor, ordinary Mondays would
  // clamp to 1.0 and lose their below-month-median signal. Bumped the
  // input deltas 2026-05-27 to keep this case below the floor after
  // DEMAND_PASS_THROUGH was reduced 0.7 → 0.5.)
  const result = computeDemandMultiplier({
    ownDelta: -0.40,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: -0.30,
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
// Phase C calendar-fallback (2026-05-24) — horizon handoff with NI holidays
// ---------------------------------------------------------------------------

test("computeDemandMultiplier — pace gated out + calendar holiday available → calendar takes over", () => {
  // Both pace signals null (far-future date where the sufficiency gate
  // dropped both). Calendar delta = +15% (Twelfth). The multiplier
  // should reflect the calendar lift via the same pass-through + clamp
  // pipeline pace uses.
  // raw = 1 + 0.5 × 0.15 = 1.075 (DEMAND_PASS_THROUGH lowered 0.7 → 0.5 on 2026-05-27)
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 12, // peer count was fine, fill density failed
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0,
    calendarFallbackDelta: 0.15,
    calendarFallbackLabel: "Battle of the Boyne (NI) 2026"
  });
  assert.ok(Math.abs(result.multiplier - 1.075) < 0.001, `expected ~1.075, got ${result.multiplier}`);
  assert.equal(result.dominantSignal, "calendar");
  assert.equal(result.rawDemandDelta, 0.15);
  assert.match(result.reasoning, /calendar fallback "Battle of the Boyne/);
});

test("computeDemandMultiplier — pace has data → calendar IGNORED (no double-count)", () => {
  // Pace own signal active (+10%). A calendar value for the same cell
  // must NOT compound on top.
  //   pace-only result: blend = 0.10, raw = 1 + 0.7 × 0.10 = 1.07
  //   if calendar wrongly added: would be larger
  const paceOnly = computeDemandMultiplier({
    ownDelta: 0.10,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0
  });
  const paceWithCalendarPresent = computeDemandMultiplier({
    ownDelta: 0.10,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0,
    calendarFallbackDelta: 0.20, // a holiday with +20% — must be ignored
    calendarFallbackLabel: "Some Holiday"
  });
  assert.equal(paceOnly.multiplier, paceWithCalendarPresent.multiplier, "calendar must be ignored when pace has data");
  assert.equal(paceWithCalendarPresent.dominantSignal, "own");
});

test("computeDemandMultiplier — pace gated out + no calendar → neutral 1.0", () => {
  // Ordinary far-future date (e.g. random Tuesday in Feb 2027) — the
  // sufficiency gate dropped pace, no holiday window covers the cell.
  // Result must be neutral; no NaN.
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 17,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0,
    calendarFallbackDelta: null,
    calendarFallbackLabel: null
  });
  assert.equal(result.multiplier, 1.0);
  assert.equal(result.dominantSignal, "none");
  assert.ok(Number.isFinite(result.multiplier));
});

test("computeDemandMultiplier — negative calendar delta honored (some holidays are SOFT for STR)", () => {
  // Christmas Day itself can be SOFT for city Airbnb. Spec: "trust the
  // data, don't assume every holiday lifts." A negative learned delta
  // must flow through, capped only by the symmetric calendar cap +
  // the underlying DEMAND_FLOOR. -20% calendar with 0.5 pass-through
  // → raw 0.90 → clamped to 0.92 floor.
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 12,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0,
    calendarFallbackDelta: -0.20, // -20% (Christmas Day soft); was -0.15 under 0.7 pass-through
    calendarFallbackLabel: "Christmas Day"
  });
  // raw = 1 + 0.7 × -0.15 = 0.895 → clamped to DEMAND_FLOOR (0.92)
  assert.equal(result.multiplier, 0.92);
  assert.equal(result.dominantSignal, "calendar");
  assert.equal(result.floorHit, true);
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
//     base × 4.0 cap; no NaN
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
    ...NEUTRAL_LADDER,
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
    ...NEUTRAL_LADDER,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.55,
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const result = computeTrialDailyRate(input, market);
  assert.ok(result !== null);
  assert.equal(result!.breakdown.events, 1.0);
  // DoW reinstated 2026-05-27 (learned per-tenant multiplier). With
  // ownDoWIndex=1.05 the rate is base × seasonality × DoW = 150 × 1.10
  // × 1.05 = 173.25 → £173 (rounded).
  assert.ok(Math.abs(result!.recommendedRate - 173) < 1.01, `expected ~173, got ${result!.recommendedRate}`);
});

test("events lever — event + demand both firing, final bounded by base × 4.0 cap and no NaN", () => {
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
    ...NEUTRAL_LADDER,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.85, // 81-90 bucket → 1.08 multiplier in standard
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const result = computeTrialDailyRate(input, market);
  assert.ok(result !== null);
  // Multiplier chain: base 150 × seas 1.3 × dow 1.10 (learned DoW reinstated 2026-05-27) × demand 1.40 × occ 1.08 × event 1.60 × pace 1.0
  // = 150 × 1.3 × 1.10 × 1.4 × 1.08 × 1.6 = 519.16
  // Event-flagged night → relaxed clamp at base × 5.0 = 750. 519 < 750, no clamp.
  // The point of this test: event × demand BOTH multiply through cleanly, no NaN.
  assert.ok(Number.isFinite(result!.recommendedRate), "recommendedRate must be finite (no NaN)");
  assert.ok(result!.recommendedRate <= 750 + 0.01, `expected ≤ base×5.0=750, got ${result!.recommendedRate}`);
  assert.ok(result!.recommendedRate >= 515, `expected ~519 (chain product), got ${result!.recommendedRate}`);
  assert.equal(result!.breakdown.events, 1.6);
  assert.equal(result!.breakdown.demand, 1.4);
});

test("daily-rate clamp — non-event night still bounded at base × 4.0 (long-standing behaviour)", () => {
  // Same wildly-hot chain as the previous test, but with localEventAdjPct=null
  // (no event covers this date). The clamp should fall back to base × 4.0 = 600
  // and the chain product is well under, so the test really pins "non-event
  // nights aren't affected by the event-night relax".
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
  // Drive the chain past base × 4.0 using demand alone + seasonality + DoW
  // (no event). With event = null, the relax does NOT apply.
  const input: TrialDailyInput = {
    listingId: "test-listing",
    bedrooms: 1,
    qualityTier: "mid_scale",
    date: "2026-07-15",
    daysToCheckIn: 60,
    dayOfWeek: 6,
    monthIndex: 6,
    trailing365dAdr: 150,
    trailing365dOccupancy: 0.65,
    ownSeasonalityIndex: 1.50,
    ownSeasonalitySampleSize: 100,
    ownDoWIndex: 1.10,
    listingSizeAnchor: 150,
    manualSeasonalityAdjPct: 0,
    manualDoWAdjPct: 0,
    localEventAdjPct: null, // NOT event-flagged
    demandCrossSectional: {
      ownDelta: 1.0,
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
    ...NEUTRAL_LADDER,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.85, // 81-90 bucket → 1.08
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const result = computeTrialDailyRate(input, market);
  assert.ok(result !== null);
  // Chain product: 150 × 1.50 × 1.10 (learned DoW reinstated) × 1.40 × 1.08 × 1.0 = 374.2.
  // Non-event night clamp = base × 4.0 = 600. 374 < 600 → no clamp.
  // Final ~374. Test the upper bound (would have been clamped if we'd pushed harder).
  assert.equal(result!.breakdown.events, 1.0, "non-event night → eventMult=1.0");
  assert.ok(result!.recommendedRate <= 600 + 0.01, `expected ≤ base×4.0=600 on non-event night, got ${result!.recommendedRate}`);
});

test("event-night clamp — event-flagged + chain > base×4.0 lands above non-event cap (relaxed clamp fires)", () => {
  // Wildly hot fleadh-class night: chain product is pushed above both
  // caps. On the non-event cap (base × 4.0 = 600) it'd be clamped to 600;
  // on the relaxed event cap (base × 5.0 = 750) it clamps to 750. The 750
  // result sits above the non-event 600 cap — confirming the relax engages
  // on event-flagged nights.
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
    date: "2026-08-08",
    daysToCheckIn: 78,
    dayOfWeek: 6,
    monthIndex: 7,
    trailing365dAdr: 150,
    trailing365dOccupancy: 0.65,
    ownSeasonalityIndex: 1.50,
    ownSeasonalitySampleSize: 100,
    // ownDoWIndex bumped 1.10 → 1.40 on 2026-05-27 PM to push chain past the
    // new base × 5.0 = 750 event cap (post-clamp widening). 1.40 sits inside
    // the new DoW_CEIL=1.50 bracket so the multiplier passes through unclipped.
    ownDoWIndex: 1.40,
    listingSizeAnchor: 150,
    manualSeasonalityAdjPct: 0,
    manualDoWAdjPct: 0,
    localEventAdjPct: 60, // event-flagged, at the cap
    demandCrossSectional: {
      ownDelta: 1.5,
      ownPeerSampleSize: 25,
      ownTargetFill: 0.55,
      ownPeerMedianFill: 0.22,
      kdRevparDelta: 1.0,
      kdAdrDelta: 0.10,
      kdSupplyDelta: -0.30,
      kdEffectiveDelta: 1.0,
      kdSupplyGuardTriggered: false,
      kdPeerSampleSize: 25
    },
    ...NEUTRAL_LADDER,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.85, // 1.08
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const result = computeTrialDailyRate(input, market);
  assert.ok(result !== null);
  // Chain product: 150 × 1.50 × 1.40 × 1.40 × 1.08 × 1.60 = 762.05.
  // Event-flagged night clamp = base × 5.0 = 750. → final ≈ 750.
  assert.ok(Number.isFinite(result!.recommendedRate));
  assert.ok(result!.recommendedRate <= 750 + 0.01, `expected ≤ base×5.0=750, got ${result!.recommendedRate}`);
  assert.ok(result!.recommendedRate > 600, `expected > base×4.0=600 non-event cap (relaxed clamp fired), got ${result!.recommendedRate}`);
  assert.equal(result!.breakdown.events, 1.6);
});

test("event lever — adjustmentPct is still capped at TRIAL_EVENT_ADJUSTMENT_PCT_CAP via trial-events", () => {
  // The cap lives in `trial-events.ts` — events with |adjustmentPct| > 60
  // are dropped at runtime. This is structurally enforced when the agent
  // calls getTrialLocalEventsForTenant. computeTrialDailyRate itself
  // doesn't enforce the cap (it would happily multiply by 1 + 999/100);
  // tested elsewhere via trial-events. Here we pin the receiver-side
  // behaviour at +60% exactly = relaxed clamp upper bound math.
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
    date: "2026-08-08",
    daysToCheckIn: 78,
    dayOfWeek: 6,
    monthIndex: 7,
    trailing365dAdr: 150,
    trailing365dOccupancy: 0.65,
    ownSeasonalityIndex: null,
    ownSeasonalitySampleSize: null,
    ownDoWIndex: null,
    listingSizeAnchor: 150,
    manualSeasonalityAdjPct: 0,
    manualDoWAdjPct: 0,
    localEventAdjPct: 60, // at cap
    demandCrossSectional: {
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
    },
    ...NEUTRAL_LADDER,
    paceMultiplier: 1.0,
    scopeOccupancy: 0.55,
    userSetMinimum: null,
    roundingIncrement: 1,
    mode: "standard"
  };
  const result = computeTrialDailyRate(input, market);
  assert.ok(result !== null);
  // chain = base 150 × seas 1.0 × dow 1.0 × demand 1.0 × occ 1.0 × event 1.6 = 240.
  // Well under base × 5.0 = 750. Final = 240 (rounded).
  assert.equal(result!.breakdown.events, 1.6, "event 1+60/100 = 1.6 applied");
  assert.ok(Math.abs(result!.recommendedRate - 240) <= 1.01);
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
    ...NEUTRAL_LADDER,
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
    ...NEUTRAL_LADDER,
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
  // DoW: REINSTATED 2026-05-27 as a learned per-tenant multiplier. The
  // fixture passes ownDoWIndex=1.05 (Saturday lift); blendDayOfWeek
  // clamps to [DOW_FLOOR=0.75, DOW_CEIL=1.50] (widened 2026-05-27 PM)
  // and returns 1.05.
  assert.equal(b.dayOfWeek, 1.05);
  // Demand: no cross-sectional signal → 1.0.
  assert.equal(b.demand, 1.0);
  // Occupancy: 55% in standard ladder → 51-60 bucket → 1.0.
  assert.equal(b.occupancy, 1.0);
  // Pace: 1.0.
  assert.equal(b.pace, 1.0);
  // Events: 1.0 (no local event).
  assert.equal(b.events, 1.0);
  // Multiplier chain product:
  // base 150 × seasonality 1.10 × DoW 1.05 × demand 1.0 × occupancy 1.0 × pace 1.0 × events 1.0
  // = 150 × 1.10 × 1.05 = 173.25 → rounded by increment 1 → 173
  // Final clamping: min = max(base × 0.7 = 105, userSetMinimum 0) = 105, so 173 is unclamped.
  assert.ok(Math.abs(result!.recommendedRate - 173) < 1.01, `expected ~173, got ${result!.recommendedRate}`);
});

// ---------------------------------------------------------------------------
// computeTrialBase — four-rung ladder (2026-05-23 redesign)
//
// Calibration targets (from the diagnostic sample):
//   Castle Buildings 1-beds (own £127, occ 84%, KD £144) → lift toward PL £165
//   Castle Buildings 2-beds (own £195, occ 81%, KD £184) → ~unchanged at PL
//   Templemore           (own £107, occ 70%, KD £184) → trust own, ~£107
//   SB Fitzrovia         (own £134, occ 69%, KD £144) → mild lift
//   Portland 3br thin    (own £168, occ 4%, KD £222)  → slide to rung 3/4
// ---------------------------------------------------------------------------

test("computeTrialBase — Rung 1 rich-own, in-band: occupancy lift applies (CB-1 case)", () => {
  // Castle Buildings 1-bed: own £127 at 84% occupancy, KD market 37.77% occ, KD P50 £144.
  // own/KD = 127/144 = 0.88 (in "modestly below market" band: 0.70-1.00)
  // occRatio = 0.84/0.3777 ≈ 2.22
  // factor = 1 + (2.22-1) × 0.20 = 1.244, clamp at MAX 1.25 → 1.244
  // Wait: 1.244 < 1.25, so no clamp; factor = 1.244
  // base = 127 × 1.244 = £158, rounded → £158
  const r = computeTrialBase({
    trailing365dAdr: 127,
    trailing365dSoldNights: 305,
    trailing365dOccupancy: 0.84,
    marketP50: 144,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: null,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "rich_own");
  assert.ok(r!.base >= 155 && r!.base <= 160, `expected base ~158 for CB-1, got ${r!.base}`);
  assert.ok(r!.occupancyFactorApplied > 1.20 && r!.occupancyFactorApplied <= 1.25, `expected lift factor ~1.24, got ${r!.occupancyFactorApplied}`);
});

test("computeTrialBase — Rung 1 rich-own, cheap segment: trust own, no lift (Templemore case)", () => {
  // Templemore 2br: own £107, KD £184. own/KD = 0.58 — below CHEAP_THRESHOLD (0.70).
  // Genuinely cheap product → trust own. base = £107 (no occupancy lift).
  const r = computeTrialBase({
    trailing365dAdr: 107,
    trailing365dSoldNights: 262,
    trailing365dOccupancy: 0.72, // moderate occ but doesn't matter for cheap segment
    marketP50: 184,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: null,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "rich_own");
  assert.equal(r!.base, 107, "Templemore-class should land exactly on ownAdr");
  assert.equal(r!.occupancyFactorApplied, 1.0, "no lift in cheap segment");
});

test("computeTrialBase — Rung 1 rich-own, at/above market: trust own, no lift (CB-2 case)", () => {
  // CB-2: own £195, KD £184. own/KD = 1.06 → above 1.0 trust threshold → trust own.
  const r = computeTrialBase({
    trailing365dAdr: 195,
    trailing365dSoldNights: 296,
    trailing365dOccupancy: 0.81,
    marketP50: 184,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: null,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "rich_own");
  assert.equal(r!.base, 195, "at/above market → trust own");
  assert.equal(r!.occupancyFactorApplied, 1.0);
});

// ---------------------------------------------------------------------------
// Comp-bounded lift (2026-05-25 over-base fix) — the in-band occupancy
// lift is capped at max(ownAdr, compAnchor) so a budget listing booking
// high occupancy at a low price isn't lifted past comparable listings.
// ---------------------------------------------------------------------------

test("computeTrialBase — Rung 1 lift capped at comp anchor (over-base fix; CB-1 stays inside calibration band)", () => {
  // CB-1 case with comp = £160 (mean rung1 across SB/LF 1-bed peers).
  // Uncapped: 127 × 1.244 = 158. Comp ceiling = max(127, 160) = 160.
  // Lifted £158 < £160 ceiling → no cap fires. Base unchanged ~£158.
  const r = computeTrialBase({
    trailing365dAdr: 127,
    trailing365dSoldNights: 305,
    trailing365dOccupancy: 0.84,
    marketP50: 144,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: 160,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "rich_own");
  assert.ok(r!.base >= 155 && r!.base <= 160, `expected ~£158, got ${r!.base}`);
});

test("computeTrialBase — Rung 1 lift capped at comp anchor: a higher-own listing IS bounded down to comp", () => {
  // C-315-like case: own £182, in-band, occRatio 2.08 → factor 1.216 →
  // uncapped £221. Comp anchor = £195 (mean rung1 of other SB 2-beds).
  // Cap at max(182, 195) = 195. Lift bounded to £195.
  const r = computeTrialBase({
    trailing365dAdr: 182,
    trailing365dSoldNights: 287,
    trailing365dOccupancy: 0.786,
    marketP50: 184,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: 195,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "rich_own");
  assert.equal(r!.base, 195, "lift capped at comp anchor");
});

test("computeTrialBase — Rung 1 comp-bound never DROPS below own (upward-only ceiling)", () => {
  // own £179 in-band, factor would lift to ~£215. Comp anchor = £128
  // (hypothetical: budget-segment comp). max(own, comp) = max(179, 128) = 179.
  // Lifted £215 > ceiling £179 → cap to £179. Never drops below own.
  const r = computeTrialBase({
    trailing365dAdr: 179,
    trailing365dSoldNights: 279,
    trailing365dOccupancy: 0.764,
    marketP50: 184,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: 128, // below own — must not drop the result below own
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "rich_own");
  assert.equal(r!.base, 179, "comp below own → cap at own (lift neutralised, no drop)");
});

test("computeTrialBase — Rung 1 cheap segment: comp anchor IGNORED (cheap branch short-circuits before lift)", () => {
  // Templemore case: own £107, KD £184 → ratio 0.58 → cheap branch.
  // Cheap branch returns own directly with no lift, no comp check.
  // Even with a higher comp (say £130), result must stay at £107.
  const r = computeTrialBase({
    trailing365dAdr: 107,
    trailing365dSoldNights: 262,
    trailing365dOccupancy: 0.715,
    marketP50: 184,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: 130, // higher than own — must not pull cheap-branch upward
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "rich_own");
  assert.equal(r!.base, 107, "cheap segment trusts own irrespective of comp");
});

test("computeTrialBase — Rung 1 in-band with null compAnchor: lift uncapped (no regression on listings without a comp set)", () => {
  // When no comp anchor exists (listings with no group: tag siblings AND
  // no same-tenant + same-bedrooms siblings — e.g. only listing of its
  // kind), the lift falls back to the factor clamp only. Behaviour
  // matches pre-2026-05-25.
  const uncapped = computeTrialBase({
    trailing365dAdr: 127,
    trailing365dSoldNights: 305,
    trailing365dOccupancy: 0.84,
    marketP50: 144,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: null,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(uncapped !== null);
  assert.ok(uncapped!.base >= 155 && uncapped!.base <= 160, `expected ~£158 unbounded, got ${uncapped!.base}`);
});

test("computeTrialBase — Rung 2 thin-own: confidence-weighted blend with comp anchor", () => {
  // 50 sold nights → confidence = (50 - 20) / (100 - 20) = 30/80 = 0.375
  // own (rung 1 = 130, no lift since cheap segment) gets 0.375 weight,
  // comp anchor (e.g. £160 from siblings) gets 0.625.
  // blend = 130 × 0.375 + 160 × 0.625 = 48.75 + 100 = £149
  const r = computeTrialBase({
    trailing365dAdr: 130,
    trailing365dSoldNights: 50,
    trailing365dOccupancy: 0.5,
    marketP50: 200, // 130/200 = 0.65 → below CHEAP_THRESHOLD → rung1 = 130 (no lift)
    marketMedianOccupancy: 0.40,
    portfolioMedianOccupancy: null,
    compAnchor: 160, // sibling-derived
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "thin_own_blend");
  assert.ok(r!.base >= 148 && r!.base <= 150, `expected ~149, got ${r!.base}`);
  assert.ok(r!.weightsApplied.ownAnchor > 0.3 && r!.weightsApplied.ownAnchor < 0.4);
  assert.ok(r!.weightsApplied.compAnchor > 0.6 && r!.weightsApplied.compAnchor < 0.7);
});

test("computeTrialBase — Rung 3 no-own, comp present: inherits comp anchor", () => {
  // Brand-new listing, 0 sold nights. Comp anchor £165 from siblings.
  const r = computeTrialBase({
    trailing365dAdr: null,
    trailing365dSoldNights: 0,
    trailing365dOccupancy: null,
    marketP50: 144,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: 165,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "comp_inherit");
  assert.equal(r!.base, 165);
  assert.equal(r!.weightsApplied.compAnchor, 1);
  assert.equal(r!.weightsApplied.ownAnchor, 0);
});

test("computeTrialBase — Rung 4 no own + no comp: KD market P50", () => {
  // No own, no comp, KD P50 = £144 → base = £144.
  const r = computeTrialBase({
    trailing365dAdr: null,
    trailing365dSoldNights: 0,
    trailing365dOccupancy: null,
    marketP50: 144,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: null,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "kd_market");
  assert.equal(r!.base, 144);
  assert.equal(r!.weightsApplied.kdAnchor, 1);
});

test("computeTrialBase — graceful degradation: market occupancy missing → portfolio fallback", () => {
  // CB-1-class but KD market occ is null; portfolio median 0.65 is used.
  // occRatio = 0.84/0.65 = 1.29
  // factor = 1 + 0.29 × 0.20 = 1.058 → 127 × 1.058 = £134
  const r = computeTrialBase({
    trailing365dAdr: 127,
    trailing365dSoldNights: 305,
    trailing365dOccupancy: 0.84,
    marketP50: 144,
    marketMedianOccupancy: null,
    portfolioMedianOccupancy: 0.65,
    compAnchor: null,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "rich_own");
  assert.equal(r!.fellBackToPortfolioOccupancy, true, "should record the fallback");
  assert.ok(r!.base >= 133 && r!.base <= 135, `expected ~134 via portfolio-occ fallback, got ${r!.base}`);
});

test("computeTrialBase — manual anchor overrides all rungs", () => {
  // Manual anchor £200 replaces everything.
  const r = computeTrialBase({
    trailing365dAdr: 127,
    trailing365dSoldNights: 305,
    trailing365dOccupancy: 0.84,
    marketP50: 144,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: 150,
    manualBaseAnchor: 200,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "manual_anchor");
  assert.equal(r!.base, 200);
});

test("computeTrialBase — no inputs at all → null (no NaN)", () => {
  const r = computeTrialBase({
    trailing365dAdr: null,
    trailing365dSoldNights: 0,
    trailing365dOccupancy: null,
    marketP50: null,
    marketMedianOccupancy: null,
    portfolioMedianOccupancy: null,
    compAnchor: null,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.equal(r, null);
});

test("computeTrialBase — Portland thin-data 3br slides to rung 4 (KD market)", () => {
  // 15 sold nights < FLOOR (20) → own weight = 0. No comp → rung 4 = KD £222.
  const r = computeTrialBase({
    trailing365dAdr: 168,
    trailing365dSoldNights: 15,
    trailing365dOccupancy: 0.041,
    marketP50: 222,
    marketMedianOccupancy: 0.3777,
    portfolioMedianOccupancy: null,
    compAnchor: null,
    manualBaseAnchor: null,
    qualityTier: "mid_scale",
    roundingIncrement: 1
  });
  assert.ok(r !== null);
  assert.equal(r!.rung, "kd_market");
  assert.equal(r!.base, 222);
});

// ---------------------------------------------------------------------------
// computeTrialMinimum — sub-proposal E (2026-05-23)
// ---------------------------------------------------------------------------

test("computeTrialMinimum — KD-P20 floor disabled when ownAdr ≥ KD P50 × 1.05 (CB-2 case)", () => {
  // CB-2: base £195, own £195 ≥ KD P50 £184 × 1.05 = £193.2 → KD floor skipped.
  // min = base × 0.7 = £137 (vs old £151 with KD floor binding).
  const m = computeTrialMinimum({
    base: 195,
    marketP20: 151,
    marketP50: 184,
    trailing365dAdr: 195,
    benchmarkSimilarity: 1.0,
    userSetMinimum: null,
    roundingIncrement: 1
  });
  assert.equal(m.kdFloorApplied, false, "KD floor must be disabled when own ≥ KD × 1.05");
  assert.equal(m.recommendedMinimum, 137);
});

test("computeTrialMinimum — KD-P20 floor still applies when ownAdr < KD P50 × 1.05 (CB-1 case)", () => {
  // CB-1: base £158, own £127 < KD P50 £144 × 1.05 = £151.2 → KD floor active.
  // base × 0.7 = £111; KD P20 × similarity (0.68) = £117 × 0.68 = £80.
  // max(111, 80) = £111.
  const m = computeTrialMinimum({
    base: 158,
    marketP20: 117,
    marketP50: 144,
    trailing365dAdr: 127,
    benchmarkSimilarity: 0.68,
    userSetMinimum: null,
    roundingIncrement: 1
  });
  assert.equal(m.kdFloorApplied, true);
  assert.equal(m.recommendedMinimum, 111);
});

test("computeTrialMinimum — user override only raises the floor", () => {
  const m = computeTrialMinimum({
    base: 100,
    marketP20: 60,
    marketP50: 80,
    trailing365dAdr: 90,
    benchmarkSimilarity: 1.0,
    userSetMinimum: 120, // raises above recommended
    roundingIncrement: 1
  });
  assert.equal(m.effectiveMinimum, 120, "user override raises");
  // And cannot LOWER the floor
  const m2 = computeTrialMinimum({
    base: 100,
    marketP20: 60,
    marketP50: 80,
    trailing365dAdr: 90,
    benchmarkSimilarity: 1.0,
    userSetMinimum: 50, // attempts to lower below recommended
    roundingIncrement: 1
  });
  assert.ok(m2.effectiveMinimum >= m2.recommendedMinimum);
});
