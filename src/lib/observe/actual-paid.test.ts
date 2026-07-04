import assert from "node:assert/strict";
import test from "node:test";

import {
  HEAVY_PROMO_ABS_FALLBACK_PCT,
  HEAVY_PROMO_EXCESS_PCT,
  MIN_CHANNEL_PROMO_N,
  MIN_COHORT_PROMO_N,
  aggregatePromoGapsByChannel,
  aggregatePromoGapsByCohort,
  bookingPromoGap,
  isHeavyPromo,
  listedNightlyAtBooking,
  type NightRateChange
} from "./actual-paid";
import type { CohortListing } from "./cohorts";

const BOOKED_AT = new Date("2026-06-20T12:00:00.000Z");

function change(detectedAt: string, oldValue: number | null, newValue: number | null): NightRateChange {
  return { detectedAt: new Date(detectedAt), oldValue, newValue };
}

// ---- listedNightlyAtBooking -----------------------------------------------------

test("listed rate near booking: latest change at/before booking wins (its newValue)", () => {
  const listed = listedNightlyAtBooking({
    changes: [
      change("2026-06-10T06:00:00.000Z", 100, 120),
      change("2026-06-18T06:00:00.000Z", 120, 110), // latest before booking
      change("2026-06-25T06:00:00.000Z", 110, 90) // after booking — ignored here
    ],
    stateRate: 80,
    bookedAt: BOOKED_AT
  });
  assert.equal(listed, 110);
});

test("listed rate near booking: only later changes exist — earliest one's oldValue was in force", () => {
  const listed = listedNightlyAtBooking({
    changes: [change("2026-06-25T06:00:00.000Z", 110, 90), change("2026-06-28T06:00:00.000Z", 90, 85)],
    stateRate: 80,
    bookedAt: BOOKED_AT
  });
  assert.equal(listed, 110); // the rate in force UNTIL the first later change
});

test("listed rate near booking: no changes at all — falls back to the scanned state rate", () => {
  assert.equal(listedNightlyAtBooking({ changes: [], stateRate: 95, bookedAt: BOOKED_AT }), 95);
  assert.equal(listedNightlyAtBooking({ changes: [], stateRate: null, bookedAt: BOOKED_AT }), null);
  assert.equal(listedNightlyAtBooking({ changes: [], stateRate: 0, bookedAt: BOOKED_AT }), null);
});

// ---- bookingPromoGap -------------------------------------------------------------

test("promo gap from a fixture reservation with a discount vs the listed rate", () => {
  // Listed at 100/night near booking; guest actually paid 160 for 2 nights = 80/night.
  const gap = bookingPromoGap({
    accommodationFare: 160,
    nights: 2,
    nightObservations: [
      { changes: [change("2026-06-18T06:00:00.000Z", 110, 100)], stateRate: null },
      { changes: [], stateRate: 100 }
    ],
    bookedAt: BOOKED_AT
  });
  assert.ok(gap);
  assert.equal(gap.paidNightly, 80);
  assert.equal(gap.listedNightly, 100);
  assert.equal(gap.nightsResolved, 2);
  assert.ok(Math.abs(gap.gapPct - 0.2) < 1e-9); // paid 20% below listed — the discount drag
});

test("promo gap is null without any resolvable listed rate or with unusable fare", () => {
  const noObs = bookingPromoGap({
    accommodationFare: 160,
    nights: 2,
    nightObservations: [{ changes: [], stateRate: null }],
    bookedAt: BOOKED_AT
  });
  assert.equal(noObs, null);
  const zeroFare = bookingPromoGap({
    accommodationFare: 0,
    nights: 2,
    nightObservations: [{ changes: [], stateRate: 100 }],
    bookedAt: BOOKED_AT
  });
  assert.equal(zeroFare, null);
});

test("promo gap can be negative — paid above the listed rate is not a promo", () => {
  const gap = bookingPromoGap({
    accommodationFare: 240,
    nights: 2,
    nightObservations: [{ changes: [], stateRate: 100 }],
    bookedAt: BOOKED_AT
  });
  assert.ok(gap);
  assert.ok(gap.gapPct < 0);
});

// ---- heavy-promo judgement --------------------------------------------------------

