import assert from "node:assert/strict";
import test from "node:test";

import {
  PICKUP_SETTLE_LAG_DAYS,
  PICKUP_WINDOW_DAYS,
  aggregateMeasuredPickups,
  countWindowBookings,
  measurePickupForControl,
  pickupWindowSettled,
  type PickupReservation
} from "./pickup";

const DETECTED_AT = new Date("2026-06-20T09:00:00.000Z");
const EVENT_DATE = new Date("2026-07-05T00:00:00.000Z");

function reservation(overrides: Partial<PickupReservation> = {}): PickupReservation {
  return {
    listingId: "subject",
    createdAt: new Date("2026-06-22T12:00:00.000Z"), // inside the 7-day window
    cancelledAt: null,
    arrival: new Date("2026-07-04T00:00:00.000Z"),
    departure: new Date("2026-07-07T00:00:00.000Z"), // covers the event night
    ...overrides
  };
}

// ---- window settlement gate --------------------------------------------------

test("pickup window settles only once the 7 days + sync lag have fully elapsed", () => {
  const boundary = new Date(
    DETECTED_AT.getTime() + (PICKUP_WINDOW_DAYS + PICKUP_SETTLE_LAG_DAYS) * 24 * 60 * 60 * 1000
  );
  assert.equal(pickupWindowSettled(DETECTED_AT, new Date(boundary.getTime() - 1)), false);
  assert.equal(pickupWindowSettled(DETECTED_AT, boundary), true);
});

// ---- window booking counting ---------------------------------------------------

test("countWindowBookings counts bookings covering the night, created inside the window", () => {
  const rows = [
    reservation(), // counts
    reservation({ createdAt: new Date("2026-06-20T08:00:00.000Z") }), // created BEFORE the change
    reservation({ createdAt: new Date("2026-06-28T10:00:00.000Z") }), // after the window closed
    reservation({ arrival: new Date("2026-07-06T00:00:00.000Z") }), // does not cover the night
    reservation({ listingId: "other" }) // different listing
  ];
  const n = countWindowBookings({
    reservations: rows,
    listingIds: new Set(["subject"]),
    eventDate: EVENT_DATE,
    detectedAt: DETECTED_AT
  });
  assert.equal(n, 1);
});

test("a booking cancelled inside the window is not a kept pickup; a later cancellation still counts", () => {
  const cancelledInWindow = reservation({ cancelledAt: new Date("2026-06-25T12:00:00.000Z") });
  const cancelledLater = reservation({ cancelledAt: new Date("2026-08-01T12:00:00.000Z") });
  const args = {
    listingIds: new Set(["subject"]),
    eventDate: EVENT_DATE,
    detectedAt: DETECTED_AT
  };
  assert.equal(countWindowBookings({ reservations: [cancelledInWindow], ...args }), 0);
  assert.equal(countWindowBookings({ reservations: [cancelledLater], ...args }), 1);
});

// ---- per-control measurement (the seeded-control-set fixture) --------------------

test("pickup computed for a seeded control set: subject vs recorded controls", () => {
  const reservations = [
    reservation(), // subject booking in window
    reservation({ listingId: "ctrl-1" }), // one control booked
    reservation({ listingId: "ctrl-2", createdAt: new Date("2026-06-30T10:00:00.000Z") }) // outside window
  ];
  const measured = measurePickupForControl({
    subjectListingId: "subject",
    controlListingIds: ["ctrl-1", "ctrl-2", "ctrl-3"],
    eventDate: EVENT_DATE,
    detectedAt: DETECTED_AT,
    reservations
  });
  assert.equal(measured.subjectBookings, 1);
  assert.equal(measured.controlBookings, 1);
  assert.equal(measured.controlCount, 3);
  assert.ok(Math.abs(measured.movedPickup - 1 / PICKUP_WINDOW_DAYS) < 1e-9);
  assert.ok(Math.abs((measured.controlPickup ?? 0) - 1 / (PICKUP_WINDOW_DAYS * 3)) < 1e-9);
});

test("a rung-3 row (no control set) measures the moved side only — controlPickup null", () => {
  const measured = measurePickupForControl({
    subjectListingId: "subject",
    controlListingIds: [],
    eventDate: EVENT_DATE,
    detectedAt: DETECTED_AT,
    reservations: [reservation()]
  });
  assert.equal(measured.subjectBookings, 1);
  assert.equal(measured.controlPickup, null);
  assert.equal(measured.controlCount, 0);
});

// ---- aggregation into learning #1 --------------------------------------------------

test("aggregateMeasuredPickups pools only events WITH a control, weighted by listing-days", () => {
  const learning = aggregateMeasuredPickups([
    // Event A: subject booked 1 (1/7 per day); 2 controls booked 1 between them.
    { movedPickup: 1 / 7, controlPickup: 1 / 14, controlCount: 2 },
    // Event B: subject booked 0; 3 controls booked 3.
    { movedPickup: 0, controlPickup: 3 / 21, controlCount: 3 },
    // Rung-3 event: measured but has no control — excluded from the aggregate.
    { movedPickup: 2 / 7, controlPickup: null, controlCount: 0 }
  ]);
  assert.equal(learning.eventsWithControl, 2);
  assert.equal(learning.eventsMeasured, 3);
  assert.ok(learning.value);
  // moved: 1 booking over 2 events × 7 listing-days = 1/14 per listing-day.
  assert.ok(Math.abs(learning.value.movedPerListingDay - 1 / 14) < 1e-9);
  // control: 4 bookings over (14 + 21) listing-days.
  assert.ok(Math.abs(learning.value.controlPerListingDay - 4 / 35) < 1e-9);
  assert.ok(learning.value.liftPct !== null && learning.value.liftPct < 0); // subject picked up slower
});

test("aggregateMeasuredPickups abstains (null value) when no measured event has a control", () => {
  const learning = aggregateMeasuredPickups([{ movedPickup: 1 / 7, controlPickup: null, controlCount: 0 }]);
  assert.equal(learning.value, null);
  assert.equal(learning.eventsWithControl, 0);
  assert.equal(learning.eventsMeasured, 1);
});
