import assert from "node:assert/strict";
import test from "node:test";

import {
  HOLIDAY_DEFAULT_DELTA,
  HOLIDAY_DELTA_CAP,
  HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE,
  NI_HOLIDAY_PERIODS,
  resolveHolidayDelta,
  type HolidayDemandFactor,
  type HolidayDemandFactors
} from "./holiday-calendar";

// ---------------------------------------------------------------------------
// resolveHolidayDelta — pure per-cell lookup
// ---------------------------------------------------------------------------

function makeFactors(byDateEntries: Array<{ date: string; entry: { dateType: "twelfth" | "christmas_period" | "nye_period" | "summer_bank_hol"; delta: number; samples: number; fellBackToDefault: boolean; label: string } }>): HolidayDemandFactors {
  const byDate = new Map(byDateEntries.map((x) => [x.date, x.entry]));
  const byType = new Map<HolidayDemandFactor["dateType"], HolidayDemandFactor>();
  return { byDate, byType };
}

test("resolveHolidayDelta — holiday date inside a known window returns its delta", () => {
  const factors = makeFactors([
    {
      date: "2026-07-12",
      entry: { dateType: "twelfth", delta: 0.15, samples: 12, fellBackToDefault: false, label: "Battle of the Boyne (NI) 2026" }
    }
  ]);
  const hit = resolveHolidayDelta("2026-07-12", factors);
  assert.ok(hit !== null, "should resolve a holiday date");
  assert.equal(hit?.dateType, "twelfth");
  assert.equal(hit?.delta, 0.15);
  assert.equal(hit?.fellBackToDefault, false);
});

test("resolveHolidayDelta — ordinary far-future date returns null", () => {
  const factors = makeFactors([
    {
      date: "2026-12-25",
      entry: { dateType: "christmas_period", delta: 0.10, samples: 9, fellBackToDefault: false, label: "Christmas (NI) 2026" }
    }
  ]);
  const hit = resolveHolidayDelta("2026-12-01", factors); // not a holiday
  assert.equal(hit, null);
});

test("resolveHolidayDelta — thin-sample holiday still surfaces, with fellBackToDefault=true", () => {
  // A holiday where past history was too thin → the factor used
  // HOLIDAY_DEFAULT_DELTA instead of a learned value. The cell still
  // gets a small lift; the flag tells the report it was a default.
  const factors = makeFactors([
    {
      date: "2026-07-12",
      entry: { dateType: "twelfth", delta: HOLIDAY_DEFAULT_DELTA, samples: 3, fellBackToDefault: true, label: "Battle of the Boyne (NI) 2026" }
    }
  ]);
  const hit = resolveHolidayDelta("2026-07-12", factors);
  assert.ok(hit !== null);
  assert.equal(hit?.delta, HOLIDAY_DEFAULT_DELTA);
  assert.equal(hit?.fellBackToDefault, true);
});

// ---------------------------------------------------------------------------
// NI_HOLIDAY_PERIODS — sanity (date-window coverage)
// ---------------------------------------------------------------------------

test("NI_HOLIDAY_PERIODS — Twelfth, Christmas, NYE, Aug-bank-hol covered for 2026 (the trial primary year)", () => {
  const dateTypes2026 = NI_HOLIDAY_PERIODS.filter((p) => p.startIso.startsWith("2026") || p.endIso.startsWith("2026")).map((p) => p.dateType);
  assert.ok(dateTypes2026.includes("twelfth"), "must cover Twelfth 2026");
  assert.ok(dateTypes2026.includes("christmas_period"), "must cover Christmas 2026");
  assert.ok(dateTypes2026.includes("nye_period"), "must cover NYE 2026-2027");
  assert.ok(dateTypes2026.includes("summer_bank_hol"), "must cover August bank holiday 2026");
});

test("NI_HOLIDAY_PERIODS — each window has start <= end", () => {
  for (const p of NI_HOLIDAY_PERIODS) {
    assert.ok(p.startIso <= p.endIso, `${p.label}: start ${p.startIso} > end ${p.endIso}`);
  }
});

test("NI_HOLIDAY_PERIODS — past-2-occurrences guarantee for the primary 2026 date-types (so learning has data)", () => {
  // Counted across the static config: each annual date-type that
  // matters in 2026 has at least one 2024 + one 2025 occurrence
  // available for learning. This is the precondition for `samples`
  // to plausibly exceed HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE.
  for (const dt of ["twelfth", "christmas_period", "nye_period", "summer_bank_hol"] as const) {
    const count = NI_HOLIDAY_PERIODS.filter((p) => p.dateType === dt && (p.startIso.startsWith("2024") || p.startIso.startsWith("2025"))).length;
    assert.ok(count >= 2, `${dt}: need >=2 past occurrences (2024/2025), found ${count}`);
  }
});

// ---------------------------------------------------------------------------
// Cap + sample-floor constants
// ---------------------------------------------------------------------------

test("HOLIDAY_DELTA_CAP is modest (not Fleadh-scale)", () => {
  // Fleadh cap is 0.60 (60%). Holidays must be substantially smaller.
  assert.ok(HOLIDAY_DELTA_CAP <= 0.30, `HOLIDAY_DELTA_CAP=${HOLIDAY_DELTA_CAP} too large — would compete with Fleadh-scale events`);
  assert.ok(HOLIDAY_DELTA_CAP >= 0.10, `HOLIDAY_DELTA_CAP=${HOLIDAY_DELTA_CAP} too small to matter`);
});

test("HOLIDAY_DEFAULT_DELTA is a modest positive lift, well under the cap", () => {
  assert.ok(HOLIDAY_DEFAULT_DELTA > 0, "default should be a small positive lift");
  assert.ok(HOLIDAY_DEFAULT_DELTA <= HOLIDAY_DELTA_CAP);
});

test("HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE is large enough that single-occurrence noise can't drive a learned delta", () => {
  // With 730 days of history = 2 past occurrences typically. Each
  // occurrence has ~3 days × 10-25 listings = 30-75 potential sold
  // nights. We want at least ~half a typical occurrence in the
  // sample before trusting the learned number.
  assert.ok(HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE >= 5);
  assert.ok(HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE <= 30);
});
