import assert from "node:assert/strict";
import test from "node:test";

import { defaultMultiUnitOccupancyLeadTimeMatrix } from "./settings";
import {
  buildMultiUnitRecommendedBase,
  lookupMultiUnitOccupancyLeadTimeAdjustmentPct
} from "./multi-unit-anchor";

const matrix = defaultMultiUnitOccupancyLeadTimeMatrix();

test("matrix lookup: 65% occ + 45-day lead → row 70% × bucket 60d → -2", () => {
  // 65% occupancy → row whose occupancyMaxPct is the smallest >= 65 = 70.
  // 45-day lead → bucket is the smallest >= 45 = 60.
  // The 70/60 cell in the seeded matrix is -2.
  const result = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
    matrix,
    occupancyPct: 65,
    leadTimeDays: 45
  });
  assert.equal(result, -2);
});

test("matrix lookup: 90% occ + 100-day lead → row 90% × bucket 120d → +15", () => {
  const result = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
    matrix,
    occupancyPct: 90,
    leadTimeDays: 100
  });
  assert.equal(result, 15);
});

test("matrix lookup: 0% occ + 5-day lead → row 10% × bucket 14d → -15", () => {
  const result = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
    matrix,
    occupancyPct: 0,
    leadTimeDays: 5
  });
  assert.equal(result, -15);
});

test("matrix lookup: carry-on-edge for occupancies above 100", () => {
  const high = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
    matrix,
    occupancyPct: 999,
    leadTimeDays: 100
  });
  // Clamped to 100 → row 100 → bucket 120 = 20.
  assert.equal(high, 20);
});

test("matrix lookup: carry-on-edge for lead times above the largest bucket", () => {
  // Seeded buckets top out at 180. Lead 300 days should use the 180 bucket.
  const result = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
    matrix,
    occupancyPct: 50,
    leadTimeDays: 300
  });
  // Row 50 / bucket 180 = +10.
  assert.equal(result, 10);
});

test("matrix lookup: an occupancy of exactly the row max stays in that row", () => {
  // 70% must hit row 70 (smallest occupancyMaxPct >= 70), not row 80.
  const result = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
    matrix,
    occupancyPct: 70,
    leadTimeDays: 14
  });
  // Row 70 / bucket 14 = -5.
  assert.equal(result, -5);
});

test("matrix lookup: NaN / negative inputs degrade gracefully", () => {
  const negativeOcc = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
    matrix,
    occupancyPct: Number.NaN,
    leadTimeDays: -10
  });
  // NaN → 0, negative lead → 0 → smallest bucket (14) of row 10 = -15.
  assert.equal(negativeOcc, -15);
});

test("matrix lookup: returns 0 for empty matrix", () => {
  const result = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
    matrix: { leadTimeBuckets: [], rows: [] },
    occupancyPct: 50,
    leadTimeDays: 50
  });
  assert.equal(result, 0);
});

test("buildMultiUnitRecommendedBase: full blend with peer-set ADR present", () => {
  // market 200, trailing 220, peer 210, size 180.
  // weights: 0.30 + 0.30 + 0.25 + 0.15 = 1.0
  // weighted = 200*0.30 + 220*0.30 + 210*0.25 + 180*0.15
  //         = 60 + 66 + 52.5 + 27 = 205.5
  const { finalRecommendedBasePrice } = buildMultiUnitRecommendedBase({
    marketBenchmarkBasePrice: 200,
    trailing365dAdr: 220,
    peerSetAdr: 210,
    sizeAnchor: 180,
    qualityMultiplier: 1,
    roundingIncrement: 1
  });
  // increment=1 = no integer rounding (matches market-anchor convention).
  assert.equal(finalRecommendedBasePrice, 205.5);
});

test("buildMultiUnitRecommendedBase: reweighted blend when peer-set is null", () => {
  // peerSetAdr null → market 0.40, trailing 0.40, size 0.20 (size still
  // present). With market 200, trailing 220, size 180:
  // weighted = 200*0.40 + 220*0.40 + 180*0.20 = 80 + 88 + 36 = 204.
  const { finalRecommendedBasePrice } = buildMultiUnitRecommendedBase({
    marketBenchmarkBasePrice: 200,
    trailing365dAdr: 220,
    peerSetAdr: null,
    sizeAnchor: 180,
    qualityMultiplier: 1,
    roundingIncrement: 1
  });
  assert.equal(finalRecommendedBasePrice, 204);
});

test("buildMultiUnitRecommendedBase: applies quality multiplier", () => {
  // upscale × 1.10 should bump 200 → 220.
  const { finalRecommendedBasePrice } = buildMultiUnitRecommendedBase({
    marketBenchmarkBasePrice: 200,
    trailing365dAdr: 200,
    peerSetAdr: 200,
    sizeAnchor: 200,
    qualityMultiplier: 1.1,
    roundingIncrement: 1
  });
  assert.equal(finalRecommendedBasePrice, 220);
});

test("buildMultiUnitRecommendedBase: returns null when every anchor is missing", () => {
  const { finalRecommendedBasePrice } = buildMultiUnitRecommendedBase({
    marketBenchmarkBasePrice: null,
    trailing365dAdr: null,
    peerSetAdr: null,
    sizeAnchor: null
  });
  assert.equal(finalRecommendedBasePrice, null);
});

test("buildMultiUnitRecommendedBase: respects rounding increment", () => {
  const { finalRecommendedBasePrice } = buildMultiUnitRecommendedBase({
    marketBenchmarkBasePrice: 198.4,
    trailing365dAdr: 198.4,
    peerSetAdr: null,
    sizeAnchor: null,
    qualityMultiplier: 1,
    roundingIncrement: 5
  });
  // 198.4 → blend stays 198.4 → rounded to nearest 5 → 200.
  assert.equal(finalRecommendedBasePrice, 200);
});
