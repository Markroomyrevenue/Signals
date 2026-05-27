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
//   - target below peers → downside (floor=0.80 preserves weekday-below)
//   - own + KD both elevated → larger lift than either alone (blend pre-clamp)
//   - supply contraction + flat ADR → guard fires, lift damped to ADR-only
//   - missing both signals → 1.0, no NaN
// ---------------------------------------------------------------------------

test("computeDemandMultiplier — KD-only (2026-05-27 PM): adr_unbooked +25% → raw 1.25, no clamp", () => {
  // Post-consolidation: KD is the sole demand input at full pass-through
  // (KD_PASS_THROUGH=1.0). Own-pace removed. adr_unbooked +25% above
  // peer median → raw = 1 + 1.0 × 0.25 = 1.25 (well inside the 1.40
  // ceiling, well above the 0.80 floor).
  const result = computeDemandMultiplier({
    ownDelta: 0.20, // intentionally non-zero; must be IGNORED
    ownPeerSampleSize: 25,
    kdEffectiveDelta: 0.25,
    kdSupplyGuardTriggered: false,
    kdRevparDeltaRaw: 0.25,
    kdAdrDelta: 0.05,
    kdSupplyDelta: 0,
    kdPeerSampleSize: 25
  });
  assert.ok(Math.abs(result.multiplier - 1.25) < 0.001, `expected 1.25, got ${result.multiplier}`);
  assert.equal(result.dominantSignal, "kd");
  assert.equal(result.ceilingHit, false);
  assert.equal(result.floorHit, false);
  // KD-only path → ownWeight=0, kdWeight=1
  assert.equal(result.ownWeight, 0);
  assert.equal(result.kdWeight, 1);
});

test("computeDemandMultiplier — KD-only: target at peer baseline → 1.0", () => {
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

test("computeDemandMultiplier — KD +50% raw clamps at DEMAND_CEIL (1.40)", () => {
  // Full pass-through: raw = 1 + 1.0 × 0.50 = 1.50, clamped at 1.40.
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 0,
    kdEffectiveDelta: 0.50,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25
  });
  assert.equal(result.multiplier, 1.40);
  assert.equal(result.ceilingHit, true);
});

test("computeDemandMultiplier — KD -50% raw clamps at DEMAND_FLOOR (0.80)", () => {
  // Full pass-through downside: raw = 1 + 1.0 × -0.50 = 0.50, clamped
  // at 0.80. The outer artefact-guard floor still bounds single-cell
  // KD noise on the way down.
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 0,
    kdEffectiveDelta: -0.50,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25
  });
  assert.equal(result.multiplier, 0.80);
  assert.equal(result.floorHit, true);
  assert.equal(result.ceilingHit, false);
});

test("computeDemandMultiplier — own-pace IGNORED post-consolidation", () => {
  // The kdEffectiveDelta IS the entire demand signal. A strongly
  // negative ownDelta with neutral KD must produce multiplier 1.0 —
  // own-pace must not contaminate the result.
  const result = computeDemandMultiplier({
    ownDelta: -0.40, // strongly negative own-pace
    ownPeerSampleSize: 25,
    kdEffectiveDelta: 0, // KD neutral
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25
  });
  assert.equal(result.multiplier, 1.0, "own-pace must NOT pull the multiplier down");
  assert.equal(result.dominantSignal, "kd");
});

test("computeDemandMultiplier — KD null + own-pace -40% → still 1.0 (own-pace fully removed)", () => {
  // Stronger version of the previous test: even with KD null entirely,
  // own-pace must not push the multiplier off neutral. The own fields
  // remain on the opts shape for backward-compat but are dead code.
  const result = computeDemandMultiplier({
    ownDelta: -0.40,
    ownPeerSampleSize: 25,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0
  });
  assert.equal(result.multiplier, 1.0);
  assert.equal(result.dominantSignal, "none");
});

test("computeDemandMultiplier — supply-guard damping surfaces in reasoning when fired upstream", () => {
  // Supply guard is applied upstream in computeKdCrossSectionalDelta.
  // computeDemandMultiplier sees the already-damped kdEffectiveDelta
  // and should surface the SUPPLY-GUARD flag in the reasoning string.
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 0,
    kdEffectiveDelta: 0, // damped to zero upstream
    kdSupplyGuardTriggered: true,
    kdRevparDeltaRaw: 0.40, // raw adr_unbooked was big
    kdAdrDelta: 0.01,
    kdSupplyDelta: -0.30,
    kdPeerSampleSize: 25
  });
  assert.equal(result.multiplier, 1.0);
  assert.match(result.reasoning, /SUPPLY-GUARD damped/);
  assert.match(result.reasoning, /raw adr_unbookedΔ=40\.0%/);
});

test("computeDemandMultiplier — KD null + no calendar → neutral 1.0", () => {
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
  assert.match(result.reasoning, /no kd signal/);
});

