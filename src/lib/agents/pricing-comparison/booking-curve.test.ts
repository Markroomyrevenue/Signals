import assert from "node:assert/strict";
import test from "node:test";

import {
  computePaceDelta,
  CURVE_LEAD_TIMES,
  CURVE_LOW_VALUE_GUARD,
  CURVE_MIN_GROUP_SIZE,
  CURVE_MIN_OBSERVATIONS_PER_LEAD,
  lookupCurveValue,
  resolveBookingCurveForListing,
  resolvePaceDelta,
  type BookingCurve,
  type BookingCurves,
  type GrainForwardFill
} from "./booking-curve";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCurve(args: { grain: string; values: Array<{ lead: number; fill: number; obs?: number }>; listingIds?: string[] }): BookingCurve {
  const values = new Map<number, number>();
  const observations = new Map<number, number>();
  for (const v of args.values) {
    values.set(v.lead, v.fill);
    observations.set(v.lead, v.obs ?? 1000);
  }
  return {
    values,
    observations,
    grain: args.grain,
    listingCount: args.listingIds?.length ?? 5,
    listingIds: args.listingIds ?? ["L1", "L2", "L3", "L4", "L5"]
  };
}

function tenantCurve(): BookingCurve {
  return makeCurve({
    grain: "tenant:T1",
    values: [
      { lead: 0, fill: 0.83 },
      { lead: 28, fill: 0.57 },
      { lead: 84, fill: 0.30 },
      { lead: 126, fill: 0.18 },
      { lead: 238, fill: 0.08 }
    ],
    listingIds: Array.from({ length: 40 }, (_, i) => `T1L${i}`)
  });
}

function groupCurve(): BookingCurve {
  return makeCurve({
    grain: "group:Castle Buildings",
    values: [
      { lead: 0, fill: 0.86 },
      { lead: 28, fill: 0.55 },
      { lead: 84, fill: 0.27 },
      { lead: 126, fill: 0.13 },
      { lead: 238, fill: 0.05 }
    ],
    listingIds: ["CB1", "CB2", "CB3", "CB4", "CB5", "CB6", "CB7", "CB8", "CB9"]
  });
}

// ---------------------------------------------------------------------------
// Curve constants — spec contract pins
// ---------------------------------------------------------------------------

test("CURVE_LEAD_TIMES covers 0..238d with anchors at the standard checkpoints", () => {
  assert.equal(CURVE_LEAD_TIMES[0], 0);
  assert.equal(CURVE_LEAD_TIMES[CURVE_LEAD_TIMES.length - 1], 238);
  // Includes 14, 28, 56 — the gates and bucket boundaries the downstream uses.
  assert.ok(CURVE_LEAD_TIMES.includes(14));
  assert.ok(CURVE_LEAD_TIMES.includes(28));
  assert.ok(CURVE_LEAD_TIMES.includes(56));
});

test("CURVE_LOW_VALUE_GUARD is in the meaningful range — per spec", () => {
  // Mark's checkpoint (2026-05-26 PM): the unstable-ratio depth needs
  // to be high enough that 91-180d cells (LF curve 14-20%) fall back
  // to neutral instead of inflating demand. Set to 0.15. Must stay
  // bounded so 0-90d cells (curve 30-83%) still get a live signal.
  assert.ok(CURVE_LOW_VALUE_GUARD > 0.05 && CURVE_LOW_VALUE_GUARD <= 0.25);
});

test("group-curve thresholds keep building grain from firing on thin data", () => {
  // Need at least 3 listings AND 500 obs per lead before a group: tag
  // gets its own curve. Below either: tenant fallback.
  assert.ok(CURVE_MIN_GROUP_SIZE >= 3);
  assert.ok(CURVE_MIN_OBSERVATIONS_PER_LEAD >= 100);
});

// ---------------------------------------------------------------------------
// lookupCurveValue — linear interpolation + clamping
// ---------------------------------------------------------------------------

test("lookupCurveValue — exact anchor returns the anchor value", () => {
  const c = tenantCurve();
  assert.equal(lookupCurveValue(c, 0), 0.83);
  assert.equal(lookupCurveValue(c, 28), 0.57);
  assert.equal(lookupCurveValue(c, 126), 0.18);
});

test("lookupCurveValue — between anchors linearly interpolates", () => {
  const c = tenantCurve();
  // Halfway between 0 (0.83) and 28 (0.57): (0.83 + 0.57) / 2 = 0.70
  assert.ok(Math.abs(lookupCurveValue(c, 14) - 0.70) < 0.001);
  // Between 28 (0.57) and 84 (0.30): 56d = halfway. (0.57 + 0.30) / 2 = 0.435
  assert.ok(Math.abs(lookupCurveValue(c, 56) - 0.435) < 0.001);
});

