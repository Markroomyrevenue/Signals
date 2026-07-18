import assert from "node:assert/strict";
import test from "node:test";

import {
  mapPriceLabsLevers,
  mapPriceLabsListing,
  mapPriceLabsListings,
  mapPriceLabsNeighborhood,
  mapPriceLabsPriceCalendar,
  mapPriceLabsRecentChanges,
  mapPriceLabsSignals
} from "./pricelabs-map";

// Fixture shaped like a real GET /v1/listings entry (spec §2.1). No network.
const LISTING = {
  id: "12345",
  name: "Belfast — Castle Buildings Apt 1",
  pms: "hostaway",
  group_id: "cb-cluster",
  no_of_bedrooms: 1,
  city_name: "Belfast",
  latitude: 54.5973,
  longitude: -5.9301,
  base: 165,
  min: 116,
  max: 480,
  recommended_base_price: 171.5,
  push_enabled: true,
  last_date_pushed: "2026-06-25",
  last_refreshed_at: "2026-06-26T05:31:00Z",
  occupancy_next_7: 0.82,
  occupancy_next_30: 0.61,
  occupancy_next_60: 0.47,
  market_occupancy_next_7: 0.74,
  market_occupancy_next_30: 0.58,
  market_occupancy_next_60: 0.44
};

test("mapPriceLabsListing maps identity, geo, size, and levers", () => {
  const m = mapPriceLabsListing(LISTING);
  assert.equal(m.engineListingId, "12345");
  assert.equal(m.name, "Belfast — Castle Buildings Apt 1");
  assert.equal(m.pms, "hostaway");
  assert.equal(m.groupId, "cb-cluster");
  assert.equal(m.city, "Belfast");
  assert.equal(m.bedrooms, 1);
  assert.equal(m.base, 165);
  assert.equal(m.min, 116);
  assert.equal(m.max, 480);
  assert.equal(m.recommendedBase, 171.5);
  assert.equal(m.pushEnabled, true);
  assert.equal(m.lastDatePushed, "2026-06-25");
  assert.ok(m.lastRefreshedAt instanceof Date);
  assert.equal(m.lastRefreshedAt?.toISOString(), "2026-06-26T05:31:00.000Z");
});

test("mapPriceLabsListings unwraps { listings: [...] } and drops id-less rows", () => {
  const out = mapPriceLabsListings({ listings: [LISTING, { name: "no id" }, { id: "99", base: 100 }] });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => l.engineListingId), ["12345", "99"]);
});

test("mapPriceLabsLevers extracts base/min/max/minStay", () => {
  const levers = mapPriceLabsLevers({ ...LISTING, min_stay: 2 });
  assert.deepEqual(levers, { base: 165, min: 116, max: 480, minStay: 2 });
});

test("mapPriceLabsLevers coerces a missing/zero min-stay to null", () => {
  assert.equal(mapPriceLabsLevers(LISTING).minStay, null);
  assert.equal(mapPriceLabsLevers({ ...LISTING, min_stay: 0 }).minStay, null);
});

test("mapPriceLabsSignals maps recommended base + own/market occupancy", () => {
  const s = mapPriceLabsSignals(LISTING);
  assert.equal(s.recommendedBase, 171.5);
  assert.equal(s.occNext7, 0.82);
  assert.equal(s.occNext30, 0.61);
  assert.equal(s.occNext60, 0.47);
  assert.equal(s.marketOccNext7, 0.74);
  assert.equal(s.marketOccNext30, 0.58);
  assert.equal(s.marketOccNext60, 0.44);
});

test("mapPriceLabsPriceCalendar maps per-date price/min-stay and override flags", () => {
  const entry = {
    id: "12345",
    data: [
      { date: "2026-08-07", price: 260, min_stay: 2 },
      { date: "2026-08-08", price: 320, min_stay: 3, override: true },
      { date: "2026-08-09", price: 180, user_price: 200 }, // user_price ⇒ override
      { date: "bad-date", price: 1 } // dropped
    ]
  };
  const rows = mapPriceLabsPriceCalendar(entry);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { date: "2026-08-07", price: 260, minStay: 2, isOverride: false, unitNumber: null });
  assert.equal(rows[1].isOverride, true);
  assert.equal(rows[2].isOverride, true);
});

