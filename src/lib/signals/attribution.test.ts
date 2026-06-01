import assert from "node:assert/strict";
import test from "node:test";

import { selectAttributions, type ChangeCandidate } from "./attribution";

const BOOKED_AT = new Date("2026-06-01T12:00:00Z");

function candidate(overrides: Partial<ChangeCandidate> = {}): ChangeCandidate {
  return {
    id: "change-1",
    date: new Date("2026-07-10T00:00:00Z"),
    lever: "price",
    detectedAt: new Date("2026-06-01T00:00:00Z"), // 12h before the booking
    ...overrides
  };
}

test("a change within 48h on a matching stay-date produces one attribution draft", () => {
  const drafts = selectAttributions({ bookingCreatedAt: BOOKED_AT, candidates: [candidate()] });

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].rateChangeId, "change-1");
  assert.equal(drafts[0].stayDate, "2026-07-10");
  assert.equal(drafts[0].leverChanged, "price");
  assert.ok(Math.abs(drafts[0].hoursSinceChange - 12) < 1e-9);
});

test("a change older than 48h before the booking is excluded", () => {
  const drafts = selectAttributions({
    bookingCreatedAt: BOOKED_AT,
    candidates: [candidate({ detectedAt: new Date("2026-05-29T00:00:00Z") })] // ~60h before
  });

  assert.equal(drafts.length, 0);
});

test("a change detected after the booking landed is excluded", () => {
  const drafts = selectAttributions({
    bookingCreatedAt: BOOKED_AT,
    candidates: [candidate({ detectedAt: new Date("2026-06-01T18:00:00Z") })] // after booking
  });

  assert.equal(drafts.length, 0);
});

test("no candidate changes on the stay-date → no attribution rows", () => {
  const drafts = selectAttributions({ bookingCreatedAt: BOOKED_AT, candidates: [] });
  assert.equal(drafts.length, 0);
});

test("when several changes on one stay-date qualify, the closest to the booking wins", () => {
  const drafts = selectAttributions({
    bookingCreatedAt: BOOKED_AT,
    candidates: [
      candidate({ id: "far", detectedAt: new Date("2026-05-31T00:00:00Z") }), // 36h before
      candidate({ id: "near", detectedAt: new Date("2026-06-01T06:00:00Z") }) // 6h before
    ]
  });

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].rateChangeId, "near");
  assert.ok(Math.abs(drafts[0].hoursSinceChange - 6) < 1e-9);
});

test("changes on different stay-dates each get their own draft", () => {
  const drafts = selectAttributions({
    bookingCreatedAt: BOOKED_AT,
    candidates: [
      candidate({ id: "c-jul10", date: new Date("2026-07-10T00:00:00Z") }),
      candidate({ id: "c-jul11", date: new Date("2026-07-11T00:00:00Z") })
    ]
  });

  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts.map((d) => d.stayDate).sort(), ["2026-07-10", "2026-07-11"]);
});
