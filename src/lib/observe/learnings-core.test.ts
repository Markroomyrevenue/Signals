import assert from "node:assert/strict";
import test from "node:test";

import {
  cancellationQuality,
  classifyEngineReaction,
  classifyRegret,
  computeSettledRegret,
  leadTimeDistribution,
  nearestMinAt,
  netRealisedRate,
  pickupVelocity,
  pricingPowerByDateType,
  type SettledNight
} from "./learnings-core";

test("pickupVelocity: moved beats control ⇒ positive lift", () => {
  const v = pickupVelocity({ movedBookings: 6, movedListingDays: 30, controlBookings: 3, controlListingDays: 60 });
  assert.equal(v.movedPerListingDay, 0.2);
  assert.equal(v.controlPerListingDay, 0.05);
  assert.ok(Math.abs((v.liftPct ?? 0) - 3) < 1e-9); // 0.2/0.05 - 1 = 3
});

test("pickupVelocity: null lift when control booked nothing", () => {
  const v = pickupVelocity({ movedBookings: 5, movedListingDays: 10, controlBookings: 0, controlListingDays: 40 });
  assert.equal(v.liftPct, null);
});

test("leadTimeDistribution buckets + median", () => {
  const d = leadTimeDistribution([0, 1, 3, 10, 10, 45, 200]);
  assert.equal(d.n, 7);
  assert.equal(d.medianLeadDays, 10);
  const byLabel = Object.fromEntries(d.buckets.map((b) => [b.label, b.count]));
  assert.equal(byLabel["0-1"], 2);
  assert.equal(byLabel["8-14"], 2);
  assert.equal(byLabel["91+"], 1);
});

test("classifyRegret: settled empty beyond the seasonal expectation ⇒ held_too_high, expected empty ⇒ none", () => {
  assert.equal(
    classifyRegret({ booked: false, excessEmpty: true, leadDays: null, baselineMedianLead: null, soldAtOrBelowMin: false }),
    "held_too_high"
  );
  // A soft-season empty that the baseline predicted is NOT a client trait.
  assert.equal(
    classifyRegret({ booked: false, excessEmpty: false, leadDays: null, baselineMedianLead: null, soldAtOrBelowMin: false }),
    "none"
  );
});

test("classifyRegret: booked cheap + very early ⇒ held_too_low", () => {
  assert.equal(
    classifyRegret({ booked: true, excessEmpty: false, leadDays: 80, baselineMedianLead: 30, soldAtOrBelowMin: true }),
    "held_too_low"
  );
  // booked but at a healthy rate ⇒ none
  assert.equal(
    classifyRegret({ booked: true, excessEmpty: false, leadDays: 80, baselineMedianLead: 30, soldAtOrBelowMin: false }),
    "none"
  );
});

// ---- computeSettledRegret ----------------------------------------------------

function bookedNight(overrides: Partial<SettledNight> = {}): SettledNight {
  return { booked: true, revenueAllocated: 120, leadDays: 20, grossNightlyRate: 120, minInForce: 60, ...overrides };
}
function emptyNight(): SettledNight {
  return { booked: false, revenueAllocated: null, leadDays: null, grossNightlyRate: null, minInForce: null };
}

test("computeSettledRegret: percentages no longer sum to 1 — a none class exists", () => {
  const summary = computeSettledRegret({
    nights: [
      ...Array.from({ length: 10 }, () => bookedNight()), // healthy sales ⇒ none
      ...Array.from({ length: 4 }, () => emptyNight()) // some empties…
    ],
    baselineMedianLead: 20,
    expectedEmpties: 3, // …mostly expected for the season
    baselineSource: "pace_yoy",
    windowDays: 90,
    minDataAvailable: true
  });
  assert.ok(summary);
  assert.equal(summary.total, 14);
  assert.equal(summary.heldTooHigh, 1); // 4 empties − 3 expected
  assert.equal(summary.heldTooLow, 0);
  assert.equal(summary.none, 13);
  const highPct = summary.heldTooHigh / summary.total;
  const lowPct = (summary.heldTooLow ?? 0) / summary.total;
  assert.ok(highPct + lowPct < 1, "the two regret shares must not be complementary");
});

test("computeSettledRegret: heldTooLow is null (not 0) without min data, and cheap-early nights fall to none", () => {
  const summary = computeSettledRegret({
    nights: [
      // Would be held_too_low IF the min were known (cheap + very early)…
      bookedNight({ leadDays: 60, grossNightlyRate: 50, minInForce: null }),
      bookedNight(),
      emptyNight()
    ],
    baselineMedianLead: 20,
    expectedEmpties: 1,
    baselineSource: "trailing_dow",
    windowDays: 90,
    minDataAvailable: false
  });
  assert.ok(summary);
  assert.equal(summary.heldTooLow, null); // unmeasurable, not zero
  assert.equal(summary.heldTooHigh, 0);
  assert.equal(summary.none, 3);
});

test("computeSettledRegret: near-zero-revenue booked nights are excluded from every input", () => {
  const summary = computeSettledRegret({
    nights: [
      bookedNight({ revenueAllocated: 0 }), // owner block / artefact row
      bookedNight({ revenueAllocated: 4.5, grossNightlyRate: 4.5, leadDays: 90 }), // £0-5 artefact
      bookedNight()
    ],
    baselineMedianLead: 20,
    expectedEmpties: 0,
    baselineSource: "pace_yoy",
    windowDays: 90,
    minDataAvailable: true
  });
  assert.ok(summary);
  assert.equal(summary.total, 1); // only the real sale survives
  assert.equal(summary.heldTooLow, 0); // the artefacts did NOT flag as below-min
});

