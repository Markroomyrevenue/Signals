import assert from "node:assert/strict";
import test from "node:test";

import {
  GROUP_CURVE_MIN_BOOKINGS,
  GROUP_CURVE_MIN_LISTINGS,
  LISTING_CURVE_MIN_BOOKINGS,
  OCCUPANCY_MIN_SLOTS_PER_DOW,
  SIZE_BAND_CURVE_MIN_BOOKINGS,
  buildCohortCurveSet,
  buildCohortOccupancySet,
  groupTagsFor,
  isMultiUnit,
  normaliseCityKey,
  resolveCohortCurve,
  resolveCohortMemberships,
  resolveCohortOccupancy,
  sizeBandFor,
  summariseCohortCurveSet,
  type CohortListing,
  type CurveLeadFact,
  type OccupiedNightFact
} from "./cohorts";
import { expectedCumulativeFill, judgeNightForSuggestion } from "./suggestions";

function listing(id: string, over: Partial<CohortListing> = {}): CohortListing {
  return { id, tags: [], bedroomsNumber: 1, city: "Belfast", unitCount: 1, ...over };
}

/** `count` facts for one listing, each its own reservation, at a fixed lead. */
function facts(listingId: string, leadTimeDays: number, count: number): CurveLeadFact[] {
  return Array.from({ length: count }, (_, i) => ({
    listingId,
    leadTimeDays,
    reservationId: `${listingId}-res-${leadTimeDays}-${i}`
  }));
}

// ---- memberships (crossover expected) ----------------------------------------

test("resolveCohortMemberships: crossover across independent dimensions", () => {
  const m = resolveCohortMemberships(
    listing("l1", { tags: ["group:Argo", "group:City Centre", "seafront"], bedroomsNumber: 2, city: " Belfast " })
  );
  const keys = m.map((x) => `${x.dimension}|${x.cohortKey}`);
  assert.deepEqual(keys, [
    "listing|listing:l1",
    "group|group:Argo",
    "group|group:City Centre",
    "size_band|size:2",
    "city|city:belfast",
    "stock|stock:single-unit",
    "tenant|tenant"
  ]);
});

test("resolveCohortMemberships: multi-unit + no city + no groups", () => {
  const m = resolveCohortMemberships(listing("b1", { city: null, bedroomsNumber: null, unitCount: 40 }));
  const keys = m.map((x) => x.cohortKey);
  assert.deepEqual(keys, ["listing:b1", "size:0-1", "stock:multi-unit", "tenant"]);
});

test("dimension helpers: size bands, group tags, city normalisation, stock", () => {
  assert.equal(sizeBandFor(null), "0-1");
  assert.equal(sizeBandFor(1), "0-1");
  assert.equal(sizeBandFor(2), "2");
  assert.equal(sizeBandFor(5), "3+");
  assert.deepEqual(groupTagsFor([" group:Argo ", "GROUP:Argo x", "group:", "pets"]), ["GROUP:Argo x", "group:Argo"]);
  assert.equal(normaliseCityKey("  Saint   Andrews "), "saint andrews");
  assert.equal(normaliseCityKey("   "), null);
  assert.equal(isMultiUnit(null), false);
  assert.equal(isMultiUnit(2), true);
});

// ---- curve ladder gates -------------------------------------------------------

test("curve ladder: listing rung exactly at the bookings gate; one below falls back", () => {
  const listings = [listing("l1")];
  const at = buildCohortCurveSet({ listings, facts: facts("l1", 10, LISTING_CURVE_MIN_BOOKINGS) });
  assert.equal(resolveCohortCurve(at, "l1")?.provenance.rung, "listing");
  assert.equal(resolveCohortCurve(at, "l1")?.provenance.n, LISTING_CURVE_MIN_BOOKINGS);

  const below = buildCohortCurveSet({ listings, facts: facts("l1", 10, LISTING_CURVE_MIN_BOOKINGS - 1) });
  const resolved = resolveCohortCurve(below, "l1");
  // 99 bookings: no listing rung; l1 is the whole size band (99 < gate) so tenant.
  assert.equal(resolved?.provenance.rung, "tenant");
  assert.equal(resolved?.provenance.cohortKey, "tenant");
});

