/**
 * Render one full EXAMPLE learner weekly report from local fixture data
 * (build prompt 06 "Finish" requirement) so Mark can judge the format before
 * the first real Monday send. No DB, no email — pure builders + renderer only.
 *
 *   npx tsx scripts/render-weekly-report-example.ts
 *
 * Writes observe-reports/learner-weekly-example-<date>.html and .json.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildWeeklyReport,
  renderWeeklyReportHtml,
  type WeeklyClientInput,
  type WeeklyScoredNight
} from "@/lib/observe/weekly-report";

// The example is rendered as if it were the Monday 06:00 settle on 6 July 2026.
const NOW = new Date("2026-07-06T06:05:00.000Z");

function nights(
  count: number,
  outcome: WeeklyScoredNight["outcome"],
  args: { realised?: number; proposed?: number; scoredAt?: string } = {}
): WeeklyScoredNight[] {
  return Array.from({ length: count }, () => ({
    outcome,
    realisedRate: outcome === "booked_no_action" ? (args.realised ?? 95) : null,
    proposedValue: args.proposed ?? 78,
    scoredAt: args.scoredAt ?? "2026-07-06T06:02:00.000Z"
  }));
}

const clients: WeeklyClientInput[] = [
  // 1. A graduated, healthy client with a full week of ghost-scoring evidence.
  {
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
      generated: 11,
      mode: "pending",
      blocked: { min_floor: 8, event: 4, cumulative_cap: 2 },
      blockedTotal: 14
    },
    profile: null,
    ledger: [
      { learning: "lead_time", sampleCount: 3481, nullReason: null },
      { learning: "pricing_power", sampleCount: 365, nullReason: null },
      {
        learning: "engine_reaction",
        sampleCount: null,
        nullReason: "no engine API (hostaway-scan fallback)"
      }
    ],
    scoredNights: [
      // This week's settled nights.
      ...nights(68, "booked_no_action", { realised: 95, proposed: 78 }),
      ...nights(40, "expired_empty"),
      ...nights(12, "cancelled_after_booking"),
      // Older settled history (outside the weekly window; feeds "so far").
      ...nights(96, "booked_no_action", { realised: 101, proposed: 82, scoredAt: "2026-06-29T06:02:00.000Z" }),
      ...nights(84, "expired_empty", { scoredAt: "2026-06-29T06:02:00.000Z" })
    ],
    earliestFlaggedStay: new Date("2026-06-03T00:00:00.000Z"),
    pendingApprovals: 6,
    upcomingEvents: [{ name: "Fleadh Cheoil", start: "2026-08-02", end: "2026-08-09", adjustmentPct: 40 }],
    groupCurves: []
  },

  // 2. A healthy client mid-way through its 30-day learning period.
  {
    name: "Little Feather Management",
    window: {
      startedAt: new Date("2026-06-15T05:30:00.000Z"),
      daysObserved: 21,
      status: "observing",
      graduatedAt: null,
      lastRunAt: new Date("2026-07-06T05:30:00.000Z")
    },
    lastSuggestionRun: {
      generatedAt: "2026-07-06T05:32:00.000Z",
      generated: 7,
      mode: "shadow",
      blocked: { min_floor: 3 },
      blockedTotal: 3
    },
    profile: {
      leadTime: { medianLeadDays: 12, bucketPcts: {} }
    } as never,
    ledger: [
      { learning: "lead_time", sampleCount: 2911, nullReason: null },
      { learning: "net_realised", sampleCount: 187, nullReason: null }
    ],
    scoredNights: [
      ...nights(31, "booked_no_action", { realised: 112, proposed: 89 }),
      ...nights(22, "expired_empty")
    ],
    earliestFlaggedStay: new Date("2026-06-16T00:00:00.000Z"),
    pendingApprovals: 0,
    upcomingEvents: [],
    groupCurves: []
  },

  // 3. A healthy client whose flagged nights have not settled yet.
  {
    name: "Yo's House & Short Stay Harrogate",
    window: {
      startedAt: new Date("2026-06-29T05:30:00.000Z"),
      daysObserved: 7,
      status: "observing",
      graduatedAt: null,
      lastRunAt: new Date("2026-07-06T05:30:00.000Z")
    },
    lastSuggestionRun: {
      generatedAt: "2026-07-06T05:33:00.000Z",
      generated: 4,
      mode: "shadow",
      blocked: {},
      blockedTotal: 0
    },
    profile: null,
    ledger: [
      { learning: "lead_time", sampleCount: 1642, nullReason: null },
      {
        learning: "cancellation",
        sampleCount: 7,
        nullReason: "fewer than 10 reservations in trailing 365d (n=7)"
      }
    ],
    scoredNights: [],
    earliestFlaggedStay: new Date("2026-07-08T00:00:00.000Z"),
    pendingApprovals: 0,
    upcomingEvents: [],
    groupCurves: []
  },

  // 4. A healthy client with an engine blind spot and a quiet week.
  {
    name: "Coorie Doon Stays",
    window: {
      startedAt: new Date("2026-06-05T05:30:00.000Z"),
      daysObserved: 31,
      status: "graduated",
      graduatedAt: new Date("2026-07-05T05:30:00.000Z"),
      lastRunAt: new Date("2026-07-06T05:30:00.000Z")
    },
    lastSuggestionRun: {
      generatedAt: "2026-07-06T05:34:00.000Z",
      generated: 9,
      mode: "pending",
      blocked: { already_actioned: 1 },
      blockedTotal: 1
    },
    profile: null,
    ledger: [
      { learning: "lead_time", sampleCount: 4102, nullReason: null },
      {
        learning: "engine_reaction",
        sampleCount: null,
        nullReason: "no engine API (hostaway-scan fallback)"
      }
    ],
    scoredNights: [
      ...nights(38, "booked_no_action", { realised: 84, proposed: 71 }),
      ...nights(19, "expired_empty"),
      ...nights(3, "cancelled_after_booking")
    ],
    earliestFlaggedStay: new Date("2026-06-06T00:00:00.000Z"),
    pendingApprovals: 2,
    upcomingEvents: [],
    groupCurves: []
  },

  // 5. A client whose daily check has stopped — must be loud, not absent.
  {
    name: "Demo PM",
    window: {
      startedAt: new Date("2026-05-20T05:30:00.000Z"),
      daysObserved: 35,
      status: "graduated",
      graduatedAt: new Date("2026-06-19T05:30:00.000Z"),
      lastRunAt: new Date("2026-06-24T05:30:00.000Z")
    },
    lastSuggestionRun: null,
    profile: null,
    ledger: [
      { learning: "lead_time", sampleCount: 220, nullReason: null },
      { learning: "pricing_power", sampleCount: 0, nullReason: "daily_aggs empty — no rows in trailing 365d" }
    ],
    scoredNights: [],
    earliestFlaggedStay: null,
    pendingApprovals: 0,
    upcomingEvents: [],
    groupCurves: []
  }
];

async function main(): Promise<void> {
  const data = buildWeeklyReport({ clients, now: NOW });
  const html = renderWeeklyReportHtml(data);
  const dir = path.join(process.cwd(), "observe-reports");
  await mkdir(dir, { recursive: true });
  const base = path.join(dir, "learner-weekly-example-2026-07-06");
  await writeFile(`${base}.html`, html, "utf8");
  await writeFile(`${base}.json`, JSON.stringify(data, null, 2), "utf8");
  console.log(`written ${base}.html`);
  console.log(`written ${base}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
