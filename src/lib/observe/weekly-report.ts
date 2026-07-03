/**
 * Learner weekly report — the owner's view (build prompt 06,
 * reviews/observe-learn-2026-07).
 *
 * One email per week, "Signals learner – weekly report", covering EVERY client
 * in plain host language: is the learner healthy, what it would have done this
 * week and what actually happened (the ghost-scoring evidence), what the safety
 * gates held back, what it is still blind to, and what is coming up. The same
 * content is written to `observe-reports/learner-weekly-<date>.html` and
 * `.json` so the report survives even when the email does not send.
 *
 * Triggered from the weekly settle path: each tenant's settle records an
 * attempt marker (a file, same pattern as the `.email-sent` guard); once every
 * tenant has attempted this ISO week, the report is generated ONCE (week-keyed
 * `.done` guard) and emailed ONCE (week-keyed `.email-sent` guard). An email
 * failure is logged and retried next week — it never fails the settle, and the
 * artefacts are still written.
 *
 * Language rules (Mark is a non-technical host): a bullet is one plain
 * sentence; every number carries the count it came from; no internal jargon —
 * "nights", "bookings", "price drops", never "NightFact", "regret", "rung" or
 * a tenant/listing id. The email carries client and listing NAMES only.
 *
 * Reuses only data the daily runs already persist (windows, profiles, ledger,
 * scored suggestions, blocked counters) — no new learning, no new tables.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sendDailyReportEmail } from "@/lib/email/daily-report-email";
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { eventAdjustmentForDate } from "@/lib/pricing/events";
import type { PricingLocalEvent } from "@/lib/pricing/settings";
import { prisma } from "@/lib/prisma";

import type { ClientProfileDoc } from "./client-profile";
import { OBSERVATION_WINDOW_DAYS, defaultClientKey } from "./config";
import type { LearningKey } from "./learnings";
import { SCORE_SETTLE_LAG_DAYS, readScoreFromDetail } from "./suggestion-scoring";
import { resolveLocalEvents, type SuggestionBlockedReason } from "./suggestions";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Reports directory — same default as the day-30 runner. */
function reportsDir(): string {
  return process.env.OBSERVE_REPORTS_DIR ?? path.join(process.cwd(), "observe-reports");
}

/** A client counts as "ran this week" with a completed run inside this window. */
export const WEEKLY_RUN_FRESH_DAYS = 7;
/** The "this week" outcome window: nights whose result settled in the last 7 days. */
export const WEEKLY_OUTCOME_DAYS = 7;
/** How far ahead the "coming up" section looks for event windows. */
export const UPCOMING_EVENT_DAYS = 60;
/** Headline "most useful thing" prefers ghost-scoring evidence once it has this many nights. */
export const HEADLINE_MIN_SCORED = 20;
/** How many recent past-dated suggestions are read per client for outcomes. */
export const OUTCOME_MAX_ROWS = 600;

// ---- ISO week key (the email guard is keyed by this) -------------------------

/** ISO-8601 week key, e.g. "2026-W27". UTC. Pure. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to the ISO week's Thursday
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** True once every tenant id appears in the settled set. Pure. */
export function allTenantsSettled(settledTenantIds: Iterable<string>, tenantIds: string[]): boolean {
  const settled = new Set(settledTenantIds);
  return tenantIds.length > 0 && tenantIds.every((id) => settled.has(id));
}

