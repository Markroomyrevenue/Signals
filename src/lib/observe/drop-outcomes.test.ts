import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateDropOutcomes,
  aggregateDropOutcomesByCohort,
  analyseListingDrops,
  collapseDropEpisodes,
  dropDateType,
  dropSizeBand,
  filledWithinWindow,
  leadBucketLabel,
  matchKey,
  matchedControls,
  stratifiedSampleEpisodes,
  terminalKnown,
  unbookedAtLead,
  type DropChangeInput,
  type DropEpisode,
  type NightRecord
} from "./drop-outcomes";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function changeRow(overrides: Partial<DropChangeInput> & { date: string }): DropChangeInput {
  return {
    id: `chg-${overrides.date}-${overrides.scanId ?? "scan1"}`,
    listingId: "L1",
    scanId: "scan1",
    detectedAt: new Date("2026-05-30T05:30:00Z"),
    changePct: -0.08,
    oldValue: 100,
    newValue: 92,
    ...overrides
  };
}

function emptyOpenNight(date: string, overrides: Partial<NightRecord> = {}): NightRecord {
  return { date, occupiedBookings: [], cancelledBookings: [], openAtEnd: true, dropped: false, ...overrides };
}

function bookedNight(date: string, bookingCreatedAt: string, revenue = 90, overrides: Partial<NightRecord> = {}): NightRecord {
  const createdAt = new Date(bookingCreatedAt);
  return {
    date,
    occupiedBookings: [
      {
        bookingCreatedAt: createdAt,
        leadTimeDays: Math.floor((new Date(`${date}T00:00:00Z`).getTime() - createdAt.getTime()) / 86_400_000),
        revenue
      }
    ],
    cancelledBookings: [],
    openAtEnd: false,
    dropped: false,
    ...overrides
  };
}