test("lookupCurveValue — clamps below smallest and above largest anchor", () => {
  const c = tenantCurve();
  assert.equal(lookupCurveValue(c, -5), 0.83); // below smallest → smallest value
  assert.equal(lookupCurveValue(c, 500), 0.08); // beyond largest → largest value
});

// ---------------------------------------------------------------------------
// computePaceDelta — low-curve guard contract
// ---------------------------------------------------------------------------

test("computePaceDelta — actual above curve → positive (ahead of pace)", () => {
  const r = computePaceDelta({ actualFill: 0.80, curveValue: 0.50 });
  assert.ok(r.delta !== null);
  assert.ok(r.delta! > 0);
  // (0.80 - 0.50) / 0.50 = 0.60 → +60%
  assert.ok(Math.abs(r.delta! - 0.60) < 0.001);
  assert.equal(r.guardFired, false);
});

test("computePaceDelta — actual below curve → negative (behind pace)", () => {
  const r = computePaceDelta({ actualFill: 0.30, curveValue: 0.50 });
  assert.ok(r.delta !== null);
  assert.ok(r.delta! < 0);
  // (0.30 - 0.50) / 0.50 = -0.40 → -40%
  assert.ok(Math.abs(r.delta! - -0.40) < 0.001);
});

test("computePaceDelta — curve value below low-curve guard → null + guardFired (the deep-far-future fix)", () => {
  // Spec: "where the curve value is very low (deep far-future), the
  // pace ratio is unstable — fall back to neutral 1.0."
  // 0.03 (3%) is below the 5% guard.
  const r = computePaceDelta({ actualFill: 0.20, curveValue: 0.03 });
  assert.equal(r.delta, null);
  assert.equal(r.guardFired, true);
});

test("computePaceDelta — non-finite input → null without NaN", () => {
  const r1 = computePaceDelta({ actualFill: Number.NaN, curveValue: 0.50 });
  assert.equal(r1.delta, null);
  const r2 = computePaceDelta({ actualFill: 0.50, curveValue: Number.NaN });
  assert.equal(r2.delta, null);
});

// ---------------------------------------------------------------------------
// resolveBookingCurveForListing — most-specific group wins; tenant fallback
// ---------------------------------------------------------------------------

test("resolveBookingCurveForListing — listing with a group: tag whose curve exists returns the group curve", () => {
  const curves: BookingCurves = {
    tenantCurves: new Map([["T1", tenantCurve()]]),
    groupCurves: new Map([["group:Castle Buildings", groupCurve()]])
  };
  const r = resolveBookingCurveForListing({
    tenantId: "T1",
    tags: ["group:Castle Buildings", "Adam"],
    curves
  });
  assert.ok(r !== null);
  assert.equal(r!.grain, "group:Castle Buildings");
});

test("resolveBookingCurveForListing — multiple group tags picks the MOST SPECIFIC (smallest listingCount)", () => {
  const broaderGroup = makeCurve({
    grain: "group:CB + Templemore",
    values: [{ lead: 28, fill: 0.50 }],
    listingIds: ["CB1", "CB2", "CB3", "CB4", "CB5", "CB6", "CB7", "CB8", "CB9", "T1", "T2", "T3"]
  });
  const curves: BookingCurves = {
    tenantCurves: new Map([["T1", tenantCurve()]]),
    groupCurves: new Map([
      ["group:Castle Buildings", groupCurve()],       // 9 listings
      ["group:CB + Templemore", broaderGroup]         // 12 listings
    ])
  };
  // A CB-1 listing has BOTH tags. Should pick the smaller (Castle Buildings).
  const r = resolveBookingCurveForListing({
    tenantId: "T1",
    tags: ["group:Castle Buildings", "group:CB + Templemore"],
    curves
  });
  assert.equal(r!.grain, "group:Castle Buildings");
  assert.equal(r!.listingCount, 9);
});

test("resolveBookingCurveForListing — listing with no group: tag falls back to tenant curve", () => {
  const curves: BookingCurves = {
    tenantCurves: new Map([["T1", tenantCurve()]]),
    groupCurves: new Map([["group:Castle Buildings", groupCurve()]])
  };
  const r = resolveBookingCurveForListing({
    tenantId: "T1",
    tags: ["Fitzrovia", "Live November 2024"], // no group: tag
    curves
  });
  assert.equal(r!.grain, "tenant:T1");
});

test("resolveBookingCurveForListing — listing with a group: tag that didn't make a curve (thin) falls back to tenant", () => {
  const curves: BookingCurves = {
    tenantCurves: new Map([["T1", tenantCurve()]]),
    groupCurves: new Map() // group curve below threshold → not built
  };
  const r = resolveBookingCurveForListing({
    tenantId: "T1",
    tags: ["group:SomeThinCluster"],
    curves
  });
  assert.equal(r!.grain, "tenant:T1");
});

