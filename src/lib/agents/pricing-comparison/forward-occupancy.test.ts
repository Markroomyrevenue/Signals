import assert from "node:assert/strict";
import test from "node:test";

import {
  FORWARD_OCC_WINDOW,
  resolveForwardOccupancy,
  type ForwardOccupancyMap
} from "./forward-occupancy";

// ---------------------------------------------------------------------------
// resolveForwardOccupancy — pure per-cell lookup
// ---------------------------------------------------------------------------

function makeMap(entries: Array<{ listingId: string; monthKey: string; occ: number | null }>): ForwardOccupancyMap {
  const out: ForwardOccupancyMap = new Map();
  for (const e of entries) {
    let inner = out.get(e.listingId);
    if (!inner) {
      inner = new Map();
      out.set(e.listingId, inner);
    }
    inner.set(e.monthKey, e.occ);
  }
  return out;
}

test("FORWARD_OCC_WINDOW constant is the calendar-month window (per spec)", () => {
  // Pinned to keep the spec contract visible: window = target's
  // calendar month. The BUILD-LOG entry refers to this constant.
  assert.equal(FORWARD_OCC_WINDOW, "calendar-month");
});

test("resolveForwardOccupancy — returns the per-month value for the target's calendar month", () => {
  const map = makeMap([
    { listingId: "L1", monthKey: "2026-08", occ: 0.85 },
    { listingId: "L1", monthKey: "2026-09", occ: 0.42 }
  ]);
  // Target inside August → August's value.
  assert.equal(resolveForwardOccupancy(map, "L1", "2026-08-15"), 0.85);
  // First day of August → still August.
  assert.equal(resolveForwardOccupancy(map, "L1", "2026-08-01"), 0.85);
  // Last day of August → still August.
  assert.equal(resolveForwardOccupancy(map, "L1", "2026-08-31"), 0.85);
  // Target inside September → September's value.
  assert.equal(resolveForwardOccupancy(map, "L1", "2026-09-15"), 0.42);
});

test("resolveForwardOccupancy — unknown listing → null", () => {
  const map = makeMap([{ listingId: "L1", monthKey: "2026-08", occ: 0.85 }]);
  assert.equal(resolveForwardOccupancy(map, "L_OTHER", "2026-08-15"), null);
});

test("resolveForwardOccupancy — listing exists but month missing → null (no signal)", () => {
  const map = makeMap([{ listingId: "L1", monthKey: "2026-08", occ: 0.85 }]);
  assert.equal(resolveForwardOccupancy(map, "L1", "2026-09-15"), null);
});

test("resolveForwardOccupancy — null in the map (window has no bookable inventory) flows through as null", () => {
  // When the whole month is owner-blocked, the loader stores null.
  // Downstream the ladder's null-input branch returns multiplier 1.0
  // — yield neutral, no rung applied.
  const map = makeMap([{ listingId: "L1", monthKey: "2026-08", occ: null }]);
  assert.equal(resolveForwardOccupancy(map, "L1", "2026-08-15"), null);
});

test("resolveForwardOccupancy — yield-ladder semantic: 90%+ in target month → highest rung lift; 0-10% → lowest rung discount", () => {
  // Pin the semantic contract for the BUILD-LOG entry. The agent feeds
  // the resolved value directly into lookupTrialOccupancyMultiplier;
  // 0.95 (95% booked) hits the highest rung (+12%), 0.05 hits the
  // lowest (-12%). The test below pins the input-side behaviour;
  // ladder math itself is unit-tested separately.
  const map = makeMap([
    { listingId: "L_FULL", monthKey: "2026-08", occ: 0.95 },
    { listingId: "L_EMPTY", monthKey: "2026-08", occ: 0.05 }
  ]);
  const full = resolveForwardOccupancy(map, "L_FULL", "2026-08-12");
  const empty = resolveForwardOccupancy(map, "L_EMPTY", "2026-08-12");
  assert.ok(full !== null && full >= 0.9);
  assert.ok(empty !== null && empty <= 0.1);
});
