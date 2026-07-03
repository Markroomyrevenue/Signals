import assert from "node:assert/strict";
import test from "node:test";

import { LEAD_TIME_BUCKETS, type LeadTimeDistribution } from "./learnings-core";
import { buildSuggestionDrafts, expectedCumulativeFill, judgeNightForSuggestion } from "./suggestions";

// A front-loaded curve: most bookings arrive within ~14 days of stay.
const FRONT_LOADED: LeadTimeDistribution["buckets"] = LEAD_TIME_BUCKETS.map((b) => ({
  label: b.label,
  count: 0,
  pct: b.label === "0-1" ? 0.3 : b.label === "2-3" ? 0.3 : b.label === "4-7" ? 0.25 : b.label === "8-14" ? 0.15 : 0
}));

test("expectedCumulativeFill is ~0 far out and rises as stay approaches", () => {
  // 120 days out: almost nothing should be booked yet on a front-loaded curve.
  assert.ok(expectedCumulativeFill(120, FRONT_LOADED) < 0.05);
  // 0 days out: essentially everything that ever books is in.
  assert.ok(expectedCumulativeFill(0, FRONT_LOADED) > 0.9);
});

test("judgeNightForSuggestion: empty + behind curve ⇒ at risk with a drop", () => {
  const j = judgeNightForSuggestion({ daysToStay: 1, booked: false, rate: 200, expectedFill: 0.85 });
  assert.equal(j.atRisk, true);
  assert.equal(j.revenueAtRisk, 200);
  assert.ok(j.proposedValue !== null && j.proposedValue < 200);
  assert.ok(j.dropPct >= 0.05 && j.dropPct <= 0.25);
});

test("judgeNightForSuggestion: early on curve ⇒ not at risk", () => {
  const j = judgeNightForSuggestion({ daysToStay: 100, booked: false, rate: 200, expectedFill: 0.1 });
  assert.equal(j.atRisk, false);
  assert.equal(j.proposedValue, null);
});

test("judgeNightForSuggestion: booked nights are never at risk", () => {
  const j = judgeNightForSuggestion({ daysToStay: 1, booked: true, rate: 200, expectedFill: 0.95 });
  assert.equal(j.atRisk, false);
});

test("buildSuggestionDrafts orders by revenue at risk and caps", () => {
  const nights = [
    { listingId: "A", date: "2026-07-01", daysToStay: 1, booked: false, rate: 100 },
    { listingId: "B", date: "2026-07-01", daysToStay: 1, booked: false, rate: 300 },
    { listingId: "C", date: "2026-07-01", daysToStay: 1, booked: false, rate: 200 },
    { listingId: "D", date: "2026-09-01", daysToStay: 100, booked: false, rate: 999 } // early ⇒ dropped
  ];
  const { drafts } = buildSuggestionDrafts({ nights, buckets: FRONT_LOADED, maxSuggestions: 2 });
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts.map((d) => d.listingId), ["B", "C"]); // highest revenue at risk first
  assert.ok(drafts.every((d) => d.proposedValue < d.oldValue));
});

test("min floor: proposedValue never drops below the listing's minimum price", () => {
  // Unclamped drop would be well below 190; floor pulls it back up.
  const j = judgeNightForSuggestion({ daysToStay: 1, booked: false, rate: 200, expectedFill: 0.9, floor: 190 });
  assert.equal(j.atRisk, true);
  assert.equal(j.blockedReason, undefined);
  assert.equal(j.proposedValue, 190);
  assert.equal(j.floorUnknown, undefined);
});

test("min floor: fractional floors are never undercut by rounding", () => {
  const j = judgeNightForSuggestion({ daysToStay: 1, booked: false, rate: 200, expectedFill: 0.9, floor: 190.4 });
  assert.equal(j.proposedValue, 191);
});

