/**
 * Tests for the recs-page full-coverage window (`buildRecsWindowDrafts`) —
 * drops, explicit holds, visible suppressions, decision memory, composer wiring.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRecsWindowDrafts, type RecsPageConfig, type SuggestionNightInput } from "./suggestions";
import type { LeadTimeDistribution } from "./learnings-core";

/** A curve where ~76% of bookings arrive ≥ 3 days ahead: any empty night a few
 * days out reads as behind pace (expected fill above the 0.5 threshold). */
const BUCKETS: LeadTimeDistribution["buckets"] = [
  { label: "0-1", pct: 0.14, count: 14 },
  { label: "2-3", pct: 0.1, count: 10 },
  { label: "4-7", pct: 0.26, count: 26 },
  { label: "8-14", pct: 0.5, count: 50 }
] as LeadTimeDistribution["buckets"];

const CFG: RecsPageConfig = {
  windowDays: 14,
  provenance: "warm-start",
  provisional: true,
  recentActionedDays: 3
};

function night(overrides: Partial<SuggestionNightInput>): SuggestionNightInput {
  return {
    listingId: "l1",
    date: "2026-07-25",
    daysToStay: 7,
    booked: false,
    rate: 100,
    floor: 50,
    ...overrides
  };
}

test("behind-pace night gets a sized drop row with provenance + provisional", () => {
  const { drafts } = buildRecsWindowDrafts({ nights: [night({})], buckets: BUCKETS, cfg: CFG, recentRejected: new Map() });
  assert.equal(drafts.length, 1);
  const d = drafts[0];
  assert.ok(d.proposedValue < 100);
  assert.equal(d.rowType, "recs-night");
  assert.equal(d.provenance, "warm-start");
  assert.equal(d.provisional, true);
  assert.equal(d.detail?.recsPage, true);
  assert.equal(d.detail?.hold, undefined);
});

test("early-on-curve night gets an explicit approvable hold", () => {
  const { drafts } = buildRecsWindowDrafts({
    nights: [night({ daysToStay: 14 })], // expected fill 0.5*mid… below threshold
    buckets: [
      { label: "0-1", pct: 0.6, count: 60 },
      { label: "8-14", pct: 0.4, count: 40 }
    ] as LeadTimeDistribution["buckets"],
    cfg: CFG,
    recentRejected: new Map()
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].proposedValue, drafts[0].oldValue);
  assert.equal(drafts[0].detail?.hold, true);
  assert.equal(drafts[0].revenueAtRisk, 0);
  assert.match(drafts[0].reason, /no change needed/);
});

test("booked nights and actioned nights emit no row", () => {
  const { drafts } = buildRecsWindowDrafts({
    nights: [night({ booked: true }), night({ date: "2026-07-26", hasActionedSuggestion: true })],
    buckets: BUCKETS,
    cfg: CFG,
    recentRejected: new Map()
  });
  assert.equal(drafts.length, 0);
});

test("redropAllowed: a near-term actioned night gets a FRESH drop (late-drop relaxation)", () => {
  const { drafts } = buildRecsWindowDrafts({
    nights: [night({ hasActionedSuggestion: true, redropAllowed: true })],
    buckets: BUCKETS,
    cfg: CFG,
    recentRejected: new Map()
  });
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].proposedValue < 100); // a real fresh cut, not a suppressed hold
  assert.equal(drafts[0].detail?.hold, undefined);
  assert.equal(drafts[0].detail?.suppressed, undefined);
});

test("redropAllowed still respects the cumulative anti-ratchet cap (no spiral)", () => {
  const { drafts, blocked } = buildRecsWindowDrafts({
    nights: [night({ hasActionedSuggestion: true, redropAllowed: true, cumulativeDropPct: 0.3 })],
    buckets: BUCKETS,
    cfg: CFG,
    recentRejected: new Map()
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].detail?.suppressed, "cumulative_cap");
  assert.equal(drafts[0].proposedValue, drafts[0].oldValue);
  assert.equal(blocked.cumulative_cap, 1);
});

test("an actioned night WITHOUT redropAllowed still emits no row (guard holds)", () => {
  const { drafts } = buildRecsWindowDrafts({
    nights: [night({ hasActionedSuggestion: true })],
    buckets: BUCKETS,
    cfg: CFG,
    recentRejected: new Map()
  });
  assert.equal(drafts.length, 0);
});

test("event nights surface as held-back holds, not silent skips", () => {
  const { drafts, blocked } = buildRecsWindowDrafts({
    nights: [night({ eventAdjustmentPct: 40 })],
    buckets: BUCKETS,
    cfg: CFG,
    recentRejected: new Map()
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].detail?.suppressed, "event");
  assert.equal(drafts[0].proposedValue, drafts[0].oldValue);
  assert.ok((drafts[0].revenueAtRisk ?? 0) > 0); // at risk, drop withheld
  assert.equal(blocked.event, 1);
});

