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
import { buildListingRuns, type RecsRunView } from "@/lib/recs/runs";

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
  /** When the row was generated — ISO. Lets the read layer tell a FRESH pending
   * re-drop (created after a decision) from a stale one (near-term late-drop
   * relaxation, 2026-07-22). */
  createdAt: string | null;
  actionedAt: string | null;
  actionedByEmail: string | null;
  approvedPrice: number | null;
  /**
   * When a fresh pending re-drop supersedes a prior decision on the same night
   * (DECISIONS 2026-07-22 option a), the beaten decision rides here so the
   * calendar can still show it as blue-dot history. Null on every other row.
   */
  priorAction: {
    status: string;
    recommendedPrice: number | null;
    approvedPrice: number | null;
    actionedAt: string | null;
  } | null;
  floor: number | null;
  floorUnknown: boolean;
  /** Row generated under the client's allow-below-floor toggle. */
  allowBelowFloor: boolean;
  /** DOW occupancy factor the generator judged with (run-grouping input). */
  occFactor: number | null;
  /** Why the grouping layer kept this night out of a run (chip text). */
  soloReason: string | null;
  /** True when the night is presented inside a run (UI hides its solo row). */
  groupedInRun: boolean;
  push: { pushed: boolean; verified: boolean | null; reverted: boolean; error: string | null } | null;
  oversight: { verdict: string; reason: string | null; narrative: string | null } | null;
  /**
   * Where `currentPrice` came from (2026-07-23). Recs generate once at 05:30,
   * so `Suggestion.oldValue` is a photograph of the price at that moment — but
   * CalendarRate is refreshed hourly, and on 2026-07-23 55-92% of open tiles
   * per client were quoting a price the engine had since moved (worst gap
   * £187). "live" means the overlay found a fresh open-night rate and used it;
   * "generated" means it fell back to the 05:30 value (night booked out, or no
   * calendar row).
   */
  currentPriceSource: "live" | "generated";
  /** The 05:30 price, when the live rate has since moved off it. Null when
   * unchanged — the UI only needs to say "was X" if X differs. */
  currentPriceWas: number | null;
  /**
   * The live price moved far enough that the recommendation no longer points
   * the way it was generated (a drop that is no longer below the live rate).
   * The number is not wrong — the ADVICE is out of date, so the UI greys the
   * tile rather than inviting a push against a superseded basis.
   */
  supersededByLivePrice: boolean;
};

