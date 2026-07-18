import assert from "node:assert/strict";
import test from "node:test";

import {
  mapWheelhouseBasePriceHistory,
  mapWheelhouseCalendarDayHistory,
  mapWheelhouseLastPostedPrices,
  mapWheelhouseLevers,
  mapWheelhouseListing,
  mapWheelhouseListings,
  mapWheelhouseNeighborhoodOccupancy,
  mapWheelhouseNeighborhoodPricing,
  mapWheelhousePriceCalendar,
  mapWheelhouseRecentChanges,
  mapWheelhouseReservations,
  mapWheelhouseSignals
} from "./wheelhouse-map";

// Fixture shaped like a published RM API listing (spec §2.2). No network.
const LISTING = {
  listing_id: "wh-778",
  name: "Corrie Doon — Studio Block",
  channel: "airbnb",
  number_of_bedrooms: 0,
  base_price: 95,
  min_price: 70,
  max_price: 240,
  number_of_active_units: 12,
  recommended_base_price: 102,
  latitude: 55.86,
  longitude: -4.25,
  updated_at: "2026-06-26T04:00:00Z"
};

test("mapWheelhouseListing maps id/levers/multi-unit count", () => {
  const m = mapWheelhouseListing(LISTING);
  assert.equal(m.engineListingId, "wh-778");
  assert.equal(m.name, "Corrie Doon — Studio Block");
  assert.equal(m.channel, "airbnb");
  assert.equal(m.bedrooms, 0);
  assert.equal(m.base, 95);
  assert.equal(m.min, 70);
  assert.equal(m.max, 240);
  assert.equal(m.unitCount, 12);
  assert.equal(m.recommendedBase, 102);
});

test("mapWheelhouseListings handles array, {listings}, and {data} envelopes", () => {
  assert.equal(mapWheelhouseListings([LISTING]).length, 1);
  assert.equal(mapWheelhouseListings({ listings: [LISTING] }).length, 1);
  assert.equal(mapWheelhouseListings({ data: [LISTING] }).length, 1);
  assert.equal(mapWheelhouseListings({}).length, 0);
});

test("mapWheelhouseLevers extracts base/min/max/minStay with field aliases", () => {
  const levers = mapWheelhouseLevers({ ...LISTING, minimum_stay: 2 });
  assert.deepEqual(levers, { base: 95, min: 70, max: 240, minStay: 2 });
});

test("mapWheelhouseSignals maps recommended base", () => {
  assert.equal(mapWheelhouseSignals(LISTING).recommendedBase, 102);
});

test("mapWheelhousePriceCalendar preserves per-unit rows (multi-unit)", () => {
  const payload = {
    price_calendar: [
      { date: "2026-07-01", price: 110, min_stay: 2, unit_number: 1 },
      { date: "2026-07-01", price: 110, min_stay: 2, unit_number: 2, is_customized: true },
      { date: "2026-07-02", price: 99, unit_number: 1 }
    ]
  };
  const rows = mapWheelhousePriceCalendar(payload);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].unitNumber, 1);
  assert.equal(rows[1].unitNumber, 2);
  assert.equal(rows[1].isOverride, true);
  assert.equal(rows[2].price, 99);
});

test("mapWheelhouseRecentChanges maps change events from timestamps", () => {
  const payload = {
    recent_changes: [
      { timestamp: "2026-06-25T10:00:00Z", field: "base_price" },
      { changed_at: "2026-06-24T09:00:00Z", type: "min_stay" },
      { field: "price" } // no timestamp ⇒ dropped
    ]
  };
  const changes = mapWheelhouseRecentChanges(payload);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].lever, "base_price");
  assert.equal(changes[1].lever, "min_stay");
});

// Fixture shaped like the LIVE /listings payload (verified 2026-07-18):
// `id` is the CHANNEL listing id (Hostaway), `wheelhouse_id` is internal, and
// levers/geo nest under listing_preferences/location.
const LIVE_LISTING = {
  id: "407381",
  channel: "hostaway",
  wheelhouse_id: 62500081,
  channel_ids: { wheelhouse: "62500081" },
  title: "A flat",
  num_bedrooms: 1,
  base_min_night_stay: 2,
  currency: "GBP",
  is_active: true,
  location: { country: "GB", postal_code: "KY76PX", latitude: 56.19361598, longitude: -3.09700267 },
  listing_preferences: {
    base_price: 111,
    min_price: 90,
    minimum_stay: 2,
    automatic_rate_posting_enabled: true
  },
  market_id: 584,
  number_of_active_units: null
};

