import assert from "node:assert/strict";
import test from "node:test";

import { selectChangedRates } from "./rate-copy-push-service";

test("Fix 3: delta filter keeps only dates whose price or min-stay changed", () => {
  const rates = [
    { date: "2026-07-01", dailyPrice: 60, minStay: 2 },
    { date: "2026-07-02", dailyPrice: 65, minStay: 2 }, // price changed
    { date: "2026-07-03", dailyPrice: 70, minStay: 3 }, // min-stay changed
    { date: "2026-07-04", dailyPrice: 80, minStay: 2 } // unchanged
  ];
  const last = new Map([
    ["2026-07-01", { dailyPrice: 60, minStay: 2 }],
    ["2026-07-02", { dailyPrice: 60, minStay: 2 }],
    ["2026-07-03", { dailyPrice: 70, minStay: 2 }],
    ["2026-07-04", { dailyPrice: 80, minStay: 2 }]
  ]);
  const changed = selectChangedRates(rates, last);
  assert.deepEqual(
    changed.map((r) => r.date),
    ["2026-07-02", "2026-07-03"]
  );
});

test("Fix 3: a date with no push history is treated as changed (pushed)", () => {
  const rates = [{ date: "2026-07-05", dailyPrice: 90, minStay: 2 }];
  const changed = selectChangedRates(rates, new Map());
  assert.equal(changed.length, 1);
});

test("Fix 3: identical calendar produces zero pushes", () => {
  const rates = [
    { date: "2026-07-01", dailyPrice: 60, minStay: 2 },
    { date: "2026-07-02", dailyPrice: 65, minStay: 2 }
  ];
  const last = new Map([
    ["2026-07-01", { dailyPrice: 60, minStay: 2 }],
    ["2026-07-02", { dailyPrice: 65, minStay: 2 }]
  ]);
  assert.equal(selectChangedRates(rates, last).length, 0);
});

test("Fix 3: null vs set min-stay is a change", () => {
  const rates = [{ date: "2026-07-01", dailyPrice: 60, minStay: null }];
  const last = new Map([["2026-07-01", { dailyPrice: 60, minStay: 2 }]]);
  assert.equal(selectChangedRates(rates, last).length, 1);
});
