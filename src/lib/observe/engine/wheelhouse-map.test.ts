import assert from "node:assert/strict";
import test from "node:test";

import {
  mapWheelhouseLevers,
  mapWheelhouseListing,
  mapWheelhouseListings,
  mapWheelhousePriceCalendar,
  mapWheelhouseRecentChanges,
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
