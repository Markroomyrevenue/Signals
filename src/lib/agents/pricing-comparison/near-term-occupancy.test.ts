import assert from "node:assert/strict";
import test from "node:test";

import {
  OCCUPANCY_NEAR_TERM_LEAD_DAYS,
  resolveNearTermOccupancy,
  type NearTermOccupancyMap
} from "./near-term-occupancy";

// ---------------------------------------------------------------------------
// Constant + per-cell resolver — the spec's "late signal, ≤14d" contract
// ---------------------------------------------------------------------------

test("OCCUPANCY_NEAR_TERM_LEAD_DAYS pins the spec gate (14)", () => {
  // Mark's Phase-A decision: occupancy fires only at ≤14d lead.
  // Wider would re-introduce the lead-time contamination the prior
  // reverted commit hit on the whole forward book.
  assert.equal(OCCUPANCY_NEAR_TERM_LEAD_DAYS, 14);
});

test("resolveNearTermOccupancy — cell inside the 14d window returns the listing's fill", () => {
  const map: NearTermOccupancyMap = new Map([["L1", 9 / 14]]);
  const v = resolveNearTermOccupancy({
    map,
    listingId: "L1",
    targetIso: "2026-06-05",
    asOfIso: "2026-05-30" // 6 days out
  });
  assert.ok(v !== null);
  assert.ok(Math.abs(v! - 9 / 14) < 1e-6);
});

test("resolveNearTermOccupancy — boundary at exactly 14d (inclusive) returns the fill", () => {
  const map: NearTermOccupancyMap = new Map([["L1", 10 / 14]]);
  const v = resolveNearTermOccupancy({
    map,
    listingId: "L1",
    targetIso: "2026-06-13",
    asOfIso: "2026-05-30" // exactly 14d out
  });
  assert.ok(v !== null);
  assert.ok(Math.abs(v! - 10 / 14) < 1e-6);
});

test("resolveNearTermOccupancy — cell beyond the gate (15d+) returns null → ladder neutral", () => {
  const map: NearTermOccupancyMap = new Map([["L1", 12 / 14]]);
  const v = resolveNearTermOccupancy({
    map,
    listingId: "L1",
    targetIso: "2026-06-14",
    asOfIso: "2026-05-30" // 15 days out — beyond the gate
  });
  assert.equal(v, null);
});

test("resolveNearTermOccupancy — far-future cell returns null (does NOT discount the whole forward book)", () => {
  const map: NearTermOccupancyMap = new Map([["L1", 0 / 14]]);
  const v = resolveNearTermOccupancy({
    map,
    listingId: "L1",
    targetIso: "2027-02-10",
    asOfIso: "2026-05-30" // ~260d out
  });
  // Critical contract: this is the bug the 2026-05-26 reverted fix hit.
  // Far-future cells must NOT be discounted by occupancy.
  assert.equal(v, null);
});

test("resolveNearTermOccupancy — past target (lead < 0) returns null (defensive)", () => {
  const map: NearTermOccupancyMap = new Map([["L1", 9 / 14]]);
  const v = resolveNearTermOccupancy({
    map,
    listingId: "L1",
    targetIso: "2026-05-25",
    asOfIso: "2026-05-30" // past
  });
  assert.equal(v, null);
});

test("resolveNearTermOccupancy — unknown listing returns null without NaN", () => {
  const map: NearTermOccupancyMap = new Map();
  const v = resolveNearTermOccupancy({
    map,
    listingId: "L_UNKNOWN",
    targetIso: "2026-06-05",
    asOfIso: "2026-05-30"
  });
  assert.equal(v, null);
});

test("resolveNearTermOccupancy — null in the map (no bookable inventory) passes through as null", () => {
  const map: NearTermOccupancyMap = new Map([["L1", null]]);
  const v = resolveNearTermOccupancy({
    map,
    listingId: "L1",
    targetIso: "2026-06-05",
    asOfIso: "2026-05-30"
  });
  assert.equal(v, null);
});