// ---------------------------------------------------------------------------
// resolvePaceDelta — the per-cell wrapper the agent calls
// ---------------------------------------------------------------------------

test("resolvePaceDelta — building-grain pace catches an event the tenant signal would miss", () => {
  // The Castle Buildings late-June scenario from the Phase A worked
  // sample. 7/9 CB listings booked at 28d out; CB curve at 28d = 55%.
  // Pace_delta = (7/9 − 0.55) / 0.55 ≈ +0.41 (caught the event).
  // Tenant curve at 28d = 57% → if we (wrongly) compared CB fill to
  // tenant curve, we'd get +37% — still ahead, but smaller.
  const grainFill: GrainForwardFill = {
    grain: "group:Castle Buildings",
    byDate: new Map([["2026-06-24", { booked: 7, total: 9, fill: 7 / 9 }]])
  };
  const r = resolvePaceDelta({
    curve: groupCurve(),
    grainFill,
    targetIso: "2026-06-24",
    asOfIso: "2026-05-27" // 28 days before target
  });
  assert.ok(r.delta !== null && r.delta! > 0.40, `expected +>40% pace, got ${r.delta}`);
  assert.equal(r.guardFired, false);
});

test("resolvePaceDelta — far-future cell (curve below guard) returns null + guardFired", () => {
  // Set the far anchor low enough that 228d interpolation falls BELOW
  // the 5% guard. Linear between (0d, 0.80) and (238d, 0.01) at 228d
  // = 0.80 + (-0.79 × 228/238) ≈ 0.044 < 0.05 → guard fires.
  const tightCurve = makeCurve({
    grain: "group:X",
    values: [
      { lead: 0, fill: 0.80 },
      { lead: 238, fill: 0.01 }
    ]
  });
  const grainFill: GrainForwardFill = {
    grain: "group:X",
    byDate: new Map([["2027-01-10", { booked: 1, total: 10, fill: 0.10 }]])
  };
  const r = resolvePaceDelta({
    curve: tightCurve,
    grainFill,
    targetIso: "2027-01-10",
    asOfIso: "2026-05-27" // ~228d ahead
  });
  assert.equal(r.delta, null);
  assert.equal(r.guardFired, true);
});

test("resolvePaceDelta — null curve OR null grain fill → all-null output, no NaN", () => {
  const r1 = resolvePaceDelta({
    curve: null,
    grainFill: { grain: "x", byDate: new Map() },
    targetIso: "2026-06-24",
    asOfIso: "2026-05-27"
  });
  assert.equal(r1.delta, null);
  assert.equal(r1.actualFill, null);

  const r2 = resolvePaceDelta({
    curve: tenantCurve(),
    grainFill: null,
    targetIso: "2026-06-24",
    asOfIso: "2026-05-27"
  });
  assert.equal(r2.delta, null);
  assert.equal(r2.actualFill, null);
});

test("resolvePaceDelta — missing date in grain fill → null without NaN (forward window beyond the loaded range)", () => {
  const grainFill: GrainForwardFill = {
    grain: "tenant:T1",
    byDate: new Map([["2026-06-24", { booked: 7, total: 9, fill: 7 / 9 }]])
  };
  const r = resolvePaceDelta({
    curve: tenantCurve(),
    grainFill,
    targetIso: "2026-06-30", // not loaded
    asOfIso: "2026-05-27"
  });
  assert.equal(r.delta, null);
  assert.equal(r.actualFill, null);
});

// ---------------------------------------------------------------------------
// No double-count contract (between demand and occupancy)
// ---------------------------------------------------------------------------

test("no double-count: occupancy gate (14d) sits inside the demand lead-time range, but the multipliers measure different things", () => {
  // Demand at near-term reads grain pace (date-level signal).
  // Occupancy at near-term reads per-listing remaining fill (listing
  // signal). Both fire on the same cell at lead ≤14d but they have
  // distinct domains — no structural double-count.
  // The test asserts the contract MEMBERSHIP: occupancy threshold is
  // BELOW the demand-relevant lead-time range so the overlap is bounded.
  const { OCCUPANCY_NEAR_TERM_LEAD_DAYS } = require("./near-term-occupancy");
  assert.ok(OCCUPANCY_NEAR_TERM_LEAD_DAYS <= 21, "occupancy gate must stay in 'near check-in' range");
  assert.ok(OCCUPANCY_NEAR_TERM_LEAD_DAYS >= 7, "occupancy gate must capture the genuine remaining-inventory window");
});
