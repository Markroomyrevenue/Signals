import assert from "node:assert/strict";
import test from "node:test";

import { LEARNING_KEYS, buildLearningLedger, type LearningLedgerEntry,
  expectedEmptiesFromObserved,
  type ObservedNight
} from "./learnings";

function byKey(entries: LearningLedgerEntry[]): Record<string, LearningLedgerEntry> {
  return Object.fromEntries(entries.map((e) => [e.learning, e]));
}

test("buildLearningLedger writes a nullReason for every learning when the sources are empty (daily run)", () => {
  // The prod starvation case: daily_aggs empty, no night facts, no engine
  // changes, thin reservations — six green runs and every learning null.
  const entries = buildLearningLedger({
    leadTime: null,
    regret: null,
    pricingPower: null,
    // Measured, found nothing — the shape computeEngineReaction now returns
    // for this starvation case (it can no longer claim `available` on 0 rows).
    engineReaction: {
      available: false,
      measured: true,
      reason: "no engine changes — no human moves (owner/mark) with a following snapshot",
      reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 },
      sampled: 0
    },
    netRealised: null,
    cancellation: { value: null, sampled: 3 },
    promoGap: null,
    pickup: null,
    includeNetRealised: false
  });

  assert.equal(entries.length, LEARNING_KEYS.length); // exactly one entry per learning #1-#8
  assert.deepEqual(entries.map((e) => e.learning), [...LEARNING_KEYS]);

  const ledger = byKey(entries);
  for (const key of LEARNING_KEYS) {
    assert.ok(ledger[key].nullReason, `${key} should carry a nullReason when its source is empty`);
  }
  assert.match(ledger.pricing_power.nullReason ?? "", /no observable available nights/);
  assert.match(ledger.lead_time.nullReason ?? "", /no occupied night facts/);
  assert.match(ledger.engine_reaction.nullReason ?? "", /no engine changes/);
  assert.match(ledger.net_realised.nullReason ?? "", /weekly settle only/);
  assert.match(ledger.cancellation.nullReason ?? "", /n=3/);
  assert.match(ledger.pickup_velocity.nullReason ?? "", /weekly settle only/);
  assert.match(ledger.promo_gap.nullReason ?? "", /weekly settle only/);
});

test("buildLearningLedger records sample counts and no nullReason when learnings compute", () => {
  const entries = buildLearningLedger({
    leadTime: { buckets: [], medianLeadDays: 12, n: 140 },
    regret: {
      heldTooLow: 3,
      heldTooHigh: 9,
      none: 0,
      total: 12,
      windowDays: 90,
      emptyNights: 10,
      expectedEmpties: 1,
      baselineSource: "pace_yoy" as const
    },
    pricingPower: {
      event: { occupancy: 0.9, meanRate: 300, n: 10, rateSensitivity: "inelastic" },
      holiday: { occupancy: 0.8, meanRate: 250, n: 5, rateSensitivity: "inelastic" },
      weekend: { occupancy: 0.7, meanRate: 200, n: 100, rateSensitivity: "unknown" },
      weekday: { occupancy: 0.4, meanRate: 150, n: 250, rateSensitivity: "elastic" }
    },
    engineReaction: { available: true, measured: true, reactions: { claw_back: 5, fight: 1, hold: 2, unknown: 0 }, sampled: 8 },
    netRealised: { value: { grossPerNight: 200, netPerNight: 170, feeDragPct: 0.15 }, sampled: 42 },
    cancellation: { value: { cheapCancelRate: 0.2, expensiveCancelRate: 0.05, signal: "cheaper_cancel_more" }, sampled: 60 },
    promoGap: {
      computedAt: "2026-07-04T06:00:00.000Z",
      windowDays: 90,
      bookings: 120,
      withListedRate: 84,
      byChannel: { airbnb: { n: 84, medianGapPct: 0.01, meanGapPct: 0.03, heavyShare: 0.05 } },
      byCohort: {}
    },
    pickup: {
      value: { movedPerListingDay: 0.3, controlPerListingDay: 0.1, liftPct: 2 },
      eventsWithControl: 17,
      eventsMeasured: 60,
      windowDays: 7
    },
    includeNetRealised: true
  });

  const ledger = byKey(entries);
  assert.equal(ledger.pickup_velocity.sampleCount, 17); // measured events WITH a control
  assert.equal(ledger.pickup_velocity.nullReason, null);
  assert.equal(ledger.lead_time.sampleCount, 140);
  assert.equal(ledger.regret.sampleCount, 12);
  assert.equal(ledger.pricing_power.sampleCount, 365); // sum of n across date types
  assert.equal(ledger.engine_reaction.sampleCount, 8);
  assert.equal(ledger.net_realised.sampleCount, 42);
  assert.equal(ledger.cancellation.sampleCount, 60);
  assert.equal(ledger.promo_gap.sampleCount, 84); // bookings with a resolvable listed rate
  for (const key of [
    "lead_time",
    "regret",
    "pricing_power",
    "engine_reaction",
    "net_realised",
    "cancellation",
    "promo_gap"
  ]) {
    assert.equal(ledger[key].nullReason, null, `${key} should have no nullReason when computed`);
  }
});