test("mapWheelhouseListing maps the live payload: channelListingId = top-level id", () => {
  const m = mapWheelhouseListing(LIVE_LISTING);
  assert.equal(m.engineListingId, "407381");
  assert.equal(m.channelListingId, "407381"); // the Hostaway id, NOT wheelhouse_id
  assert.equal(m.channel, "hostaway");
  assert.equal(m.bedrooms, 1);
  assert.equal(m.latitude, 56.19361598);
  assert.equal(m.longitude, -3.09700267);
  assert.equal(m.base, 111); // from listing_preferences
  assert.equal(m.min, 90);
  assert.equal(m.pushEnabled, true); // automatic_rate_posting_enabled
  assert.equal(m.unitCount, null);
});

test("mapWheelhouseListing leaves channelListingId null when no id field exists", () => {
  assert.equal(mapWheelhouseListing(LISTING).channelListingId, null); // listing_id only
});

test("mapWheelhouseLevers falls back to listing_preferences on the live shape", () => {
  assert.deepEqual(mapWheelhouseLevers(LIVE_LISTING), { base: 111, min: 90, max: null, minStay: 2 });
});

test("mapWheelhouseBasePriceHistory maps live-shaped rows and drops date-less ones", () => {
  const payload = [
    {
      model_date: "2026-07-01",
      raw_recommendation: 128,
      recommendation: 113,
      adjustment: 1,
      fixed: 111,
      anchor_price: 85,
      anchor_weight: 0.359,
      effective_base_price: 111
    },
    { model_date: "2026-07-02", recommendation: 114 }, // sparse row ⇒ nulls
    { recommendation: 999 } // no model_date ⇒ dropped
  ];
  const rows = mapWheelhouseBasePriceHistory(payload);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    modelDate: "2026-07-01",
    rawRecommendation: 128,
    recommendation: 113,
    adjustment: 1,
    fixed: 111,
    anchorPrice: 85,
    anchorWeight: 0.359,
    effectiveBasePrice: 111
  });
  assert.equal(rows[1].rawRecommendation, null);
  assert.equal(rows[1].effectiveBasePrice, null);
});

test("mapWheelhouseBasePriceHistory returns [] for empty/odd payloads", () => {
  assert.deepEqual(mapWheelhouseBasePriceHistory([]), []);
  assert.deepEqual(mapWheelhouseBasePriceHistory({}), []);
  assert.deepEqual(mapWheelhouseBasePriceHistory(null), []);
});

test("mapWheelhouseCalendarDayHistory maps the single-day live shape", () => {
  const payload = {
    stay_date: "2026-08-01",
    posted_prices: [
      { posted_at: "2026-03-06T13:21:51.261-08:00", posted_price: 174 },
      { posted_at: "2026-07-01T02:00:00.000-07:00", posted_price: 160 }
    ],
    calendar_snapshots: [
      // Deliberately out of order + multi-unit: sorted oldest-first on map.
      { price: 160, is_available: true, unit_number: 1, created_at: "2026-06-01T00:00:00Z" },
      { price: 150, is_available: true, unit_number: 0, created_at: "2026-02-23T14:24:36Z" },
      { price: 155, is_booked: true, unit_number: 0, created_at: "2026-04-10T00:00:00Z" }
    ]
  };
  const days = mapWheelhouseCalendarDayHistory(payload);
  assert.equal(days.length, 1);
  const day = days[0];
  assert.equal(day.stayDate, "2026-08-01");
  assert.equal(day.price, 160); // most recent snapshot's price
  assert.deepEqual(
    day.history.map((h) => [h.price, h.unitNumber]),
    [[150, 0], [155, 0], [160, 1]] // oldest first, unit numbers preserved
  );
  assert.deepEqual(day.posted.map((p) => p.price), [174, 160]);
});

