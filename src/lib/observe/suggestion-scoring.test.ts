import assert from "node:assert/strict";
import test from "node:test";

import { MIN_REAL_REVENUE } from "./drop-outcomes";
import {
  assembleCalibration,
  readScoreFromDetail,
  recheckScoredCancellation,
  scoreSuggestionNight,
  summariseScoredSuggestion,
  type ReservationLite,
  type ScoredSuggestionSummary,
  type SuggestionScore,
  type SuggestionScoreSkip
} from "./suggestion-scoring";

const NOW = new Date("2026-07-20T06:00:00.000Z");
const SUGGESTED_AT = new Date("2026-07-01T05:30:00.000Z");

function baseInput() {
  return {
    suggestedAt: SUGGESTED_AT,
    proposedValue: 180,
    occupiedFacts: [] as Array<{ revenueAllocated: number; reservationId: string | null; status: string | null }>,
    reservationsById: new Map<string, ReservationLite>(),
    cancelledCovering: [] as ReservationLite[],
    priceChangeTimes: [] as Date[],
    promoByReservationId: undefined as Map<string, { gapPct: number; heavy: boolean }> | undefined,
    now: NOW
  };
}

/** Narrow a scoring result to a real score, failing the test on a skip. */
function asScore(result: SuggestionScore | SuggestionScoreSkip): SuggestionScore {
  assert.ok(!("skipped" in result), "expected a score, got a skip");
  return result;
}

/** Narrow a scoring result to a skip, failing the test on a real score. */
function asSkip(result: SuggestionScore | SuggestionScoreSkip): SuggestionScoreSkip {
  assert.ok("skipped" in result, "expected a skip, got a score");
  return result;
}

test("outcome booked_no_action: realised rate, ratio vs proposed, days to booking", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 200, reservationId: "res-1", status: "confirmed" }];
  input.reservationsById.set("res-1", {
    id: "res-1",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    cancelledAt: null
  });

  const score = asScore(scoreSuggestionNight(input));
  assert.equal(score.outcome, "booked_no_action");
  assert.equal(score.realisedRate, 200);
  // Booked at 200 against a proposed drop to 180 ⇒ realised 111% of proposed.
  assert.ok(Math.abs((score.realisedVsProposed ?? 0) - 200 / 180) < 1e-9);
  assert.equal(score.daysToBookingAfterSuggestion, 3); // 1 Jul 05:30 → 4 Jul 12:00
  assert.equal(score.rateMovedAfter, false);
  assert.equal(score.reservationId, "res-1");
});

test("outcome expired_empty: no booking ever arrived", () => {
  const score = asScore(scoreSuggestionNight(baseInput()));
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
  const score = asScore(scoreSuggestionNight(input));
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
  assert.equal(asScore(scoreSuggestionNight(input)).outcome, "expired_empty");
});

test("occupied fact linked to a cancelled reservation is not a live booking", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 200, reservationId: "res-x", status: "cancelled" }];
  input.reservationsById.set("res-x", {
    id: "res-x",
    createdAt: new Date("2026-07-03T09:00:00.000Z"),
    cancelledAt: new Date("2026-07-10T09:00:00.000Z")
  });
  input.cancelledCovering = [input.reservationsById.get("res-x") as ReservationLite];
  assert.equal(asScore(scoreSuggestionNight(input)).outcome, "cancelled_after_booking");
});

test("rateMovedAfter: a price change between suggestion and booking is flagged", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 170, reservationId: "res-1", status: "confirmed" }];
  input.reservationsById.set("res-1", {
    id: "res-1",
    createdAt: new Date("2026-07-06T12:00:00.000Z"),
    cancelledAt: null
  });
  input.priceChangeTimes = [new Date("2026-07-03T10:00:00.000Z")]; // moved BEFORE the booking
  assert.equal(asScore(scoreSuggestionNight(input)).rateMovedAfter, true);

  // A move AFTER the booking landed is not "the status quo acted first".
  input.priceChangeTimes = [new Date("2026-07-08T10:00:00.000Z")];
  assert.equal(asScore(scoreSuggestionNight(input)).rateMovedAfter, false);

  // A move BEFORE the suggestion never counts.
  input.priceChangeTimes = [new Date("2026-06-28T10:00:00.000Z")];
  assert.equal(asScore(scoreSuggestionNight(input)).rateMovedAfter, false);
});