/** "6 July 2026" from a YYYY-MM-DD string. Pure. */
export function formatDayGB(dateOnly: string): string {
  const d = fromDateOnly(dateOnly);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Next Monday ON OR AFTER the given date-only string. Pure. */
export function nextMondayOnOrAfter(dateOnly: string): string {
  const d = fromDateOnly(dateOnly);
  const day = d.getUTCDay(); // 0 Sun … 6 Sat
  const add = (8 - day) % 7; // Mon → 0
  return toDateOnly(addUtcDays(d, add));
}

function pounds(value: number): string {
  return `£${Math.round(value).toLocaleString("en-GB")}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---- Per-client input (gathered from the DB, or built as a fixture) ----------

export type WeeklyLedgerEntry = {
  learning: LearningKey | string;
  sampleCount: number | null;
  nullReason: string | null;
};

export type WeeklyScoredNight = {
  outcome: "booked_no_action" | "expired_empty" | "cancelled_after_booking";
  /** Actual average nightly revenue when the night booked. */
  realisedRate: number | null;
  /** The price the system would have dropped to. */
  proposedValue: number | null;
  /** When the ghost scorer settled this night. */
  scoredAt: string;
};

export type WeeklyClientInput = {
  name: string;
  window: {
    startedAt: Date;
    daysObserved: number;
    status: string;
    graduatedAt: Date | null;
    lastRunAt: Date | null;
  } | null;
  /** The `lastSuggestionRun` JSON persisted on the observation window. */
  lastSuggestionRun: unknown;
  profile: ClientProfileDoc | null;
  /** Latest ledger entry per learning (newest run wins). */
  ledger: WeeklyLedgerEntry[];
  /** Every scored night available (recent history); the builder windows it. */
  scoredNights: WeeklyScoredNight[];
  /** Earliest stay date the system ever flagged (any status); null = none yet. */
  earliestFlaggedStay: Date | null;
  /** Suggestions waiting for human approval right now. */
  pendingApprovals: number;
  /** Event windows inside the next `UPCOMING_EVENT_DAYS` days. */
  upcomingEvents: Array<{ name: string; start: string; end: string; adjustmentPct: number }>;
};

// ---- The report data model ----------------------------------------------------

export type WeeklyClientReport = {
  client: string;
  healthy: boolean;
  ranThisWeek: boolean;
  dataFlowing: boolean;
  lastRunDay: string | null;
  /** One plain sentence describing health + when suggestions start/started. */
  headline: string;
  /** One plain sentence: the single most useful thing learned so far. */
  mostUseful: string;
  /** Plain sentences describing this week's would-have-done evidence. */
  weekOutcomeSentences: string[];
  weekOutcome: {
    settled: number;
    bookedAnyway: number;
    avgRealisedRate: number | null;
    avgProposedRate: number | null;
    expiredEmpty: number;
    cancelledAfterBooking: number;
    /** Set when nothing settled this week: when results should first appear. */
    firstResultsExpected: string | null;
  };
  /** Plain sentence(s) for the safety-gate section. */
  safetySentences: string[];
  safety: { total: number; byReason: Record<string, number>; checkedOn: string | null } | null;
  /** One plain sentence per blind spot. */
  blindSpots: string[];
  /** Coming-up bullets for this client (graduation, events, decisions). */
  comingUp: string[];
};

export type WeeklyReportData = {
  title: string;
  isoWeek: string;
  generatedAt: string;
  /** Clients with no completed run this week — shown prominently. */
  clientsNotRun: Array<{ client: string; lastRunDay: string | null }>;
  clients: WeeklyClientReport[];
};

// ---- Plain-language pieces (pure) ----------------------------------------------

/** Safety-gate reasons in host words. */
const BLOCKED_REASON_TEXT: Record<SuggestionBlockedReason, string> = {
  min_floor: "the price is already at its minimum",
  event: "the night is during an event and priced up on purpose",
  already_actioned: "a price drop was already approved for that night",
  cumulative_cap: "the price has already been dropped recently"
};

function blockedReasonText(reason: string): string {
  return BLOCKED_REASON_TEXT[reason as SuggestionBlockedReason] ?? reason.replace(/_/g, " ");
}

/**
 * Turn one learning-ledger null-reason into a plain host-language sentence, or
 * null for entries that need no line. Pure.
 */
export function plainBlindSpot(args: {
  clientName: string;
  learning: string;
  sampleCount: number | null;
  nullReason: string;
}): string | null {
  const { clientName, learning, nullReason } = args;
  switch (learning) {
    case "pickup_velocity":
      return `We do not yet measure how quickly bookings arrive after a price change for ${clientName}.`;
    case "lead_time":
      return `We cannot yet see how far ahead guests book for ${clientName}, because no completed bookings are on record yet.`;
    case "regret":
      return `We cannot yet judge whether ${clientName}'s prices were held too high, because too few recent nights have finished yet.`;
    case "pricing_power":
      return `We cannot yet see which days of the week hold their price for ${clientName}, because the daily occupancy figures have not built up yet.`;
    case "engine_reaction":
      if (nullReason.includes("no engine API")) {
        return `We cannot yet see engine price moves for ${clientName} because no engine key is connected, so we read prices from the booking calendar instead.`;
      }
      return `We cannot yet tell how ${clientName}'s pricing engine responds to manual changes, because no manual price moves have been seen since observing began.`;
    case "net_realised":
      if (nullReason.includes("weekly settle only")) {
        return `The weekly fees check has not produced a figure for ${clientName} yet.`;
      }
      return `We cannot yet work out ${clientName}'s nightly rate after fees, because no recent bookings are on record.`;
    case "cancellation": {
      const n = args.sampleCount ?? 0;
      return `We cannot yet read cancellation patterns for ${clientName}, because only ${n} booking${n === 1 ? "" : "s"} are on record (we need at least 10).`;
    }
    default:
      return `We cannot yet learn one part of ${clientName}'s picture (not enough data yet).`;
  }
}

