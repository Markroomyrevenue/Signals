import assert from "node:assert/strict";
import { test } from "node:test";

import type { RecsNightView } from "./data";
import {
  buildListingRuns,
  distributeRunTotal,
  weekendSignal,
  SOLO_DROP_DEVIATION_PP,
  WEEKEND_SPLIT_MIN_GAP
} from "./runs";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function night(date: string, overrides: Partial<RecsNightView> = {}): RecsNightView {
  const dow = DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const currentPrice = overrides.currentPrice ?? 150;
  const recommendedPrice = overrides.recommendedPrice ?? 135;
  return {
    suggestionId: `s-${date}`,
    listingId: "l1",
    date,
    dow,
    currentPrice,
    recommendedPrice,
    changePct: currentPrice ? (recommendedPrice! - currentPrice) / currentPrice : null,
    kind: "drop",
    suppressed: null,
    revenueAtRisk: currentPrice,
    why: "",
    whyShort: "",
    sizingComponents: [],
    confidence: 0.7,
    curveCohort: null,
    provenance: "warm-start",
    provisional: true,
    status: "pending",
    actionedAt: null,
    actionedByEmail: null,
    approvedPrice: null,
    floor: 90,
    floorUnknown: false,
    allowBelowFloor: false,
    occFactor: 0.5,
    soloReason: null,
    groupedInRun: false,
    push: null,
    oversight: null,
    ...overrides
  };
}

test("three consecutive drop nights group into one run with totals (Mark's Crest Road example)", () => {
  const { runs, groupedIds } = buildListingRuns([
    night("2026-07-21"),
    night("2026-07-22"),
    night("2026-07-23")
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].nightsCount, 3);
  assert.equal(runs[0].totalCurrent, 450);
  assert.equal(runs[0].totalProposed, 405);
  assert.ok(runs[0].uniformPct !== null, "identical sizing reads as one percentage");
  assert.equal(groupedIds.size, 3);
});

test("a booked/missing night breaks the run; singles stay individual", () => {
  const { runs } = buildListingRuns([night("2026-07-21"), night("2026-07-23"), night("2026-07-24")]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].dateFrom, "2026-07-23");
});

test("holds, actioned and suppressed nights never group", () => {
  const { runs } = buildListingRuns([
    night("2026-07-21", { kind: "hold", recommendedPrice: 150 }),
    night("2026-07-22", { status: "approved" }),
    night("2026-07-23", { suppressed: "cumulative_cap" }),
    night("2026-07-24")
  ]);
  assert.equal(runs.length, 0);
});

test("weekend split fires ONLY when the listing's own DOW factors differ enough", () => {
  // Tue 21 → Sat 25 with weekend occ factors far above weekday.
  const strong = [
    night("2026-07-21", { occFactor: 0.4 }),
    night("2026-07-22", { occFactor: 0.4 }),
    night("2026-07-23", { occFactor: 0.4 }),
    night("2026-07-24", { occFactor: 0.4 + WEEKEND_SPLIT_MIN_GAP + 0.1 }),
    night("2026-07-25", { occFactor: 0.4 + WEEKEND_SPLIT_MIN_GAP + 0.1 })
  ];
  const split = buildListingRuns(strong);
  assert.equal(split.runs.length, 2);
  assert.deepEqual(split.runs.map((r) => r.segment).sort(), ["weekday", "weekend"]);
  assert.match(split.runs.find((r) => r.segment === "weekday")!.why.join(" "), /split so each runs on its own pattern/);

  // Same dates, no meaningful gap → one mixed run, no split.
  const flat = strong.map((n) => ({ ...n, occFactor: 0.5 }));
  const noSplit = buildListingRuns(flat);
  assert.equal(noSplit.runs.length, 1);
  assert.equal(noSplit.runs[0].segment, "mixed");
});

test("a night whose sizing stands apart is pulled out with a written reason (judgement call)", () => {
  const { runs, soloReasons } = buildListingRuns([
    night("2026-07-21"),
    night("2026-07-22"),
    night("2026-07-23", {
      recommendedPrice: 150 - (SOLO_DROP_DEVIATION_PP + 12) * 1.5, // far deeper drop
      changePct: -((SOLO_DROP_DEVIATION_PP + 12) / 100)
    }),
    night("2026-07-24")
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].nightsCount, 3);
  const reason = soloReasons.get("s-2026-07-23");
  assert.ok(reason && /stands apart/.test(reason));
});