test("mapPriceLabsPriceCalendar accepts a bare data array", () => {
  const rows = mapPriceLabsPriceCalendar([{ date: "2026-09-01", price: 150 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 150);
});

test("mapPriceLabsRecentChanges synthesises a change from last_refreshed_at", () => {
  const changes = mapPriceLabsRecentChanges(LISTING);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].lever, "price");
  assert.equal(changes[0].at.toISOString(), "2026-06-26T05:31:00.000Z");
});

test("mapPriceLabsRecentChanges returns [] when no timing field is present", () => {
  assert.deepEqual(mapPriceLabsRecentChanges({ id: "x", base: 100 }), []);
});

// Fixture shaped like the documented GET /v1/neighborhood_data response
// (chart-style sections; this endpoint is entitlement-gated so not live-probed).
const NEIGHBORHOOD = {
  status: "success",
  data: {
    currency: "GBP",
    source: "airbnb",
    "Future Percentile Prices": {
      X_values: ["2026-08-01", "2026-08-02", "2026-08-03"],
      Y_values: [
        { name: "25th Percentile", values: [80, 85, null] },
        { name: "50th Percentile", values: [100, 105, 102] },
        { name: "75th Percentile", values: [130, 140, 135] },
        { name: "90th Percentile", values: [180, 190, 185] }
      ]
    },
    "Future Occ/New/Canc": {
      X_values: ["2026-08-01", "2026-08-02", "2026-08-03"],
      Y_values: [
        { name: "Occupancy", values: [64, 58, 51] },
        { name: "New Bookings", values: [3, 1, 2] },
        { name: "Canceled Bookings", values: [0, 1, 0] }
      ]
    },
    "Market KPI": { some: "ignored" }
  }
};

test("mapPriceLabsNeighborhood maps percentile prices + market occupancy per date", () => {
  const out = mapPriceLabsNeighborhood(NEIGHBORHOOD);
  assert.equal(out.currency, "GBP");
  assert.equal(out.source, "airbnb");
  assert.equal(out.days.length, 3);
  assert.deepEqual(out.days[0], {
    date: "2026-08-01",
    p25: 80,
    p50: 100,
    p75: 130,
    p90: 180,
    marketOccupancy: 64
  });
  // Occupancy comes from the "Occupancy" series, not New/Canceled.
  assert.equal(out.days[1].marketOccupancy, 58);
  // A null point in one series is null-safe, others still map.
  assert.equal(out.days[2].p25, null);
  assert.equal(out.days[2].p50, 102);
});

test("mapPriceLabsNeighborhood handles the date-keyed fallback section shape", () => {
  const out = mapPriceLabsNeighborhood({
    data: {
      currency: "EUR",
      "Future Percentile Prices": {
        "25": { "2026-09-01": 70, "2026-09-02": 72 },
        Median: { "2026-09-01": 95 }
      },
      "Future Occ/New/Canc": {
        occupancy: { "2026-09-01": 40 }
      }
    }
  });
  assert.equal(out.currency, "EUR");
  assert.equal(out.days.length, 2);
  assert.deepEqual(out.days[0], {
    date: "2026-09-01",
    p25: 70,
    p50: 95, // "Median" counts as the 50th percentile
    p75: null,
    p90: null,
    marketOccupancy: 40
  });
  assert.equal(out.days[1].p25, 72);
  assert.equal(out.days[1].marketOccupancy, null);
});

test("mapPriceLabsNeighborhood degrades to empty days on missing sections", () => {
  assert.deepEqual(mapPriceLabsNeighborhood({ status: "success", data: { currency: "GBP" } }), {
    currency: "GBP",
    source: null,
    days: []
  });
  assert.deepEqual(mapPriceLabsNeighborhood(null), { currency: null, source: null, days: [] });
  assert.deepEqual(mapPriceLabsNeighborhood({}).days, []);
});
