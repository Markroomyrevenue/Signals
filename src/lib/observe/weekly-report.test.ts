import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PromoGapLearning } from "./actual-paid";
import {
  allTenantsSettled,
  bookingLeadPhrase,
  buildWeeklyClientReport,
  buildWeeklyReport,
  firstResultsExpected,
  formatDayGB,
  groupBookingSentences,
  groupPatternChangeSentences,
  isoWeekKey,
  maybeSendWeeklyLearnerReport,
  nextMondayOnOrAfter,
  pickMostUseful,
  plainBlindSpot,
  promoGapSentences,
  renderWeeklyReportHtml,
  summariseWeekOutcomes,
  upcomingEventWindows,
  type WeeklyClientInput,
  type WeeklyGroupCurve,
  type WeeklyScoredNight
} from "./weekly-report";

const NOW = new Date("2026-07-06T06:30:00.000Z"); // a Monday

function scored(overrides: Partial<WeeklyScoredNight>): WeeklyScoredNight {
  return {
    outcome: "booked_no_action",
    realisedRate: 95,
    proposedValue: 78,
    scoredAt: "2026-07-06T06:10:00.000Z",
    ...overrides
  };
}

function clientInput(overrides: Partial<WeeklyClientInput>): WeeklyClientInput {
  return {
    name: "Stay Belfast",
    window: {
      startedAt: new Date("2026-06-02T05:30:00.000Z"),
      daysObserved: 34,
      status: "graduated",
      graduatedAt: new Date("2026-07-02T05:30:00.000Z"),
      lastRunAt: new Date("2026-07-06T05:30:00.000Z")
    },
    lastSuggestionRun: {
      generatedAt: "2026-07-06T05:31:00.000Z",
      generated: 12,
      mode: "pending",
      blocked: { min_floor: 3, event: 2 },
      blockedTotal: 5
    },
    profile: null,
    ledger: [
      { learning: "lead_time", sampleCount: 3481, nullReason: null },
      { learning: "engine_reaction", sampleCount: null, nullReason: "no engine API (hostaway-scan fallback)" }
    ],
    scoredNights: [],
    earliestFlaggedStay: new Date("2026-06-03T00:00:00.000Z"),
    pendingApprovals: 0,
    upcomingEvents: [],
    groupCurves: [],
    ...overrides
  };
}

// ---- ISO week + date helpers ---------------------------------------------------

