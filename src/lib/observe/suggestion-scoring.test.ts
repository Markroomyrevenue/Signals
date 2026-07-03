import assert from "node:assert/strict";
import test from "node:test";

import {
  readScoreFromDetail,
  recheckScoredCancellation,
  scoreSuggestionNight,
  type ReservationLite,
  type SuggestionScore
} from "./suggestion-scoring";

const NOW = new Date("2026-07-20T06:00:00.000Z");
const SUGGESTED_AT = new Date("2026-07-01T05:30:00.000Z");

function baseInput() {
  return {
    suggestedAt: SUGGESTED_AT,
    proposedValue: 180,
    occupiedFacts: [] as Array<{ revenueAllocated: number; reservationId: string | null }>,
    reservationsById: new Map<string, ReservationLite>(),
    cancelledCovering: [] as ReservationLite[],
    priceChangeTimes: [] as Date[],
    now: NOW
  };
}

test("outcome booked_no_action: realised rate, ratio vs proposed, days to booking", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 200, reservationId: "res-1" }];
  input.reservationsById.set("res-1", {
    id: "res-1",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    cancelledAt: null
  });

  const score = scoreSuggestionNight(input);
  assert.equal(score.outcome, "booked_no_action");
  assert.equal(score.realisedRate, 200);
  // Booked at 200 against a proposed drop to 180 ⇒ realised 111% of proposed.
  assert.ok(Math.abs((score.realisedVsProposed ?? 0) - 200 / 180) < 1e-9);
  assert.equal(score.daysToBookingAfterSuggestion, 3); // 1 Jul 05:30 → 4 Jul 12:00
  assert.equal(score.rateMovedAfter, false);
  assert.equal(score.reservationId, "res-1");
});

test("outcome expired_empty: no booking ever arrived", () => {
  const score = scoreSuggestionNight(baseInput());
  assert.equal(score.outcome, "expired_empty");
  assert.equal(score.realisedRate, null);
  assert.equal(score.realisedVsProposed, null);
  assert.equal(score.daysToBookingAfterSuggestion, null);
  assert.equal(score.reservationId, null);
});

test("outcome cancelled_after_booking: booked after the suggestion, then cancelled", () => {
  const input = baseInput();
  input.cancelledCovering = [
    {
      id: "res-c",
      createdAt: new Date("2026-07-03T09:00:00.000Z"),
      cancelledAt: new Date("2026-07-08T09:00:00.000Z")
    }
  ];
  const score = scoreSuggestionNight(input);
  assert.equal(score.outcome, "cancelled_after_booking");
  assert.equal(score.realisedRate, null); // revenue did not survive
  assert.equal(score.daysToBookingAfterSuggestion, 2);
  assert.equal(score.reservationId, "res-c");
});

test("a booking cancelled BEFORE the suggestion existed does not count as cancelled_after_booking", () => {
  const input = baseInput();
  input.cancelledCovering = [
    {
      id: "res-old",
      createdAt: new Date("2026-06-20T09:00:00.000Z"), // created before the suggestion
      cancelledAt: new Date("2026-06-25T09:00:00.000Z")
    }
  ];
  assert.equal(scoreSuggestionNight(input).outcome, "expired_empty");
});

test("occupied fact linked to a cancelled reservation is not a live booking", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 200, reservationId: "res-x" }];
  input.reservationsById.set("res-x", {
    id: "res-x",
    createdAt: new Date("2026-07-03T09:00:00.000Z"),
    cancelledAt: new Date("2026-07-10T09:00:00.000Z")
  });
  input.cancelledCovering = [input.reservationsById.get("res-x") as ReservationLite];
  assert.equal(scoreSuggestionNight(input).outcome, "cancelled_after_booking");
});

test("rateMovedAfter: a price change between suggestion and booking is flagged", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 170, reservationId: "res-1" }];
  input.reservationsById.set("res-1", {
    id: "res-1",
    createdAt: new Date("2026-07-06T12:00:00.000Z"),
    cancelledAt: null
  });
  input.priceChangeTimes = [new Date("2026-07-03T10:00:00.000Z")]; // moved BEFORE the booking
  assert.equal(scoreSuggestionNight(input).rateMovedAfter, true);

  // A move AFTER the booking landed is not "the status quo acted first".
  input.priceChangeTimes = [new Date("2026-07-08T10:00:00.000Z")];
  assert.equal(scoreSuggestionNight(input).rateMovedAfter, false);

  // A move BEFORE the suggestion never counts.
  input.priceChangeTimes = [new Date("2026-06-28T10:00:00.000Z")];
  assert.equal(scoreSuggestionNight(input).rateMovedAfter, false);
});

test("rateMovedAfter on an expired night: any post-suggestion move counts", () => {
  const input = baseInput();
  input.priceChangeTimes = [new Date("2026-07-10T10:00:00.000Z")];
  const score = scoreSuggestionNight(input);
  assert.equal(score.outcome, "expired_empty");
  assert.equal(score.rateMovedAfter, true);
});

test("multi-unit: realisedRate is the mean across occupied units", () => {
  const input = baseInput();
  input.occupiedFacts = [
    { revenueAllocated: 180, reservationId: null },
    { revenueAllocated: 220, reservationId: null }
  ];
  const score = scoreSuggestionNight(input);
  assert.equal(score.outcome, "booked_no_action");
  assert.equal(score.realisedRate, 200);
  assert.equal(score.daysToBookingAfterSuggestion, null); // no linked reservation
});

// ---- cancellation re-check ---------------------------------------------------

function bookedScore(): SuggestionScore {
  return {
    outcome: "booked_no_action",
    realisedRate: 200,
    realisedVsProposed: 200 / 180,
    daysToBookingAfterSuggestion: 3,
    rateMovedAfter: false,
    reservationId: "res-1",
    scoredAt: "2026-07-13T06:00:00.000Z"
  };
}

test("re-check flips booked_no_action to cancelled_after_booking when cancelledAt appears", () => {
  const updated = recheckScoredCancellation({
    score: bookedScore(),
    reservation: { cancelledAt: new Date("2026-07-15T09:00:00.000Z") },
    now: NOW
  });
  assert.ok(updated);
  assert.equal(updated.outcome, "cancelled_after_booking");
  assert.equal(updated.realisedRate, null);
  assert.equal(updated.realisedVsProposed, null);
  assert.equal(updated.recheckedAt, NOW.toISOString());
  assert.equal(updated.reservationId, "res-1"); // provenance kept
});

test("re-check is a no-op when the reservation is still live, missing, or the outcome is not booked", () => {
  assert.equal(recheckScoredCancellation({ score: bookedScore(), reservation: { cancelledAt: null }, now: NOW }), null);
  assert.equal(recheckScoredCancellation({ score: bookedScore(), reservation: null, now: NOW }), null);
  const expired: SuggestionScore = { ...bookedScore(), outcome: "expired_empty" };
  assert.equal(
    recheckScoredCancellation({ score: expired, reservation: { cancelledAt: new Date() }, now: NOW }),
    null
  );
});

// ---- detail parsing ------------------------------------------------------------

test("readScoreFromDetail parses a score and rejects malformed blobs", () => {
  assert.equal(readScoreFromDetail(null), null);
  assert.equal(readScoreFromDetail("x"), null);
  assert.equal(readScoreFromDetail({}), null);
  assert.equal(readScoreFromDetail({ score: { outcome: 42 } }), null);
  const parsed = readScoreFromDetail({ floor: 150, score: bookedScore() });
  assert.ok(parsed);
  assert.equal(parsed.outcome, "booked_no_action");
});
