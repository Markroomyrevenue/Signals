import assert from "node:assert/strict";
import test from "node:test";

import { computeRateCopyByDateFromRows } from "./rate-copy";

const BASE_PARAMS = {
  occupancyByDate: null,
  multiUnitMatrix: null,
  targetDefaultMinStay: 2,
  targetUserMin: 45,
  overrides: [],
  roundingIncrement: 1,
  todayDateOnly: "2026-07-07"
};

test("a booked source date with a rate still produces a pushable rate", () => {
  // Fully-booked dates must keep copying the source's live rate: if a booking
  // cancels, the night re-opens at today's price, not a stale one.
  const out = computeRateCopyByDateFromRows({
    ...BASE_PARAMS,
    sourceRates: [{ date: "2026-08-08", rate: 216, available: false }]
  });
  const entry = out.get("2026-08-08");
  assert.ok(entry && !("skipReason" in entry), "expected a rate, not a skip");
  assert.equal(entry.rate, 216);
});

test("a source date with no rate is skipped as no_source_rate", () => {
  const out = computeRateCopyByDateFromRows({
    ...BASE_PARAMS,
    sourceRates: [
      { date: "2026-08-08", rate: null, available: true },
      { date: "2026-08-09", rate: 0, available: true }
    ]
  });
  for (const date of ["2026-08-08", "2026-08-09"]) {
    const entry = out.get(date);
    assert.ok(entry && "skipReason" in entry && entry.skipReason === "no_source_rate");
  }
});

test("copied rate is floored at the user min", () => {
  const out = computeRateCopyByDateFromRows({
    ...BASE_PARAMS,
    sourceRates: [{ date: "2026-08-10", rate: 30, available: false }]
  });
  const entry = out.get("2026-08-10");
  assert.ok(entry && !("skipReason" in entry));
  assert.equal(entry.rate, 45);
  assert.equal(entry.flooredAtMin, true);
});