/**
 * Pick the single most useful thing learned so far, as one plain sentence with
 * its count. Preference order: ghost-scoring evidence (the strongest, most
 * honest thing the system knows), then booking lead times, then which days hold
 * their price, then empty-night excess. Pure.
 */
export function pickMostUseful(args: {
  clientName: string;
  profile: ClientProfileDoc | null;
  ledger: WeeklyLedgerEntry[];
  allTimeScored: { settled: number; bookedAnyway: number } | null;
}): string {
  const { clientName, profile, ledger, allTimeScored } = args;
  if (allTimeScored && allTimeScored.settled >= HEADLINE_MIN_SCORED) {
    const pct = Math.round((allTimeScored.bookedAnyway / allTimeScored.settled) * 100);
    return (
      `Of the ${allTimeScored.settled} nights it would have cut prices on so far, ` +
      `${allTimeScored.bookedAnyway} (${pct}%) booked anyway with no cut.`
    );
  }
  const ledgerN = (key: string): number | null => {
    const entry = ledger.find((e) => e.learning === key && e.nullReason === null);
    return entry?.sampleCount ?? null;
  };
  const median = profile?.leadTime?.medianLeadDays;
  if (typeof median === "number") {
    const n = ledgerN("lead_time");
    return `Guests typically book about ${median} day${median === 1 ? "" : "s"} ahead${
      n !== null ? ` (from ${n.toLocaleString("en-GB")} booked nights)` : ""
    }.`;
  }
  const weekend = profile?.pricingPower?.weekend;
  if (weekend) {
    const n = ledgerN("pricing_power");
    const occ = Math.round(weekend.occupancy * 100);
    const strength = weekend.sensitivity === "inelastic" ? "fill even at higher prices" : "are sensitive to price";
    return `Weekends ${strength} for ${clientName} (${occ}% of weekend nights filled${
      n !== null ? `, from ${n.toLocaleString("en-GB")} days of history` : ""
    }).`;
  }
  const regret = profile?.regret;
  if (regret && regret.total > 0) {
    return `Over the last ${regret.windowDays} days, ${regret.emptyNights} of ${regret.total} finished nights ended up empty.`;
  }
  return `Still building its first picture of ${clientName}; nothing solid to report yet.`;
}

/** Windowed outcome summary from scored nights. Pure. */
export function summariseWeekOutcomes(args: {
  scoredNights: WeeklyScoredNight[];
  now: Date;
  windowDays?: number;
}): {
  settled: number;
  bookedAnyway: number;
  avgRealisedRate: number | null;
  avgProposedRate: number | null;
  expiredEmpty: number;
  cancelledAfterBooking: number;
} {
  const windowDays = args.windowDays ?? WEEKLY_OUTCOME_DAYS;
  const cutoff = args.now.getTime() - windowDays * DAY_MS;
  const rows = args.scoredNights.filter((s) => {
    const t = Date.parse(s.scoredAt);
    return Number.isFinite(t) && t > cutoff && t <= args.now.getTime();
  });
  const booked = rows.filter((r) => r.outcome === "booked_no_action");
  const realised = booked.map((r) => r.realisedRate).filter((v): v is number => v !== null);
  const proposed = booked.map((r) => r.proposedValue).filter((v): v is number => v !== null);
  const mean = (vals: number[]): number | null =>
    vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  return {
    settled: rows.length,
    bookedAnyway: booked.length,
    avgRealisedRate: mean(realised),
    avgProposedRate: mean(proposed),
    expiredEmpty: rows.filter((r) => r.outcome === "expired_empty").length,
    cancelledAfterBooking: rows.filter((r) => r.outcome === "cancelled_after_booking").length
  };
}

/**
 * When the first ghost-scoring results should appear for a client with nothing
 * settled yet: nights settle `SCORE_SETTLE_LAG_DAYS` after the stay and results
 * land on the Monday settle, so the answer is the first Monday after the
 * earliest flagged stay has settled (never before tomorrow). Pure.
 */
export function firstResultsExpected(args: { earliestFlaggedStay: Date | null; now: Date }): string | null {
  if (!args.earliestFlaggedStay) return null;
  const settledBy = addUtcDays(fromDateOnly(toDateOnly(args.earliestFlaggedStay)), SCORE_SETTLE_LAG_DAYS);
  const tomorrow = addUtcDays(fromDateOnly(toDateOnly(args.now)), 1);
  const from = settledBy.getTime() > tomorrow.getTime() ? settledBy : tomorrow;
  return nextMondayOnOrAfter(toDateOnly(from));
}

