import assert from "node:assert/strict";
import { test } from "node:test";

import type { RecsNightView } from "./data";
import type { RecsRunView } from "./runs";
import {
  CALENDAR_CONTEXT_DAYS,
  buildBookedAtByListing,
  buildBookedByListing,
  buildRateContextByListing,
  calendarWindow,
  historyFromNight,
  isUnresolvedPush,
  londonToday,
  nightToCalendar,
  resolveListingMin,
  roundedOrNull,
  runToCalendar
} from "./calendar-data";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function night(date: string, overrides: Partial<RecsNightView> = {}): RecsNightView {
  const dow = DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const currentPrice = overrides.currentPrice !== undefined ? overrides.currentPrice : 150;
  const recommendedPrice = overrides.recommendedPrice !== undefined ? overrides.recommendedPrice : 135;
  return {
    suggestionId: `s-${date}`,
    listingId: "l1",
    date,
    dow,
    currentPrice,
    recommendedPrice,
    changePct:
      currentPrice && recommendedPrice !== null ? (recommendedPrice - currentPrice) / currentPrice : null,
    kind: "drop",
    suppressed: null,
    revenueAtRisk: currentPrice,
    why: "behind pace; curve: expected 60%, actual 20%",
    whyShort: "behind pace",
    sizingComponents: ["base −10%"],
    confidence: 0.5,
    curveCohort: null,
    provenance: "live-observed",
    provisional: false,
    status: "pending",
    actionedAt: null,
    actionedByEmail: null,
    approvedPrice: null,
    floor: 100,
    floorUnknown: false,
    allowBelowFloor: false,
    occFactor: null,
    soloReason: null,
    groupedInRun: false,
    push: null,
    oversight: null,
    ...overrides
  };
}

function utc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

// ---------------------------------------------------------------------------
// Date window
// ---------------------------------------------------------------------------

test("londonToday: the 00:00-01:00 BST hour still counts as the NEW London day", () => {
  // 23:30 UTC on the 19th is 00:30 BST on the 20th.
  assert.equal(toIso(londonToday(new Date("2026-07-19T23:30:00Z"))), "2026-07-20");
  // Winter (GMT): UTC and London agree.
  assert.equal(toIso(londonToday(new Date("2026-01-19T23:30:00Z"))), "2026-01-19");
});

test("calendarWindow: today..today+30 inclusive, keyed on the London day", () => {
  const window = calendarWindow(new Date("2026-07-19T12:00:00Z"));
  assert.equal(window.today, "2026-07-19");
  assert.equal(toIso(window.start), "2026-07-19");
  assert.equal(toIso(window.end), "2026-08-18");
  assert.equal((window.end.getTime() - window.start.getTime()) / 86_400_000, CALENDAR_CONTEXT_DAYS);
});

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Night + run mapping
// ---------------------------------------------------------------------------

test("nightToCalendar: why carries the short line, whyFull the full sentence", () => {
  const mapped = nightToCalendar(night("2026-07-21"));
  assert.equal(mapped.id, "s-2026-07-21");
  assert.equal(mapped.date, "2026-07-21");
  assert.equal(mapped.dow, "Tue");
  assert.equal(mapped.cur, 150);
  assert.equal(mapped.rec, 135);
  assert.equal(mapped.pct, (135 - 150) / 150);
  assert.equal(mapped.kind, "drop");
  assert.equal(mapped.sup, null);
  assert.equal(mapped.why, "behind pace");
  assert.equal(mapped.whyFull, "behind pace; curve: expected 60%, actual 20%");
  assert.deepEqual(mapped.comp, ["base −10%"]);
  assert.equal(mapped.floor, 100);
  assert.equal(mapped.floorUnknown, false);
  assert.equal(mapped.status, "pending");
  assert.equal(mapped.ov, null);
});

test("nightToCalendar: an actioned row's rec is the APPROVED price (edited numbers survive reload)", () => {
  const mapped = nightToCalendar(night("2026-07-21", { status: "applied", approvedPrice: 128 }));
  assert.equal(mapped.rec, 128);
});

test("nightToCalendar: push outcome passes through (the UI needs it — status alone can't tell verified from mismatch)", () => {
  const clean = nightToCalendar(night("2026-07-21"));
  assert.equal(clean.push, null);
  const mismatched = nightToCalendar(
    night("2026-07-21", { status: "approved", push: { pushed: true, verified: false, reverted: false, error: null } })
  );
  assert.deepEqual(mismatched.push, { pushed: true, verified: false, reverted: false, error: null });
});

test("nightToCalendar: oversight passes through; null current price falls back to 0", () => {
  const ov = { verdict: "endorse", reason: null, narrative: "sensible" };
  const mapped = nightToCalendar(night("2026-07-22", { currentPrice: null, changePct: null, oversight: ov }));
  assert.equal(mapped.cur, 0);
  assert.equal(mapped.pct, null);
  assert.deepEqual(mapped.ov, ov);
});

test("runToCalendar: field-for-field ribbon mapping", () => {
  const run: RecsRunView = {
    kind: "run",
    runKind: "drop",
    listingId: "l1",
    suggestionIds: ["a", "b"],
    dateFrom: "2026-07-29",
    dateTo: "2026-07-30",
    nightsCount: 2,
    segment: "weekday",
    totalCurrent: 298,
    totalProposed: 277,
    uniformPct: -0.07,
    why: ["all 2 nights size to ~7%"],
    nights: [night("2026-07-29"), night("2026-07-30")]
  };
  assert.deepEqual(runToCalendar(run), {
    ids: ["a", "b"],
    from: "2026-07-29",
    to: "2026-07-30",
    n: 2,
    runKind: "drop",
    seg: "weekday",
    totCur: 298,
    totRec: 277,
    uniformPct: -0.07,
    why: ["all 2 nights size to ~7%"]
  });
});

