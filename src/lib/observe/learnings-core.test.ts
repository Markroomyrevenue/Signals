import assert from "node:assert/strict";
import test from "node:test";

import {
  cancellationQuality,
  classifyEngineReaction,
  classifyRegret,
  leadTimeDistribution,
  netRealisedRate,
  pickupVelocity,
  pricingPowerByDateType,
  summarizeRegret
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

test("classifyRegret: empty within the wire ⇒ held_too_high", () => {
  assert.equal(
    classifyRegret({ booked: false, daysToStay: 3, leadDays: null, baselineMedianLead: null, soldAtOrBelowMin: false }),
    "held_too_high"
  );
  assert.equal(
    classifyRegret({ booked: false, daysToStay: 40, leadDays: null, baselineMedianLead: null, soldAtOrBelowMin: false }),
    "none"
  );
});

test("classifyRegret: booked cheap + very early ⇒ held_too_low", () => {
  assert.equal(
    classifyRegret({ booked: true, daysToStay: 50, leadDays: 80, baselineMedianLead: 30, soldAtOrBelowMin: true }),
    "held_too_low"
  );
  // booked but at a healthy rate ⇒ none
  assert.equal(
    classifyRegret({ booked: true, daysToStay: 50, leadDays: 80, baselineMedianLead: 30, soldAtOrBelowMin: false }),
    "none"
  );
});

test("summarizeRegret tallies", () => {
  const s = summarizeRegret(["held_too_low", "held_too_high", "held_too_high", "none"]);
  assert.deepEqual(s, { heldTooLow: 1, heldTooHigh: 2, none: 1, total: 4 });
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