/** Build one client's section of the report. Pure. */
export function buildWeeklyClientReport(input: WeeklyClientInput, now: Date): WeeklyClientReport {
  const name = input.name;
  const lastRunAt = input.window?.lastRunAt ?? null;
  const ranThisWeek =
    lastRunAt !== null && now.getTime() - lastRunAt.getTime() <= WEEKLY_RUN_FRESH_DAYS * DAY_MS;
  const dataFlowing = input.ledger.some((e) => e.nullReason === null && (e.sampleCount ?? 0) > 0);
  const healthy = ranThisWeek && dataFlowing;
  const lastRunDay = lastRunAt ? toDateOnly(lastRunAt) : null;

  // Headline sentence: health + when suggestions start/started.
  let suggestingPart: string;
  if (!input.window) {
    suggestingPart = "it has never been checked, so the 30-day learning period has not started";
  } else if (input.window.status === "graduated") {
    const since = input.window.graduatedAt ? formatDayGB(toDateOnly(input.window.graduatedAt)) : "graduation";
    suggestingPart = `suggesting since ${since}`;
  } else {
    const daysLeft = Math.max(0, OBSERVATION_WINDOW_DAYS - input.window.daysObserved);
    const startDay = formatDayGB(toDateOnly(addUtcDays(input.window.startedAt, OBSERVATION_WINDOW_DAYS)));
    suggestingPart =
      daysLeft === 0
        ? `due to start suggesting at its next daily check (on schedule for ${startDay})`
        : `starts suggesting in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (on ${startDay})`;
  }
  const healthPart = !ranThisWeek
    ? `NOT CHECKED this week${lastRunDay ? ` (last checked ${formatDayGB(lastRunDay)})` : " (never checked)"}, learning is paused`
    : dataFlowing
      ? "Healthy: checked this week and data is flowing"
      : "Checked this week, but no data is flowing yet";
  const headline = `${healthPart}; ${suggestingPart}.`;

  // All-time scored evidence for the "most useful" line.
  const settledAll = input.scoredNights.length;
  const bookedAll = input.scoredNights.filter((s) => s.outcome === "booked_no_action").length;
  const mostUseful = pickMostUseful({
    clientName: name,
    profile: input.profile,
    ledger: input.ledger,
    allTimeScored: settledAll > 0 ? { settled: settledAll, bookedAnyway: bookedAll } : null
  });

  // This week's would-have-done evidence.
  const week = summariseWeekOutcomes({ scoredNights: input.scoredNights, now });
  const weekOutcomeSentences: string[] = [];
  let expected: string | null = null;
  if (week.settled === 0) {
    expected = firstResultsExpected({ earliestFlaggedStay: input.earliestFlaggedStay, now });
    if (input.earliestFlaggedStay === null) {
      weekOutcomeSentences.push(
        `The system has not flagged any nights for ${name} yet, so there is nothing to check against real results.`
      );
    } else {
      weekOutcomeSentences.push(
        `The results checker has not settled any of ${name}'s flagged nights yet.`
      );
      if (expected) {
        weekOutcomeSentences.push(
          `Each night is checked ${SCORE_SETTLE_LAG_DAYS} days after the stay, so the first results should appear in the report on Monday ${formatDayGB(expected)}.`
        );
      }
    }
  } else {
    const priced =
      week.avgRealisedRate !== null && week.avgProposedRate !== null
        ? `, at an average of ${pounds(week.avgRealisedRate)} a night against the ${pounds(week.avgProposedRate)} it would have dropped to`
        : "";
    weekOutcomeSentences.push(
      `Of ${week.settled} night${week.settled === 1 ? "" : "s"} the system would have dropped the price on, ` +
        `${week.bookedAnyway} booked anyway with no drop${priced}.`
    );
    const tail: string[] = [];
    if (week.expiredEmpty > 0) tail.push(`${week.expiredEmpty} stayed empty`);
    if (week.cancelledAfterBooking > 0) tail.push(`${week.cancelledAfterBooking} were booked but later cancelled`);
    if (tail.length > 0) weekOutcomeSentences.push(`${tail.join(" and ")}.`);
  }

  // Safety gates, from the persisted blocked counters (latest daily check).
  let safety: WeeklyClientReport["safety"] = null;
  const run = input.lastSuggestionRun;
  if (run && typeof run === "object" && !Array.isArray(run)) {
    const r = run as { generatedAt?: unknown; blocked?: unknown; blockedTotal?: unknown };
    const byReason: Record<string, number> = {};
    if (r.blocked && typeof r.blocked === "object" && !Array.isArray(r.blocked)) {
      for (const [reason, count] of Object.entries(r.blocked as Record<string, unknown>)) {
        if (typeof count === "number" && count > 0) byReason[reason] = count;
      }
    }
    const total =
      typeof r.blockedTotal === "number"
        ? r.blockedTotal
        : Object.values(byReason).reduce((s, n) => s + n, 0);
    const checkedOn = typeof r.generatedAt === "string" ? r.generatedAt.slice(0, 10) : null;
    safety = { total, byReason, checkedOn };
  }
  const safetySentences: string[] = [];
  if (!safety) {
    safetySentences.push(`No daily check has recorded safety-gate counts for ${name} yet.`);
  } else if (safety.total === 0) {
    safetySentences.push(
      `No would-be price drops needed holding back for ${name} in the latest daily check${
        safety.checkedOn ? ` (${formatDayGB(safety.checkedOn)})` : ""
      }.`
    );
  } else {
    const parts = Object.entries(safety.byReason).map(
      ([reason, count]) => `${count} because ${blockedReasonText(reason)}`
    );
    safetySentences.push(
      `${safety.total} would-be price drop${safety.total === 1 ? " was" : "s were"} held back for ${name} in the latest daily check${
        safety.checkedOn ? ` (${formatDayGB(safety.checkedOn)})` : ""
      }${parts.length > 0 ? `: ${parts.join(", ")}` : ""}.`
    );
  }

  // Blind spots from the ledger's null-reasons; a paused client leads with that.
  const blindSpots: string[] = [];
  if (!ranThisWeek) {
    blindSpots.push(
      `${name} was not checked this week${lastRunDay ? ` (last checked ${formatDayGB(lastRunDay)})` : ""}, so its learning is paused until the daily check runs again.`
    );
  }
  for (const entry of input.ledger) {
    if (entry.nullReason === null) continue;
    const sentence = plainBlindSpot({
      clientName: name,
      learning: entry.learning,
      sampleCount: entry.sampleCount,
      nullReason: entry.nullReason
    });
    if (sentence) blindSpots.push(sentence);
  }

  // Coming up: graduation, events inside 60 days, decisions needed.
  const comingUp: string[] = [];
  if (input.window && input.window.status !== "graduated") {
    const startDay = formatDayGB(toDateOnly(addUtcDays(input.window.startedAt, OBSERVATION_WINDOW_DAYS)));
    comingUp.push(`${name} finishes its learning period and starts suggesting on ${startDay}.`);
  }
  for (const ev of input.upcomingEvents) {
    const span = ev.start === ev.end ? formatDayGB(ev.start) : `${formatDayGB(ev.start)} to ${formatDayGB(ev.end)}`;
    comingUp.push(
      `${name}: ${ev.name} (${span}) is priced up ${Math.round(ev.adjustmentPct)}%, so no drops will be suggested for those nights.`
    );
  }
  if (input.pendingApprovals > 0) {
    comingUp.push(
      `Decision needed: ${name} has ${input.pendingApprovals} price suggestion${input.pendingApprovals === 1 ? "" : "s"} waiting for your approval in Signals.`
    );
  }

  return {
    client: name,
    healthy,
    ranThisWeek,
    dataFlowing,
    lastRunDay,
    headline,
    mostUseful,
    weekOutcomeSentences,
    weekOutcome: { ...week, firstResultsExpected: expected },
    safetySentences,
    safety,
    blindSpots,
    comingUp
  };
}

