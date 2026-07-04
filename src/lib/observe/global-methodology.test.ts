import assert from "node:assert/strict";
import test from "node:test";

import { buildClientProfileDoc } from "./client-profile";
import {
  anonymiseForGlobal,
  emptyGlobalMethodology,
  mergeGlobalMethodology,
  rebuildGlobalMethodology,
  type AnonymisedContribution
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
    pickup: {
      value: { movedPerListingDay: 0.3, controlPerListingDay: 0.1, liftPct: 2 },
      eventsWithControl: 17,
      eventsMeasured: 60,
      windowDays: 7
    },
    leadTime: {
      buckets: [
        { label: "0-1", count: 2, pct: 0.2 },
        { label: "8-14", count: 8, pct: 0.8 }
      ],
      medianLeadDays: 11,
      n: 10
    },
    leadTimeByMarket: {
      belfast: {
        buckets: [
          { label: "0-1", count: 100, pct: 0.25 },
          { label: "8-14", count: 300, pct: 0.75 }
        ],
        medianLeadDays: 9,
        n: 400
      }
    },
    regret: {
      heldTooLow: 3,
      heldTooHigh: 5,
      none: 12,
      total: 20,
      windowDays: 90,
      emptyNights: 8,
      expectedEmpties: 3,
      baselineSource: "pace_yoy"
    },
    pricingPower: {
      event: { occupancy: 0.9, meanRate: RAW_MEAN_RATE, n: 10, rateSensitivity: "inelastic" },
      holiday: { occupancy: 0.8, meanRate: RAW_MEAN_RATE, n: 8, rateSensitivity: "inelastic" },
      weekend: { occupancy: 0.7, meanRate: RAW_MEAN_RATE, n: 20, rateSensitivity: "unknown" },
      weekday: { occupancy: 0.4, meanRate: RAW_MEAN_RATE, n: 30, rateSensitivity: "elastic" }
    },
    engineReaction: { available: true, reactions: { claw_back: 6, fight: 2, hold: 2, unknown: 0 }, sampled: 10 },
    netRealised: { grossPerNight: RAW_GROSS, netPerNight: RAW_NET, feeDragPct: 0.1875 },
    cancellation: { cheapCancelRate: 0.3, expensiveCancelRate: 0.1, signal: "cheaper_cancel_more" },
    promoGap: {
      computedAt: "2026-06-26T00:00:00.000Z",
      windowDays: 90,
      bookings: 40,
      withListedRate: 30,
      // Absolute paid/listed rates never enter the learning — only the gap
      // ratios below. The whitelist must still keep the whole block out.
      byChannel: { "booking.com": { n: 30, medianGapPct: 0.26, meanGapPct: 0.27, heavyShare: 0.1 } },
      byCohort: { "group:SECRET-GROUP": { n: 12, medianGapPct: 0.2 } }
    },
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
  // Cohort labels (group tags can carry building/client names) stay siloed:
  // the promo-gap learning as a whole is NOT whitelisted into the global doc.
  assert.ok(!json.includes("SECRET-GROUP"), "group cohort label leaked into global doc");
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
      "leadTimeByMarket",
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

// ---- rebuildGlobalMethodology (the production path) ---------------------------

function contribution(overrides: Partial<AnonymisedContribution> = {}): AnonymisedContribution {
  return {
    engine: "pricelabs",
    leadTimeBucketPcts: { "0-1": 0.2, "8-14": 0.8 },
    medianLeadDays: 10,
    leadTimeByMarket: null,
    regret: { heldTooLowPct: 0.1, heldTooHighPct: 0.2 },
    pricingPowerSensitivity: { event: { sensitivity: "inelastic", occupancy: 0.9 } },
    engineReactionFractions: { claw_back: 0.5, hold: 0.5 },
    feeDragPct: 0.1,
    cancellationSignal: "cheaper_cancel_more",
    ...overrides
  };
}

test("rebuildGlobalMethodology weights every client equally — one latest profile each", () => {
  const doc = rebuildGlobalMethodology([
    contribution({ feeDragPct: 0.1, medianLeadDays: 10 }),
    contribution({ feeDragPct: 0.3, medianLeadDays: 30 })
  ]);
  assert.equal(doc.samples, 2); // contributing CLIENTS, not folds
  assert.equal(doc.feeDragPctMean, 0.2); // plain equal-weight mean
  assert.equal(doc.feeDragSamples, 2);
  assert.equal(doc.medianLeadDays, 20);
  assert.equal(doc.medianLeadSamples, 2);
});

test("rebuildGlobalMethodology: a missing field does not drag the mean — per-field sample counts", () => {
  const doc = rebuildGlobalMethodology([
    contribution({ leadTimeBucketPcts: { "0-1": 0.4 }, medianLeadDays: 12 }),
    contribution({ leadTimeBucketPcts: null, medianLeadDays: null }), // no lead-time data
    contribution({ leadTimeBucketPcts: { "0-1": 0.6 }, medianLeadDays: 24 })
  ]);
  // Equal weight over the CONTRIBUTING clients only — the incremental fold got
  // this wrong ((2·x1 + x3)/3 instead of (x1 + x3)/2).
  assert.ok(Math.abs(doc.leadTimeBucketPcts["0-1"] - 0.5) < 1e-9);
  assert.equal(doc.leadTimeSamples, 2);
  assert.equal(doc.medianLeadDays, 18);
  assert.equal(doc.medianLeadSamples, 2);
  assert.equal(doc.samples, 3);
});

test("rebuildGlobalMethodology: a deleted tenant simply stops contributing on the next rebuild", () => {
  const three = rebuildGlobalMethodology([
    contribution({ feeDragPct: 0.1 }),
    contribution({ feeDragPct: 0.2 }),
    contribution({ feeDragPct: 0.6 })
  ]);
  assert.equal(three.samples, 3);
  assert.ok(Math.abs((three.feeDragPctMean ?? 0) - 0.3) < 1e-9);

  // Tenant 3 deleted ⇒ next settle rebuilds from the two current profiles. No
  // running-mean memory keeps its ghost alive (prod had 14 permanent
  // contributions from deleted tenants).
  const two = rebuildGlobalMethodology([contribution({ feeDragPct: 0.1 }), contribution({ feeDragPct: 0.2 })]);
  assert.equal(two.samples, 2);
  assert.ok(Math.abs((two.feeDragPctMean ?? 0) - 0.15) < 1e-9);
});

test("rebuildGlobalMethodology: null heldTooLowPct is skipped, tracked by its own sample count", () => {
  const doc = rebuildGlobalMethodology([
    contribution({ regret: { heldTooLowPct: 0.2, heldTooHighPct: 0.3 } }),
    contribution({ regret: { heldTooLowPct: null, heldTooHighPct: 0.5 } }) // no min data
  ]);
  assert.equal(doc.regretSamples, 2);
  assert.equal(doc.regret.heldTooHighPct, 0.4);
  assert.equal(doc.regretHeldTooLowSamples, 1);
  assert.equal(doc.regret.heldTooLowPct, 0.2); // only the measurable client

  const none = rebuildGlobalMethodology([contribution({ regret: { heldTooLowPct: null, heldTooHighPct: 0.5 } })]);
  assert.equal(none.regret.heldTooLowPct, null); // explicit absence, never a fake 0
});

test("rebuildGlobalMethodology: engines tracked separately with per-engine samples", () => {
  const doc = rebuildGlobalMethodology([
    contribution({ engine: "pricelabs", engineReactionFractions: { claw_back: 1 } }),
    contribution({ engine: "pricelabs", engineReactionFractions: { claw_back: 0 } }),
    contribution({ engine: "wheelhouse", engineReactionFractions: { hold: 1 } })
  ]);
  assert.equal(doc.engineReactionByEngine.pricelabs?.samples, 2);
  assert.equal(doc.engineReactionByEngine.pricelabs?.fractions.claw_back, 0.5);
  assert.equal(doc.engineReactionByEngine.wheelhouse?.samples, 1);
});

test("REQUIRED: rebuild path leaks no identifiers or raw rates either", () => {
  const profile = buildClientProfileDoc(seededLearnings());
  const doc = rebuildGlobalMethodology([anonymiseForGlobal(profile)]);
  const json = JSON.stringify(doc);
  assert.ok(!json.includes(SECRET_TENANT_ID));
  assert.ok(!json.includes(SECRET_LISTING_NAME));
  assert.ok(!json.includes("SECRET-GROUP"));
  assert.ok(!json.includes(String(RAW_MEAN_RATE)));
  assert.equal(doc.samples, 1);
  // The market stratification keeps ONLY the city label (allowed) + ratios.
  assert.ok(doc.leadTimeByMarket.belfast);
  assert.equal(doc.leadTimeByMarket.belfast.samples, 1);
  assert.equal(doc.leadTimeByMarket.belfast.medianLeadDays, 9);
});

test("rebuildGlobalMethodology: markets aggregate equal-weight per contributing client", () => {
  const doc = rebuildGlobalMethodology([
    contribution({
      leadTimeByMarket: {
        belfast: { medianLeadDays: 10, bucketPcts: { "0-1": 0.4 }, n: 500 },
        ayr: { medianLeadDays: 30, bucketPcts: { "0-1": 0.1 }, n: 400 }
      }
    }),
    contribution({
      leadTimeByMarket: { belfast: { medianLeadDays: 20, bucketPcts: { "0-1": 0.2 }, n: 300 } }
    }),
    contribution({ leadTimeByMarket: null }) // no market data — contributes nothing here
  ]);
  assert.equal(doc.leadTimeByMarket.belfast?.samples, 2);
  assert.equal(doc.leadTimeByMarket.belfast?.medianLeadDays, 15); // equal-weight client mean
  assert.ok(Math.abs((doc.leadTimeByMarket.belfast?.leadTimeBucketPcts["0-1"] ?? 0) - 0.3) < 1e-9);
  assert.equal(doc.leadTimeByMarket.belfast?.nights, 800);
  assert.equal(doc.leadTimeByMarket.ayr?.samples, 1);
  assert.equal(Object.keys(doc.leadTimeByMarket).length, 2);
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