// ---------------------------------------------------------------------------
// Phase C calendar-fallback (2026-05-24) — horizon handoff with NI holidays
// ---------------------------------------------------------------------------

test("computeDemandMultiplier — KD null + calendar holiday available → calendar takes over", () => {
  // KD signal null (gated out / fallback exhausted). Calendar delta =
  // +15% (Twelfth). The multiplier should reflect the calendar lift
  // via the same KD_PASS_THROUGH=1.0 + clamp pipeline.
  // raw = 1 + 1.0 × 0.15 = 1.15 (clean signal, full pass-through 2026-05-27 PM).
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 12,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0,
    calendarFallbackDelta: 0.15,
    calendarFallbackLabel: "Battle of the Boyne (NI) 2026"
  });
  assert.ok(Math.abs(result.multiplier - 1.15) < 0.001, `expected ~1.15, got ${result.multiplier}`);
  assert.equal(result.dominantSignal, "calendar");
  assert.equal(result.rawDemandDelta, 0.15);
  assert.match(result.reasoning, /calendar fallback "Battle of the Boyne/);
});

test("computeDemandMultiplier — KD has data → calendar IGNORED (no double-count)", () => {
  // KD signal active (+10%). A calendar value for the same cell must
  // NOT compound on top. Own-pace value is irrelevant post-consolidation.
  const kdOnly = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 0,
    kdEffectiveDelta: 0.10,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25
  });
  const kdWithCalendarPresent = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 0,
    kdEffectiveDelta: 0.10,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 25,
    calendarFallbackDelta: 0.20, // would compound to +30% if wrongly added
    calendarFallbackLabel: "Some Holiday"
  });
  assert.equal(kdOnly.multiplier, kdWithCalendarPresent.multiplier, "calendar must be ignored when KD has data");
  assert.equal(kdWithCalendarPresent.dominantSignal, "kd");
});