/** Assemble the full report from per-client inputs. Pure. */
export function buildWeeklyReport(args: { clients: WeeklyClientInput[]; now: Date }): WeeklyReportData {
  const clients = args.clients.map((c) => buildWeeklyClientReport(c, args.now));
  return {
    title: "Signals learner – weekly report",
    isoWeek: isoWeekKey(args.now),
    generatedAt: args.now.toISOString(),
    clientsNotRun: clients
      .filter((c) => !c.ranThisWeek)
      .map((c) => ({ client: c.client, lastRunDay: c.lastRunDay })),
    clients
  };
}

// ---- HTML renderer (single column, phone-first) --------------------------------

/** Render the weekly report as a self-contained, phone-readable HTML page. Pure. */
export function renderWeeklyReportHtml(data: WeeklyReportData): string {
  const notRunBox =
    data.clientsNotRun.length > 0
      ? `<div class="alert"><b>Needs attention:</b> ${data.clientsNotRun
          .map(
            (c) =>
              `${escapeHtml(c.client)} was not checked this week${
                c.lastRunDay ? ` (last checked ${escapeHtml(formatDayGB(c.lastRunDay))})` : " (never checked)"
              }`
          )
          .join("; ")}. Learning for ${data.clientsNotRun.length === 1 ? "this client" : "these clients"} is paused.</div>`
      : "";

  const headlineBox = data.clients
    .map(
      (c) =>
        `<div class="card${c.ranThisWeek ? "" : " bad"}"><b>${escapeHtml(c.client)}</b><br>${escapeHtml(
          c.headline
        )}<br><span class="muted">Most useful so far: ${escapeHtml(c.mostUseful)}</span></div>`
    )
    .join("");

  const section = (title: string, body: string): string => `<h2>${escapeHtml(title)}</h2>${body}`;
  const perClient = (fn: (c: WeeklyClientReport) => string): string =>
    data.clients.map((c) => `<div class="card"><b>${escapeHtml(c.client)}</b><br>${fn(c)}</div>`).join("");
  const sentences = (list: string[]): string => list.map((s) => escapeHtml(s)).join("<br>");

  const blindSpotsBody = data.clients
    .map((c) => {
      const lines = c.blindSpots.length > 0 ? c.blindSpots : [`Nothing: every check is producing data for ${c.client}.`];
      return `<div class="card${c.ranThisWeek ? "" : " bad"}"><b>${escapeHtml(c.client)}</b><br>${sentences(lines)}</div>`;
    })
    .join("");

  const comingUpLines = data.clients.flatMap((c) => c.comingUp);
  const comingUpBody =
    comingUpLines.length > 0
      ? `<ul>${comingUpLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
      : "<p>Nothing on the horizon: no learning periods finishing, no event weeks inside the next 60 days, and nothing waiting on a decision.</p>";

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)}</title>
<style>
body{font:16px/1.55 -apple-system,system-ui,sans-serif;max-width:560px;margin:16px auto;padding:0 14px;color:#1a1a1a}
h1{font-size:20px;margin-bottom:2px}h2{font-size:17px;margin:26px 0 8px;border-bottom:1px solid #e3e3e3;padding-bottom:4px}
.card{border:1px solid #e3e3e3;border-radius:8px;padding:10px 12px;margin:8px 0}
.card.bad{border-color:#b00020;background:#fff6f6}
.alert{border:1px solid #b00020;background:#fff6f6;border-radius:8px;padding:10px 12px;margin:12px 0;color:#7a0016}
.muted{color:#666}ul{padding-left:20px}li{margin:6px 0}
</style></head><body>
<h1>${escapeHtml(data.title)}</h1>
<p class="muted">Week ${escapeHtml(data.isoWeek)} · generated ${escapeHtml(formatDayGB(data.generatedAt.slice(0, 10)))}. Nothing in here changes any prices; the system watches, learns and suggests only.</p>
${notRunBox}
${section("How each client's learner is doing", headlineBox)}
${section(
    "What we would have done this week, and what actually happened",
    `<p class="muted">Every night the system would have dropped a price on is checked against what really happened, about ${SCORE_SETTLE_LAG_DAYS} days after the stay. Nights that booked anyway at full rate are evidence the drop was not needed.</p>` +
      perClient((c) => sentences(c.weekOutcomeSentences))
  )}
${section(
    "Safety gates: drops the system held back",
    `<p class="muted">Before a drop is even suggested, safety checks can hold it back. This is the system protecting your prices, so a low number here is not a problem.</p>` +
      perClient((c) => sentences(c.safetySentences))
  )}
${section("What the learner is still blind to", blindSpotsBody)}
${section("Coming up", comingUpBody)}
<p class="muted">Generated automatically after the Monday morning weekly check.</p>
</body></html>`;
}