test("curve ladder: group needs BOTH >=3 member listings AND the pooled bookings gate", () => {
  const two = [listing("g1", { tags: ["group:Duo"] }), listing("g2", { tags: ["group:Duo"] })];
  const twoSet = buildCohortCurveSet({
    listings: two,
    facts: [...facts("g1", 10, 50), ...facts("g2", 10, 50)]
  });
  assert.notEqual(resolveCohortCurve(twoSet, "g1")?.provenance.rung, "group"); // 2 members < 3

  const three = [
    listing("g1", { tags: ["group:Trio"] }),
    listing("g2", { tags: ["group:Trio"] }),
    listing("g3", { tags: ["group:Trio"] })
  ];
  const atGate = buildCohortCurveSet({
    listings: three,
    facts: [...facts("g1", 10, 20), ...facts("g2", 10, 20), ...facts("g3", 10, GROUP_CURVE_MIN_BOOKINGS - 40)]
  });
  const resolvedAt = resolveCohortCurve(atGate, "g1");
  assert.equal(resolvedAt?.provenance.rung, "group");
  assert.equal(resolvedAt?.provenance.cohortKey, "group:Trio");
  assert.equal(resolvedAt?.provenance.n, GROUP_CURVE_MIN_BOOKINGS);

  const belowGate = buildCohortCurveSet({
    listings: three,
    facts: [...facts("g1", 10, 20), ...facts("g2", 10, 20), ...facts("g3", 10, GROUP_CURVE_MIN_BOOKINGS - 41)]
  });
  assert.notEqual(resolveCohortCurve(belowGate, "g1")?.provenance.rung, "group"); // pooled 59 < gate
});

test("curve ladder: size band pools single-unit stock; multi-unit listings skip the rung", () => {
  const listings = [
    listing("s1", { bedroomsNumber: 1 }),
    listing("s2", { bedroomsNumber: 1 }),
    listing("block", { bedroomsNumber: 1, unitCount: 40 })
  ];
  const set = buildCohortCurveSet({
    listings,
    facts: [
      ...facts("s1", 10, SIZE_BAND_CURVE_MIN_BOOKINGS - 10),
      ...facts("s2", 10, 10),
      ...facts("block", 50, 30) // multi-unit: must NOT pollute size:0-1
    ]
  });
  const flat = resolveCohortCurve(set, "s2");
  assert.equal(flat?.provenance.rung, "size_band");
  assert.equal(flat?.provenance.cohortKey, "size:0-1");
  assert.equal(flat?.provenance.n, SIZE_BAND_CURVE_MIN_BOOKINGS); // block's 30 bookings excluded
  // The block itself (30 bookings, no group) falls straight to tenant.
  assert.equal(resolveCohortCurve(set, "block")?.provenance.rung, "tenant");
});

test("curve set: facts from unknown (removed) listings count toward the tenant rung only", () => {
  const set = buildCohortCurveSet({ listings: [listing("l1")], facts: facts("ghost", 10, 30) });
  assert.equal(set.tenant?.bookings, 30);
  assert.equal(set.byListing.has("ghost"), false);
});

test("curve set: null reservationIds contribute nights but zero bookings", () => {
  const set = buildCohortCurveSet({
    listings: [listing("l1")],
    facts: Array.from({ length: 30 }, () => ({ listingId: "l1", leadTimeDays: 5, reservationId: null }))
  });
  assert.equal(set.tenant?.distribution.n, 30);
  assert.equal(set.tenant?.bookings, 0);
});

// ---- the audit's worked example: Argo (54d lead) vs St James (3d lead) --------
// reviews/observe-learn-2026-07/07-learning-granularity.md §2: same tenant,
// group:Argo median booking lead 54 days, group:St James Apartments 3 days.
// One pooled tenant curve judges both identically — false drops on the
// late-booking building, missed context on the early one.

function yoHouseFixture() {
  const listings = [
    listing("argo-1", { tags: ["group:Argo"] }),
    listing("argo-2", { tags: ["group:Argo"] }),
    listing("argo-3", { tags: ["group:Argo"] }),
    listing("sj-1", { tags: ["group:St James Apartments"] }),
    listing("sj-2", { tags: ["group:St James Apartments"] }),
    listing("sj-3", { tags: ["group:St James Apartments"] })
  ];
  const leadFacts = [
    ...facts("argo-1", 54, 25),
    ...facts("argo-2", 54, 25),
    ...facts("argo-3", 54, 25),
    ...facts("sj-1", 3, 25),
    ...facts("sj-2", 3, 25),
    ...facts("sj-3", 3, 25)
  ];
  return buildCohortCurveSet({ listings, facts: leadFacts });
}

test("worked example: Argo and St James resolve to their own group curves with provenance", () => {
  const set = yoHouseFixture();
  const argo = resolveCohortCurve(set, "argo-1");
  const stJames = resolveCohortCurve(set, "sj-1");
  assert.deepEqual(argo?.provenance, { rung: "group", cohortKey: "group:Argo", n: 75 });
  assert.deepEqual(stJames?.provenance, { rung: "group", cohortKey: "group:St James Apartments", n: 75 });
  assert.equal(argo?.medianLeadDays, 54);
  assert.equal(stJames?.medianLeadDays, 3);
});

