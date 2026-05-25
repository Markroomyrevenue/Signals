import assert from "node:assert/strict";
import test from "node:test";

import { classifyAgreementBands, shouldIncludeCalendarCell } from "./agent";

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

// ---------------------------------------------------------------------------
// Banded agreement distribution (2026-05-25 spec)
// ---------------------------------------------------------------------------

test("classifyAgreementBands — empty input → all zero", () => {
  const bands = classifyAgreementBands([]);
  assert.equal(bands.count, 0);
  assert.equal(bands.within10, 0);
  assert.equal(bands.within25, 0);
  assert.equal(bands.beyond25, 0);
  assert.equal(bands.beyond50, 0);
});

test("classifyAgreementBands — within bands are CUMULATIVE (a cell at 7% counts toward all four within buckets)", () => {
  const bands = classifyAgreementBands([0.07, 0.07, 0.07]);
  assert.equal(bands.within10, 3);
  assert.equal(bands.within15, 3);
  assert.equal(bands.within20, 3);
  assert.equal(bands.within25, 3);
  assert.equal(bands.beyond25, 0);
  assert.equal(bands.beyond50, 0);
});

test("classifyAgreementBands — beyond bands are STRICT TAILS (a cell at 30% is beyond25 NOT beyond50)", () => {
  const bands = classifyAgreementBands([0.30, 0.40, 0.60, 0.80]);
  assert.equal(bands.within10, 0);
  assert.equal(bands.within25, 0);
  // 0.30 and 0.40 → beyond25 (4 of them total: all 4 are > 0.25)
  assert.equal(bands.beyond25, 4);
  // 0.60 and 0.80 → beyond50 (strict, > 0.50)
  assert.equal(bands.beyond50, 2);
});

test("classifyAgreementBands — boundary at exactly 0.10 → counted as within10 (inclusive)", () => {
  const bands = classifyAgreementBands([0.10, 0.15, 0.20, 0.25]);
  // All four boundary values fall in their respective within bands
  // (inclusive ≤ check).
  assert.equal(bands.within10, 1, "0.10 → within10");
  assert.equal(bands.within15, 2, "0.10 + 0.15 → within15");
  assert.equal(bands.within20, 3, "+0.20");
  assert.equal(bands.within25, 4, "+0.25");
  // Nothing strictly above 0.25 → beyond25 = 0.
  assert.equal(bands.beyond25, 0);
});

test("classifyAgreementBands — invalid values (NaN, negative) are silently skipped", () => {
  const bands = classifyAgreementBands([0.05, Number.NaN, -0.10, 0.30]);
  assert.equal(bands.within10, 1, "only 0.05 is a valid within10");
  assert.equal(bands.beyond25, 1, "only 0.30 is a valid beyond25");
});

test("classifyAgreementBands — complementary identity: within25 + beyond25 = count (every valid cell lands in exactly one of the two)", () => {
  const deltas = [0.05, 0.12, 0.18, 0.23, 0.27, 0.51, 0.95];
  const bands = classifyAgreementBands(deltas);
  assert.equal(bands.within25 + bands.beyond25, deltas.length);
});