test("computeSettledRegret: anachronistic min (raised after booking) no longer flags", () => {
  // Booking made 2026-04-02 at £80/night. Min at the time: £75 (nearest
  // snapshot). Min TODAY: £100 — the old code compared against the latest min
  // and minted a false held_too_low.
  const snaps = [
    { capturedAt: new Date("2026-04-01T06:00:00Z"), min: 75 },
    { capturedAt: new Date("2026-06-25T06:00:00Z"), min: 100 }
  ];
  const minInForce = nearestMinAt(snaps, new Date("2026-04-02T12:00:00Z"));
  assert.equal(minInForce, 75); // NOT the latest (100)

  const summary = computeSettledRegret({
    nights: [bookedNight({ leadDays: 60, grossNightlyRate: 80, minInForce })],
    baselineMedianLead: 20, // lead 60 ≥ 1.5 × 20 ⇒ "unusually early" holds
    expectedEmpties: 0,
    baselineSource: "pace_yoy",
    windowDays: 90,
    minDataAvailable: true
  });
  assert.ok(summary);
  assert.equal(summary.heldTooLow, 0); // 80 > 75 × 1.05 ⇒ not below min
  // Control: against the anachronistic latest min it WOULD have flagged.
  const anachronistic = computeSettledRegret({
    nights: [bookedNight({ leadDays: 60, grossNightlyRate: 80, minInForce: 100 })],
    baselineMedianLead: 20,
    expectedEmpties: 0,
    baselineSource: "pace_yoy",
    windowDays: 90,
    minDataAvailable: true
  });
  assert.equal(anachronistic?.heldTooLow, 1);
});

test("computeSettledRegret: no baseline ⇒ every empty is excess, flagged as baselineSource none", () => {
  const summary = computeSettledRegret({
    nights: [emptyNight(), emptyNight(), bookedNight()],
    baselineMedianLead: 20,
    expectedEmpties: null,
    baselineSource: "none",
    windowDays: 90,
    minDataAvailable: true
  });
  assert.ok(summary);
  assert.equal(summary.heldTooHigh, 2);
  assert.equal(summary.baselineSource, "none"); // profile rules guard on this
  assert.equal(summary.expectedEmpties, null);
});

test("computeSettledRegret: returns null when no usable settled nights exist", () => {
  assert.equal(
    computeSettledRegret({
      nights: [bookedNight({ revenueAllocated: 0 })],
      baselineMedianLead: null,
      expectedEmpties: null,
      baselineSource: "none",
      windowDays: 90,
      minDataAvailable: false
    }),
    null
  );
});

test("nearestMinAt: empty snapshot list ⇒ null", () => {
  assert.equal(nearestMinAt([], new Date()), null);
});

test("pricingPowerByDateType: inelastic when occupancy high regardless of rate", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    dateType: "event" as const,
    occupied: true,
    rate: 200 + i
  }));
  const out = pricingPowerByDateType(rows);
  assert.equal(out.event.rateSensitivity, "inelastic");
  assert.equal(out.event.occupancy, 1);
  assert.equal(out.weekday.rateSensitivity, "unknown"); // no rows
});

test("pricingPowerByDateType: elastic when occupancy low", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    dateType: "weekday" as const,
    occupied: i < 3,
    rate: 100
  }));
  assert.equal(pricingPowerByDateType(rows).weekday.rateSensitivity, "elastic");
});

test("classifyEngineReaction: hold / claw_back / fight", () => {
  // engine kept the human's new value
  assert.equal(classifyEngineReaction({ oldValue: 100, newValue: 130, engineAfter: 131 }), "hold");
  // engine reverted toward old
  assert.equal(classifyEngineReaction({ oldValue: 100, newValue: 130, engineAfter: 108 }), "claw_back");
  // engine pushed further past new in the same direction
  assert.equal(classifyEngineReaction({ oldValue: 100, newValue: 130, engineAfter: 150 }), "fight");
  // missing data
  assert.equal(classifyEngineReaction({ oldValue: null, newValue: 130, engineAfter: 150 }), "unknown");
});

test("netRealisedRate nets discounts + fees", () => {
  const r = netRealisedRate({ grossRevenue: 1000, discounts: 100, fees: 150, nights: 10 });
  assert.equal(r.grossPerNight, 100);
  assert.equal(r.netPerNight, 75);
  assert.ok(Math.abs((r.feeDragPct ?? 0) - 0.25) < 1e-9);
});

test("netRealisedRate guards zero nights", () => {
  assert.deepEqual(netRealisedRate({ grossRevenue: 100, discounts: 0, fees: 0, nights: 0 }), {
    grossPerNight: null,
    netPerNight: null,
    feeDragPct: null
  });
});

test("cancellationQuality detects cheaper-cancel-more", () => {
  const bookings = [
    { winPricePercentile: 0.1, cancelled: true },
    { winPricePercentile: 0.2, cancelled: true },
    { winPricePercentile: 0.3, cancelled: false },
    { winPricePercentile: 0.8, cancelled: false },
    { winPricePercentile: 0.9, cancelled: false }
  ];
  const q = cancellationQuality(bookings);
  assert.ok((q.cheapCancelRate ?? 0) > (q.expensiveCancelRate ?? 1));
  assert.equal(q.signal, "cheaper_cancel_more");
});

test("cancellationQuality: no signal when rates are close", () => {
  const q = cancellationQuality([
    { winPricePercentile: 0.1, cancelled: false },
    { winPricePercentile: 0.9, cancelled: false }
  ]);
  assert.equal(q.signal, "no_signal");
});