export type RecsListingView = {
  listingId: string;
  name: string;
  unitCount: number;
  /** ISO instant a "don't raise for 30 days" snooze runs until, when active. */
  snoozedUntil: string | null;
  nights: RecsNightView[];
  /** Consecutive pending drops grouped for one-click approval (2026-07-19). */
  runs: RecsRunView[];
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
  /** Pending recommendations currently sitting below their resolved floor. */
  belowFloorPending: number;
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
  occFactor?: unknown;
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
 * bullets carry that; the visible line keeps only the lead sentence. The sizing
 * trail (and legacy "curve …" detail) is appended after the first "; ", so a
 * single split on that separator keeps the plain-English lead for the tile. */
export function shortWhy(reason: string): string {
  return reason.split("; ")[0].trim();
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
  createdAt: Date | null;
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
    // Defaults: the row as generated. `applyLiveCurrentPrice` overlays the
    // hourly CalendarRate on top for nights that are still open.
    currentPriceSource: "generated",
    currentPriceWas: null,
    supersededByLivePrice: false,
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
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    actionedAt: row.actionedAt ? row.actionedAt.toISOString() : null,
    actionedByEmail: row.actionedByEmail,
    approvedPrice: num(row.approvedPrice),
    priorAction: null,
    floor: num(detail.floor),
    floorUnknown: detail.floorUnknown === true,
    allowBelowFloor: detail.allowBelowFloor === true,
    occFactor: num(detail.occFactor),
    soloReason: null,
    groupedInRun: false,
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

/**
 * A push that was attempted but did NOT verify (the engine read back a
 * different price) — status stays "approved" with a pushed-but-unverified
 * detail. These must stay LIVE, retryable tiles; a fresh re-drop must never
 * supersede one, or the wrong engine price would hide behind a "skipped" dot.
 * (Canonical home: RecsNightView lives here; calendar-data re-exports this.)
 */
export function isUnresolvedPush(night: RecsNightView): boolean {
  return (
    night.status === "approved" &&
    night.push !== null &&
    night.push.pushed === true &&
    night.push.verified === false &&
    !night.push.reverted
  );
}

/**
 * One row per (listing, date) for the recs page. Pure.
 *
 * A human decision normally stands — the night becomes blue-dot history and the
 * decision row is returned. The ONE exception is the near-term late-drop
 * relaxation (DECISIONS 2026-07-22 option a): a FRESH pending DROP generated
 * AFTER the decision is a deliberate re-drop, so it wins the tile and carries
 * the beaten decision on `priorAction` (the prior push still shows as history).
 * A pending HOLD or suppressed row never beats a decision. An UNRESOLVED PUSH
 * (verify-mismatch) is never superseded either — it must stay a live, retryable
 * tile. Among competing actioned rows the NEWEST wins (daily re-pricing can
 * leave two applied rows).
 */
export function resolveNightRows(pending: RecsNightView[], actioned: RecsNightView[]): RecsNightView[] {
  const actionedAtMs = (n: RecsNightView): number => (n.actionedAt ? new Date(n.actionedAt).getTime() : 0);
  const createdAtMs = (n: RecsNightView): number => (n.createdAt ? new Date(n.createdAt).getTime() : 0);
  const keyOf = (n: RecsNightView): string => `${n.listingId}|${n.date}`;

  // Newest actioned decision per night.
  const actionedByNight = new Map<string, RecsNightView>();
  for (const n of actioned) {
    const key = keyOf(n);
    const existing = actionedByNight.get(key);
    if (!existing || actionedAtMs(n) >= actionedAtMs(existing)) actionedByNight.set(key, n);
  }

  // Pending rows first (a pending-only night is a live tile).
  const byNight = new Map<string, RecsNightView>();
  for (const n of pending) byNight.set(keyOf(n), n);

  // Reconcile pending vs the decision that stands on the same night. A re-drop
  // only supersedes a CLEANLY-resolved decision — never an unresolved push,
  // which must stay live so the operator can retry the mismatch.
  for (const [key, act] of actionedByNight) {
    const pend = byNight.get(key);
    const freshRedrop =
      pend !== undefined &&
      pend.kind === "drop" &&
      pend.suppressed === null &&
      !isUnresolvedPush(act) &&
      createdAtMs(pend) > actionedAtMs(act);
    if (freshRedrop && pend) {
      // The re-drop is the live tile; the superseded decision becomes history.
      pend.priorAction = {
        status: act.status,
        recommendedPrice: act.recommendedPrice,
        approvedPrice: act.approvedPrice,
        actionedAt: act.actionedAt
      };
    } else {
      byNight.set(key, act);
    }
  }
  return [...byNight.values()];
}

/** Key for the live-rate lookup: one listing, one night. */
export function liveRateKey(listingId: string, date: string): string {
  return `${listingId}|${date}`;
}

/**
 * Build the live-rate map from CalendarRate rows. OPEN nights only — a booked
 * night has no sellable price, so quoting one as "current" would mislead
 * (same rule `buildRateContextByListing` applies for the calendar's `live`).
 */
export function buildLiveRateMap(
  rows: { listingId: string; date: Date; available: boolean; rate: unknown }[]
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!row.available) continue;
    const rate = num(row.rate);
    if (rate === null || rate <= 0) continue;
    out.set(liveRateKey(row.listingId, toDateOnly(row.date)), rate);
  }
  return out;
}

/**
 * Overlay today's live rate onto the generated `currentPrice` (2026-07-23).
 *
 * WHY: recs are generated once a day (~05:30 London) and `Suggestion.oldValue`
 * freezes the price at that instant, but the engines keep moving prices all
 * day and CalendarRate is re-read hourly. Measured on prod 2026-07-23 20:45,
 * between 55% and 92% of each client's open tiles were quoting a price that
 * was no longer real, up to £187 out. The page is already `force-dynamic`, so
 * the staleness was never caching — it was reading the wrong column.
 *
 * Applied BEFORE run-grouping so run totals and every percentage the UI
 * derives from `currentPrice` agree with the number on the tile.
 *
 * A night whose live price has moved BELOW the recommendation is marked
 * `supersededByLivePrice`: the recommendation was reasoned about a basis that
 * no longer holds, and pushing it would raise the price rather than drop it.
 * Actioned rows are left alone — they are a record of a decision already
 * taken, not live advice.
 */