function isoDate(dayOfJune: number): string {
  return `2026-06-${String(dayOfJune).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Episode collapsing
// ---------------------------------------------------------------------------

test("collapseDropEpisodes: a 30-date sweep is ONE episode", () => {
  const rows: DropChangeInput[] = [];
  for (let d = 1; d <= 30; d++) rows.push(changeRow({ date: isoDate(d), detectedAt: new Date("2026-05-30T05:00:00Z") }));
  const episodes = collapseDropEpisodes(rows);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].nights.length, 30);
  assert.equal(episodes[0].startDate, "2026-06-01");
  assert.equal(episodes[0].endDate, "2026-06-30");
  assert.ok(Math.abs(episodes[0].meanDropPct - 0.08) < 1e-9);
});

test("collapseDropEpisodes: a gap in stay dates splits the episode", () => {
  const rows = [changeRow({ date: "2026-06-01" }), changeRow({ date: "2026-06-02" }), changeRow({ date: "2026-06-05" })];
  const episodes = collapseDropEpisodes(rows);
  assert.equal(episodes.length, 2);
  assert.deepEqual(
    episodes.map((e) => [e.startDate, e.endDate]),
    [
      ["2026-06-01", "2026-06-02"],
      ["2026-06-05", "2026-06-05"]
    ]
  );
});

test("collapseDropEpisodes: different scans never merge", () => {
  const rows = [changeRow({ date: "2026-06-01", scanId: "scanA" }), changeRow({ date: "2026-06-02", scanId: "scanB" })];
  assert.equal(collapseDropEpisodes(rows).length, 2);
});

test("collapseDropEpisodes: 3% noise floor — sub-3% wiggle is dropped, rises are dropped", () => {
  const rows = [
    changeRow({ date: "2026-06-01", changePct: -0.0099 }), // median RMS wiggle
    changeRow({ date: "2026-06-02", changePct: -0.0299 }), // just under the floor
    changeRow({ date: "2026-06-03", changePct: -0.03 }), // exactly at the floor — counts
    changeRow({ date: "2026-06-04", changePct: 0.25 }) // a rise, never a drop
  ];
  const episodes = collapseDropEpisodes(rows);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].nights.length, 1);
  assert.equal(episodes[0].nights[0].date, "2026-06-03");
});

test("collapseDropEpisodes: stay dates before the detection date are discarded", () => {
  const rows = [changeRow({ date: "2026-06-01", detectedAt: new Date("2026-06-09T05:00:00Z") })];
  assert.equal(collapseDropEpisodes(rows).length, 0);
});

test("collapseDropEpisodes: per-night lead days computed from detection date", () => {
  const [episode] = collapseDropEpisodes([
    changeRow({ date: "2026-06-17", detectedAt: new Date("2026-06-10T23:59:00Z") })
  ]);
  assert.equal(episode.nights[0].leadDays, 7);
});

// ---------------------------------------------------------------------------
// Banding, buckets, keys, date types
// ---------------------------------------------------------------------------

test("dropSizeBand boundaries: 3-7 / 7-15 / 15+, noise floor below", () => {
  assert.equal(dropSizeBand(0.02), null);
  assert.equal(dropSizeBand(0.03), "3-7%");
  assert.equal(dropSizeBand(0.0699), "3-7%");
  assert.equal(dropSizeBand(0.07), "7-15%");
  assert.equal(dropSizeBand(0.1499), "7-15%");
  assert.equal(dropSizeBand(0.15), "15%+");
  assert.equal(dropSizeBand(0.6), "15%+");
});

test("leadBucketLabel uses the canonical observe buckets; negative lead is null", () => {
  assert.equal(leadBucketLabel(0), "0-1");
  assert.equal(leadBucketLabel(7), "4-7");
  assert.equal(leadBucketLabel(30), "15-30");
  assert.equal(leadBucketLabel(365), "91+");
  assert.equal(leadBucketLabel(-1), null);
});

test("matchKey: same listing + DOW + lead bucket share a key; others differ", () => {
  // 2026-06-12 and 2026-06-19 are both Fridays.
  const a = matchKey("L1", "2026-06-12", 10);
  assert.equal(a, "L1|dow5|lead8-14");
  assert.equal(matchKey("L1", "2026-06-19", 12), a); // same DOW, same bucket
  assert.notEqual(matchKey("L1", "2026-06-13", 10), a); // Saturday
  assert.notEqual(matchKey("L2", "2026-06-12", 10), a); // other listing
  assert.notEqual(matchKey("L1", "2026-06-12", 20), a); // other lead bucket
  assert.equal(matchKey("L1", "2026-06-12", -3), null);
});

test("dropDateType: weekend is Friday/Saturday night", () => {
  assert.equal(dropDateType("2026-06-12"), "weekend"); // Fri
  assert.equal(dropDateType("2026-06-13"), "weekend"); // Sat
  assert.equal(dropDateType("2026-06-14"), "weekday"); // Sun
  assert.equal(dropDateType("2026-06-15"), "weekday"); // Mon
});

// ---------------------------------------------------------------------------
// Stratified sampling
// ---------------------------------------------------------------------------

function episodeAt(listingId: string, detectedAt: string, startDate: string): DropEpisode {
  return {
    key: `${listingId}|scan-${detectedAt}|${startDate}`,
    listingId,
    scanId: `scan-${detectedAt}`,
    detectedAt: new Date(detectedAt),
    startDate,
    endDate: startDate,
    meanDropPct: 0.1,
    nights: []
  };
}

test("stratifiedSampleEpisodes: spans full history, not most-recent-first", () => {
  const episodes: DropEpisode[] = [];
  for (let i = 0; i < 100; i++) {
    episodes.push(episodeAt("L1", `2026-0${1 + Math.floor(i / 20)}-${String((i % 20) + 1).padStart(2, "0")}T05:00:00Z`, "2026-06-01"));
  }
  const sampled = stratifiedSampleEpisodes(episodes, 10);
  assert.equal(sampled.length, 10);
  const months = new Set(sampled.map((e) => e.detectedAt.toISOString().slice(0, 7)));
  assert.ok(months.size >= 4, `sample should span history, got months ${[...months].join(",")}`);
  // The earliest episode is included — a newest-first cut would miss it.
  assert.equal(sampled[0].detectedAt.toISOString(), episodes[0].detectedAt.toISOString());
});

test("stratifiedSampleEpisodes: under the cap is a no-op; cap applies per listing", () => {
  const episodes = [
    episodeAt("L1", "2026-01-01T05:00:00Z", "2026-06-01"),
    episodeAt("L1", "2026-02-01T05:00:00Z", "2026-06-02"),
    episodeAt("L2", "2026-03-01T05:00:00Z", "2026-06-03")
  ];
  assert.equal(stratifiedSampleEpisodes(episodes, 5).length, 3);
  const capped = stratifiedSampleEpisodes(episodes, 1);
  assert.equal(capped.length, 2);
  assert.deepEqual(new Set(capped.map((e) => e.listingId)), new Set(["L1", "L2"]));
});

// ---------------------------------------------------------------------------
// Night-state predicates
// ---------------------------------------------------------------------------

test("terminalKnown: filled or visibly open counts; blocked/unknown does not", () => {
  assert.equal(terminalKnown(emptyOpenNight("2026-06-01")), true);
  assert.equal(terminalKnown(bookedNight("2026-06-01", "2026-05-20T12:00:00Z")), true);
  assert.equal(terminalKnown(emptyOpenNight("2026-06-01", { openAtEnd: false })), false);
});

test("unbookedAtLead: booked earlier than the lead blocks control eligibility", () => {
  const night = bookedNight("2026-06-20", "2026-06-01T12:00:00Z"); // lead 18-19d
  assert.equal(unbookedAtLead(night, 10), false); // already booked by lead 10
  assert.equal(unbookedAtLead(night, 25), true); // still open at lead 25
  assert.equal(unbookedAtLead(emptyOpenNight("2026-06-20"), 10), true);
  const unknown = bookedNight("2026-06-20", "2026-06-01T12:00:00Z");
  unknown.occupiedBookings[0] = { bookingCreatedAt: null, leadTimeDays: null, revenue: 80 };
  assert.equal(unbookedAtLead(unknown, 10), null);
});

test("filledWithinWindow: timestamp path and lead-days fallback", () => {
  const detectedAt = new Date("2026-06-10T05:30:00Z");
  const inWindow = bookedNight("2026-06-20", "2026-06-15T12:00:00Z");
  const outWindow = bookedNight("2026-06-20", "2026-06-05T12:00:00Z"); // booked BEFORE detection
  assert.equal(filledWithinWindow(inWindow, detectedAt, 10), true);
  assert.equal(filledWithinWindow(outWindow, detectedAt, 10), false);
  const fallback: NightRecord = {
    date: "2026-06-20",
    occupiedBookings: [{ bookingCreatedAt: null, leadTimeDays: 4, revenue: 80 }],
    cancelledBookings: [],
    openAtEnd: false,
    dropped: false
  };
  assert.equal(filledWithinWindow(fallback, detectedAt, 10), true); // lead 4 within (10-14, 10]
  assert.equal(filledWithinWindow(fallback, detectedAt, 25), false); // 4 < 25-14
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test("matchedControls: same DOW within ±21d, un-dropped, terminal known, unbooked at lead", () => {
  const nights = new Map<string, NightRecord>();
  // Treated: Wednesday 2026-06-17, lead 10.
  nights.set("2026-06-10", emptyOpenNight("2026-06-10")); // Wed, eligible
  nights.set("2026-06-24", emptyOpenNight("2026-06-24", { dropped: true })); // Wed but dropped
  nights.set("2026-07-01", emptyOpenNight("2026-07-01", { openAtEnd: false })); // Wed, terminal unknown
  nights.set("2026-06-03", bookedNight("2026-06-03", "2026-05-01T10:00:00Z")); // Wed, booked at lead 33 ⇒ not at risk
  nights.set("2026-06-16", emptyOpenNight("2026-06-16")); // Tuesday — wrong DOW
  const controls = matchedControls({ treatedDate: "2026-06-17", leadDays: 10, nights });
  assert.deepEqual(
    controls.map((c) => c.date),
    ["2026-06-10"]
  );
});

test("matchedControls: never matches the treated night itself and respects the ±21d window", () => {
  const nights = new Map<string, NightRecord>();
  nights.set("2026-06-17", emptyOpenNight("2026-06-17"));
  nights.set("2026-07-15", emptyOpenNight("2026-07-15")); // Wed, +28d — outside window
  const controls = matchedControls({ treatedDate: "2026-06-17", leadDays: 10, nights });
  assert.equal(controls.length, 0);
});

// ---------------------------------------------------------------------------
// End-to-end: analyse + aggregate
// ---------------------------------------------------------------------------

test("analyseListingDrops: treated fill vs matched control, realised % of pre-drop", () => {
  const detectedAt = new Date("2026-06-10T05:30:00Z");
  const episodes = collapseDropEpisodes([
    changeRow({ date: "2026-06-17", detectedAt, changePct: -0.1, oldValue: 100 })
  ]);
  const nights = new Map<string, NightRecord>();
  nights.set("2026-06-17", bookedNight("2026-06-17", "2026-06-14T09:00:00Z", 85, { dropped: true })); // treated, filled d+4
  nights.set("2026-06-10", emptyOpenNight("2026-06-10")); // control Wed, expired empty
  nights.set("2026-06-24", bookedNight("2026-06-24", "2026-06-20T09:00:00Z", 95)); // control Wed, filled in pseudo-window
  const analysis = analyseListingDrops({ listingId: "L1", episodes, nights, today: "2026-07-03" });
  assert.equal(analysis.treated.length, 1);
  const t = analysis.treated[0];
  assert.equal(t.filled14, true);
  assert.equal(t.leadBucket, "4-7");
  assert.equal(t.dropBand, "7-15%");
  assert.equal(t.dateType, "weekday");
  assert.equal(t.controlCount, 2);
  assert.equal(t.controlFillMean, 0.5);
  assert.ok(Math.abs((t.realisedPctOfPreDrop ?? 0) - 0.85) < 1e-9);

  const cells = aggregateDropOutcomes(analysis.treated);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].treatedNights, 1);
  assert.equal(cells[0].treatedFillRate, 1);
  assert.equal(cells[0].controlFillRate, 0.5);
  assert.ok(Math.abs((cells[0].fillDeltaPp ?? 0) - 50) < 1e-9);
});

test("analyseListingDrops: unsettled nights excluded; repeat drops attributed to first episode only", () => {
  const first = collapseDropEpisodes([
    changeRow({ date: "2026-06-17", scanId: "scanA", detectedAt: new Date("2026-06-10T05:30:00Z") })
  ]);
  const second = collapseDropEpisodes([
    changeRow({ date: "2026-06-17", scanId: "scanB", detectedAt: new Date("2026-06-12T05:30:00Z") }),
    changeRow({ date: "2026-08-01", scanId: "scanB", detectedAt: new Date("2026-06-12T05:30:00Z") })
  ]);
  const nights = new Map<string, NightRecord>();
  nights.set("2026-06-17", emptyOpenNight("2026-06-17", { dropped: true }));
  const analysis = analyseListingDrops({
    listingId: "L1",
    episodes: [...first, ...second],
    nights,
    today: "2026-07-03"
  });
  assert.equal(analysis.treated.length, 1);
  assert.equal(analysis.treated[0].episodeKey, first[0].key); // earliest detection wins
  assert.equal(analysis.skippedRepeatDrop, 1);
  assert.equal(analysis.skippedUnsettled, 1); // 2026-08-01 not settled
});

test("analyseListingDrops: unknown terminal state is skipped, not counted as empty", () => {
  const episodes = collapseDropEpisodes([changeRow({ date: "2026-06-17" })]);
  const nights = new Map<string, NightRecord>();
  nights.set("2026-06-17", emptyOpenNight("2026-06-17", { openAtEnd: false, dropped: true }));
  const analysis = analyseListingDrops({ listingId: "L1", episodes, nights, today: "2026-07-03" });
  assert.equal(analysis.treated.length, 0);
  assert.equal(analysis.skippedUnknownTerminal, 1);
});

test("aggregateDropOutcomes: cancellation rate over booked-in-window nights", () => {
  const detectedAt = new Date("2026-06-10T05:30:00Z");
  const episodes = collapseDropEpisodes([
    changeRow({ date: "2026-06-17", detectedAt, changePct: -0.05 }),
    changeRow({ date: "2026-06-18", detectedAt, changePct: -0.05 })
  ]);
  const nights = new Map<string, NightRecord>();
  nights.set("2026-06-17", bookedNight("2026-06-17", "2026-06-13T10:00:00Z", 80, { dropped: true }));
  const cancelled = emptyOpenNight("2026-06-18", { dropped: true });
  cancelled.cancelledBookings.push({ bookingCreatedAt: new Date("2026-06-12T10:00:00Z"), leadTimeDays: null });
  nights.set("2026-06-18", cancelled);
  const analysis = analyseListingDrops({ listingId: "L1", episodes, nights, today: "2026-07-03" });
  const cells = aggregateDropOutcomes(analysis.treated);
  const total = cells.reduce((s, c) => s + (c.cancellationRate.n ?? 0), 0);
  assert.equal(total, 2);
  const cancelledCount = cells.reduce((s, c) => s + (c.cancellationRate.value ?? 0) * c.cancellationRate.n, 0);
  assert.ok(Math.abs(cancelledCount - 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// Cohort re-cuts (build prompt 07 Part B item 6)
// ---------------------------------------------------------------------------

test("aggregateDropOutcomesByCohort: cuts by cohort key with crossover; thin cells suppressed", () => {
  const detectedAt = new Date("2026-06-10T05:30:00Z");
  const episodes = collapseDropEpisodes([
    changeRow({ date: "2026-06-17", detectedAt, changePct: -0.1, oldValue: 100 })
  ]);
  const nights = new Map<string, NightRecord>();
  nights.set("2026-06-17", bookedNight("2026-06-17", "2026-06-14T09:00:00Z", 85, { dropped: true }));
  const analysis = analyseListingDrops({ listingId: "L1", episodes, nights, today: "2026-07-03" });
  assert.equal(analysis.treated.length, 1);

  const cohortKeys = new Map([["L1", ["group:Argo", "size:2"]]]);
  // At the default minimum (20 treated) a single treated night is suppressed
  // everywhere — thin cuts are hidden, never shown as noise.
  assert.deepEqual(aggregateDropOutcomesByCohort(analysis.treated, cohortKeys), []);

  // With the gate at 1 the night appears under BOTH its cohorts (crossover).
  const cuts = aggregateDropOutcomesByCohort(analysis.treated, cohortKeys, 1);
  assert.deepEqual(cuts.map((c) => c.cohortKey), ["group:Argo", "size:2"]);
  assert.equal(cuts[0].treatedNights, 1);
  assert.equal(cuts[0].cells.length, 1);
  assert.equal(cuts[0].cells[0].treatedNights, 1);

  // A listing with no cohort mapping joins no cut.
  assert.deepEqual(aggregateDropOutcomesByCohort(analysis.treated, new Map(), 1), []);
});