test("isoWeekKey handles mid-year, year-start and ISO-year boundaries", () => {
  assert.equal(isoWeekKey(new Date("2026-07-06T06:00:00Z")), "2026-W28");
  assert.equal(isoWeekKey(new Date("2026-07-05T23:59:59Z")), "2026-W27"); // Sunday before
  assert.equal(isoWeekKey(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  assert.equal(isoWeekKey(new Date("2027-01-01T00:00:00Z")), "2026-W53"); // Friday, ISO year 2026
  assert.equal(isoWeekKey(new Date("2024-12-30T00:00:00Z")), "2025-W01"); // Monday, ISO year 2025
});

test("nextMondayOnOrAfter and formatDayGB", () => {
  assert.equal(nextMondayOnOrAfter("2026-07-06"), "2026-07-06"); // already Monday
  assert.equal(nextMondayOnOrAfter("2026-07-07"), "2026-07-13");
  assert.equal(nextMondayOnOrAfter("2026-07-12"), "2026-07-13"); // Sunday
  assert.equal(formatDayGB("2026-07-06"), "6 July 2026");
});

test("allTenantsSettled requires every tenant and rejects the empty estate", () => {
  assert.equal(allTenantsSettled(["a", "b"], ["a", "b"]), true);
  assert.equal(allTenantsSettled(["a"], ["a", "b"]), false);
  assert.equal(allTenantsSettled(["a", "b", "stale-extra"], ["a", "b"]), true);
  assert.equal(allTenantsSettled([], []), false);
});

// ---- Week outcome summariser ----------------------------------------------------

test("summariseWeekOutcomes windows on scoredAt and averages booked nights only", () => {
  const rows: WeeklyScoredNight[] = [
    scored({ realisedRate: 100, proposedValue: 80 }),
    scored({ realisedRate: 90, proposedValue: 76 }),
    scored({ outcome: "expired_empty", realisedRate: null, proposedValue: 70 }),
    scored({ outcome: "cancelled_after_booking", realisedRate: null, proposedValue: 70 }),
    // Outside the 7-day window — must be ignored.
    scored({ scoredAt: "2026-06-20T06:00:00.000Z", realisedRate: 500, proposedValue: 400 })
  ];
  const week = summariseWeekOutcomes({ scoredNights: rows, now: NOW });
  assert.equal(week.settled, 4);
  assert.equal(week.bookedAnyway, 2);
  assert.equal(week.avgRealisedRate, 95);
  assert.equal(week.avgProposedRate, 78);
  assert.equal(week.expiredEmpty, 1);
  assert.equal(week.cancelledAfterBooking, 1);
});

test("firstResultsExpected lands on the first Monday after the earliest stay settles", () => {
  // Earliest flagged stay 2026-07-10 (Fri) → settles 2026-07-12 (Sun) → Monday 13th.
  assert.equal(
    firstResultsExpected({ earliestFlaggedStay: new Date("2026-07-10T00:00:00Z"), now: NOW }),
    "2026-07-13"
  );
  // Already settled in the past → never "today"; the next Monday.
  assert.equal(
    firstResultsExpected({ earliestFlaggedStay: new Date("2026-06-01T00:00:00Z"), now: NOW }),
    "2026-07-13"
  );
  assert.equal(firstResultsExpected({ earliestFlaggedStay: null, now: NOW }), null);
});

// ---- Plain-language pieces -------------------------------------------------------

test("plainBlindSpot translates ledger null-reasons into host language", () => {
  const engine = plainBlindSpot({
    clientName: "Coorie Doon Stays",
    learning: "engine_reaction",
    sampleCount: null,
    nullReason: "no engine API (hostaway-scan fallback)"
  });
  assert.ok(engine?.includes("no engine key is connected"), engine ?? "");
  const cancellation = plainBlindSpot({
    clientName: "Demo PM",
    learning: "cancellation",
    sampleCount: 4,
    nullReason: "fewer than 10 reservations in trailing 365d (n=4)"
  });
  assert.ok(cancellation?.includes("only 4 bookings"), cancellation ?? "");
  // No jargon leaks through any translation.
  for (const learning of ["pickup_velocity", "lead_time", "regret", "pricing_power", "net_realised"]) {
    const s = plainBlindSpot({ clientName: "X", learning, sampleCount: 0, nullReason: "whatever" });
    assert.ok(s && !/daily_agg|NightFact|tenant|rung|regret/i.test(s), `${learning}: ${s}`);
  }
});

test("pickMostUseful prefers ghost-scoring evidence, then lead time, then a safe fallback", () => {
  const withScores = pickMostUseful({
    clientName: "Stay Belfast",
    profile: null,
    ledger: [],
    allTimeScored: { settled: 120, bookedAnyway: 68 }
  });
  assert.ok(withScores.includes("120") && withScores.includes("68") && withScores.includes("57%"), withScores);

  const withLead = pickMostUseful({
    clientName: "Stay Belfast",
    profile: { leadTime: { medianLeadDays: 12, bucketPcts: {} } } as never,
    ledger: [{ learning: "lead_time", sampleCount: 3481, nullReason: null }],
    allTimeScored: { settled: 3, bookedAnyway: 1 } // below the evidence threshold
  });
  assert.ok(withLead.includes("12 days ahead") && withLead.includes("3,481"), withLead);

  const fallback = pickMostUseful({ clientName: "Demo PM", profile: null, ledger: [], allTimeScored: null });
  assert.ok(fallback.includes("nothing solid to report yet"), fallback);
});

test("upcomingEventWindows groups contiguous event days via eventAdjustmentForDate", () => {
  const windows = upcomingEventWindows({
    events: [
      {
        id: "fleadh-2026",
        name: "Fleadh Cheoil",
        startDate: "2026-08-02",
        endDate: "2026-08-09",
        adjustmentPct: 40
      }
    ],
    todayOnly: "2026-07-06",
    days: 60
  });
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0], { name: "Fleadh Cheoil", start: "2026-08-02", end: "2026-08-09", adjustmentPct: 40 });
  // An event starting beyond the horizon is excluded.
  const none = upcomingEventWindows({
    events: [
      { id: "x", name: "Far", startDate: "2026-10-01", endDate: "2026-10-03", adjustmentPct: 20 }
    ],
    todayOnly: "2026-07-06",
    days: 60
  });
  assert.equal(none.length, 0);
});

