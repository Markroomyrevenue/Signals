import assert from "node:assert/strict";
import test from "node:test";

import { buildClientProfileDoc } from "./client-profile";
import type { ClientLearnings } from "./learnings";

function learnings(overrides: Partial<ClientLearnings> = {}): ClientLearnings {
  return {
    tenantId: "tenant-x",
    engine: "pricelabs",
    computedAt: "2026-06-26T00:00:00.000Z",
    leadTime: { buckets: [{ label: "0-1", count: 5, pct: 0.5 }], medianLeadDays: 12, n: 10 },
    regret: { heldTooLow: 0, heldTooHigh: 0, none: 10, total: 10 },
    pricingPower: {
      event: { occupancy: 0.9, meanRate: 300, n: 10, rateSensitivity: "inelastic" },
      holiday: { occupancy: 0.85, meanRate: 280, n: 8, rateSensitivity: "inelastic" },
      weekend: { occupancy: 0.7, meanRate: 200, n: 20, rateSensitivity: "unknown" },
      weekday: { occupancy: 0.4, meanRate: 150, n: 30, rateSensitivity: "elastic" }
    },
    engineReaction: { available: true, reactions: { claw_back: 0, fight: 0, hold: 0, unknown: 0 }, sampled: 0 },
    netRealised: { grossPerNight: 200, netPerNight: 170, feeDragPct: 0.15 },
    cancellation: { cheapCancelRate: 0.2, expensiveCancelRate: 0.05, signal: "cheaper_cancel_more" },
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

test("below-min divergence rule fires when held-too-low share is high", () => {
  const doc = buildClientProfileDoc(
    learnings({ regret: { heldTooLow: 4, heldTooHigh: 1, none: 15, total: 20 } })
  );
  const rule = doc.rules.find((r) => r.key === "below_min_short_window");
  assert.ok(rule, "expected a below_min_short_window rule");
  assert.equal(rule?.params?.allowBelowMinInShortWindows, true);
});

test("below-min rule does NOT fire for a client that respects its minimum", () => {
  const doc = buildClientProfileDoc(
    learnings({ regret: { heldTooLow: 0, heldTooHigh: 0, none: 20, total: 20 } })
  );
  assert.equal(doc.rules.find((r) => r.key === "below_min_short_window"), undefined);
});

test("empty-premium-tolerance rule fires on high held-too-high share", () => {
  const doc = buildClientProfileDoc(
    learnings({ regret: { heldTooLow: 1, heldTooHigh: 8, none: 11, total: 20 } })
  );
  assert.ok(doc.rules.find((r) => r.key === "tolerates_empty_premium"));
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