test("buildLearningLedger propagates the engine-reaction unavailability reason (hostaway-scan)", () => {
  const entries = buildLearningLedger({
    leadTime: null,
    regret: null,
    pricingPower: null,
    engineReaction: {
      available: false,
      measured: false,
      reason: "no engine API (hostaway-scan fallback)",
      reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 },
      sampled: 0
    },
    netRealised: null,
    cancellation: { value: null, sampled: 0 },
    promoGap: null,
    pickup: null,
    includeNetRealised: false
  });
  const ledger = byKey(entries);
  assert.equal(ledger.engine_reaction.nullReason, "no engine API (hostaway-scan fallback)");
  assert.equal(ledger.engine_reaction.sampleCount, null);
});

test("buildLearningLedger marks net_realised empty-source distinctly from not-computed on the settle", () => {
  const entries = buildLearningLedger({
    leadTime: null,
    regret: null,
    pricingPower: null,
    engineReaction: { available: true, measured: true, reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 }, sampled: 0 },
    netRealised: { value: null, sampled: 0 },
    cancellation: { value: null, sampled: 0 },
    promoGap: {
      computedAt: "2026-07-04T06:00:00.000Z",
      windowDays: 90,
      bookings: 6,
      withListedRate: 0,
      byChannel: {},
      byCohort: {}
    },
    pickup: { value: null, eventsWithControl: 0, eventsMeasured: 3, windowDays: 7 },
    includeNetRealised: true
  });
  const ledger = byKey(entries);
  assert.match(ledger.net_realised.nullReason ?? "", /no uncancelled reservations/);
  assert.equal(ledger.net_realised.sampleCount, 0);
  // #1: measured events without a control are visible, not silently null.
  assert.match(ledger.pickup_velocity.nullReason ?? "", /measured=3/);
  assert.equal(ledger.pickup_velocity.sampleCount, 0);
  // #8: empty-source on the settle is distinct from not-computed on the daily.
  assert.match(ledger.promo_gap.nullReason ?? "", /no bookings in trailing 90d/);
  assert.equal(ledger.promo_gap.sampleCount, 0);
});

/**
 * Regression guard (2026-07-23). `computeEngineReaction` used to return
 * `available: true` for any client whose engine had an API, regardless of
 * whether a single reaction had been observed. The client profile published
 * that verbatim — `{available: true, dominant: null, fractions: all zeros}` —
 * and the oversight model reads the profile as fact, so an absence of data
 * presented itself as a measured result of zero. On prod that was 104 of 126
 * runs. `available` must now mean "there is a reading".
 */
test("a measured-but-empty engine reaction is not 'available'", () => {
  const entries = buildLearningLedger({
    leadTime: null,
    regret: null,
    pricingPower: null,
    engineReaction: {
      available: false,
      measured: true,
      reason: "no engine changes — no human moves (owner/mark) with a following snapshot",
      reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 },
      sampled: 0
    },
    netRealised: null,
    cancellation: { value: null, sampled: 0 },
    promoGap: null,
    pickup: null,
    includeNetRealised: false
  });
  const ledger = byKey(entries);
  // Measured-but-empty keeps sampleCount 0 (it ran), distinct from the
  // no-engine-API case which stays null (it could not run).
  assert.equal(ledger.engine_reaction.sampleCount, 0);
  assert.match(ledger.engine_reaction.nullReason ?? "", /no engine changes/);
});