test("cumulative-cap nights surface the anti-ratchet stop", () => {
  const { drafts, blocked } = buildRecsWindowDrafts({
    nights: [night({ cumulativeDropPct: 0.3 })],
    buckets: BUCKETS,
    cfg: CFG,
    recentRejected: new Map()
  });
  assert.equal(drafts[0].detail?.suppressed, "cumulative_cap");
  assert.equal(blocked.cumulative_cap, 1);
});

test("a rejection inside the memory window stands when the price basis is unchanged", () => {
  const recentRejected = new Map([
    ["l1|2026-07-25", { actionedAt: new Date("2026-07-23T09:00:00Z"), oldValueAtAction: 100 }]
  ]);
  const { drafts, blocked } = buildRecsWindowDrafts({ nights: [night({})], buckets: BUCKETS, cfg: CFG, recentRejected });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].detail?.suppressed, "recently_actioned");
  assert.equal(drafts[0].proposedValue, 100);
  assert.match(drafts[0].reason, /decision stands/);
  assert.equal(blocked.recently_actioned, 1);
});

test("a rejection is re-suggested when the world moved materially (price basis shifted)", () => {
  const recentRejected = new Map([
    ["l1|2026-07-25", { actionedAt: new Date("2026-07-23T09:00:00Z"), oldValueAtAction: 80 }]
  ]);
  const { drafts } = buildRecsWindowDrafts({ nights: [night({})], buckets: BUCKETS, cfg: CFG, recentRejected });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].detail?.suppressed, undefined);
  assert.ok(drafts[0].proposedValue < 100);
});

test("the composer resizes the drop and its components land in reason + detail", () => {
  const { drafts } = buildRecsWindowDrafts({
    nights: [night({})],
    buckets: BUCKETS,
    cfg: {
      ...CFG,
      composeNight: (_night, judged) => ({
        dropPct: Math.min(0.3, judged.dropPct * 2),
        hold: false,
        components: ["evidence: deepened (test)"]
      })
    },
    recentRejected: new Map()
  });
  const d = drafts[0];
  assert.match(d.reason, /deepened \(test\)/);
  assert.ok(d.detail?.sizing);
  assert.ok((d.detail?.sizing?.finalDropPct ?? 0) > (d.detail?.sizing?.baseDropPct ?? 1) - 1e-9);
});

test("a composer hold produces a hold row carrying the sizing trail", () => {
  const { drafts } = buildRecsWindowDrafts({
    nights: [night({})],
    buckets: BUCKETS,
    cfg: {
      ...CFG,
      composeNight: () => ({ dropPct: 0, hold: true, components: ["market: hot — hold instead of drop"] })
    },
    recentRejected: new Map()
  });
  assert.equal(drafts[0].detail?.hold, true);
  assert.equal(drafts[0].proposedValue, drafts[0].oldValue);
  assert.match(drafts[0].reason, /hold instead of drop/);
});

test("composer output is floor-clamped — evidence can never push below the minimum", () => {
  const { drafts, blocked } = buildRecsWindowDrafts({
    nights: [night({ floor: 99 })],
    buckets: BUCKETS,
    cfg: { ...CFG, composeNight: (_n, j) => ({ dropPct: Math.max(j.dropPct, 0.25), hold: false, components: ["deep"] }) },
    recentRejected: new Map()
  });
  // clamped to ceil(99)=99 which is < rate 100 → a 1-unit drop survives…
  assert.equal(drafts[0].proposedValue, 99);
  assert.equal(blocked.min_floor ?? 0, 0);
});

test("fully-clamped drops become min_floor holds", () => {
  const { drafts, blocked } = buildRecsWindowDrafts({
    nights: [night({ floor: 100 })],
    buckets: BUCKETS,
    cfg: CFG,
    recentRejected: new Map()
  });
  assert.equal(drafts[0].detail?.suppressed, "min_floor");
  assert.equal(drafts[0].proposedValue, drafts[0].oldValue);
  assert.equal(blocked.min_floor, 1);
});

test("allowBelowFloor: the drop may propose below the floor, flagged on detail, floor still displayed", () => {
  const { drafts, blocked } = buildRecsWindowDrafts({
    nights: [night({ floor: 95 })],
    buckets: BUCKETS,
    cfg: {
      ...CFG,
      allowBelowFloor: true,
      composeNight: () => ({ dropPct: 0.25, hold: false, components: ["deep (test)"] })
    },
    recentRejected: new Map()
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].proposedValue, 75); // 100 × (1 − 0.25), UNclamped
  assert.equal(drafts[0].detail?.allowBelowFloor, true);
  assert.equal(drafts[0].detail?.floor, 95); // display value survives
  assert.equal(blocked.min_floor ?? 0, 0);
});

test("allowBelowFloor off (default): same night clamps to the floor", () => {
  const { drafts } = buildRecsWindowDrafts({
    nights: [night({ floor: 95 })],
    buckets: BUCKETS,
    cfg: { ...CFG, composeNight: () => ({ dropPct: 0.25, hold: false, components: ["deep (test)"] }) },
    recentRejected: new Map()
  });
  assert.equal(drafts[0].proposedValue, 95);
  assert.equal(drafts[0].detail?.allowBelowFloor, undefined);
});