// ---- DB gather (tenant-scoped reads; reuses persisted data only) ---------------

/**
 * Group the next `days` days into contiguous event windows using the shared
 * `eventAdjustmentForDate` resolver. Pure.
 */
export function upcomingEventWindows(args: {
  events: PricingLocalEvent[];
  todayOnly: string;
  days?: number;
}): Array<{ name: string; start: string; end: string; adjustmentPct: number }> {
  const days = args.days ?? UPCOMING_EVENT_DAYS;
  const windows: Array<{ name: string; start: string; end: string; adjustmentPct: number }> = [];
  let current: { id: string; name: string; start: string; end: string; adjustmentPct: number } | null = null;
  const today = fromDateOnly(args.todayOnly);
  for (let i = 0; i < days; i += 1) {
    const dateStr = toDateOnly(addUtcDays(today, i));
    const ev = eventAdjustmentForDate(args.events, dateStr);
    if (ev && current && current.id === ev.id) {
      current.end = dateStr;
    } else {
      if (current) windows.push({ name: current.name, start: current.start, end: current.end, adjustmentPct: current.adjustmentPct });
      current = ev ? { id: ev.id, name: ev.name, start: dateStr, end: dateStr, adjustmentPct: ev.adjustmentPct } : null;
    }
  }
  if (current) windows.push({ name: current.name, start: current.start, end: current.end, adjustmentPct: current.adjustmentPct });
  return windows;
}

