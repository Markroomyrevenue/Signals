import assert from "node:assert/strict";
import test from "node:test";

import {
  coerceTrimmedNeighborhood,
  normalizeOccFraction,
  trimPlNeighborhood,
  trimWhNeighborhood
} from "./map";

// ---- occupancy normalisation ------------------------------------------------

test("normalizeOccFraction: fractions pass, percents scale, nonsense nulls", () => {
  assert.equal(normalizeOccFraction(0.45), 0.45);
  assert.equal(normalizeOccFraction(45), 0.45);
  assert.equal(normalizeOccFraction(1), 1); // fully booked, not 1%
  assert.equal(normalizeOccFraction(100), 1);
  assert.equal(normalizeOccFraction(0), 0);
  assert.equal(normalizeOccFraction(101), null);
  assert.equal(normalizeOccFraction(-1), null);
  assert.equal(normalizeOccFraction(Number.NaN), null);
  assert.equal(normalizeOccFraction(null), null);
});

// ---- PriceLabs neighborhood -------------------------------------------------

const PL_RAW = {
  data: {
    "Future Percentile Prices": {
      Labels: ["25th Percentile", "50th Percentile", "75th Percentile", "90th Percentile"],
      Category: {
        "1": {
          X_values: ["2026-08-01"],
          Y_values: [[60], [70], [80], [95]]
        },
        "2": {
          X_values: ["2026-08-01", "2026-08-02", "2026-08-03"],
          Y_values: [
            [80, 82, 84],
            [98, 100, 102],
            [120, 122, 124],
            [150, 152, 154]
          ]
        }
      }
    },
    "Future Occ/New/Canc": {
      Labels: ["Occupancy", "New Bookings", "Cancellations"],
      Category: {
        "2": {
          X_values: ["2026-08-01", "2026-08-02"],
          Y_values: [
            [62, 70],
            [3, 4],
            [0, 1]
          ]
        }
      }
    },
    "Market KPI": { ignored: true }
  }
};

test("trimPlNeighborhood extracts 50th percentile prices + occupancy for the bedroom category", () => {
  const trimmed = trimPlNeighborhood(PL_RAW, 2);
  assert.ok(trimmed);
  assert.deepEqual(trimmed.days, [
    { date: "2026-08-01", medianPrice: 98, marketOcc: 0.62 },
    { date: "2026-08-02", medianPrice: 100, marketOcc: 0.7 },
    { date: "2026-08-03", medianPrice: 102, marketOcc: null }
  ]);
});

test("trimPlNeighborhood picks the exact bedroom category when hinted", () => {
  const trimmed = trimPlNeighborhood(PL_RAW, 1);
  assert.ok(trimmed);
  const day = trimmed.days.find((d) => d.date === "2026-08-01");
  assert.equal(day?.medianPrice, 70);
});

test("trimPlNeighborhood uses the only category when no bedrooms hint is given", () => {
  const single = {
    data: {
      "Future Occ/New/Canc": {
        Labels: ["Occupancy"],
        Category: { "3": { X_values: ["2026-08-01"], Y_values: [[55]] } }
      }
    }
  };
  const trimmed = trimPlNeighborhood(single);
  assert.ok(trimmed);
  assert.deepEqual(trimmed.days, [{ date: "2026-08-01", medianPrice: null, marketOcc: 0.55 }]);
});

test("trimPlNeighborhood without a 50th-percentile label still extracts occupancy", () => {
  const raw = {
    data: {
      "Future Percentile Prices": {
        Labels: ["25th Percentile", "75th Percentile"],
        Category: { "2": { X_values: ["2026-08-01"], Y_values: [[80], [120]] } }
      },
      "Future Occ/New/Canc": PL_RAW.data["Future Occ/New/Canc"]
    }
  };
  const trimmed = trimPlNeighborhood(raw, 2);
  assert.ok(trimmed);
  assert.deepEqual(trimmed.days, [
    { date: "2026-08-01", medianPrice: null, marketOcc: 0.62 },
    { date: "2026-08-02", medianPrice: null, marketOcc: 0.7 }
  ]);
});

test("trimPlNeighborhood is defensive against malformed payloads (never throws)", () => {
  assert.equal(trimPlNeighborhood(null), null);
  assert.equal(trimPlNeighborhood(undefined), null);
  assert.equal(trimPlNeighborhood("nope"), null);
  assert.equal(trimPlNeighborhood({}), null);
  assert.equal(trimPlNeighborhood({ data: null }), null);
  assert.deepEqual(trimPlNeighborhood({ data: {} }), { days: [] });
  assert.deepEqual(trimPlNeighborhood({ data: { "Future Percentile Prices": { Category: "nope" } } }), {
    days: []
  });
  assert.deepEqual(
    trimPlNeighborhood({
      data: {
        "Future Occ/New/Canc": {
          Labels: ["Occupancy"],
          Category: { "2": { X_values: ["not-a-date", "2026-08-01"], Y_values: [["abc", 900]] } }
        }
      }
    }),
    { days: [] } // bad date skipped; 900 is a nonsense occupancy
  );
});

// ---- Wheelhouse neighborhood ------------------------------------------------

test("trimWhNeighborhood merges pricing + occupancy reads by date", () => {
  const pricing = { data: [{ date: "2026-08-01", median_price: 90 }, { date: "2026-08-02", median_price: 95 }] };
  const occupancy = [
    { day: "2026-08-01", occupancy: 55 }, // percent form
    { day: "2026-08-03", occupancy: 0.4 } // fraction form
  ];
  const trimmed = trimWhNeighborhood(pricing, occupancy);
  assert.ok(trimmed);
  assert.deepEqual(trimmed.days, [
    { date: "2026-08-01", medianPrice: 90, marketOcc: 0.55 },
    { date: "2026-08-02", medianPrice: 95, marketOcc: null },
    { date: "2026-08-03", medianPrice: null, marketOcc: 0.4 }
  ]);
});

test("trimWhNeighborhood works with one side missing and nulls when both unusable", () => {
  const occOnly = trimWhNeighborhood(undefined, [{ date: "2026-08-01", occ: 60 }]);
  assert.ok(occOnly);
  assert.deepEqual(occOnly.days, [{ date: "2026-08-01", medianPrice: null, marketOcc: 0.6 }]);

  assert.equal(trimWhNeighborhood(null, null), null);
  assert.equal(trimWhNeighborhood("nope", { data: "also nope" }), null);
  assert.equal(trimWhNeighborhood({ data: [{ noDate: true }] }, []), null);
});

// ---- cache round trip -------------------------------------------------------

test("coerceTrimmedNeighborhood round-trips a trimmed payload and rejects garbage", () => {
  const trimmed = trimPlNeighborhood(PL_RAW, 2);
  assert.ok(trimmed);
  const roundTripped = coerceTrimmedNeighborhood(JSON.parse(JSON.stringify(trimmed)));
  assert.deepEqual(roundTripped, trimmed);

  assert.equal(coerceTrimmedNeighborhood(null), null);
  assert.equal(coerceTrimmedNeighborhood({ days: "nope" }), null);
  assert.deepEqual(coerceTrimmedNeighborhood({ days: [{ noDate: 1 }] }), { days: [] });
  // A poisoned cache row with percent occupancy is re-normalised on the way out.
  assert.deepEqual(coerceTrimmedNeighborhood({ days: [{ date: "2026-08-01", marketOcc: 62 }] }), {
    days: [{ date: "2026-08-01", medianPrice: null, marketOcc: 0.62 }]
  });
});
