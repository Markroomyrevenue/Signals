/**
 * Read layer for the internal Pricing Recommendations page (2026-07-18).
 *
 * Every function here is called ONLY from /api/recs routes and the recs page,
 * both behind `getInternalRecsAuth` (admin role + INTERNAL_RECS_EMAILS). The
 * data is cross-client by design — this is the internal approvals surface —
 * but every individual Prisma query still filters by tenantId (house rule).
 *
 * Numbers policy (review B9): anything shown as a percentage or a learned
 * figure carries its sample size / provenance; `confidence` is a RANKING
 * signal, not a probability, and the UI labels it so.
 */

import { toDateOnly } from "@/lib/metrics/helpers";
import { readProvenanceFromDetail } from "@/lib/observe/suggestions";
import { resolveObserveSource } from "@/lib/observe/registry";
import { prisma } from "@/lib/prisma";
import { londonDayOf } from "@/lib/recs/market/context";
import { readClientRecsSettings, readListingSnoozes } from "@/lib/recs/settings";

/** Midnight (UTC-encoded) of the LONDON calendar day for `now` — a page view
 * in the 00:00-01:00 BST hour must not start the window on yesterday. */
function londonToday(now: Date): Date {
  const [y, m, d] = londonDayOf(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export const RECS_WINDOW_DAYS = 14;
/** Non-suppressed "on pace" holds further out than this are hidden by default
 * (Mark, 2026-07-19: they clog the view; empty-night awareness only matters
 * close-in). They still exist, still remember decisions, and a toggle shows
 * them all. Suppressed holds (held-back drops) always show. */
export const RECS_HOLD_VISIBLE_DAYS = 4;
/** Calendar reads older than this get a staleness warning on every quoted
 * current price (red-team narrative 4: never quote a stale oldValue as live). */
export const STALE_CALENDAR_HOURS = 24;

export type RecsNightView = {
  suggestionId: string;
  listingId: string;
  date: string;
  dow: string;
  currentPrice: number | null;
  recommendedPrice: number | null;
  changePct: number | null;
  kind: "drop" | "hold";
  suppressed: string | null;
  revenueAtRisk: number | null;
  why: string;
  /** The short, non-duplicated part of the why — the sizing decomposition
   * lives in `sizingComponents`; the full sentence stays in `why`. */
  whyShort: string;
  sizingComponents: string[];
  /** Ranking signal 0..1 — labelled "ranking", never a probability. */
  confidence: number | null;
  curveCohort: { rung: string; cohortKey: string; n: number } | null;
  provenance: string | null;
  provisional: boolean;
  status: string;
  actionedAt: string | null;
  actionedByEmail: string | null;
  approvedPrice: number | null;
  floor: number | null;
  floorUnknown: boolean;
  /** Row generated under the client's allow-below-floor toggle. */
  allowBelowFloor: boolean;
  push: { pushed: boolean; verified: boolean | null; reverted: boolean; error: string | null } | null;
  oversight: { verdict: string; reason: string | null; narrative: string | null } | null;
};

export type RecsListingView = {
  listingId: string;
  name: string;
  unitCount: number;
  /** ISO instant a "don't raise for 30 days" snooze runs until, when active. */
  snoozedUntil: string | null;
  nights: RecsNightView[];
};

export type RecsDecisionView = {
  suggestionId: string;
  listingName: string;
  date: string;
  action: string; // approved | rejected | applied
  actionedAt: string | null;
  actionedByEmail: string | null;
  oldValue: number | null;
  approvedPrice: number | null;
  outcomeSoFar: string | null; // from ghost scoring when settled
};

export type RecsClientSummary = {
  tenantId: string;
  name: string;
  currency: string;
  engine: string;
  engineKeyPresent: boolean;
  listings: number;
  nightsAtRisk: number;
  revenueAtRisk: number;
  pendingCount: number;
  holdCount: number;
  actioned7d: number;
  provenance: string | null;
  provisionalShare: number | null;
  lastGeneratedAt: string | null;
  calendarFreshHours: number | null;
  stale: boolean;
  lowConfidence: { note: string; question: string | null } | null;
  oversight: { status: string; flags: number | null; runAt: string | null } | null;
  /** Listings currently snoozed ("don't raise for 30 days"). */
  snoozedListings: number;
  /** Per-client toggle: recommendations may go below the floor. */
  allowBelowFloor: boolean;
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type DetailShape = {
  recsPage?: unknown;
  hold?: unknown;
  suppressed?: unknown;
  sizing?: { baseDropPct?: unknown; finalDropPct?: unknown; components?: unknown };
  floor?: unknown;
  floorUnknown?: unknown;
  curveCohort?: unknown;
  allowBelowFloor?: unknown;
  push?: { pushedAt?: unknown; verified?: unknown; reverted?: unknown; error?: unknown };
  oversight?: { verdict?: unknown; reason?: unknown; narrative?: unknown };
  score?: { outcome?: unknown };
};

function detailOf(value: unknown): DetailShape {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DetailShape) : {};
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Cut the reason at the point where the sizing decomposition begins — the
 * bullets carry that; the visible line keeps only the unique part. */
export function shortWhy(reason: string): string {
  return reason
    .split("; curve:")[0]
    .split("; early on curve")[0]
    .split("; curve expects")[0]
    .trim();
}

function nightFromRow(row: {
  id: string;
  listingId: string | null;
  dateFrom: Date;
  oldValue: unknown;
  proposedValue: unknown;
  revenueAtRisk: unknown;
  confidence: unknown;
  reason: string;
  status: string;
  detail: unknown;
  provenance: string | null;
  provisional: boolean;
  actionedAt: Date | null;
  actionedByEmail: string | null;
  approvedPrice: unknown;
}): RecsNightView {
  const detail = detailOf(row.detail);
  const oldValue = num(row.oldValue);
  const proposed = num(row.proposedValue);
  const hold = detail.hold === true || (oldValue !== null && proposed !== null && proposed >= oldValue);
  const sizing = detail.sizing && typeof detail.sizing === "object" ? detail.sizing : null;
  const components = Array.isArray(sizing?.components) ? (sizing?.components as unknown[]).filter((c): c is string => typeof c === "string") : [];
  const push = detail.push && typeof detail.push === "object" ? detail.push : null;
  const oversight = detail.oversight && typeof detail.oversight === "object" ? detail.oversight : null;
  return {
    suggestionId: row.id,
    listingId: row.listingId ?? "",
    date: toDateOnly(row.dateFrom),
    dow: DOW[row.dateFrom.getUTCDay()],
    currentPrice: oldValue,
    recommendedPrice: proposed,
    changePct: oldValue && proposed && oldValue > 0 ? (proposed - oldValue) / oldValue : null,
    kind: hold ? "hold" : "drop",
    suppressed: typeof detail.suppressed === "string" ? detail.suppressed : null,
    revenueAtRisk: num(row.revenueAtRisk),
    why: row.reason,
    whyShort: shortWhy(row.reason),
    sizingComponents: components,
    confidence: num(row.confidence),
    curveCohort: readProvenanceFromDetail(detail.curveCohort),
    provenance: row.provenance,
    provisional: row.provisional,
    status: row.status,
    actionedAt: row.actionedAt ? row.actionedAt.toISOString() : null,
    actionedByEmail: row.actionedByEmail,
    approvedPrice: num(row.approvedPrice),
    floor: num(detail.floor),
    floorUnknown: detail.floorUnknown === true,
    allowBelowFloor: detail.allowBelowFloor === true,
    push: push
      ? {
          pushed: true,
          verified: typeof push.verified === "boolean" ? push.verified : null,
          reverted: Boolean(push.reverted),
          error: typeof push.error === "string" ? push.error : null
        }
      : null,
    oversight:
      oversight && typeof oversight.verdict === "string"
        ? {
            verdict: oversight.verdict,
            reason: typeof oversight.reason === "string" ? oversight.reason : null,
            narrative: typeof oversight.narrative === "string" ? oversight.narrative : null
          }
        : null
  };
}

/** Freshest CalendarRate write for the tenant, in hours. Null = no rows. */
async function calendarFreshnessHours(tenantId: string, now: Date): Promise<number | null> {
  const newest = await prisma.calendarRate.aggregate({
    where: { tenantId },
    _max: { updatedAt: true }
  });
  const ts = newest._max.updatedAt;
  return ts ? Math.round(((now.getTime() - ts.getTime()) / 36e5) * 10) / 10 : null;
}

/** Suggestion select shared by the client view + decision history. */
const NIGHT_SELECT = {
  id: true,
  listingId: true,
  dateFrom: true,
  oldValue: true,
  proposedValue: true,
  revenueAtRisk: true,
  confidence: true,
  reason: true,
  status: true,
  detail: true,
  provenance: true,
  provisional: true,
  actionedAt: true,
  actionedByEmail: true,
  approvedPrice: true
} as const;

export type RecsClientViewResult = {
  tenantId: string;
  name: string;
  engine: string;
  currency: string;
  generatedAt: string | null;
  calendarFreshHours: number | null;
  stale: boolean;
  provisional: boolean;
  provenance: string | null;
  lowConfidence: { note: string; question: string | null } | null;
  oversightRead: { bullets: string[]; runAt: string; model: string; status: string } | null;
  listings: RecsListingView[];
  decisions: RecsDecisionView[];
  /** Far-out on-pace holds hidden by the default view (0 when allHolds). */
  hiddenHolds: number;
  allowBelowFloor: boolean;
};

export async function loadRecsClientView(
  tenantId: string,
  now = new Date(),
  opts: { allHolds?: boolean } = {}
): Promise<RecsClientViewResult | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, defaultCurrency: true }
  });
  if (!tenant) return null;
  const today = londonToday(now);
  const windowEnd = new Date(today.getTime() + RECS_WINDOW_DAYS * 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [pendingRows, actionedRows, recentDecisions, listings, windowRow, freshHours, evidenceRows, oversightRun, snoozes, clientSettings] =
    await Promise.all([
      prisma.suggestion.findMany({
        where: { tenantId, type: "recs-night", status: "pending", dateFrom: { gte: today, lte: windowEnd } },
        select: NIGHT_SELECT
      }),
      // Human-actioned nights inside the window still render in the grid.
      prisma.suggestion.findMany({
        where: {
          tenantId,
          lever: "price",
          status: { in: ["approved", "applied", "rejected"] },
          dateFrom: { gte: today, lte: windowEnd }
        },
        select: NIGHT_SELECT
      }),
      prisma.suggestion.findMany({
        where: { tenantId, actionedAt: { gte: weekAgo, not: null } },
        orderBy: { actionedAt: "desc" },
        take: 100,
        select: NIGHT_SELECT
      }),
      prisma.listing.findMany({
        where: { tenantId, removedAt: null },
        select: { id: true, name: true, unitCount: true }
      }),
      prisma.observationWindow.findFirst({
        where: { tenantId },
        select: { status: true, lastSuggestionRun: true }
      }),
      calendarFreshnessHours(tenantId, now),
      prisma.recsEvidence.findMany({
        where: { tenantId, kind: { in: ["fidelity-note", "mark-prior", "drop-outcomes"] } },
        select: { kind: true, provenance: true, payload: true, computedAt: true }
      }),
      prisma.oversightRun.findFirst({
        where: { tenantId },
        orderBy: { runAt: "desc" },
        select: { status: true, clientRead: true, runAt: true, model: true }
      }),
      readListingSnoozes(tenantId, now),
      readClientRecsSettings(tenantId)
    ]);

  const nameByListing = new Map(listings.map((l) => [l.id, l.name ?? l.id]));
  // One row per (listing, date): a human-actioned row wins over a pending one.
  const byNight = new Map<string, RecsNightView>();
  for (const row of pendingRows) {
    const night = nightFromRow(row);
    byNight.set(`${night.listingId}|${night.date}`, night);
  }
  for (const row of actionedRows) {
    const night = nightFromRow(row);
    byNight.set(`${night.listingId}|${night.date}`, night);
  }

  // Far-out "on pace" holds are hidden by default (Mark, 2026-07-19): they
  // clog the approval flow. Suppressed holds (a drop was held back — that IS
  // information) and actioned rows always show. Toggleable via opts.allHolds.
  const holdCutoff = toDateOnly(new Date(today.getTime() + RECS_HOLD_VISIBLE_DAYS * 86_400_000));
  let hiddenHolds = 0;
  const nightsByListing = new Map<string, RecsNightView[]>();
  for (const night of byNight.values()) {
    if (
      !opts.allHolds &&
      night.kind === "hold" &&
      night.suppressed === null &&
      night.status === "pending" &&
      night.date > holdCutoff
    ) {
      hiddenHolds += 1;
      continue;
    }
    const list = nightsByListing.get(night.listingId) ?? [];
    list.push(night);
    nightsByListing.set(night.listingId, list);
  }
  const listingViews: RecsListingView[] = [...nightsByListing.entries()]
    .map(([listingId, nights]) => ({
      listingId,
      name: nameByListing.get(listingId) ?? listingId,
      unitCount: Math.max(1, listings.find((l) => l.id === listingId)?.unitCount ?? 1),
      snoozedUntil: snoozes.get(listingId) ?? null,
      nights: nights.sort((a, b) => a.date.localeCompare(b.date))
    }))
    // Snoozed listings sink to the bottom; active ones sort by name.
    .sort((a, b) => Number(a.snoozedUntil !== null) - Number(b.snoozedUntil !== null) || a.name.localeCompare(b.name));

  const decisions: RecsDecisionView[] = recentDecisions.map((row) => {
    const detail = detailOf(row.detail);
    return {
      suggestionId: row.id,
      listingName: row.listingId ? (nameByListing.get(row.listingId) ?? row.listingId) : "—",
      date: toDateOnly(row.dateFrom),
      action: row.status,
      actionedAt: row.actionedAt ? row.actionedAt.toISOString() : null,
      actionedByEmail: row.actionedByEmail,
      oldValue: num(row.oldValue),
      approvedPrice: num(row.approvedPrice),
      outcomeSoFar: typeof detail.score?.outcome === "string" ? (detail.score.outcome as string) : null
    };
  });

  const lastRun = windowRow?.lastSuggestionRun;
  const generatedAt =
    lastRun && typeof lastRun === "object" && !Array.isArray(lastRun) && typeof (lastRun as { generatedAt?: unknown }).generatedAt === "string"
      ? ((lastRun as { generatedAt?: string }).generatedAt as string)
      : null;

  const fidelity = evidenceRows.find((r) => r.kind === "fidelity-note");
  const fidelityPayload = fidelity ? (fidelity.payload as { note?: unknown; question?: unknown; lowConfidence?: unknown }) : null;
  const provenance = evidenceRows.some((r) => r.kind !== "fidelity-note" && r.provenance === "live-observed")
    ? "live-observed"
    : evidenceRows.some((r) => r.kind !== "fidelity-note")
      ? "warm-start"
      : null;

  const clientRead = oversightRun?.clientRead;
  return {
    tenantId: tenant.id,
    name: tenant.name,
    engine: resolveObserveSource({ id: tenant.id, name: tenant.name }).kind,
    currency: tenant.defaultCurrency,
    generatedAt,
    calendarFreshHours: freshHours,
    stale: freshHours !== null && freshHours > STALE_CALENDAR_HOURS,
    provisional: windowRow?.status !== "graduated",
    provenance,
    lowConfidence:
      fidelityPayload && fidelityPayload.lowConfidence === true
        ? {
            note: typeof fidelityPayload.note === "string" ? fidelityPayload.note : "flagged low-confidence",
            question: typeof fidelityPayload.question === "string" ? fidelityPayload.question : null
          }
        : null,
    oversightRead:
      oversightRun && Array.isArray(clientRead)
        ? {
            bullets: (clientRead as unknown[]).filter((b): b is string => typeof b === "string"),
            runAt: oversightRun.runAt.toISOString(),
            model: oversightRun.model,
            status: oversightRun.status
          }
        : null,
    listings: listingViews,
    decisions,
    hiddenHolds,
    allowBelowFloor: clientSettings.allowBelowFloor
  };
}