/** Gather one client's report input. Every query is tenant-scoped. */
async function gatherClientInput(tenant: { id: string; name: string }, now: Date): Promise<WeeklyClientInput> {
  const clientKey = defaultClientKey(tenant.id);
  const today = fromDateOnly(toDateOnly(now));

  const [window, profileRow, scoredRows, earliestFlagged, pendingApprovals, localEvents] = await Promise.all([
    prisma.observationWindow.findUnique({
      where: { tenantId_clientKey: { tenantId: tenant.id, clientKey } },
      select: {
        startedAt: true,
        daysObserved: true,
        status: true,
        graduatedAt: true,
        lastRunAt: true,
        lastSuggestionRun: true
      }
    }),
    prisma.clientProfile.findUnique({
      where: { tenantId_clientKey: { tenantId: tenant.id, clientKey } },
      select: { profile: true }
    }),
    prisma.suggestion.findMany({
      where: { tenantId: tenant.id, clientKey, lever: "price", dateTo: { lt: today } },
      orderBy: { dateFrom: "desc" },
      take: OUTCOME_MAX_ROWS,
      select: { proposedValue: true, detail: true }
    }),
    prisma.suggestion.findFirst({
      where: { tenantId: tenant.id, clientKey, lever: "price" },
      orderBy: { dateFrom: "asc" },
      select: { dateFrom: true }
    }),
    prisma.suggestion.count({ where: { tenantId: tenant.id, clientKey, status: "pending" } }),
    resolveLocalEvents({ tenantId: tenant.id })
  ]);

  // Latest ledger entry per learning (newest run wins).
  const ledgerRows = await prisma.observeLearningLedger.findMany({
    where: { tenantId: tenant.id },
    orderBy: { runAt: "desc" },
    take: 60,
    select: { learning: true, sampleCount: true, nullReason: true }
  });
  const ledger: WeeklyLedgerEntry[] = [];
  const seen = new Set<string>();
  for (const row of ledgerRows) {
    if (seen.has(row.learning)) continue;
    seen.add(row.learning);
    ledger.push({ learning: row.learning, sampleCount: row.sampleCount, nullReason: row.nullReason });
  }

  const scoredNights: WeeklyScoredNight[] = [];
  for (const row of scoredRows) {
    const score = readScoreFromDetail(row.detail);
    if (!score) continue;
    scoredNights.push({
      outcome: score.outcome,
      realisedRate: score.realisedRate ?? null,
      proposedValue: row.proposedValue === null ? null : Number(row.proposedValue),
      scoredAt: score.scoredAt
    });
  }

  // Events: tenant-wide plus per-listing ones, deduped by event id — the report
  // only needs the window, not which listing carries it.
  const eventById = new Map<string, PricingLocalEvent>();
  for (const ev of [...localEvents.tenantWide, ...[...localEvents.byListingId.values()].flat()]) {
    eventById.set(ev.id, ev);
  }
  const upcomingEvents = upcomingEventWindows({
    events: [...eventById.values()],
    todayOnly: toDateOnly(today)
  });

  return {
    name: tenant.name,
    window: window
      ? {
          startedAt: window.startedAt,
          daysObserved: window.daysObserved,
          status: window.status,
          graduatedAt: window.graduatedAt,
          lastRunAt: window.lastRunAt
        }
      : null,
    lastSuggestionRun: window?.lastSuggestionRun ?? null,
    profile: (profileRow?.profile as ClientProfileDoc | undefined) ?? null,
    ledger,
    scoredNights,
    earliestFlaggedStay: earliestFlagged?.dateFrom ?? null,
    pendingApprovals,
    upcomingEvents
  };
}

// ---- Runner: settle tracking + week-keyed guards + artefacts + email -----------

