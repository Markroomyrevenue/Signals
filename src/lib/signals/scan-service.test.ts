import assert from "node:assert/strict";
import test from "node:test";

import type { HostawayCalendarRate } from "@/lib/hostaway/types";

import {
  collectRateCopyExclusionIds,
  diffListingCalendar,
  normalizeCalendar,
  type NormalizedDay,
  type PriorState,
  type RateCopySettingRow
} from "./scan-service";

function day(date: string, overrides: Partial<NormalizedDay> = {}): NormalizedDay {
  return { date, rate: 100, minStay: 2, available: true, currency: "GBP", ...overrides };
}

function priorOf(state: Partial<PriorState> = {}): PriorState {
  return { rate: 100, minStay: 2, available: true, ...state };
}

function rawRate(date: string, overrides: Partial<HostawayCalendarRate> = {}): HostawayCalendarRate {
  return { date, rate: 100, minStay: 2, available: true, currency: "GBP", raw: null, ...overrides };
}

test("normalizeCalendar dedupes by date (last wins), drops bad dates, and normalises fields", () => {
  const rows: HostawayCalendarRate[] = [
    rawRate("2026-06-01", { rate: 100, minStay: 2, currency: "gbp" }),
    rawRate("2026-06-01", { rate: 110, minStay: 0, currency: "gbp" }), // dup → last wins; minStay 0 → null
    rawRate("not-a-date", { rate: 50 }), // dropped
    rawRate("2026-06-03", { rate: 90, available: false, currency: "" }) // empty currency → GBP default
  ];

  const result = normalizeCalendar(rows);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { date: "2026-06-01", rate: 110, minStay: null, available: true, currency: "GBP" });
  assert.deepEqual(result[1], { date: "2026-06-03", rate: 90, minStay: 2, available: false, currency: "GBP" });
});

test("no change → zero RateChange drafts, but state is still seeded for next time", () => {
  const fresh = [day("2026-07-01")];
  const prior = new Map<string, PriorState>([["2026-07-01", priorOf()]]);

  const { changes, nextStates } = diffListingCalendar({ fresh, prior, yearlyAdrMedian: 200 });

  assert.equal(changes.length, 0);
  assert.equal(nextStates.length, 1);
});

test("first-seen date seeds RateState and emits no RateChange", () => {
  const fresh = [day("2026-07-02")];
  const prior = new Map<string, PriorState>(); // nothing seen yet

  const { changes, nextStates } = diffListingCalendar({ fresh, prior, yearlyAdrMedian: 200 });

  assert.equal(changes.length, 0);
  assert.equal(nextStates.length, 1);
  assert.equal(nextStates[0].date, "2026-07-02");
});

test("price move above epsilon emits a price change with changePct and pctOfYearlyAdr", () => {
  const fresh = [day("2026-07-03", { rate: 130 })];
  const prior = new Map<string, PriorState>([["2026-07-03", priorOf({ rate: 100 })]]);

  const { changes } = diffListingCalendar({ fresh, prior, yearlyAdrMedian: 200 });

  assert.equal(changes.length, 1);
  const change = changes[0];
  assert.equal(change.lever, "price");
  assert.equal(change.oldValue, 100);
  assert.equal(change.newValue, 130);
  assert.ok(Math.abs((change.changePct ?? 0) - 0.3) < 1e-9);
  assert.equal(change.yearlyAdrMedian, 200);
  assert.ok(Math.abs((change.pctOfYearlyAdr ?? 0) - 0.65) < 1e-9); // 130 / 200
});

test("price move below epsilon is ignored as float dust", () => {
  const fresh = [day("2026-07-04", { rate: 100.005 })];
  const prior = new Map<string, PriorState>([["2026-07-04", priorOf({ rate: 100 })]]);

  const { changes } = diffListingCalendar({ fresh, prior, yearlyAdrMedian: 200 });

  assert.equal(changes.length, 0);
});

test("pctOfYearlyAdr is null when the baseline is null, but changePct is still recorded", () => {
  const fresh = [day("2026-07-05", { rate: 120 })];
  const prior = new Map<string, PriorState>([["2026-07-05", priorOf({ rate: 100 })]]);

  const { changes } = diffListingCalendar({ fresh, prior, yearlyAdrMedian: null });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].pctOfYearlyAdr, null);
  assert.equal(changes[0].yearlyAdrMedian, null);
  assert.ok(Math.abs((changes[0].changePct ?? 0) - 0.2) < 1e-9);
});

