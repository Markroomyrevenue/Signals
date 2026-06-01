import assert from "node:assert/strict";
import test from "node:test";

import { computeMedian, yearlyAdrMedianFromNightlyRates } from "./baseline";
import { MIN_NIGHTS_FOR_BASELINE } from "./config";

test("computeMedian returns null on an empty list", () => {
  assert.equal(computeMedian([]), null);
});

test("computeMedian handles a single value", () => {
  assert.equal(computeMedian([42]), 42);
});

test("computeMedian on an odd-length list returns the middle value (order-independent)", () => {
  assert.equal(computeMedian([3, 1, 2]), 2);
});

test("computeMedian on an even-length list averages the two middle values", () => {
  assert.equal(computeMedian([1, 2, 3, 4]), 2.5);
});

test("yearlyAdrMedianFromNightlyRates returns null below the min-nights threshold", () => {
  const tooFew = Array.from({ length: MIN_NIGHTS_FOR_BASELINE - 1 }, (_, i) => 100 + i);
  assert.equal(yearlyAdrMedianFromNightlyRates(tooFew), null);
});

test("yearlyAdrMedianFromNightlyRates returns the median at exactly the threshold", () => {
  const justEnough = Array.from({ length: MIN_NIGHTS_FOR_BASELINE }, () => 100);
  assert.equal(yearlyAdrMedianFromNightlyRates(justEnough), 100);
});

test("yearlyAdrMedianFromNightlyRates filters non-finite and non-positive rates before counting", () => {
  // Five usable values [100,200,300,400,500] plus dust that must be dropped.
  const values = [100, 200, 300, 400, 500, 0, -10, Number.NaN, Number.POSITIVE_INFINITY];
  assert.equal(yearlyAdrMedianFromNightlyRates(values), 300);
});

test("yearlyAdrMedianFromNightlyRates returns null when too few usable values survive filtering", () => {
  // Only three positive finite values — below the threshold once dust is removed.
  const values = [100, 200, 300, 0, -1, Number.NaN];
  assert.equal(yearlyAdrMedianFromNightlyRates(values), null);
});