test("rateMovedAfter on an expired night: any post-suggestion move counts", () => {
  const input = baseInput();
  input.priceChangeTimes = [new Date("2026-07-10T10:00:00.000Z")];
  const score = asScore(scoreSuggestionNight(input));
  assert.equal(score.outcome, "expired_empty");
  assert.equal(score.rateMovedAfter, true);
});

test("promo evidence: the winning booking's gap + heavy flag land on the score", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 150, reservationId: "res-1", status: "confirmed" }];
  input.reservationsById.set("res-1", {
    id: "res-1",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    cancelledAt: null
  });
  input.promoByReservationId = new Map([["res-1", { gapPct: 0.35, heavy: true }]]);
  const score = asScore(scoreSuggestionNight(input));
  assert.equal(score.outcome, "booked_no_action");
  assert.equal(score.paidVsListedGapPct, 0.35);
  assert.equal(score.heavyPromo, true);

  // No promo evidence for the reservation ⇒ null gap, not-heavy (unknown ≠ dirty).
  input.promoByReservationId = new Map();
  const clean = asScore(scoreSuggestionNight(input));
  assert.equal(clean.paidVsListedGapPct, null);
  assert.equal(clean.heavyPromo, false);
});

test("summariseScoredSuggestion carries heavyPromo through the detail JSON", () => {
  const scored = summariseScoredSuggestion({
    oldValue: 200,
    proposedValue: 180,
    dateFrom: new Date("2026-07-10T00:00:00.000Z"),
    createdAt: new Date("2026-07-01T05:30:00.000Z"),
    detail: { score: { ...bookedScore(), heavyPromo: true, paidVsListedGapPct: 0.4 } }
  });
  assert.ok(scored);
  assert.equal(scored.heavyPromo, true);
});

test("multi-unit: realisedRate is the mean across occupied units", () => {
  const input = baseInput();
  input.occupiedFacts = [
    { revenueAllocated: 180, reservationId: null, status: "confirmed" },
    { revenueAllocated: 220, reservationId: null, status: "confirmed" }
  ];
  const score = asScore(scoreSuggestionNight(input));
  assert.equal(score.outcome, "booked_no_action");
  assert.equal(score.realisedRate, 200);
  assert.equal(score.daysToBookingAfterSuggestion, null); // no linked reservation
});

// ---- owner blocks / artefact rows (audit finding F1) --------------------------

test("F1: an ownerstay occupied fact is not a booking — the night is skipped", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 0, reservationId: null, status: "ownerstay" }];
  const skip = asSkip(scoreSuggestionNight(input));
  assert.equal(skip.skipped, true);
  assert.equal(skip.reason, "non_revenue_occupancy");
  assert.equal(skip.skippedAt, NOW.toISOString());
});

test("F1: a near-zero-revenue fact (<= MIN_REAL_REVENUE) is not a booking — skipped", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: MIN_REAL_REVENUE, reservationId: "res-1", status: "confirmed" }];
  input.reservationsById.set("res-1", {
    id: "res-1",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    cancelledAt: null
  });
  assert.equal(asSkip(scoreSuggestionNight(input)).reason, "non_revenue_occupancy");

  // Just above the threshold it IS a real booking.
  input.occupiedFacts = [{ revenueAllocated: MIN_REAL_REVENUE + 1, reservationId: "res-1", status: "confirmed" }];
  assert.equal(asScore(scoreSuggestionNight(input)).outcome, "booked_no_action");
});

test("F1: a real booking alongside an ownerstay unit books at the REAL rate only", () => {
  const input = baseInput();
  input.occupiedFacts = [
    { revenueAllocated: 0, reservationId: null, status: "ownerstay" },
    { revenueAllocated: 200, reservationId: "res-1", status: "confirmed" }
  ];
  input.reservationsById.set("res-1", {
    id: "res-1",
    createdAt: new Date("2026-07-04T12:00:00.000Z"),
    cancelledAt: null
  });
  const score = asScore(scoreSuggestionNight(input));
  assert.equal(score.outcome, "booked_no_action");
  assert.equal(score.realisedRate, 200); // NOT dragged down to 100 by the owner block
});