test("mapWheelhouseCalendarDayHistory handles missing arrays and bad payloads", () => {
  const days = mapWheelhouseCalendarDayHistory({ stay_date: "2026-08-01" });
  assert.equal(days.length, 1);
  assert.deepEqual(days[0], { stayDate: "2026-08-01", price: null, history: [], posted: [] });
  assert.deepEqual(mapWheelhouseCalendarDayHistory(null), []);
  assert.deepEqual(mapWheelhouseCalendarDayHistory({ posted_prices: [] }), []); // no stay_date
});

test("mapWheelhouseLastPostedPrices maps per-unit rows (live shape)", () => {
  const payload = [
    { stay_date: "2026-07-18", unit_number: 0, last_posted_price: 126 },
    { stay_date: "2026-07-18", unit_number: 1, last_posted_price: 126 },
    { stay_date: "2026-07-19", last_posted_price: null }, // price null-safe
    { unit_number: 3 } // no stay_date ⇒ dropped
  ];
  const rows = mapWheelhouseLastPostedPrices(payload);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { stayDate: "2026-07-18", price: 126, unitNumber: 0 });
  assert.equal(rows[1].unitNumber, 1);
  assert.equal(rows[2].price, null);
  assert.deepEqual(mapWheelhouseLastPostedPrices({}), []);
});

test("mapWheelhouseReservations maps trimmed rows and never carries PII", () => {
  const payload = [
    {
      id: "58709848",
      status: "Canceled",
      start_date: "2026-06-18",
      end_date: "2026-06-19",
      booked_at: "2026-05-03T12:24:21.000-07:00",
      created_at: "2026-05-04T05:55:10.335-07:00",
      num_guests: 2,
      currency: "GBP",
      total_price: 113.39,
      nightly_subtotal: 94.49,
      source_name: "bookingcom",
      confirmation_code: "SECRET-CODE",
      comments: "guest phone 07..."
    },
    { status: "Confirmed" } // no id ⇒ dropped
  ];
  const rows = mapWheelhouseReservations(payload);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, "58709848");
  assert.equal(row.checkIn, "2026-06-18");
  assert.equal(row.checkOut, "2026-06-19");
  assert.equal(row.status, "Canceled");
  assert.equal(row.bookedAt, "2026-05-03T12:24:21.000-07:00");
  assert.equal(row.totalPrice, 113.39);
  assert.equal(row.sourceName, "bookingcom");
  assert.equal(row.raw, undefined); // PII (confirmation code / comments) dropped
  assert.ok(!JSON.stringify(row).includes("SECRET-CODE"));
});

test("mapWheelhouseNeighborhoodPricing maps { data: [...] } price days", () => {
  const payload = {
    currency: "GBP",
    data: [
      { stay_date: "2026-07-18", median_price: 113, low_price: 89, high_price: 148, listings_count: 145 },
      { stay_date: "2026-07-19", median_price: null }, // sparse ⇒ nulls
      { median_price: 100 } // no date ⇒ dropped
    ]
  };
  const days = mapWheelhouseNeighborhoodPricing(payload);
  assert.equal(days.length, 2);
  assert.deepEqual(days[0], {
    date: "2026-07-18",
    medianPrice: 113,
    lowPrice: 89,
    highPrice: 148,
    listingsCount: 145,
    occupancy: null,
    adjustedOccupancy: null
  });
  assert.equal(days[1].medianPrice, null);
  assert.deepEqual(mapWheelhouseNeighborhoodPricing({ data: [] }), []);
});

test("mapWheelhouseNeighborhoodOccupancy maps { data: [...] } occupancy days", () => {
  const payload = {
    data: [
      { stay_date: "2026-07-18", occupancy: 0.2898, adjusted_occupancy: 0.4354, calendar_nights: 354 },
      { stay_date: "2026-07-19", occupancy: 0.2503 }
    ]
  };
  const days = mapWheelhouseNeighborhoodOccupancy(payload);
  assert.equal(days.length, 2);
  assert.equal(days[0].occupancy, 0.2898);
  assert.equal(days[0].adjustedOccupancy, 0.4354);
  assert.equal(days[0].medianPrice, null);
  assert.equal(days[1].adjustedOccupancy, null);
  assert.deepEqual(mapWheelhouseNeighborhoodOccupancy(null), []);
});