test("worked example: the same empty night 20d out triggers on Argo, stays quiet on St James", () => {
  const set = yoHouseFixture();
  const argo = resolveCohortCurve(set, "argo-1")!;
  const stJames = resolveCohortCurve(set, "sj-1")!;

  // Argo books ~8 weeks out: by 20 days before stay virtually every eventual
  // booking is in — an empty Argo night IS dying.
  const argoJudgement = judgeNightForSuggestion({
    daysToStay: 20,
    booked: false,
    rate: 100,
    expectedFill: expectedCumulativeFill(20, argo.buckets)
  });
  assert.equal(argoJudgement.atRisk, true);
  assert.ok(argoJudgement.proposedValue !== null && argoJudgement.proposedValue < 100);

  // St James books in the final days: an empty night 20d out is normal.
  const stJamesJudgement = judgeNightForSuggestion({
    daysToStay: 20,
    booked: false,
    rate: 100,
    expectedFill: expectedCumulativeFill(20, stJames.buckets)
  });
  assert.equal(stJamesJudgement.atRisk, false);

  // The OLD behaviour: the pooled tenant curve judges both nights identically
  // — at risk — i.e. a false drop on St James.
  const tenantFill = expectedCumulativeFill(20, set.tenant!.distribution.buckets);
  const pooled = judgeNightForSuggestion({ daysToStay: 20, booked: false, rate: 100, expectedFill: tenantFill });
  assert.equal(pooled.atRisk, true);
});

// ---- occupancy ladder ----------------------------------------------------------

