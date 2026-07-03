import assert from "node:assert/strict";
import test from "node:test";

import { buildClientProfileDoc } from "./client-profile";
import {
  anonymiseForGlobal,
  emptyGlobalMethodology,
  mergeGlobalMethodology
} from "./global-methodology";
import type { ClientLearnings } from "./learnings";

// Sensitive sample values seeded into the learnings — none may reach the global doc.
const SECRET_TENANT_ID = "tenant-SECRET-abc123";
const SECRET_LISTING_NAME = "Castle Buildings Apt 1 (PRIVATE)";
const RAW_GROSS = 233.1;
const RAW_NET = 189.42;
const RAW_MEAN_RATE = 247.83;

function seededLearnings(): ClientLearnings {
  return {
    tenantId: SECRET_TENANT_ID,
    engine: "pricelabs",
    computedAt: "2026-06-26T00:00:00.000Z",
    leadTime: {
      buckets: [
        { label: "0-1", count: 2, pct: 0.2 },
        { label: "8-14", count: 8, pct: 0.8 }
      ],
      medianLeadDays: 11,
      n: 10
    },
    regret: { heldTooLow: 3, heldTooHigh: 5, none: 12, total: 20 },
    pricingPower: {
      event: { occupancy: 0.9, meanRate: RAW_MEAN_RATE, n: 10, rateSensitivity: "inelastic" },
      holiday: { occupancy: 0.8, meanRate: RAW_MEAN_RATE, n: 8, rateSensitivity: "inelastic" },
      weekend: { occupancy: 0.7, meanRate: RAW_MEAN_RATE, n: 20, rateSensitivity: "unknown" },
      weekday: { occupancy: 0.4, meanRate: RAW_MEAN_RATE, n: 30, rateSensitivity: "elastic" }
    },
    engineReaction: { available: true, reactions: { claw_back: 6, fight: 2, hold: 2, unknown: 0 }, sampled: 10 },
    netRealised: { grossPerNight: RAW_GROSS, netPerNight: RAW_NET, feeDragPct: 0.1875 },
    cancellation: { cheapCancelRate: 0.3, expensiveCancelRate: 0.1, signal: "cheaper_cancel_more" },
    ledger: []
  };
}

test("REQUIRED: no tenantId / listing name / raw rate leaks into the global doc", () => {
  const profile = buildClientProfileDoc(seededLearnings());
  const contribution = anonymiseForGlobal(profile);
  const global = mergeGlobalMethodology(null, contribution);
  const json = JSON.stringify(global);

  // Identifiers must never appear.
  assert.ok(!json.includes(SECRET_TENANT_ID), "tenantId leaked into global doc");
  assert.ok(!json.includes(SECRET_LISTING_NAME), "listing name leaked into global doc");
  // Raw absolute rates must never appear (only ratios survive).
  assert.ok(!json.includes(String(RAW_GROSS)), "gross per-night rate leaked");
  assert.ok(!json.includes(String(RAW_NET)), "net per-night rate leaked");
  assert.ok(!json.includes(String(RAW_MEAN_RATE)), "mean rate leaked");

  // Safe abstractions DID survive.
  assert.equal(global.samples, 1);
  assert.equal(global.feeDragPctMean, 0.1875); // a ratio, allowed
  assert.equal(global.engineReactionByEngine.pricelabs?.samples, 1);
});

test("anonymiseForGlobal output contains only whitelisted keys", () => {
  const contribution = anonymiseForGlobal(buildClientProfileDoc(seededLearnings()));
  assert.deepEqual(
    Object.keys(contribution).sort(),
    [
      "cancellationSignal",
      "engine",
      "engineReactionFractions",
      "feeDragPct",
      "leadTimeBucketPcts",
      "medianLeadDays",
      "pricingPowerSensitivity",
      "regret"
    ].sort()
  );
  // pricingPower entries carry only sensitivity + occupancy — never meanRate.
  for (const v of Object.values(contribution.pricingPowerSensitivity ?? {})) {
    assert.deepEqual(Object.keys(v).sort(), ["occupancy", "sensitivity"]);
  }
});

test("mergeGlobalMethodology averages ratios and accumulates votes across clients", () => {
  const a = anonymiseForGlobal(buildClientProfileDoc(seededLearnings()));
  const b = anonymiseForGlobal(
    buildClientProfileDoc({ ...seededLearnings(), engine: "wheelhouse" })
  );
  let doc = mergeGlobalMethodology(emptyGlobalMethodology(), a);
  doc = mergeGlobalMethodology(doc, b);

  assert.equal(doc.samples, 2);
  // Two engines tracked separately (spec: learn each engine separately).
  assert.equal(doc.engineReactionByEngine.pricelabs?.samples, 1);
  assert.equal(doc.engineReactionByEngine.wheelhouse?.samples, 1);
  // Pricing-power votes accumulated.
  assert.equal(doc.pricingPowerVotes.event?.inelastic, 2);
  assert.equal(doc.pricingPowerVotes.weekday?.elastic, 2);
  // Cancellation signal votes accumulated.
  assert.equal(doc.cancellationSignalVotes.cheaper_cancel_more, 2);
});