test("heavy promo is judged RELATIVE to the channel median (structural wedge cancels)", () => {
  // booking.com's structural median gap is ~26%; a booking at 30% is normal there.
  assert.equal(isHeavyPromo(0.3, 0.26), false);
  // The same 30% gap on a channel whose median is ~1% IS a heavy promo.
  assert.equal(isHeavyPromo(0.3, 0.01), true);
  // Boundary: exactly median + HEAVY_PROMO_EXCESS_PCT flags.
  assert.equal(isHeavyPromo(0.26 + HEAVY_PROMO_EXCESS_PCT, 0.26), true);
  assert.equal(isHeavyPromo(0.26 + HEAVY_PROMO_EXCESS_PCT - 1e-9, 0.26), false);
});

test("heavy promo without a channel baseline uses the absolute fallback floor", () => {
  assert.equal(isHeavyPromo(HEAVY_PROMO_ABS_FALLBACK_PCT, null), true);
  assert.equal(isHeavyPromo(HEAVY_PROMO_ABS_FALLBACK_PCT - 1e-9, null), false);
});

// ---- channel aggregation with minimum-n suppression --------------------------------

test("channel gaps: median/mean/heavy share per channel; thin channels suppressed", () => {
  const rows = [
    ...Array.from({ length: MIN_CHANNEL_PROMO_N - 1 }, () => ({ channel: "vrbo", gapPct: 0.5 })),
    ...Array.from({ length: 9 }, () => ({ channel: "airbnb", gapPct: 0.01 })),
    { channel: "airbnb", gapPct: 0.4 } // one genuine heavy promo
  ];
  const byChannel = aggregatePromoGapsByChannel(rows);
  assert.equal(byChannel.vrbo, undefined); // below MIN_CHANNEL_PROMO_N — suppressed
  assert.ok(byChannel.airbnb);
  assert.equal(byChannel.airbnb.n, 10);
  assert.equal(byChannel.airbnb.medianGapPct, 0.01);
  assert.ok(Math.abs(byChannel.airbnb.heavyShare - 0.1) < 1e-9); // the 0.4 outlier only
});

test("channel aggregation pools unlabelled bookings under 'unknown'", () => {
  const rows = Array.from({ length: MIN_CHANNEL_PROMO_N }, () => ({ channel: null, gapPct: 0.1 }));
  const byChannel = aggregatePromoGapsByChannel(rows);
  assert.ok(byChannel.unknown);
  assert.equal(byChannel.unknown.n, MIN_CHANNEL_PROMO_N);
});

// ---- cohort re-cuts ------------------------------------------------------------------

function cohortListing(id: string, tags: string[], beds: number, unitCount = 1): CohortListing {
  return { id, tags, bedroomsNumber: beds, city: "Belfast", unitCount };
}

test("cohort promo cuts: crossover membership (group AND size band), thin cohorts suppressed", () => {
  const listings = [cohortListing("l1", ["group:Argo"], 2), cohortListing("l2", [], 2)];
  const rows = [
    ...Array.from({ length: MIN_COHORT_PROMO_N }, () => ({ listingId: "l1", gapPct: 0.2 })),
    ...Array.from({ length: 4 }, () => ({ listingId: "l2", gapPct: 0.1 }))
  ];
  const byCohort = aggregatePromoGapsByCohort(rows, listings);
  // The group cut has exactly l1's bookings.
  assert.equal(byCohort["group:Argo"]?.n, MIN_COHORT_PROMO_N);
  assert.equal(byCohort["group:Argo"]?.medianGapPct, 0.2);
  // The size-band cut pools BOTH listings (crossover with the group cut).
  assert.equal(byCohort["size:2"]?.n, MIN_COHORT_PROMO_N + 4);
  // Single-unit stock cut mirrors the size band here.
  assert.equal(byCohort["stock:single-unit"]?.n, MIN_COHORT_PROMO_N + 4);
});

test("cohort promo cuts below the minimum n are suppressed, not shown as noise", () => {
  const listings = [cohortListing("l1", ["group:Thin"], 1)];
  const rows = Array.from({ length: MIN_COHORT_PROMO_N - 1 }, () => ({ listingId: "l1", gapPct: 0.3 }));
  const byCohort = aggregatePromoGapsByCohort(rows, listings);
  assert.equal(Object.keys(byCohort).length, 0);
});