export async function loadRecsOverview(now = new Date()): Promise<RecsClientSummary[]> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, defaultCurrency: true }, orderBy: { name: "asc" } });
  const today = londonToday(now);
  const windowEnd = new Date(today.getTime() + RECS_WINDOW_DAYS * 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const summaries: RecsClientSummary[] = [];
  for (const tenant of tenants) {
    const source = resolveObserveSource({ id: tenant.id, name: tenant.name });
    const [pending, listingCount, actioned7d, windowRow, freshHours, fidelity, oversightRun, snoozes, clientSettings] = await Promise.all([
      prisma.suggestion.findMany({
        where: { tenantId: tenant.id, type: "recs-night", status: "pending", dateFrom: { gte: today, lte: windowEnd } },
        select: { revenueAtRisk: true, detail: true, provenance: true, provisional: true, listingId: true }
      }),
      prisma.listing.count({ where: { tenantId: tenant.id, removedAt: null } }),
      prisma.suggestion.count({ where: { tenantId: tenant.id, actionedAt: { gte: weekAgo, not: null } } }),
      prisma.observationWindow.findFirst({
        where: { tenantId: tenant.id },
        select: { status: true, lastSuggestionRun: true }
      }),
      calendarFreshnessHours(tenant.id, now),
      prisma.recsEvidence.findFirst({
        where: { tenantId: tenant.id, kind: "fidelity-note" },
        select: { payload: true }
      }),
      prisma.oversightRun.findFirst({
        where: { tenantId: tenant.id },
        orderBy: { runAt: "desc" },
        select: { status: true, flagCount: true, runAt: true }
      }),
      readListingSnoozes(tenant.id, now),
      readClientRecsSettings(tenant.id)
    ]);

    let nightsAtRisk = 0;
    let revenueAtRisk = 0;
    let holdCount = 0;
    let provisionalCount = 0;
    let provenance: string | null = null;
    for (const row of pending) {
      // Snoozed listings are ignored on purpose — their nights stay out of
      // the headline counts, and the snoozedListings figure keeps them
      // visible so they can't be forgotten.
      if (row.listingId && snoozes.has(row.listingId)) continue;
      const detail = detailOf(row.detail);
      const rar = num(row.revenueAtRisk) ?? 0;
      if (detail.hold === true) holdCount += 1;
      if (rar > 0) {
        nightsAtRisk += 1;
        revenueAtRisk += rar;
      }
      if (row.provisional) provisionalCount += 1;
      if (row.provenance && provenance === null) provenance = row.provenance;
    }

    const lastRun = windowRow?.lastSuggestionRun;
    const generatedAt =
      lastRun && typeof lastRun === "object" && !Array.isArray(lastRun) && typeof (lastRun as { generatedAt?: unknown }).generatedAt === "string"
        ? ((lastRun as { generatedAt?: string }).generatedAt as string)
        : null;
    const fidelityPayload = fidelity ? (fidelity.payload as { note?: unknown; question?: unknown; lowConfidence?: unknown }) : null;

    summaries.push({
      tenantId: tenant.id,
      name: tenant.name,
      currency: tenant.defaultCurrency,
      engine: source.kind,
      engineKeyPresent: source.keyPresent,
      listings: listingCount,
      nightsAtRisk,
      revenueAtRisk: Math.round(revenueAtRisk),
      pendingCount: pending.length,
      holdCount,
      actioned7d,
      provenance,
      provisionalShare: pending.length > 0 ? Math.round((provisionalCount / pending.length) * 100) / 100 : null,
      lastGeneratedAt: generatedAt,
      calendarFreshHours: freshHours,
      stale: freshHours !== null && freshHours > STALE_CALENDAR_HOURS,
      lowConfidence:
        fidelityPayload && fidelityPayload.lowConfidence === true
          ? {
              note: typeof fidelityPayload.note === "string" ? fidelityPayload.note : "flagged low-confidence",
              question: typeof fidelityPayload.question === "string" ? fidelityPayload.question : null
            }
          : null,
      oversight: oversightRun
        ? { status: oversightRun.status, flags: oversightRun.flagCount, runAt: oversightRun.runAt.toISOString() }
        : null,
      snoozedListings: snoozes.size,
      allowBelowFloor: clientSettings.allowBelowFloor
    });
  }
  return summaries;
}