test("min-stay change emits a single min_stay row with no price math", () => {
  const fresh = [day("2026-07-06", { minStay: 3 })];
  const prior = new Map<string, PriorState>([["2026-07-06", priorOf({ minStay: 2 })]]);

  const { changes } = diffListingCalendar({ fresh, prior, yearlyAdrMedian: 200 });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].lever, "min_stay");
  assert.equal(changes[0].oldValue, 2);
  assert.equal(changes[0].newValue, 3);
  assert.equal(changes[0].changePct, null);
  assert.equal(changes[0].yearlyAdrMedian, null);
});

test("availability open→close and close→open each emit an availability row encoded 1/0", () => {
  const closeFresh = [day("2026-07-07", { available: false })];
  const closePrior = new Map<string, PriorState>([["2026-07-07", priorOf({ available: true })]]);
  const closed = diffListingCalendar({ fresh: closeFresh, prior: closePrior, yearlyAdrMedian: 200 });
  assert.equal(closed.changes.length, 1);
  assert.equal(closed.changes[0].lever, "availability");
  assert.equal(closed.changes[0].oldValue, 1);
  assert.equal(closed.changes[0].newValue, 0);

  const openFresh = [day("2026-07-08", { available: true })];
  const openPrior = new Map<string, PriorState>([["2026-07-08", priorOf({ available: false })]]);
  const opened = diffListingCalendar({ fresh: openFresh, prior: openPrior, yearlyAdrMedian: 200 });
  assert.equal(opened.changes.length, 1);
  assert.equal(opened.changes[0].lever, "availability");
  assert.equal(opened.changes[0].oldValue, 0);
  assert.equal(opened.changes[0].newValue, 1);
});

test("multiple levers can move on the same date in one diff", () => {
  const fresh = [day("2026-07-09", { rate: 150, minStay: 4, available: false })];
  const prior = new Map<string, PriorState>([["2026-07-09", priorOf({ rate: 100, minStay: 2, available: true })]]);

  const { changes } = diffListingCalendar({ fresh, prior, yearlyAdrMedian: 200 });

  const levers = changes.map((c) => c.lever).sort();
  assert.deepEqual(levers, ["availability", "min_stay", "price"]);
});

function settingRow(scopeRef: string | null, settings: RateCopySettingRow["settings"]): RateCopySettingRow {
  return { scopeRef, settings };
}

test("rate-copy exclusion set includes BOTH the target (scopeRef) and the source listing id", () => {
  const rows = [
    settingRow("L-target", { pricingMode: "rate_copy", rateCopySourceListingId: "L-source" })
  ];

  const excluded = collectRateCopyExclusionIds(rows);

  assert.equal(excluded.size, 2);
  assert.ok(excluded.has("L-target"));
  assert.ok(excluded.has("L-source"));
});

test("non-rate_copy property rows contribute nothing to the exclusion set", () => {
  const rows = [
    settingRow("L-standard", { pricingMode: "standard", rateCopySourceListingId: "L-x" }),
    settingRow("L-live", { pricingMode: "hostaway_live" }),
    settingRow("L-empty", {})
  ];

  const excluded = collectRateCopyExclusionIds(rows);

  assert.equal(excluded.size, 0);
});

test("a rate_copy row with no source excludes only the target listing", () => {
  const rows = [
    settingRow("L-target-only", { pricingMode: "rate_copy" }),
    settingRow("L-null-source", { pricingMode: "rate_copy", rateCopySourceListingId: null }),
    settingRow("L-blank-source", { pricingMode: "rate_copy", rateCopySourceListingId: "   " })
  ];

  const excluded = collectRateCopyExclusionIds(rows);

  assert.deepEqual([...excluded].sort(), ["L-blank-source", "L-null-source", "L-target-only"]);
});

test("excluded rate-copy listings are filtered out before scanning; others remain", () => {
  const rows = [
    settingRow("L-target", { pricingMode: "rate_copy", rateCopySourceListingId: "L-source" }),
    settingRow("L-standard", { pricingMode: "standard" })
  ];
  const excluded = collectRateCopyExclusionIds(rows);

  const activeListings = [{ id: "L-target" }, { id: "L-source" }, { id: "L-standard" }, { id: "L-keep" }];
  const scanned = activeListings.filter((listing) => !excluded.has(listing.id));

  assert.deepEqual(
    scanned.map((listing) => listing.id),
    ["L-standard", "L-keep"]
  );
  assert.equal(activeListings.length - scanned.length, 2); // the excludedCount the scan reports
});
