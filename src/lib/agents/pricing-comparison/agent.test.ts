import assert from "node:assert/strict";
import test from "node:test";

import { shouldIncludeCalendarCell } from "./agent";

// ---------------------------------------------------------------------------
// Available-nights filter (2026-05-22) — restrict the trial comparison
// to nights the listing is actually bookable.
//
// The trial comparison agent scores our recommended rate against the
// Hostaway calendar rate per (listing × forward date × 270d). Before
// 2026-05-22 it scored every cell regardless of whether the listing
// was available — a blocked night carries a stale placeholder rate
// that becomes pure noise in tenant means / band stats / KPI / per-
// listing aggregates. The filter excludes:
//   - missing calendar row for (listing, date)
//   - available === false (calendar shows blocked)
//   - available === true but rate null/zero (no PL comparable)
// and INCLUDES only available + rate > 0.
//
// The whole behavioural contract is in `shouldIncludeCalendarCell`;
// the inline agent loop just increments `unavailableCellsExcluded`
// when the predicate is false and `continue`s.
// ---------------------------------------------------------------------------

test("availability filter — available cell with rate is INCLUDED for scoring", () => {
  assert.equal(shouldIncludeCalendarCell({ available: true, rate: 150 }), true);
});

test("availability filter — available cell with positive rate is included even at low rate", () => {
  // Floor: any positive rate counts. The classifier handles the comparison.
  assert.equal(shouldIncludeCalendarCell({ available: true, rate: 50 }), true);
});

test("availability filter — blocked cell (available=false) is EXCLUDED even with a rate", () => {
  // The LF worst-5 spot-check showed blocked Fleadh nights still carry
  // PL placeholder rates (£326-£713). Excluding by `available` directly
  // is what stops that noise hitting the aggregates.
  assert.equal(shouldIncludeCalendarCell({ available: false, rate: 700 }), false);
});

test("availability filter — available cell with null rate is EXCLUDED (no PL comparable)", () => {
  // We can't score against `null`; classify as "unavailable for comparison"
  // and exclude. The summary's `noHostawayRate` field is therefore zero
  // by construction; this case is folded into `unavailableCellsExcluded`.
  assert.equal(shouldIncludeCalendarCell({ available: true, rate: null }), false);
});

test("availability filter — null cell (no calendar row) is EXCLUDED", () => {
  assert.equal(shouldIncludeCalendarCell(null), false);
  assert.equal(shouldIncludeCalendarCell(undefined), false);
});