// ---- Groups, pattern changes and the promo line (build prompt 07 Part C) ----------

const ARGO: WeeklyGroupCurve = { name: "Argo", medianLeadDays: 54, bookings: 338, listings: 5, ownPattern: true };
const ST_JAMES: WeeklyGroupCurve = {
  name: "St James Apartments",
  medianLeadDays: 3,
  bookings: 93,
  listings: 8,
  ownPattern: true
};
const THIN: WeeklyGroupCurve = { name: "Marina Block", medianLeadDays: 17, bookings: 12, listings: 3, ownPattern: false };

function promoGap(overrides: Partial<PromoGapLearning> = {}): PromoGapLearning {
  return {
    computedAt: "2026-07-06T06:00:00.000Z",
    windowDays: 90,
    bookings: 480,
    withListedRate: 430,
    byChannel: {
      "booking.com": { n: 210, medianGapPct: 0.26, meanGapPct: 0.27, heavyShare: 0.1 },
      airbnb: { n: 180, medianGapPct: 0.01, meanGapPct: 0.02, heavyShare: 0.02 }
    },
    byCohort: {},
    ...overrides
  };
}

test("bookingLeadPhrase turns a median lead into host words", () => {
  assert.equal(bookingLeadPhrase(54), "about 8 weeks ahead");
  assert.equal(bookingLeadPhrase(3), "in the final days");
  assert.equal(bookingLeadPhrase(10), "about 10 days ahead");
  assert.equal(bookingLeadPhrase(12), "about 2 weeks ahead");
  assert.equal(bookingLeadPhrase(95), "about 3 months ahead");
});

test("groupBookingSentences: the audit's worked example, with each n attached", () => {
  const lines = groupBookingSentences([ARGO, ST_JAMES, THIN]);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("Your Argo properties book about 8 weeks ahead"), lines[0]);
  assert.ok(lines[0].includes("from 338 bookings"), lines[0]);
  assert.ok(lines[1].includes("St James Apartments properties book in the final days"), lines[1]);
  assert.ok(lines[1].includes("from 93 bookings"), lines[1]);
  // A group below its sample gate says so honestly, never a noisy median.
  assert.ok(lines[2].includes("does not have enough bookings yet"), lines[2]);
  assert.ok(lines[2].includes("only 12 in the last year"), lines[2]);
  assert.ok(!lines[2].includes("17"), "a below-gate group must not quote its noisy median");
});

test("groupPatternChangeSentences flags gained and lost patterns, silent without a previous report", () => {
  const gained = groupPatternChangeSentences([ARGO], { Argo: false });
  assert.equal(gained.length, 1);
  assert.ok(gained[0].includes("Argo now has enough booking history to be judged by its own pattern"), gained[0]);

  const lost = groupPatternChangeSentences([THIN], { "Marina Block": true });
  assert.equal(lost.length, 1);
  assert.ok(lost[0].includes("no longer has enough recent bookings"), lost[0]);

  assert.deepEqual(groupPatternChangeSentences([ARGO], null), []);
  assert.deepEqual(groupPatternChangeSentences([ARGO], undefined), []);
  assert.deepEqual(groupPatternChangeSentences([ARGO], { Argo: true }), []); // unchanged
  assert.deepEqual(groupPatternChangeSentences([ARGO], {}), []); // group not seen last week
});

test("promoGapSentences quotes the heavy share (never the raw wedge) and suppresses the immaterial", () => {
  const lines = promoGapSentences(promoGap());
  assert.equal(lines.length, 1); // airbnb at 2% is below the material threshold
  assert.ok(lines[0].includes("About 1 in 10 of the last 210 bookings through booking.com"), lines[0]);
  assert.ok(!lines[0].includes("26"), "the structural median gap must never be quoted");

  // The unknown-channel pool is never named in the email.
  const withUnknown = promoGapSentences(
    promoGap({ byChannel: { unknown: { n: 50, medianGapPct: 0.2, meanGapPct: 0.2, heavyShare: 0.5 } } })
  );
  assert.deepEqual(withUnknown, []);
  assert.deepEqual(promoGapSentences(null), []);
  assert.deepEqual(promoGapSentences(undefined), []);
});

