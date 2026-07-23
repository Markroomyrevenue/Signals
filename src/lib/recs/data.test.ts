/**
 * Tests for the recs read-layer night reconciliation (`resolveNightRows`) — the
 * one-row-per-night tie-break, including the near-term late-drop relaxation
 * (DECISIONS 2026-07-22 option a): a fresh pending re-drop wins over the
 * decision it supersedes and carries that decision as `priorAction`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyLiveCurrentPrice,
  buildLiveRateMap,
  liveRateKey,
  resolveNightRows,
  type RecsNightView
} from "./data";

function row(overrides: Partial<RecsNightView> & { suggestionId: string }): RecsNightView {
  return {
    listingId: "l1",
    date: "2026-07-25",
    dow: "Sat",
    currentPrice: 100,
    recommendedPrice: 90,
    changePct: -0.1,
    kind: "drop",
    suppressed: null,
    revenueAtRisk: 100,
    why: "",
    whyShort: "",
    sizingComponents: [],
    confidence: 0.5,
    curveCohort: null,
    provenance: "live-observed",
    provisional: false,
    status: "pending",
    createdAt: null,
    actionedAt: null,
    actionedByEmail: null,
    approvedPrice: null,
    priorAction: null,
    floor: 70,
    floorUnknown: false,
    allowBelowFloor: false,
    occFactor: null,
    soloReason: null,
    groupedInRun: false,
    push: null,
    oversight: null,
    currentPriceSource: "generated",
    currentPriceWas: null,
    supersededByLivePrice: false,
    ...overrides
  };
}

test("pending-only night: the pending row is the live tile", () => {
  const out = resolveNightRows([row({ suggestionId: "p1", createdAt: "2026-07-24T05:30:00Z" })], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "pending");
  assert.equal(out[0].priorAction, null);
});

test("actioned-only night: the decision stands as the row", () => {
  const out = resolveNightRows(
    [],
    [row({ suggestionId: "a1", status: "applied", actionedAt: "2026-07-23T09:00:00Z", approvedPrice: 90 })]
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "applied");
});

test("fresh re-drop (created after the decision) wins the tile and carries the prior decision", () => {
  const applied = row({
    suggestionId: "a1",
    status: "applied",
    actionedAt: "2026-07-23T09:00:00Z",
    recommendedPrice: 90,
    approvedPrice: 88
  });
  const redrop = row({ suggestionId: "p1", status: "pending", createdAt: "2026-07-24T05:30:00Z", recommendedPrice: 80 });
  const out = resolveNightRows([redrop], [applied]);
  assert.equal(out.length, 1);
  assert.equal(out[0].suggestionId, "p1"); // the live re-drop
  assert.equal(out[0].status, "pending");
  assert.ok(out[0].priorAction); // the beaten decision rides along as history
  assert.equal(out[0].priorAction?.status, "applied");
  assert.equal(out[0].priorAction?.approvedPrice, 88);
});

test("a pending HOLD never beats a decision (decision stands as history)", () => {
  const applied = row({ suggestionId: "a1", status: "applied", actionedAt: "2026-07-23T09:00:00Z", approvedPrice: 88 });
  const hold = row({
    suggestionId: "p1",
    status: "pending",
    kind: "hold",
    createdAt: "2026-07-24T05:30:00Z",
    recommendedPrice: 100
  });
  const out = resolveNightRows([hold], [applied]);
  assert.equal(out.length, 1);
  assert.equal(out[0].suggestionId, "a1"); // the decision, not the hold
  assert.equal(out[0].status, "applied");
});

test("a suppressed pending row never beats a decision", () => {
  const rejected = row({ suggestionId: "a1", status: "rejected", actionedAt: "2026-07-23T09:00:00Z" });
  const suppressed = row({
    suggestionId: "p1",
    status: "pending",
    suppressed: "recently_actioned",
    createdAt: "2026-07-24T05:30:00Z"
  });
  const out = resolveNightRows([suppressed], [rejected]);
  assert.equal(out.length, 1);
  assert.equal(out[0].suggestionId, "a1"); // rejection stands (ignored history)
});

test("a fresh re-drop NEVER supersedes an unresolved push (mismatch stays live + retryable)", () => {
  // Yesterday's approved drop verify-mismatched → stays status "approved",
  // push.verified=false, not reverted. It MUST remain the live tile so the
  // operator can retry; a fresh re-drop must not hide the wrong engine price.
  const unresolved = row({
    suggestionId: "a1",
    status: "approved",
    actionedAt: "2026-07-23T09:00:00Z",
    approvedPrice: 88,
    push: { pushed: true, verified: false, reverted: false, error: null }
  });
  const redrop = row({ suggestionId: "p1", status: "pending", createdAt: "2026-07-24T05:30:00Z", recommendedPrice: 80 });
  const out = resolveNightRows([redrop], [unresolved]);
  assert.equal(out.length, 1);
  assert.equal(out[0].suggestionId, "a1"); // the unresolved push wins, not the re-drop
  assert.equal(out[0].priorAction, null); // and it is NOT demoted to history
});

test("a pending drop created BEFORE the action does not beat it (no stale re-drop)", () => {
  const applied = row({ suggestionId: "a1", status: "applied", actionedAt: "2026-07-24T09:00:00Z", approvedPrice: 88 });
  const stale = row({ suggestionId: "p1", status: "pending", createdAt: "2026-07-24T05:30:00Z" });
  const out = resolveNightRows([stale], [applied]);
  assert.equal(out.length, 1);
  assert.equal(out[0].suggestionId, "a1"); // the newer decision wins
});

test("among competing actioned rows the newest decision wins", () => {
  const older = row({ suggestionId: "a1", status: "applied", actionedAt: "2026-07-22T09:00:00Z", approvedPrice: 95 });
  const newer = row({ suggestionId: "a2", status: "applied", actionedAt: "2026-07-24T09:00:00Z", approvedPrice: 80 });
  const out = resolveNightRows([], [older, newer]);
  assert.equal(out.length, 1);
  assert.equal(out[0].suggestionId, "a2");
});

// ---------------------------------------------------------------------------
// Live current-price overlay (2026-07-23) — recs freeze `oldValue` at 05:30,
// CalendarRate is re-read hourly, so the tile must quote the live rate.
// ---------------------------------------------------------------------------

function rateRow(over: Partial<{ listingId: string; date: Date; available: boolean; rate: unknown }> = {}) {
  return { listingId: "l1", date: new Date("2026-07-25T00:00:00Z"), available: true, rate: 120, ...over };
}

test("buildLiveRateMap keeps open nights and drops booked ones", () => {
  const map = buildLiveRateMap([
    rateRow(),
    rateRow({ date: new Date("2026-07-26T00:00:00Z"), available: false, rate: 200 })
  ]);
  assert.equal(map.get(liveRateKey("l1", "2026-07-25")), 120);
  // A booked night has no sellable price — quoting one would mislead.
  assert.equal(map.has(liveRateKey("l1", "2026-07-26")), false);
});

test("buildLiveRateMap ignores zero and non-numeric rates", () => {
  const map = buildLiveRateMap([rateRow({ rate: 0 }), rateRow({ date: new Date("2026-07-26T00:00:00Z"), rate: null })]);
  assert.equal(map.size, 0);
});

test("live rate replaces the frozen price and recomputes the percentage", () => {
  const [out] = applyLiveCurrentPrice(
    [row({ suggestionId: "p1", currentPrice: 100, recommendedPrice: 90, changePct: -0.1 })],
    new Map([[liveRateKey("l1", "2026-07-25"), 120]])
  );
  assert.equal(out.currentPrice, 120);
  assert.equal(out.currentPriceSource, "live");
  assert.equal(out.currentPriceWas, 100); // the 05:30 photograph, for "was £100"
  assert.equal(out.changePct, (90 - 120) / 120); // NOT the stale -0.1
  assert.equal(out.supersededByLivePrice, false); // 90 is still below 120
});

test("an unmoved live rate reports live source but no 'was' value", () => {
  const [out] = applyLiveCurrentPrice(
    [row({ suggestionId: "p1", currentPrice: 120 })],
    new Map([[liveRateKey("l1", "2026-07-25"), 120]])
  );
  assert.equal(out.currentPriceSource, "live");
  assert.equal(out.currentPriceWas, null);
});

test("a drop whose live price fell below the recommendation is superseded", () => {
  const [out] = applyLiveCurrentPrice(
    [row({ suggestionId: "p1", currentPrice: 100, recommendedPrice: 90, kind: "drop" })],
    new Map([[liveRateKey("l1", "2026-07-25"), 85]])
  );
  // Pushing 90 against a live 85 would RAISE the price — the advice is stale.
  assert.equal(out.supersededByLivePrice, true);
});

test("a hold is never marked superseded", () => {
  const [out] = applyLiveCurrentPrice(
    [row({ suggestionId: "p1", currentPrice: 100, recommendedPrice: 100, kind: "hold" })],
    new Map([[liveRateKey("l1", "2026-07-25"), 85]])
  );
  assert.equal(out.supersededByLivePrice, false);
});

test("nights with no live rate keep the generated price", () => {
  const [out] = applyLiveCurrentPrice([row({ suggestionId: "p1", currentPrice: 100 })], new Map());
  assert.equal(out.currentPrice, 100);
  assert.equal(out.currentPriceSource, "generated");
  assert.equal(out.currentPriceWas, null);
});

test("actioned rows are never overlaid — they record a decision, not live advice", () => {
  const [out] = applyLiveCurrentPrice(
    [row({ suggestionId: "a1", status: "applied", currentPrice: 100, approvedPrice: 88 })],
    new Map([[liveRateKey("l1", "2026-07-25"), 200]])
  );
  assert.equal(out.currentPrice, 100);
  assert.equal(out.currentPriceSource, "generated");
});