test("computeDemandMultiplier — KD null + no calendar → neutral 1.0", () => {
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
  // the underlying DEMAND_FLOOR. -25% calendar with full pass-through
  // (KD_PASS_THROUGH=1.0) → raw = 1 + 1.0 × -0.25 = 0.75 → clamped to
  // 0.80 floor. (Calendar delta tightened from -0.50 → -0.25 on
  // 2026-05-27 PM with the consolidation — at full pass-through, -0.25
  // now produces raw 0.75 which clamps; the prior -0.50 with 0.5
  // pass-through clamped at the same place.)
  const result = computeDemandMultiplier({
    ownDelta: null,
    ownPeerSampleSize: 12,
    kdEffectiveDelta: null,
    kdSupplyGuardTriggered: false,
    kdPeerSampleSize: 0,
    calendarFallbackDelta: -0.25, // -25% with full pass-through clamps at 0.80
    calendarFallbackLabel: "Christmas Day"
  });
  assert.equal(result.multiplier, 0.80);
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
// Events lever — 2026-05-27 PM consolidation
//
// The events lever was REMOVED from the trial chain on 2026-05-27 PM —
// `eventMult` is now a constant 1.0 regardless of `localEventAdjPct`.
// Per Mark's principle: if demand signals (adr_unbooked +
// booking-window corroborator) are strong enough, they should catch
// events organically; a manual lever contradicts the data-led
// principle and creates two sources of truth.
//
// The CAP-FLAGGING is decoupled and preserved — `localEventAdjPct`
// still selects the relaxed `EVENT_NIGHT_RATE_MULTIPLE` (5.0×) cap on
// event-flagged dates, so a data-led chain CAN price through to
// PL-grade peaks without the lever lifting the rate itself.
//
// The tests below pin:
//   - non-null adjPct → eventMult stays 1.0 (lever inert)
//   - non-null adjPct → 5.0× event-night cap still selected
//   - null adjPct → 4.0× normal cap, eventMult 1.0
//   - chain composes cleanly (no NaN) regardless of event-flag state
//   - `eventAdjustmentForDate` and `trial-events.ts` UNTOUCHED — the
//     production path still uses them.
// ---------------------------------------------------------------------------

test("events lever — adjustmentPct=40 does NOT lift the daily rate (lever removed 2026-05-27 PM)", () => {
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
  // Post-consolidation: events lever returns 1.0 regardless of
  // localEventAdjPct. Same rate on the event and non-event date with
  // otherwise-identical inputs.
  assert.equal(
    withEvent!.recommendedRate,
    noEvent!.recommendedRate,
    `expected same rate (events lever inert), got with-event=${withEvent!.recommendedRate} vs no-event=${noEvent!.recommendedRate}`
  );
  assert.equal(withEvent!.breakdown.events, 1.0);
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

test("events lever — event-flagged + hot demand stack composes cleanly and lands under 5.0× cap", () => {
  // Fleadh-class week with the event flag set AND a hot demand signal.
  // Post-consolidation: events lever is inert (1.0), but the event-
  // flag still selects the 5.0× cap so the demand-driven chain has
  // headroom to price through. Verifies the chain composes cleanly
  // (no NaN) and lands inside the relaxed cap.
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
  // Post-consolidation chain: base 150 × seas 1.3 × dow 1.10 × demand 1.40 (KD ceiling on hot kdEffectiveDelta) × occ 1.08 × event 1.0 (lever inert) × pace 1.0
  // = 150 × 1.3 × 1.10 × 1.4 × 1.08 × 1.0 = 324.5
  // Event-flagged night → relaxed clamp at base × 5.0 = 750. 324 < 750, no clamp.
  // The point of this test: chain composes cleanly with the event flag set
  // (which selects the 5.0× cap), and no NaN.
  assert.ok(Number.isFinite(result!.recommendedRate), "recommendedRate must be finite (no NaN)");
  assert.ok(result!.recommendedRate <= 750 + 0.01, `expected ≤ base×5.0=750, got ${result!.recommendedRate}`);
  assert.ok(result!.recommendedRate >= 320, `expected ~324 (chain product), got ${result!.recommendedRate}`);
  assert.equal(result!.breakdown.events, 1.0, "events lever inert post-2026-05-27-PM consolidation");
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

test("event-night clamp — event-flagged + hot data-led chain > 5.0× cap clamps at 750", () => {
  // Wildly hot fleadh-class night driven by data alone (events lever
  // inert post-2026-05-27 PM). Chain pushed past 5.0× cap by stacking
  // seasonality + DoW + demand to extreme values. Event flag selects
  // 5.0× cap. Verifies the relax still engages when the data-led chain
  // demands it.
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
  // Post-consolidation chain: base 150 × seas 1.50 × dow 1.40 × demand 1.40 (KD ceiling) × occ 1.08 × event 1.0 × pace 1.0
  // = 150 × 1.50 × 1.40 × 1.40 × 1.08 × 1.0 = 476.28
  // Event-flagged → 5.0× cap selected (750), but chain sits well under
  // it. Result = chain product (no clamp). Verifies the event flag
  // still propagates to cap selection even though the lever is inert.
  assert.ok(Number.isFinite(result!.recommendedRate));
  assert.ok(result!.recommendedRate <= 750 + 0.01, `expected ≤ base×5.0=750, got ${result!.recommendedRate}`);
  assert.ok(
    result!.recommendedRate >= 470 && result!.recommendedRate <= 500,
    `expected ~476 (chain product, no clamp), got ${result!.recommendedRate}`
  );
  // Result MUST be under the 4.0× non-event cap (600), proving the
  // 4.0× cap would NOT have bound either — but this is also what we'd
  // see if 5.0× wasn't selected. The structural pin below is what
  // proves the event-flag still picks 5.0×.
  assert.equal(result!.breakdown.events, 1.0, "events lever inert post-2026-05-27-PM consolidation");
});

test("event lever — adjustmentPct still propagates to event-cap selection (lever inert, cap-flag preserved)", () => {
  // Post-consolidation: localEventAdjPct no longer LIFTS the rate
  // (events lever is constant 1.0) but it IS still read by the cap-
  // selection logic so the relaxed 5.0× cap fires on event-flagged
  // dates. The TRIAL_EVENT_ADJUSTMENT_PCT_CAP (60%) cap in
  // trial-events.ts is now structurally moot for rate-lift but still
  // bounds what adjPct values can reach this function (defence-in-depth).
  // Here we pin: localEventAdjPct=60 means event-flagged (cap=5.0×),
  // but the rate is just the base-product, unmultiplied by the lever.
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
  // Post-consolidation chain: base 150 × seas 1.0 × dow 1.0 × demand 1.0 × occ 1.0 × event 1.0 (lever inert) = 150.
  // Well under base × 5.0 = 750 (event-flagged cap selected). Final = 150.
  assert.equal(result!.breakdown.events, 1.0, "events lever inert (was 1.6 pre-2026-05-27-PM)");
  assert.ok(Math.abs(result!.recommendedRate - 150) <= 1.01);
});

test("events lever — date outside event window (null adjPct) → same rate as inside; lever inert either way", () => {
  // Post-consolidation: the events lever is constant 1.0 regardless
  // of localEventAdjPct. inside-window and outside-window cells with
  // the same other inputs land at the same rate. The cap differs
  // (5.0× inside, 4.0× outside) but neither binds on a quiet
  // multiplier chain.
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
  // Both lever values are inert post-consolidation.
  assert.equal(outside!.breakdown.events, 1.0);
  assert.equal(inside!.breakdown.events, 1.0);
  // Rates identical (lever inert; cap differs but doesn't bind here).
  assert.equal(inside!.recommendedRate, outside!.recommendedRate);
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