test("min floor: clamped value at/above current rate ⇒ blocked, nothing emitted", () => {
  const j = judgeNightForSuggestion({ daysToStay: 1, booked: false, rate: 200, expectedFill: 0.9, floor: 200 });
  assert.equal(j.blockedReason, "min_floor");
  assert.equal(j.proposedValue, null);

  const { drafts, blocked } = buildSuggestionDrafts({
    nights: [{ listingId: "A", date: "2026-07-01", daysToStay: 1, booked: false, rate: 200, floor: 250 }],
    buckets: FRONT_LOADED
  });
  assert.equal(drafts.length, 0);
  assert.equal(blocked.min_floor, 1);
});

test("event shield: a +50% event night is blocked, never dropped", () => {
  const j = judgeNightForSuggestion({ daysToStay: 1, booked: false, rate: 300, expectedFill: 0.9, eventAdjustmentPct: 50 });
  assert.equal(j.blockedReason, "event");
  assert.equal(j.proposedValue, null);

  const { drafts, blocked } = buildSuggestionDrafts({
    nights: [
      { listingId: "A", date: "2026-08-08", daysToStay: 1, booked: false, rate: 300, eventAdjustmentPct: 50 },
      { listingId: "B", date: "2026-08-20", daysToStay: 1, booked: false, rate: 200, eventAdjustmentPct: null }
    ],
    buckets: FRONT_LOADED
  });
  assert.equal(drafts.length, 1); // only the non-event night survives
  assert.equal(drafts[0].listingId, "B");
  assert.equal(blocked.event, 1);
});

test("event shield: a negative event adjustment does not block", () => {
  const j = judgeNightForSuggestion({ daysToStay: 1, booked: false, rate: 300, expectedFill: 0.9, eventAdjustmentPct: -10 });
  assert.equal(j.blockedReason, undefined);
  assert.ok(j.proposedValue !== null && j.proposedValue < 300);
});

test("no compounding: an approved/applied night never gets a fresh drop", () => {
  const j = judgeNightForSuggestion({
    daysToStay: 1,
    booked: false,
    rate: 200,
    expectedFill: 0.9,
    hasActionedSuggestion: true
  });
  assert.equal(j.blockedReason, "already_actioned");
  assert.equal(j.proposedValue, null);

  const { drafts, blocked } = buildSuggestionDrafts({
    nights: [{ listingId: "A", date: "2026-07-01", daysToStay: 1, booked: false, rate: 200, hasActionedSuggestion: true }],
    buckets: FRONT_LOADED
  });
  assert.equal(drafts.length, 0);
  assert.equal(blocked.already_actioned, 1);
});

test("cumulative cap: prior 14d drops totalling ≥ 25% block a further drop", () => {
  const capped = judgeNightForSuggestion({
    daysToStay: 1,
    booked: false,
    rate: 200,
    expectedFill: 0.9,
    cumulativeDropPct: 0.25
  });
  assert.equal(capped.blockedReason, "cumulative_cap");
  assert.equal(capped.proposedValue, null);

  const underCap = judgeNightForSuggestion({
    daysToStay: 1,
    booked: false,
    rate: 200,
    expectedFill: 0.9,
    cumulativeDropPct: 0.2
  });
  assert.equal(underCap.blockedReason, undefined);
  assert.ok(underCap.proposedValue !== null);

  const { blocked } = buildSuggestionDrafts({
    nights: [{ listingId: "A", date: "2026-07-01", daysToStay: 1, booked: false, rate: 200, cumulativeDropPct: 0.3 }],
    buckets: FRONT_LOADED
  });
  assert.equal(blocked.cumulative_cap, 1);
});

test("min floor: unknown floor ⇒ clamp skipped and draft flagged floorUnknown", () => {
  const j = judgeNightForSuggestion({ daysToStay: 1, booked: false, rate: 200, expectedFill: 0.9, floor: null });
  assert.equal(j.floorUnknown, true);
  assert.ok(j.proposedValue !== null && j.proposedValue < 200);

  const { drafts } = buildSuggestionDrafts({
    nights: [{ listingId: "A", date: "2026-07-01", daysToStay: 1, booked: false, rate: 200, floor: null }],
    buckets: FRONT_LOADED
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].detail?.floorUnknown, true);
});