// ---------------------------------------------------------------------------
// Min column + Decimal handling
// ---------------------------------------------------------------------------

test("resolveListingMin: snapshot min wins; else the lowest night floor; else null", () => {
  const nights = [nightToCalendar(night("2026-07-21", { floor: 110 })), nightToCalendar(night("2026-07-22", { floor: 95 }))];
  assert.equal(resolveListingMin(180, nights), 180);
  assert.equal(resolveListingMin(null, nights), 95);
  assert.equal(resolveListingMin(null, [nightToCalendar(night("2026-07-23", { floor: null, floorUnknown: true }))]), null);
  assert.equal(resolveListingMin(null, []), null);
});

test("roundedOrNull: rounds Decimal-ish values, null when absent or junk", () => {
  assert.equal(roundedOrNull("179.6"), 180);
  assert.equal(roundedOrNull(250.4), 250);
  assert.equal(roundedOrNull(null), null);
  assert.equal(roundedOrNull(undefined), null);
  assert.equal(roundedOrNull("not-a-number"), null);
});

// ---------------------------------------------------------------------------
// Booked + rate context maps
// ---------------------------------------------------------------------------

test("buildBookedByListing: sums per date, excludes ownerstay, groups by listing", () => {
  const map = buildBookedByListing([
    { listingId: "l1", date: utc("2026-07-21"), status: "confirmed", revenueAllocated: "100.5" },
    // Multi-unit second factKey on the same date sums in.
    { listingId: "l1", date: utc("2026-07-21"), status: "confirmed", revenueAllocated: 49.5 },
    { listingId: "l1", date: utc("2026-07-22"), status: "ownerstay", revenueAllocated: 999 },
    { listingId: "l2", date: utc("2026-07-21"), status: null, revenueAllocated: 80 }
  ]);
  assert.deepEqual(map.get("l1"), { "2026-07-21": 150 });
  assert.deepEqual(map.get("l2"), { "2026-07-21": 80 });
});

test("buildRateContextByListing: minStay kept on any row, live only on OPEN days (rounded)", () => {
  const map = buildRateContextByListing([
    { listingId: "l1", date: utc("2026-07-21"), available: true, minStay: 2, rate: "180.267857" },
    { listingId: "l1", date: utc("2026-07-22"), available: false, minStay: 2, rate: 210 },
    { listingId: "l1", date: utc("2026-07-23"), available: true, minStay: null, rate: 199.5 }
  ]);
  assert.deepEqual(map.get("l1"), {
    minStay: { "2026-07-21": 2, "2026-07-22": 2 },
    live: { "2026-07-21": 180, "2026-07-23": 200 }
  });
});

test("historyFromNight: a pending night is NOT history (still a live tile)", () => {
  assert.equal(historyFromNight(night("2026-07-21", { status: "pending" })), null);
});

test("historyFromNight: outcomes map — rejected→ignored, applied→pushed, approved-not-live→skipped", () => {
  assert.equal(historyFromNight(night("2026-07-21", { status: "rejected" }))?.outcome, "ignored");
  assert.equal(historyFromNight(night("2026-07-21", { status: "applied" }))?.outcome, "pushed");
  assert.equal(historyFromNight(night("2026-07-21", { status: "approved" }))?.outcome, "skipped");
});

test("historyFromNight: edited flag set when the pushed price differs from the recommendation", () => {
  const plain = historyFromNight(night("2026-07-21", { status: "applied", recommendedPrice: 135, approvedPrice: 135 }));
  assert.equal(plain?.edited, false);
  const edited = historyFromNight(night("2026-07-21", { status: "applied", recommendedPrice: 135, approvedPrice: 120 }));
  assert.equal(edited?.edited, true);
  assert.equal(edited?.recommended, 135);
  assert.equal(edited?.decided, 120);
});

test("buildBookedAtByListing: keeps the earliest booking-created time per date, ownerstay excluded", () => {
  const map = buildBookedAtByListing([
    { listingId: "l1", date: new Date("2026-07-21T00:00:00Z"), status: null, bookingCreatedAt: new Date("2026-07-20T10:00:00Z") },
    { listingId: "l1", date: new Date("2026-07-21T00:00:00Z"), status: null, bookingCreatedAt: new Date("2026-07-19T09:00:00Z") },
    { listingId: "l1", date: new Date("2026-07-22T00:00:00Z"), status: "ownerstay", bookingCreatedAt: new Date("2026-07-01T00:00:00Z") }
  ]);
  assert.equal(map.get("l1")?.["2026-07-21"], "2026-07-19T09:00:00.000Z");
  assert.equal(map.get("l1")?.["2026-07-22"], undefined);
});

test("isUnresolvedPush: only an approved, pushed-but-unverified, not-reverted night stays LIVE (mismatch kept off the history dot)", () => {
  const mismatch = night("2026-07-21", {
    status: "approved",
    push: { pushed: true, verified: false, reverted: false, error: null }
  });
  assert.equal(isUnresolvedPush(mismatch), true);
  // A verified push is terminal → history, not live.
  assert.equal(
    isUnresolvedPush(night("2026-07-21", { status: "applied", push: { pushed: true, verified: true, reverted: false, error: null } })),
    false
  );
  // Pending, rejected, and reverted are never "unresolved pushes".
  assert.equal(isUnresolvedPush(night("2026-07-21", { status: "pending" })), false);
  assert.equal(isUnresolvedPush(night("2026-07-21", { status: "rejected" })), false);
  assert.equal(
    isUnresolvedPush(night("2026-07-21", { status: "approved", push: { pushed: true, verified: false, reverted: true, error: null } })),
    false
  );
});