test("the weekly report renders the groups section with change lines, and omits it when no client has groups", () => {
  const withGroups = buildWeeklyReport({
    clients: [clientInput({ groupCurves: [ARGO, ST_JAMES] })],
    now: NOW,
    previousGroupPatterns: { "Stay Belfast": { Argo: false } }
  });
  const html = renderWeeklyReportHtml(withGroups);
  assert.ok(html.includes("How your groups book differently"), "groups section missing");
  assert.ok(html.includes("Your Argo properties book about 8 weeks ahead"), html.slice(0, 0) || "Argo line missing");
  assert.ok(html.includes("St James Apartments properties book in the final days"), "St James line missing");
  assert.ok(html.includes("New this week: Argo now has enough booking history"), "pattern-change line missing");

  const without = renderWeeklyReportHtml(buildWeeklyReport({ clients: [clientInput({})], now: NOW }));
  assert.ok(!without.includes("How your groups book differently"), "empty groups section should be omitted");
});

test("the weekly report renders the big-discount section only when material", () => {
  const profile = { promoGap: promoGap() } as never;
  const withPromo = renderWeeklyReportHtml(buildWeeklyReport({ clients: [clientInput({ profile })], now: NOW }));
  assert.ok(withPromo.includes("Bookings won by big discounts"), "promo section missing");
  assert.ok(withPromo.includes("About 1 in 10 of the last 210 bookings through booking.com"), "promo line missing");

  const without = renderWeeklyReportHtml(buildWeeklyReport({ clients: [clientInput({})], now: NOW }));
  assert.ok(!without.includes("Bookings won by big discounts"), "empty promo section should be omitted");
});

// ---- Client report builder --------------------------------------------------------

test("a graduated healthy client renders the full plain-language evidence", () => {
  const input = clientInput({
    scoredNights: [
      ...Array.from({ length: 68 }, () => scored({ realisedRate: 95, proposedValue: 78 })),
      ...Array.from({ length: 40 }, () => scored({ outcome: "expired_empty", realisedRate: null })),
      ...Array.from({ length: 12 }, () => scored({ outcome: "cancelled_after_booking", realisedRate: null }))
    ],
    pendingApprovals: 3
  });
  const report = buildWeeklyClientReport(input, NOW);
  assert.equal(report.healthy, true);
  assert.ok(report.headline.includes("suggesting since 2 July 2026"), report.headline);
  const outcome = report.weekOutcomeSentences.join(" ");
  assert.ok(
    outcome.includes("Of 120 nights the system would have dropped the price on, 68 booked anyway with no drop"),
    outcome
  );
  assert.ok(outcome.includes("£95") && outcome.includes("£78"), outcome);
  assert.ok(outcome.includes("40 stayed empty") && outcome.includes("12 were booked but later cancelled"), outcome);
  const safety = report.safetySentences.join(" ");
  assert.ok(safety.includes("5 would-be price drops were held back"), safety);
  assert.ok(safety.includes("3 because the price is already at its minimum"), safety);
  assert.ok(safety.includes("2 because the night is during an event and priced up on purpose"), safety);
  assert.ok(report.comingUp.some((l) => l.includes("3 price suggestions waiting for your approval")), String(report.comingUp));
});

test("the not-enough-data state says exactly that and when results will appear", () => {
  const input = clientInput({
    name: "Little Feather Management",
    scoredNights: [],
    earliestFlaggedStay: new Date("2026-07-04T00:00:00Z") // settles 6 July = today → next Monday
  });
  const report = buildWeeklyClientReport(input, NOW);
  const text = report.weekOutcomeSentences.join(" ");
  assert.ok(text.includes("has not settled any of Little Feather Management's flagged nights yet"), text);
  assert.ok(text.includes("Monday 13 July 2026"), text);
  assert.equal(report.weekOutcome.firstResultsExpected, "2026-07-13");

  const neverFlagged = buildWeeklyClientReport(clientInput({ scoredNights: [], earliestFlaggedStay: null }), NOW);
  const noneText = neverFlagged.weekOutcomeSentences.join(" ");
  assert.ok(noneText.includes("has not flagged any nights"), noneText);
});

test("an observing client shows days until suggesting and its graduation date", () => {
  const input = clientInput({
    name: "Yo's House",
    window: {
      startedAt: new Date("2026-06-15T05:30:00.000Z"),
      daysObserved: 21,
      status: "observing",
      graduatedAt: null,
      lastRunAt: new Date("2026-07-06T05:30:00.000Z")
    }
  });
  const report = buildWeeklyClientReport(input, NOW);
  assert.ok(report.headline.includes("starts suggesting in 9 days (on 15 July 2026)"), report.headline);
  assert.ok(report.comingUp.some((l) => l.includes("starts suggesting on 15 July 2026")), String(report.comingUp));
});

