import assert from "node:assert/strict";
import test from "node:test";

import { LEARNING_KEYS, buildLearningLedger, type LearningLedgerEntry } from "./learnings";

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
    engineReaction: { available: true, reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 }, sampled: 0 },
    netRealised: null,
    cancellation: { value: null, sampled: 3 },
    promoGap: null,
    includeNetRealised: false
  });

  assert.equal(entries.length, LEARNING_KEYS.length); // exactly one entry per learning #1-#8
  assert.deepEqual(entries.map((e) => e.learning), [...LEARNING_KEYS]);

  const ledger = byKey(entries);
  for (const key of LEARNING_KEYS) {
    assert.ok(ledger[key].nullReason, `${key} should carry a nullReason when its source is empty`);
  }
  assert.match(ledger.pricing_power.nullReason ?? "", /daily_aggs empty/);
  assert.match(ledger.lead_time.nullReason ?? "", /no occupied night facts/);
  assert.match(ledger.engine_reaction.nullReason ?? "", /no engine changes/);
  assert.match(ledger.net_realised.nullReason ?? "", /weekly settle only/);
  assert.match(ledger.cancellation.nullReason ?? "", /n=3/);
  assert.match(ledger.pickup_velocity.nullReason ?? "", /not wired/);
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
    engineReaction: { available: true, reactions: { claw_back: 5, fight: 1, hold: 2, unknown: 0 }, sampled: 8 },
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
    includeNetRealised: true
  });

  const ledger = byKey(entries);
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
  // #1 is never computed — always recorded as starved, never silently absent.
  assert.match(ledger.pickup_velocity.nullReason ?? "", /not wired/);
});

test("buildLearningLedger propagates the engine-reaction unavailability reason (hostaway-scan)", () => {
  const entries = buildLearningLedger({
    leadTime: null,
    regret: null,
    pricingPower: null,
    engineReaction: {
      available: false,
      reason: "no engine API (hostaway-scan fallback)",
      reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 },
      sampled: 0
    },
    netRealised: null,
    cancellation: { value: null, sampled: 0 },
    promoGap: null,
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
    engineReaction: { available: true, reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 }, sampled: 0 },
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
    includeNetRealised: true
  });
  const ledger = byKey(entries);
  assert.match(ledger.net_realised.nullReason ?? "", /no uncancelled reservations/);
  assert.equal(ledger.net_realised.sampleCount, 0);
  // #8: empty-source on the settle is distinct from not-computed on the daily.
  assert.match(ledger.promo_gap.nullReason ?? "", /no bookings in trailing 90d/);
  assert.equal(ledger.promo_gap.sampleCount, 0);
});