test("F1: ownerstay occupancy takes priority over a covering cancellation — still skipped", () => {
  const input = baseInput();
  input.occupiedFacts = [{ revenueAllocated: 0, reservationId: null, status: "ownerstay" }];
  input.cancelledCovering = [
    {
      id: "res-c",
      createdAt: new Date("2026-07-03T09:00:00.000Z"),
      cancelledAt: new Date("2026-07-08T09:00:00.000Z")
    }
  ];
  // The night's final state is owner-blocked: neither booked nor empty is honest.
  assert.equal(asSkip(scoreSuggestionNight(input)).reason, "non_revenue_occupancy");
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

// ---- calibration bucketing -----------------------------------------------------

function summary(overrides: Partial<ScoredSuggestionSummary> = {}): ScoredSuggestionSummary {
  return {
    outcome: "booked_no_action",
    oldValue: 200,
    proposedValue: 180, // 10% drop ⇒ "<=10%" bucket
    realisedVsProposed: 200 / 180,
    rateMovedAfter: false,
    heavyPromo: false,
    leadDaysAtSuggestion: 2, // "0-3d" bucket
    ...overrides
  };
}

test("assembleCalibration: headline counts, booked share, and average realised vs proposed", () => {
  const report = assembleCalibration([
    summary(),
    summary({ realisedVsProposed: 1.0 }),
    summary({ outcome: "expired_empty", realisedVsProposed: null }),
    summary({ outcome: "cancelled_after_booking", realisedVsProposed: null }),
    summary({ rateMovedAfter: true, realisedVsProposed: 0.9 })
  ]);
  assert.ok(report);
  assert.equal(report.scored, 5);
  assert.equal(report.booked, 3);
  assert.equal(report.bookedNoRateMove, 2); // one booked night had a rate move in between
  assert.equal(report.bookedHeavyPromo, 0);
  assert.equal(report.bookedNoIntervention, 2);
  assert.equal(report.expiredEmpty, 1);
  assert.equal(report.cancelledAfterBooking, 1);
  // Mean over the three booked nights' ratios.
  assert.ok(Math.abs((report.avgRealisedVsProposed ?? 0) - (200 / 180 + 1.0 + 0.9) / 3) < 1e-9);
});

test("assembleCalibration: a heavy-promo booking is not counted as a no-intervention win", () => {
  const report = assembleCalibration([
    summary(), // clean full-rate win
    summary({ heavyPromo: true, realisedVsProposed: 1.2 }) // promo-filled, however good the ratio
  ]);
  assert.ok(report);
  assert.equal(report.booked, 2);
  assert.equal(report.bookedNoRateMove, 2); // no rate move on either
  assert.equal(report.bookedHeavyPromo, 1);
  assert.equal(report.bookedNoIntervention, 1); // only the clean win survives
});

test("assembleCalibration: buckets by drop size and lead time, each with its n; empty buckets omitted", () => {
  const report = assembleCalibration([
    summary(), // 10% drop, lead 2d
    summary({ proposedValue: 150, leadDaysAtSuggestion: 10 }), // 25% drop ⇒ ">15%", lead "8-14d"
    summary({ proposedValue: 150, leadDaysAtSuggestion: 12, outcome: "expired_empty", realisedVsProposed: null })
  ]);
  assert.ok(report);

  assert.deepEqual(report.byDropSize.map((b) => b.label), ["<=10%", ">15%"]); // 10-15% omitted (n=0)
  const small = report.byDropSize.find((b) => b.label === "<=10%");
  assert.equal(small?.n, 1);
  assert.equal(small?.booked, 1);
  const big = report.byDropSize.find((b) => b.label === ">15%");
  assert.equal(big?.n, 2);
  assert.equal(big?.booked, 1);
  assert.equal(big?.bookedPct, 0.5);

  assert.deepEqual(report.byLeadTime.map((b) => b.label), ["0-3d", "8-14d"]);
  assert.equal(report.byLeadTime.find((b) => b.label === "8-14d")?.n, 2);
});

test("assembleCalibration returns null when nothing is scored yet", () => {
  assert.equal(assembleCalibration([]), null);
});

test("summariseScoredSuggestion: maps a scored row, null when unscored", () => {
  const scored = summariseScoredSuggestion({
    oldValue: 200,
    proposedValue: 180,
    dateFrom: new Date("2026-07-10T00:00:00.000Z"),
    createdAt: new Date("2026-07-01T05:30:00.000Z"),
    detail: { floor: 150, score: bookedScore() }
  });
  assert.ok(scored);
  assert.equal(scored.outcome, "booked_no_action");
  assert.equal(scored.leadDaysAtSuggestion, 8); // 1 Jul 05:30 → 10 Jul 00:00
  assert.equal(scored.rateMovedAfter, false);

  assert.equal(
    summariseScoredSuggestion({
      oldValue: 200,
      proposedValue: 180,
      dateFrom: new Date("2026-07-10T00:00:00.000Z"),
      createdAt: new Date("2026-07-01T05:30:00.000Z"),
      detail: { floor: 150 }
    }),
    null
  );
});