// ---- The "did not run this week" requirement ---------------------------------------

test("a client with no run this week is prominent, never silently absent", () => {
  const stale = clientInput({
    name: "Escape Ordinary",
    window: {
      startedAt: new Date("2026-05-01T05:30:00.000Z"),
      daysObserved: 40,
      status: "graduated",
      graduatedAt: new Date("2026-05-31T05:30:00.000Z"),
      lastRunAt: new Date("2026-06-24T05:30:00.000Z") // 12 days ago
    }
  });
  const data = buildWeeklyReport({ clients: [clientInput({}), stale], now: NOW });
  assert.equal(data.clientsNotRun.length, 1);
  assert.equal(data.clientsNotRun[0].client, "Escape Ordinary");

  const html = renderWeeklyReportHtml(data);
  assert.ok(html.includes("Needs attention:"), "not-run alert box missing");
  assert.ok(html.includes("Escape Ordinary was not checked this week"), "stale client not named in the alert");
  assert.ok(html.includes("last checked 24 June 2026"), "last-checked date missing");
  // And its blind-spot section leads with the pause.
  const staleReport = data.clients.find((c) => c.client === "Escape Ordinary");
  assert.ok(staleReport?.blindSpots[0]?.includes("was not checked this week"), String(staleReport?.blindSpots));
});

test("a client with no observation window at all is still shown, marked never checked", () => {
  const data = buildWeeklyReport({
    clients: [clientInput({ name: "Brand New PM", window: null, lastSuggestionRun: null, ledger: [] })],
    now: NOW
  });
  assert.equal(data.clientsNotRun.length, 1);
  const html = renderWeeklyReportHtml(data);
  assert.ok(html.includes("never checked"), "never-checked client not flagged");
});

// ---- Renderer hygiene -----------------------------------------------------------------

test("the rendered HTML is single-column, jargon-free and id-free", () => {
  const data = buildWeeklyReport({
    clients: [
      clientInput({
        scoredNights: [scored({})],
        upcomingEvents: [{ name: "Fleadh Cheoil", start: "2026-08-02", end: "2026-08-09", adjustmentPct: 40 }],
        pendingApprovals: 1,
        // The Part C sections must obey the same language rules.
        groupCurves: [ARGO, ST_JAMES, THIN],
        profile: { promoGap: promoGap() } as never
      })
    ],
    now: NOW,
    previousGroupPatterns: { "Stay Belfast": { Argo: false, "Marina Block": true } }
  });
  const html = renderWeeklyReportHtml(data);
  assert.ok(html.includes("Signals learner – weekly report"));
  assert.ok(html.includes("Fleadh Cheoil"));
  assert.ok(html.includes("How your groups book differently"), "groups section must be in the hygiene fixture");
  assert.ok(html.includes("Bookings won by big discounts"), "promo section must be in the hygiene fixture");
  assert.ok(!html.includes("<table"), "no wide tables — phone-first single column");
  for (const banned of [
    "tenantId",
    "NightFact",
    "regret",
    "rung",
    "clientKey",
    "listingId",
    "cohort",
    "promo_gap",
    "heavyShare",
    "size band",
    "ownPattern"
  ]) {
    assert.ok(!html.includes(banned), `jargon "${banned}" leaked into the email`);
  }
  assert.ok(!/—/.test(html), "no em dashes in the email");
});

// ---- Runner: settle tracking + ISO-week guards (temp dir, stubbed deps) -------------