// ---------------------------------------------------------------------------
// Regret seasonal baseline, rebuilt on NightFact (2026-07-23).
//
// Both baseline paths were failing in prod: pace_yoy needs year-old pace data
// that will not exist until ~April 2027, and the trailing-DOW fallback read
// `daily_aggs`, a table nothing writes. Every client carried
// `baselineSource: "none"`, which regretFromNights then treated as an
// expectation of ZERO empties.
// ---------------------------------------------------------------------------

/** Build n observed nights on a fixed weekday, `occ` of them occupied. */
function nightsOn(
  dateIso: string,
  n: number,
  occ: number,
  available = true,
  observedAvailability = true
): ObservedNight[] {
  return Array.from({ length: n }, (_, i) => ({
    listingId: `l${i}`,
    date: dateIso,
    occupied: i < occ,
    available,
    rate: 100,
    observedAvailability
  }));
}

test("baseline declines to answer on a thin sample rather than guess", () => {
  // 2026-07-25 is a Saturday. Well under REGRET_BASELINE_MIN_NIGHTS.
  const out = expectedEmptiesFromObserved(nightsOn("2026-07-25", 50, 25), ["2026-07-25"]);
  assert.equal(out.expectedEmpties, null);
  assert.equal(out.baselineSource, "none");
});

test("baseline uses each date's own day-of-week empty rate", () => {
  // Saturdays 90% full (10% empty), Tuesdays 50% full (50% empty).
  const nights = [
    ...nightsOn("2026-07-25", 200, 180), // Sat
    ...nightsOn("2026-07-28", 200, 100) // Tue
  ];
  const out = expectedEmptiesFromObserved(nights, ["2026-07-25", "2026-07-28"]);
  assert.equal(out.baselineSource, "trailing_dow");
  // 0.10 (Sat) + 0.50 (Tue) = 0.60 expected empties across the two nights.
  assert.ok(Math.abs((out.expectedEmpties as number) - 0.6) < 1e-9, `got ${out.expectedEmpties}`);
});

test("a day-of-week with too few observations borrows the overall rate", () => {
  // 300 Saturdays at 20% empty, but only 3 Tuesdays (all empty). The Tuesday
  // estimate must NOT be 100% off three nights.
  const nights = [...nightsOn("2026-07-25", 300, 240), ...nightsOn("2026-07-28", 3, 0)];
  const out = expectedEmptiesFromObserved(nights, ["2026-07-28"]);
  const overall = (303 - 240) / 303;
  assert.ok(Math.abs((out.expectedEmpties as number) - overall) < 1e-9, `got ${out.expectedEmpties}`);
});

test("unavailable nights are excluded from the baseline entirely", () => {
  // Owner blocks (available: false) must not read as empty demand.
  const nights = [...nightsOn("2026-07-25", 250, 250), ...nightsOn("2026-07-25", 500, 0, false)];
  const out = expectedEmptiesFromObserved(nights, ["2026-07-25"]);
  assert.equal(out.baselineSource, "trailing_dow");
  assert.equal(out.expectedEmpties, 0); // every AVAILABLE night sold
});

test("baseline scales with the number of dates being judged", () => {
  const nights = nightsOn("2026-07-25", 400, 200); // 50% empty on Saturdays
  const out = expectedEmptiesFromObserved(nights, ["2026-07-25", "2026-08-01", "2026-08-08"]);
  assert.ok(Math.abs((out.expectedEmpties as number) - 1.5) < 1e-9, `got ${out.expectedEmpties}`);
});

test("nights whose availability was only INFERRED cannot establish an empty rate", () => {
  // Occupancy history reaches 2017; availability history began 2025-10-24. A
  // window older than that returns occupied nights with inferred availability
  // and no empties — an empty rate of 0, i.e. the zero-expectation bug via the
  // back door. Those nights must not count toward the sample.
  const nights = nightsOn("2026-07-25", 1000, 1000, true, false);
  const out = expectedEmptiesFromObserved(nights, ["2026-07-25"]);
  assert.equal(out.expectedEmpties, null);
  assert.equal(out.baselineSource, "none");
});

test("a mixed window counts only the observed-availability nights", () => {
  // 150 genuinely observed (below the 200 floor) + 1000 inferred ⇒ still none.
  const nights = [...nightsOn("2026-07-25", 150, 75), ...nightsOn("2026-07-25", 1000, 1000, true, false)];
  assert.equal(expectedEmptiesFromObserved(nights, ["2026-07-25"]).baselineSource, "none");
});
