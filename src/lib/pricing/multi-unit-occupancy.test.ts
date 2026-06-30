import assert from "node:assert/strict";
import test from "node:test";

import { computeMultiUnitOccupancyByDateFromInputs } from "./multi-unit-occupancy";

test("Fix 2: released-stock denominator = booked + availableUnitsToSell, not static unit_count", () => {
  // 150-unit Edge listing, but only ~31 released for sale on the date.
  // 22 booked + 9 available = 31 released → 22/31 ≈ 71% (NOT 22/150 = 14.7%).
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "edge",
        tags: ["group:The Edge"],
        unitCount: 150,
        // 22 concurrent reservations spanning the date
        reservations: Array.from({ length: 22 }, () => ({
          arrivalDate: "2026-07-02",
          departureDate: "2026-07-04"
        })),
        availableUnitsToSellByDate: new Map([["2026-07-03", 9]])
      }
    ],
    fromDate: "2026-07-03",
    toDate: "2026-07-03"
  });
  const cell = result.get("edge")?.get("2026-07-03");
  assert.equal(cell?.unitsSold, 22);
  assert.equal(cell?.unitsTotal, 150); // physical count preserved for display
  assert.equal(cell?.unitsDenominator, 31); // 22 booked + 9 available
  assert.equal(cell?.occupancyPct, 71); // round(22/31*100,1) = 71.0
  assert.equal(cell?.denominatorBasis, "released");
});

test("Fix 2: a date with no availability signal falls back to static unit_count", () => {
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "edge",
        tags: [],
        unitCount: 150,
        reservations: Array.from({ length: 30 }, () => ({
          arrivalDate: "2026-07-02",
          departureDate: "2026-07-04"
        })),
        // availability map present but no entry for this date → null → fallback
        availableUnitsToSellByDate: new Map([["2026-07-10", 5]])
      }
    ],
    fromDate: "2026-07-03",
    toDate: "2026-07-03"
  });
  const cell = result.get("edge")?.get("2026-07-03");
  assert.equal(cell?.unitsDenominator, 150);
  assert.equal(cell?.occupancyPct, 20); // 30/150
  assert.equal(cell?.denominatorBasis, "static");
});

test("Fix 1: poolSingleUnitMembers pools single-unit listings in a group on released stock", () => {
  // A 'building' modelled as 3 individual single-unit listings sharing a group.
  // Each released for sale (availableUnitsToSell present); 2 of 3 booked.
  const mk = (id: string, booked: boolean, avail: number) => ({
    listingId: id,
    tags: ["group:The Edge"],
    unitCount: 1,
    reservations: booked ? [{ arrivalDate: "2026-07-02", departureDate: "2026-07-04" }] : [],
    availableUnitsToSellByDate: new Map([["2026-07-03", avail]])
  });
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [mk("r1", true, 0), mk("r2", true, 0), mk("r3", false, 1)],
    fromDate: "2026-07-03",
    toDate: "2026-07-03",
    poolSingleUnitMembers: true
  });
  // Pool: booked 2 (r1,r2), released = (1+0)+(1+0)+(0+1) = 3 → 2/3 = 66.7%
  const a = result.get("r1")?.get("2026-07-03");
  const c = result.get("r3")?.get("2026-07-03");
  assert.equal(a?.unitsSold, 2);
  assert.equal(a?.unitsDenominator, 3);
  assert.equal(a?.occupancyPct, 66.7);
  assert.equal(a?.denominatorBasis, "released");
  // Every member shares the same pooled cell
  assert.equal(a?.occupancyPct, c?.occupancyPct);
});

test("Fix 1: without poolSingleUnitMembers, single-unit group members are excluded", () => {
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      { listingId: "r1", tags: ["group:The Edge"], unitCount: 1, reservations: [] },
      { listingId: "r2", tags: ["group:The Edge"], unitCount: 1, reservations: [] }
    ],
    fromDate: "2026-07-03",
    toDate: "2026-07-03"
  });
  assert.equal(result.size, 0);
});

test("Fix 2: mixed pool (one member with availability, one without) reports 'mixed' basis", () => {
  const result = computeMultiUnitOccupancyByDateFromInputs({
    listings: [
      {
        listingId: "edge",
        tags: ["group:Student Accomodation"],
        unitCount: 10,
        reservations: Array.from({ length: 3 }, () => ({ arrivalDate: "2026-07-02", departureDate: "2026-07-04" })),
        availableUnitsToSellByDate: new Map([["2026-07-03", 2]]) // released = 3+2 = 5
      },
      {
        listingId: "alma",
        tags: ["group:Student Accomodation"],
        unitCount: 4,
        reservations: [{ arrivalDate: "2026-07-02", departureDate: "2026-07-04" }] // static fallback: 1/4
        // no availability map → static
      }
    ],
    fromDate: "2026-07-03",
    toDate: "2026-07-03"
  });
  const cell = result.get("edge")?.get("2026-07-03");
  // booked 3+1=4; denominator 5 (released) + 4 (static) = 9 → 4/9 = 44.4%
  assert.equal(cell?.unitsSold, 4);
  assert.equal(cell?.unitsDenominator, 9);
  assert.equal(cell?.occupancyPct, 44.4);
  assert.equal(cell?.denominatorBasis, "mixed");
});

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