test("the runner waits for every tenant, generates once, and the ISO-week email guard holds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weekly-report-test-"));
  const tenants = [
    { id: "t-belfast", name: "Stay Belfast" },
    { id: "t-lfm", name: "Little Feather Management" }
  ];
  let emailsSent = 0;
  const deps = {
    reportsDir: dir,
    loadTenants: async () => tenants,
    loadClientInput: async (tenant: { id: string; name: string }) => clientInput({ name: tenant.name }),
    sendEmail: async () => {
      emailsSent += 1;
      return { messageId: `msg-${emailsSent}` };
    }
  };

  // First tenant settles: not all attempted yet — nothing generated.
  const first = await maybeSendWeeklyLearnerReport({ tenantId: "t-belfast", now: NOW, deps });
  assert.equal(first.generated, false);
  assert.equal(first.settledCount, 1);
  assert.equal(emailsSent, 0);

  // Second tenant settles: everything attempted — generate + email once.
  const second = await maybeSendWeeklyLearnerReport({ tenantId: "t-lfm", now: NOW, deps });
  assert.equal(second.generated, true);
  assert.equal(second.emailMessageId, "msg-1");
  assert.equal(emailsSent, 1);
  assert.ok(second.htmlPath && second.jsonPath);
  const html = await readFile(second.htmlPath as string, "utf8");
  assert.ok(html.includes("Stay Belfast") && html.includes("Little Feather Management"));

  // A re-fired settle in the same ISO week: guarded, no second email or rebuild.
  const third = await maybeSendWeeklyLearnerReport({ tenantId: "t-belfast", now: NOW, deps });
  assert.equal(third.generated, false);
  assert.equal(third.skipped, true);
  assert.equal(emailsSent, 1);

  const files = await readdir(dir);
  assert.ok(files.includes("learner-weekly-2026-W28.email-sent"), String(files));
  assert.ok(files.includes("learner-weekly-2026-W28.done"), String(files));
  assert.ok(files.includes("learner-weekly-2026-07-06.html"), String(files));
  assert.ok(files.includes("learner-weekly-2026-07-06.json"), String(files));
});

test("an email failure never throws, leaves the artefacts, and stays retryable next week", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weekly-report-test-"));
  const deps = {
    reportsDir: dir,
    loadTenants: async () => [{ id: "t-solo", name: "Stay Belfast" }],
    loadClientInput: async () => clientInput({}),
    sendEmail: async () => {
      throw new Error("resend down");
    }
  };
  const run = await maybeSendWeeklyLearnerReport({ tenantId: "t-solo", now: NOW, deps });
  assert.equal(run.generated, true);
  assert.equal(run.emailMessageId, null);
  assert.equal(run.errors.length, 1);
  assert.ok(run.errors[0].includes("resend down"));
  const files = await readdir(dir);
  assert.ok(files.includes("learner-weekly-2026-07-06.html"), "artefact must survive an email failure");
  assert.ok(!files.includes("learner-weekly-2026-W28.email-sent"), "no sent marker on failure");

  // NEXT ISO week: a fresh settle regenerates and the email retries.
  let sent = 0;
  const nextWeek = new Date("2026-07-13T06:30:00.000Z");
  const retryDeps = { ...deps, sendEmail: async () => ({ messageId: `retry-${(sent += 1)}` }) };
  const retry = await maybeSendWeeklyLearnerReport({ tenantId: "t-solo", now: nextWeek, deps: retryDeps });
  assert.equal(retry.generated, true);
  assert.equal(retry.emailMessageId, "retry-1");
});

test("a group gaining its own pattern is flagged against LAST week's artefact on disk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weekly-report-test-"));
  let ownPattern = false;
  const deps = {
    reportsDir: dir,
    loadTenants: async () => [{ id: "t-solo", name: "Stay Belfast" }],
    loadClientInput: async () =>
      clientInput({
        groupCurves: [{ name: "Argo", medianLeadDays: 54, bookings: 61, listings: 5, ownPattern }]
      }),
    sendEmail: async () => ({ messageId: "m" })
  };

  // Week 1: below the gate; no previous artefact, so no change line.
  const week1 = await maybeSendWeeklyLearnerReport({ tenantId: "t-solo", now: NOW, deps });
  assert.equal(week1.generated, true);
  const html1 = await readFile(week1.htmlPath as string, "utf8");
  assert.ok(html1.includes("does not have enough bookings yet"), "week 1 should show the below-gate line");
  assert.ok(!html1.includes("New this week"), "week 1 has nothing to compare against");

  // Week 2: the group clears its gate — the change is read from week 1's JSON.
  ownPattern = true;
  const week2 = await maybeSendWeeklyLearnerReport({
    tenantId: "t-solo",
    now: new Date("2026-07-13T06:30:00.000Z"),
    deps
  });
  assert.equal(week2.generated, true);
  const html2 = await readFile(week2.htmlPath as string, "utf8");
  assert.ok(
    html2.includes("New this week: Argo now has enough booking history to be judged by its own pattern"),
    "week 2 must flag the gained pattern"
  );
});
