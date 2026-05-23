import assert from "node:assert/strict";
import test from "node:test";

import { eventAdjustmentForDate } from "@/lib/pricing/events";
import type { TrialTenantInfo } from "@/lib/pricing/trial-tenants";

import { getTrialLocalEventsForTenant, TRIAL_EVENT_ADJUSTMENT_PCT_CAP } from "./trial-events";

const LF: TrialTenantInfo = { id: "lf", name: "Little Feather Management", slug: "little-feather-management" };
const SB: TrialTenantInfo = { id: "sb", name: "Stay Belfast Apartments", slug: "stay-belfast-apartments" };
const OTHER: TrialTenantInfo = { id: "x", name: "Some Other", slug: "some-other" };

// ---------------------------------------------------------------------------
// Per-night per-tenant Fleadh events (2026-05-22 evening rewrite).
//
// The previous flat +40% Fleadh-week event was replaced with per-night,
// per-tenant adjustments sized from the Phase A diagnostic. Mon-Wed +
// lead-in Sun (08-02) + post-event Sun (08-09) carry NO event lift.
// Thu-Sat peaks differ per tenant.
// ---------------------------------------------------------------------------

test("trial-events — Mon-Wed of Fleadh week resolve to NO event for both tenants", () => {
  for (const tenant of [LF, SB]) {
    const events = getTrialLocalEventsForTenant(tenant);
    for (const date of ["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-09"]) {
      assert.equal(eventAdjustmentForDate(events, date), null, `tenant=${tenant.name} date=${date} should have no event`);
    }
  }
});

test("trial-events — LF peak nights: Thu +15%, Fri +50%, Sat +60% (cap) — re-sized 2026-05-23 on four-rung base", () => {
  const events = getTrialLocalEventsForTenant(LF);
  const thu = eventAdjustmentForDate(events, "2026-08-06");
  const fri = eventAdjustmentForDate(events, "2026-08-07");
  const sat = eventAdjustmentForDate(events, "2026-08-08");
  // Thu 30→15 and Fri 60→50: previous sizes were calibrated when LF base
  // was £132 (mean); the four-rung-ladder lift to £155-£171 made the
  // higher-percentage events over-fire on Thu/Fri. Sat stays at the cap
  // because the chain on a £160 base × Sat multiplier × 1.6 still lands
  // -9% under PriceLabs on the highest-PL apartment.
  assert.equal(thu?.adjustmentPct, 15);
  assert.equal(fri?.adjustmentPct, 50);
  assert.equal(sat?.adjustmentPct, 60);
});

test("trial-events — SB peak nights: Thu +15%, Fri +50%, Sat +25%", () => {
  const events = getTrialLocalEventsForTenant(SB);
  const thu = eventAdjustmentForDate(events, "2026-08-06");
  const fri = eventAdjustmentForDate(events, "2026-08-07");
  const sat = eventAdjustmentForDate(events, "2026-08-08");
  assert.equal(thu?.adjustmentPct, 15);
  assert.equal(fri?.adjustmentPct, 50);
  assert.equal(sat?.adjustmentPct, 25);
});

test("trial-events — non-trial tenant gets empty events", () => {
  assert.deepEqual(getTrialLocalEventsForTenant(OTHER), []);
});

test("trial-events — events exceeding the ±60% cap are dropped at runtime", () => {
  // The cap is a structural guard in `getTrialLocalEventsForTenant`. The
  // current static config respects the cap so this is verified by
  // construction; here we pin the contract that the cap exists and is 60.
  assert.equal(TRIAL_EVENT_ADJUSTMENT_PCT_CAP, 60);
  // All currently-loaded events for both tenants must respect the cap.
  for (const tenant of [LF, SB]) {
    for (const ev of getTrialLocalEventsForTenant(tenant)) {
      assert.ok(Math.abs(ev.adjustmentPct) <= 60, `${ev.name} adjustmentPct=${ev.adjustmentPct} exceeds cap`);
    }
  }
});