export type WeeklyReportRunResult = {
  isoWeek: string;
  /** Tenants that have attempted their settle this week so far. */
  settledCount: number;
  tenantCount: number;
  generated: boolean;
  skipped: boolean;
  htmlPath: string | null;
  jsonPath: string | null;
  emailMessageId: string | null;
  errors: string[];
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Deps seam so the guard/artefact/email flow is unit-testable without a DB. */
export type WeeklyReportDeps = {
  reportsDir?: string;
  loadTenants?: () => Promise<Array<{ id: string; name: string }>>;
  loadClientInput?: (tenant: { id: string; name: string }, now: Date) => Promise<WeeklyClientInput>;
  sendEmail?: (args: { subject: string; html: string }) => Promise<{ messageId: string }>;
};

/**
 * Record one tenant's weekly-settle attempt and, once EVERY tenant has
 * attempted this ISO week, generate the weekly learner report once (week-keyed
 * `.done` guard), write the HTML + JSON artefacts, and send the email once
 * (week-keyed `.email-sent` guard). Never throws — a report problem must never
 * fail the settle; errors are returned and logged by the caller. An email
 * failure leaves the artefacts in place and is retried next week.
 */
export async function maybeSendWeeklyLearnerReport(args: {
  tenantId: string;
  now?: Date;
  deps?: WeeklyReportDeps;
}): Promise<WeeklyReportRunResult> {
  const now = args.now ?? new Date();
  const week = isoWeekKey(now);
  const dir = args.deps?.reportsDir ?? reportsDir();
  const result: WeeklyReportRunResult = {
    isoWeek: week,
    settledCount: 0,
    tenantCount: 0,
    generated: false,
    skipped: false,
    htmlPath: null,
    jsonPath: null,
    emailMessageId: null,
    errors: []
  };

  try {
    await mkdir(dir, { recursive: true });

    // 1. Record this tenant's settle attempt (idempotent; file keyed by week).
    const settlesPath = path.join(dir, `learner-weekly-${week}.settles.json`);
    let settledIds: string[] = [];
    if (await fileExists(settlesPath)) {
      try {
        const parsed = JSON.parse(await readFile(settlesPath, "utf8")) as { tenantIds?: unknown };
        if (Array.isArray(parsed.tenantIds)) settledIds = parsed.tenantIds.filter((t): t is string => typeof t === "string");
      } catch {
        settledIds = [];
      }
    }
    if (!settledIds.includes(args.tenantId)) settledIds.push(args.tenantId);
    await writeFile(settlesPath, JSON.stringify({ isoWeek: week, tenantIds: settledIds }, null, 2), "utf8");
    result.settledCount = settledIds.length;

    // 2. Only generate once every tenant has attempted its settle this week.
    const loadTenants =
      args.deps?.loadTenants ??
      (() => prisma.tenant.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }));
    const tenants = await loadTenants();
    result.tenantCount = tenants.length;
    if (!allTenantsSettled(settledIds, tenants.map((t) => t.id))) return result;

    // 3. Week-keyed generation guard: the report is built once per week.
    const doneMarker = path.join(dir, `learner-weekly-${week}.done`);
    if (await fileExists(doneMarker)) {
      result.skipped = true;
      return result;
    }

    const loadClientInput = args.deps?.loadClientInput ?? gatherClientInput;
    const inputs: WeeklyClientInput[] = [];
    for (const tenant of tenants) {
      inputs.push(await loadClientInput(tenant, now));
    }
    const data = buildWeeklyReport({ clients: inputs, now });
    const html = renderWeeklyReportHtml(data);

    const dateStr = toDateOnly(now);
    result.htmlPath = path.join(dir, `learner-weekly-${dateStr}.html`);
    result.jsonPath = path.join(dir, `learner-weekly-${dateStr}.json`);
    await writeFile(result.htmlPath, html, "utf8");
    await writeFile(result.jsonPath, JSON.stringify(data, null, 2), "utf8");
    await writeFile(doneMarker, JSON.stringify({ generatedAt: now.toISOString(), html: result.htmlPath }), "utf8");
    result.generated = true;

    // 4. Email once per ISO week; a failure is logged for next week's retry.
    const emailMarker = path.join(dir, `learner-weekly-${week}.email-sent`);
    if (await fileExists(emailMarker)) {
      result.skipped = true;
      return result;
    }
    const sendEmail =
      args.deps?.sendEmail ??
      ((emailArgs: { subject: string; html: string }) =>
        sendDailyReportEmail({ ...emailArgs, includeBuildLog: false }));
    try {
      const sent = await sendEmail({ subject: `${data.title} (week ${week})`, html });
      result.emailMessageId = sent.messageId;
      await writeFile(
        emailMarker,
        JSON.stringify({ messageId: sent.messageId, sentAt: now.toISOString() }, null, 2),
        "utf8"
      );
    } catch (err) {
      result.errors.push(`email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  } catch (err) {
    result.errors.push(`weekly report failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
}