test("a high-priced demand date is kept individual with the demand-date reason", () => {
  const { runs, soloReasons } = buildListingRuns([
    night("2026-07-21"),
    night("2026-07-22", { currentPrice: 400, recommendedPrice: 360, changePct: -0.1 }),
    night("2026-07-23")
  ]);
  assert.equal(runs.length, 1);
  assert.match(soloReasons.get("s-2026-07-22") ?? "", /likely a demand date/);
});

test("weekendSignal is null without data on both sides", () => {
  assert.equal(weekendSignal([night("2026-07-21"), night("2026-07-22")]), null);
});

test("distributeRunTotal keeps shares, rounds, and lands the total on the priciest night", () => {
  const { prices, total, notes } = distributeRunTotal(
    [
      { suggestionId: "a", proposed: 200, floor: 90, allowBelowFloor: false },
      { suggestionId: "b", proposed: 100, floor: 90, allowBelowFloor: false },
      { suggestionId: "c", proposed: 100, floor: 90, allowBelowFloor: false }
    ],
    380
  );
  assert.equal(total, 380);
  assert.equal(prices.get("a"), 190);
  assert.equal(prices.get("b"), 95);
  assert.equal(prices.get("c"), 95);
  assert.equal(notes.length, 0);
});

test("distributeRunTotal honours a typed total below floors and names the below-floor nights (Mark, 2026-07-20)", () => {
  // A typed run total is the operator's call: floors no longer clamp the
  // split — the notes call out each night that lands below its floor.
  const below = distributeRunTotal(
    [
      { suggestionId: "a", proposed: 100, floor: 95, allowBelowFloor: false },
      { suggestionId: "b", proposed: 100, floor: 95, allowBelowFloor: false }
    ],
    170 // 85 + 85, both under the £95 floors
  );
  assert.equal(below.prices.get("a"), 85);
  assert.equal(below.prices.get("b"), 85);
  assert.equal(below.total, 170);
  assert.equal(below.notes.filter((n) => /below the £95 floor — your call/.test(n)).length, 2);

  // At-or-above floors: no notes.
  const clean = distributeRunTotal(
    [
      { suggestionId: "a", proposed: 100, floor: 95, allowBelowFloor: false },
      { suggestionId: "b", proposed: 100, floor: 95, allowBelowFloor: false }
    ],
    200
  );
  assert.equal(clean.total, 200);
  assert.equal(clean.notes.length, 0);
});

test("three consecutive on-pace holds group into one hold run (Mark, 2026-07-19)", () => {
  const holds = ["2026-07-21", "2026-07-22", "2026-07-23"].map((d) =>
    night(d, { kind: "hold", recommendedPrice: 150, changePct: 0 })
  );
  const { runs, groupedIds } = buildListingRuns(holds);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runKind, "hold");
  assert.equal(runs[0].nightsCount, 3);
  assert.equal(runs[0].totalCurrent, 450);
  assert.equal(runs[0].totalProposed, 450);
  assert.match(runs[0].why.join(" "), /one decision covers the run/);
  assert.equal(groupedIds.size, 3);
});

test("suppressed holds stay individual; a gap breaks a hold run", () => {
  const { runs } = buildListingRuns([
    night("2026-07-21", { kind: "hold", recommendedPrice: 150, changePct: 0 }),
    night("2026-07-22", { kind: "hold", recommendedPrice: 150, changePct: 0, suppressed: "recently_actioned" }),
    night("2026-07-23", { kind: "hold", recommendedPrice: 150, changePct: 0 })
  ]);
  assert.equal(runs.length, 0); // the suppressed middle night breaks the chain
});

test("drops and holds group into separate runs on the same listing", () => {
  const { runs } = buildListingRuns([
    night("2026-07-21"),
    night("2026-07-22"),
    night("2026-07-23", { kind: "hold", recommendedPrice: 150, changePct: 0 }),
    night("2026-07-24", { kind: "hold", recommendedPrice: 150, changePct: 0 })
  ]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.runKind), ["drop", "hold"]);
});
