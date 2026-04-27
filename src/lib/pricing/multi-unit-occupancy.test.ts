import assert from "node:assert/strict";
import test from "node:test";

import { computeMultiUnitOccupancyByDateFromInputs } from "./multi-unit-occupancy";

test("single-unit listings are skipped (not present in output)", () => {
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "single-1",
        tags: [],
        unitCount: null,
        reservations: [{ arrivalDate: "2026-05-01", departureDate: "2026-05-03" }]
      },
      {
        listingId: "single-2",
        tags: [],
        unitCount: 1,
        reservations: []
      }
    ],
    fromDate: "2026-05-01",
    toDate: "2026-05-05"
  });

  assert.equal(result.size, 0);
  assert.equal(result.has("single-1"), false);
  assert.equal(result.has("single-2"), false);
});

test("multi-unit standalone listing aggregates its own reservations into per-date counts", () => {
  // 5-unit listing. 2 overlapping reservations on 2026-05-02.
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "multi-1",
        tags: [],
        unitCount: 5,
        reservations: [
          { arrivalDate: "2026-05-01", departureDate: "2026-05-04" },
          { arrivalDate: "2026-05-02", departureDate: "2026-05-03" }
        ]
      }
    ],
    fromDate: "2026-05-01",
    toDate: "2026-05-04"
  });

  const dateMap = result.get("multi-1");
  assert.ok(dateMap, "multi-1 should appear in the result");
  assert.equal(dateMap?.get("2026-05-01")?.unitsSold, 1);
  assert.equal(dateMap?.get("2026-05-01")?.unitsTotal, 5);
  assert.equal(dateMap?.get("2026-05-01")?.occupancyPct, 20);

  // 2026-05-02: both reservations overlap → 2 sold of 5 → 40%.
  assert.equal(dateMap?.get("2026-05-02")?.unitsSold, 2);
  assert.equal(dateMap?.get("2026-05-02")?.unitsTotal, 5);
  assert.equal(dateMap?.get("2026-05-02")?.occupancyPct, 40);

  // 2026-05-03: only the first reservation still occupies (the second
  // departs on 2026-05-03 — exclusive).
  assert.equal(dateMap?.get("2026-05-03")?.unitsSold, 1);
  assert.equal(dateMap?.get("2026-05-04")?.unitsSold, 0);
  assert.equal(dateMap?.get("2026-05-04")?.occupancyPct, 0);
});

test("group-aware aggregation: 2 multi-unit listings sharing a group:tag receive identical pcts", () => {
  // Listing A: 10 units, 3 sold on 2026-05-02.
  // Listing B: 20 units, 7 sold on 2026-05-02.
  // Group total: 10 sold / 30 = 33.3%.
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "multi-a",
        tags: ["group:Camden Block"],
        unitCount: 10,
        reservations: [
          { arrivalDate: "2026-05-02", departureDate: "2026-05-03" },
          { arrivalDate: "2026-05-02", departureDate: "2026-05-03" },
          { arrivalDate: "2026-05-02", departureDate: "2026-05-03" }
        ]
      },
      {
        listingId: "multi-b",
        tags: ["group:Camden Block"],
        unitCount: 20,
        reservations: Array.from({ length: 7 }, () => ({
          arrivalDate: "2026-05-02",
          departureDate: "2026-05-03"
        }))
      }
    ],
    fromDate: "2026-05-02",
    toDate: "2026-05-02"
  });

  const a = result.get("multi-a")?.get("2026-05-02");
  const b = result.get("multi-b")?.get("2026-05-02");
  assert.ok(a, "multi-a must be present");
  assert.ok(b, "multi-b must be present");
  // Same pct, same totals — both rooms in the building share the matrix lookup.
  assert.equal(a?.unitsSold, 10);
  assert.equal(a?.unitsTotal, 30);
  assert.equal(a?.occupancyPct, 33.3);
  assert.equal(b?.unitsSold, 10);
  assert.equal(b?.unitsTotal, 30);
  assert.equal(b?.occupancyPct, 33.3);
  assert.deepStrictEqual(a, b);
});

test("group-aware aggregation: case-insensitive group key matching", () => {
  // Differing whitespace / case should still resolve to the same group.
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "multi-a",
        tags: ["group:Shoreditch House"],
        unitCount: 4,
        reservations: [{ arrivalDate: "2026-05-02", departureDate: "2026-05-03" }]
      },
      {
        listingId: "multi-b",
        tags: ["group:shoreditch house"],
        unitCount: 6,
        reservations: []
      }
    ],
    fromDate: "2026-05-02",
    toDate: "2026-05-02"
  });

  const a = result.get("multi-a")?.get("2026-05-02");
  const b = result.get("multi-b")?.get("2026-05-02");
  assert.equal(a?.unitsTotal, 10);
  assert.equal(b?.unitsTotal, 10);
  assert.equal(a?.unitsSold, b?.unitsSold);
  assert.equal(a?.occupancyPct, b?.occupancyPct);
});

test("multi-unit listings with different group tags do NOT share occupancy", () => {
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "multi-a",
        tags: ["group:Camden"],
        unitCount: 4,
        reservations: [{ arrivalDate: "2026-05-02", departureDate: "2026-05-03" }]
      },
      {
        listingId: "multi-b",
        tags: ["group:Shoreditch"],
        unitCount: 6,
        reservations: []
      }
    ],
    fromDate: "2026-05-02",
    toDate: "2026-05-02"
  });

  const a = result.get("multi-a")?.get("2026-05-02");
  const b = result.get("multi-b")?.get("2026-05-02");
  assert.equal(a?.unitsTotal, 4);
  assert.equal(a?.unitsSold, 1);
  assert.equal(a?.occupancyPct, 25);
  assert.equal(b?.unitsTotal, 6);
  assert.equal(b?.unitsSold, 0);
  assert.equal(b?.occupancyPct, 0);
});

test("ungrouped multi-unit listings are not aggregated together", () => {
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "multi-a",
        tags: [],
        unitCount: 4,
        reservations: [{ arrivalDate: "2026-05-02", departureDate: "2026-05-03" }]
      },
      {
        listingId: "multi-b",
        tags: [],
        unitCount: 8,
        reservations: []
      }
    ],
    fromDate: "2026-05-02",
    toDate: "2026-05-02"
  });

  const a = result.get("multi-a")?.get("2026-05-02");
  const b = result.get("multi-b")?.get("2026-05-02");
  assert.equal(a?.unitsTotal, 4);
  assert.equal(a?.unitsSold, 1);
  assert.equal(a?.occupancyPct, 25);
  assert.equal(b?.unitsTotal, 8);
  assert.equal(b?.occupancyPct, 0);
});

test("sold count is capped at the listing's unit count to defend against duplicate reservations", () => {
  // 2 units, 5 reservations all on the same date. Cap at 2 so the listing
  // never reports 250% occupancy.
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "multi-1",
        tags: [],
        unitCount: 2,
        reservations: Array.from({ length: 5 }, () => ({
          arrivalDate: "2026-05-02",
          departureDate: "2026-05-03"
        }))
      }
    ],
    fromDate: "2026-05-02",
    toDate: "2026-05-02"
  });

  const a = result.get("multi-1")?.get("2026-05-02");
  assert.equal(a?.unitsSold, 2);
  assert.equal(a?.unitsTotal, 2);
  assert.equal(a?.occupancyPct, 100);
});