/** Every date in [startIso, endIso) as date-only strings. */
function eachDate(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const end = new Date(`${endIso}T00:00:00Z`);
  for (let d = new Date(`${startIso}T00:00:00Z`); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// 364-day window (exactly 52 of each DOW), Sunday 2025-01-05 → 2026-01-04.
const WINDOW_START = "2025-01-05";
const WINDOW_END = "2026-01-04";

test("occupancy gate: a listing active exactly 140 days clears 20 slots per DOW; 139 does not", () => {
  const listings = [listing("l1")];
  // 140 consecutive days ending at the window end = 20 dates per DOW.
  const dates140 = eachDate("2025-08-17", WINDOW_END);
  assert.equal(dates140.length, 140);
  const occupied: OccupiedNightFact[] = dates140.map((date) => ({ listingId: "l1", date }));
  const at = buildCohortOccupancySet({ listings, occupied, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  assert.equal(at.byListing.get("l1")?.minDowSlots, OCCUPANCY_MIN_SLOTS_PER_DOW);
  assert.equal(resolveCohortOccupancy(at, "l1")?.provenance.rung, "listing");

  const below = buildCohortOccupancySet({
    listings,
    occupied: occupied.slice(1), // active 139 days → one DOW has 19 slots
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END
  });
  assert.equal(resolveCohortOccupancy(below, "l1")?.provenance.rung, "tenant");
});

test("occupancy: the audit's Little Feather case — a block no longer drowns the flats", () => {
  // A 10-unit student block, full every night, next to a flat that only ever
  // sells Sundays. The old unit-weighted tenant scaler gave the flat ~0.9+
  // occupancy on every weekday; its own curve says 0.
  const listings = [listing("block", { unitCount: 10, bedroomsNumber: 1 }), listing("flat", { bedroomsNumber: 1 })];
  const allDates = eachDate(WINDOW_START, WINDOW_END);
  const occupied: OccupiedNightFact[] = [];
  for (const date of allDates) {
    for (let unit = 0; unit < 10; unit++) occupied.push({ listingId: "block", date });
  }
  for (const date of allDates) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) occupied.push({ listingId: "flat", date });
  }
  const set = buildCohortOccupancySet({ listings, occupied, windowStart: WINDOW_START, windowEnd: WINDOW_END });

  const flat = resolveCohortOccupancy(set, "flat");
  assert.equal(flat?.provenance.rung, "listing");
  assert.equal(flat?.factors[0], 1); // Sundays: always sold
  assert.equal(flat?.factors[1], 0); // Mondays: never sold — trigger must know that
  // The tenant pool (what the flat used to be scaled by) says Mondays ~0.91.
  assert.ok((set.tenant?.factors[1] ?? 0) > 0.9);
  // The block resolves to its own occupancy too.
  assert.deepEqual(resolveCohortOccupancy(set, "block")?.provenance, {
    rung: "listing",
    cohortKey: "listing:block",
    n: 10 * 364
  });
});

test("occupancy: stacked facts cap at unitCount; unknown listings are ignored", () => {
  const listings = [listing("l1")];
  const occupied: OccupiedNightFact[] = [
    { listingId: "l1", date: WINDOW_START },
    { listingId: "l1", date: WINDOW_START }, // stacked fact — capped at 1 unit
    { listingId: "ghost", date: WINDOW_START }
  ];
  const set = buildCohortOccupancySet({ listings, occupied, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  assert.equal(set.byListing.get("l1")?.occupiedUnitNights, 1);
  assert.equal(set.byListing.has("ghost"), false);
  assert.equal(set.tenant?.occupiedUnitNights, 1);
});

test("occupancy: group rung catches a thin listing before the tenant pool does", () => {
  const listings = [
    listing("new", { tags: ["group:Argo"] }),
    listing("old-1", { tags: ["group:Argo"] }),
    listing("other")
  ];
  const occupied: OccupiedNightFact[] = [
    // "new" has 7 days of history — nowhere near its own rung.
    ...eachDate("2025-12-28", WINDOW_END).map((date) => ({ listingId: "new", date })),
    // Its group sibling has a full year.
    ...eachDate(WINDOW_START, WINDOW_END).map((date) => ({ listingId: "old-1", date })),
    ...eachDate(WINDOW_START, WINDOW_END).map((date) => ({ listingId: "other", date }))
  ];
  const set = buildCohortOccupancySet({ listings, occupied, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const resolved = resolveCohortOccupancy(set, "new");
  assert.equal(resolved?.provenance.rung, "group");
  assert.equal(resolved?.provenance.cohortKey, "group:Argo");
});

// ---- curve-set summaries (Part C surfacing) ------------------------------------

test("summariseCohortCurveSet reports every cohort with n, median and gate status", () => {
  const listings = [
    listing("a1", { tags: ["group:Argo"] }),
    listing("a2", { tags: ["group:Argo"] }),
    listing("a3", { tags: ["group:Argo"] }),
    listing("s1", { tags: ["group:St James"] }),
    listing("s2", { tags: ["group:St James"] }),
    listing("s3", { tags: ["group:St James"] }),
    listing("flat", { bedroomsNumber: 2 })
  ];
  const allFacts = [
    ...facts("a1", 54, 30),
    ...facts("a2", 54, 30),
    ...facts("a3", 54, 30),
    // St James: enough members but pooled bookings below GROUP_CURVE_MIN_BOOKINGS.
    ...facts("s1", 3, 10),
    ...facts("s2", 3, 10),
    ...facts("s3", 3, 10),
    ...facts("flat", 21, 5)
  ];
  const summary = summariseCohortCurveSet(buildCohortCurveSet({ listings, facts: allFacts }));

  assert.ok(summary.tenant);
  assert.equal(summary.tenant?.bookings, 125);

  const argo = summary.groups.find((g) => g.cohortKey === "group:Argo");
  assert.equal(argo?.ownCurve, true);
  assert.equal(argo?.bookings, 90);
  assert.equal(argo?.listingCount, 3);
  assert.equal(argo?.medianLeadDays, 54);

  const stJames = summary.groups.find((g) => g.cohortKey === "group:St James");
  assert.equal(stJames?.ownCurve, false); // 30 pooled bookings < gate
  assert.equal(stJames?.medianLeadDays, 3);

  // Size bands: 0-1 (a1-a3 + s1-s3) and 2 (flat); only 0-1 clears its gate.
  const band01 = summary.sizeBands.find((b) => b.cohortKey === "size:0-1");
  assert.equal(band01?.ownCurve, true);
  const band2 = summary.sizeBands.find((b) => b.cohortKey === "size:2");
  assert.equal(band2?.ownCurve, false);
  assert.equal(band2?.bookings, 5);

  // Stable ordering for rendering.
  assert.deepEqual(
    summary.groups.map((g) => g.cohortKey),
    ["group:Argo", "group:St James"]
  );
});

test("summariseCohortCurveSet gate status matches what resolveCohortCurve actually does", () => {
  const listings = [
    listing("g1", { tags: ["group:Thin"] }),
    listing("g2", { tags: ["group:Thin"] }),
    listing("g3", { tags: ["group:Thin"] })
  ];
  const atGate = buildCohortCurveSet({ listings, facts: facts("g1", 10, GROUP_CURVE_MIN_BOOKINGS) });
  const summary = summariseCohortCurveSet(atGate);
  assert.equal(summary.groups[0]?.ownCurve, true);
  assert.equal(resolveCohortCurve(atGate, "g2")?.provenance.rung, "group");

  const belowGate = buildCohortCurveSet({ listings, facts: facts("g1", 10, GROUP_CURVE_MIN_BOOKINGS - 1) });
  const summaryBelow = summariseCohortCurveSet(belowGate);
  assert.equal(summaryBelow.groups[0]?.ownCurve, false);
  assert.notEqual(resolveCohortCurve(belowGate, "g2")?.provenance.rung, "group");
});
