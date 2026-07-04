import assert from "node:assert/strict";
import test from "node:test";

import { buildClientProfileDoc } from "./client-profile";
import type { ClientLearnings } from "./learnings";
import type { RegretSummary } from "./learnings-core";

function regretFixture(overrides: Partial<RegretSummary> = {}): RegretSummary {
  return {
    heldTooLow: 0,
    heldTooHigh: 0,
    none: 10,
    total: 10,
    windowDays: 90,
    emptyNights: 2,
    expectedEmpties: 2,
    baselineSource: "pace_yoy",
    ...overrides
  };
}

function learnings(overrides: Partial<ClientLearnings> = {}): ClientLearnings {
  return {
    tenantId: "tenant-x",
    engine: "pricelabs",
    computedAt: "2026-06-26T00:00:00.000Z",
    pickup: null,
    leadTime: { buckets: [{ label: "0-1", count: 5, pct: 0.5 }], medianLeadDays: 12, n: 10 },
    leadTimeByMarket: null,
    regret: regretFixture(),
    pricingPower: {
      event: { occupancy: 0.9, meanRate: 300, n: 10, rateSensitivity: "inelastic" },
      holiday: { occupancy: 0.85, meanRate: 280, n: 8, rateSensitivity: "inelastic" },
      weekend: { occupancy: 0.7, meanRate: 200, n: 20, rateSensitivity: "unknown" },
      weekday: { occupancy: 0.4, meanRate: 150, n: 30, rateSensitivity: "elastic" }
    },
    engineReaction: { available: true, reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 }, sampled: 0 },
    netRealised: { grossPerNight: 200, netPerNight: 170, feeDragPct: 0.15 },
    cancellation: { cheapCancelRate: 0.2, expensiveCancelRate: 0.05, signal: "cheaper_cancel_more" },
    promoGap: null,
    ledger: [],
    ...overrides
  };
}

test("buildClientProfileDoc carries lead-time, pricing power, fee drag, cancellation", () => {
  const doc = buildClientProfileDoc(learnings());
  assert.equal(doc.leadTime?.medianLeadDays, 12);
  assert.equal(doc.pricingPower?.event?.sensitivity, "inelastic");
  assert.equal(doc.pricingPower?.weekday?.sensitivity, "elastic");
  assert.equal(doc.feeDragPct, 0.15);
  assert.equal(doc.cancellationSignal, "cheaper_cancel_more");
});

test("below-min divergence rule fires as an OBSERVATION (long lead), never as a permission", () => {
  const doc = buildClientProfileDoc(
    learnings({ regret: regretFixture({ heldTooLow: 4, heldTooHigh: 1, none: 15, total: 20 }) })
  );
  const rule = doc.rules.find((r) => r.key === "below_min_long_lead");
  assert.ok(rule, "expected a below_min_long_lead rule");
  // The description must match the trigger (LONG leads), not "short windows".
  assert.match(rule?.description ?? "", /long booking leads/i);
  assert.match(rule?.description ?? "", /observation/i);
  // A learned below-min PERMISSION must not exist until validated.
  assert.equal(rule?.params?.allowBelowMinInShortWindows, undefined);
  assert.equal(rule?.params?.observationOnly, true);
  // Every rule carries its evidence.
  assert.equal(rule?.params?.n, 20);
  assert.equal(rule?.params?.windowDays, 90);
});

test("below-min rule does NOT fire for a client that respects its minimum", () => {
  const doc = buildClientProfileDoc(
    learnings({ regret: regretFixture({ heldTooLow: 0, heldTooHigh: 0, none: 20, total: 20 }) })
  );
  assert.equal(doc.rules.find((r) => r.key === "below_min_long_lead"), undefined);
});

test("below-min rule may NOT fire when heldTooLow is null (no engine min data)", () => {
  // The Coorie Doon / Yo's House artefact: no engine keys ⇒ no min data. The
  // old code scored heldTooLow 0, pinning heldTooHighPct at exactly 1.0.
  const doc = buildClientProfileDoc(
    learnings({ regret: regretFixture({ heldTooLow: null, heldTooHigh: 3, none: 17, total: 20 }) })
  );
  assert.equal(doc.rules.find((r) => r.key === "below_min_long_lead"), undefined);
  assert.equal(doc.regret?.heldTooLowPct, null); // surfaced as unmeasurable, not 0
});

test("empty-premium-tolerance rule fires on high held-too-high share, with n + window", () => {
  const doc = buildClientProfileDoc(
    learnings({ regret: regretFixture({ heldTooLow: 1, heldTooHigh: 8, none: 11, total: 20 }) })
  );
  const rule = doc.rules.find((r) => r.key === "tolerates_empty_premium");
  assert.ok(rule);
  assert.equal(rule?.params?.n, 20);
  assert.equal(rule?.params?.windowDays, 90);
});

test("empty-premium-tolerance rule may NOT fire without a seasonal baseline (one-sided input)", () => {
  const doc = buildClientProfileDoc(
    learnings({
      regret: regretFixture({
        heldTooLow: 0,
        heldTooHigh: 18,
        none: 2,
        total: 20,
        expectedEmpties: null,
        baselineSource: "none"
      })
    })
  );
  assert.equal(doc.rules.find((r) => r.key === "tolerates_empty_premium"), undefined);
});

test("engine-claws-back rule fires when claw_back dominates", () => {
  const doc = buildClientProfileDoc(
    learnings({
      engineReaction: { available: true, reactions: { claw_back: 7, fight: 1, hold: 2, unknown: 0 }, sampled: 10 }
    })
  );
  const rule = doc.rules.find((r) => r.key === "engine_claws_back");
  assert.ok(rule);
  assert.equal(doc.engineReaction.dominant, "claw_back");
});

test("engine reaction marked unavailable for the hostaway-scan fallback", () => {
  const doc = buildClientProfileDoc(
    learnings({
      engine: "hostaway-scan",
      engineReaction: { available: false, reason: "no engine API", reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 }, sampled: 0 }
    })
  );
  assert.equal(doc.engineReaction.available, false);
  assert.equal(doc.engineReaction.dominant, null);
});