export function applyLiveCurrentPrice(nights: RecsNightView[], liveRates: Map<string, number>): RecsNightView[] {
  return nights.map((night) => {
    if (night.status !== "pending") return night;
    const live = liveRates.get(liveRateKey(night.listingId, night.date));
    if (live === undefined || live <= 0) return night;

    const generated = night.currentPrice;
    const moved = generated === null || Math.round(generated) !== Math.round(live);
    const rec = night.recommendedPrice;
    return {
      ...night,
      currentPrice: live,
      changePct: rec !== null ? (rec - live) / live : null,
      currentPriceSource: "live",
      currentPriceWas: moved ? generated : null,
      // Only a drop can be superseded — a hold has no direction to invert.
      supersededByLivePrice: night.kind === "drop" && rec !== null && rec >= live
    };
  });
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
  createdAt: true,
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

  const [
    pendingRows,
    actionedRows,
    recentDecisions,
    listings,
    windowRow,
    freshHours,
    evidenceRows,
    oversightRun,
    snoozes,
    clientSettings,
    liveRateRows
  ] = await Promise.all([
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
      readClientRecsSettings(tenantId),
      // The hourly-refreshed live rate for every night in the window — the
      // basis `applyLiveCurrentPrice` overlays onto the 05:30 `oldValue`.
      prisma.calendarRate.findMany({
        where: { tenantId, date: { gte: today, lte: windowEnd } },
        select: { listingId: true, date: true, available: true, rate: true }
      })
    ]);

  const nameByListing = new Map(listings.map((l) => [l.id, l.name ?? l.id]));
  const resolvedNights = applyLiveCurrentPrice(
    resolveNightRows(pendingRows.map(nightFromRow), actionedRows.map(nightFromRow)),
    buildLiveRateMap(liveRateRows)
  );

  // Far-out "on pace" holds are hidden by default (Mark, 2026-07-19): they
  // clog the approval flow. Suppressed holds (a drop was held back — that IS
  // information) and actioned rows always show. Toggleable via opts.allHolds.
  const holdCutoff = toDateOnly(new Date(today.getTime() + RECS_HOLD_VISIBLE_DAYS * 86_400_000));
  let hiddenHolds = 0;
  const nightsByListing = new Map<string, RecsNightView[]>();
  for (const night of resolvedNights) {
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
    .map(([listingId, nights]) => {
      const sorted = nights.sort((a, b) => a.date.localeCompare(b.date));
      const grouping = buildListingRuns(sorted);
      for (const night of sorted) {
        night.groupedInRun = grouping.groupedIds.has(night.suggestionId);
        night.soloReason = grouping.soloReasons.get(night.suggestionId) ?? null;
      }
      return {
        listingId,
        name: nameByListing.get(listingId) ?? listingId,
        unitCount: Math.max(1, listings.find((l) => l.id === listingId)?.unitCount ?? 1),
        snoozedUntil: snoozes.get(listingId) ?? null,
        nights: sorted,
        runs: grouping.runs
      };
    })
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
        select: { revenueAtRisk: true, detail: true, provenance: true, provisional: true, listingId: true, proposedValue: true }
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
    let belowFloorPending = 0;
    let provenance: string | null = null;
    for (const row of pending) {
      // Snoozed listings are ignored on purpose — their nights stay out of
      // the headline counts, and the snoozedListings figure keeps them
      // visible so they can't be forgotten.
      if (row.listingId && snoozes.has(row.listingId)) continue;
      const detail = detailOf(row.detail);
      const rar = num(row.revenueAtRisk) ?? 0;
      if (detail.hold === true) holdCount += 1;
      // A pending recommendation sitting below its resolved floor — feeds the
      // red state on the client's allow-below-minimum button.
      const rowFloor = typeof detail.floor === "number" ? (detail.floor as number) : null;
      const rowProposed = num(row.proposedValue);
      if (detail.hold !== true && rowFloor !== null && rowProposed !== null && rowProposed < rowFloor) {
        belowFloorPending += 1;
      }
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
      allowBelowFloor: clientSettings.allowBelowFloor,
      belowFloorPending
    });
  }
  return summaries;
}
