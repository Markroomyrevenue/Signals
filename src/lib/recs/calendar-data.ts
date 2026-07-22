/**
 * Read layer for the recs CALENDAR view (2026-07-20).
 *
 * One GET (/api/recs/calendar) returns every client's month-at-a-glance
 * payload: the 14-day recommendation nights/runs from `loadRecsClientView`
 * (the same rows the list page shows — one source of truth for what is
 * recommended), plus 30 days of per-listing calendar CONTEXT the list page
 * never needed: booked earnings, min-stay, and the live rate on open days
 * beyond the recs window (clickable there to set an operator price).
 *
 * Internal-only, same gate as every /api/recs route. The payload is
 * cross-client by design — this is the internal approvals surface — but every
 * individual Prisma query still filters by tenantId (house rule).
 *
 * Field names are deliberately terse (cur/rec/pct/sup/ov…) — they are the
 * prototype's embedded DATA contract and the UI consumes them verbatim.
 */

import { toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";
import { loadRecsClientView, RECS_WINDOW_DAYS, type RecsNightView } from "@/lib/recs/data";
import { londonDayOf } from "@/lib/recs/market/context";
import { type RecsRunView } from "@/lib/recs/runs";
import { readListingSnoozes } from "@/lib/recs/settings";

/** Booked/min-stay/live context runs today..today+30 (inclusive) — the recs
 * nights only cover 14 days; the extra days give the grid a real month. */
export const CALENDAR_CONTEXT_DAYS = 30;

/** Operator price-setting (user-set) is bounded to the SAME window the recs
 * pipeline surfaces and tracks — a manual price beyond it would push live yet
 * never re-appear on the calendar (loadRecsClientView only returns the first
 * `RECS_WINDOW_DAYS` days), so it could silently double-push. Days past this
 * boundary are read-only context. Re-exported for the route + the UI. */
export const CALENDAR_SETTABLE_DAYS = RECS_WINDOW_DAYS;

export type CalendarNight = {
  id: string;
  date: string;
  dow: string;
  cur: number;
  rec: number | null;
  pct: number | null;
  kind: "drop" | "hold";
  sup: string | null;
  /** Short line for the tile; the full sentence lives in `whyFull`. */
  why: string;
  whyFull: string;
  /** Sizing decomposition bullets (empty for holds/user-set rows). */
  comp: string[];
  floor: number | null;
  floorUnknown: boolean;
  status: string;
  /** When the human actioned (approved/pushed) this night — ISO — so a pushed
   * tile can show "Pushed 20 Jul" and the daily workflow knows its age. */
  actionedAt: string | null;
  /** The actual push outcome, when one has been attempted — the ONLY reliable
   * signal that a night is verified-pushed vs mismatched/failed. `status`
   * alone cannot tell them apart (a mismatch stays "approved"). */
  push: { pushed: boolean; verified: boolean | null; reverted: boolean; error: string | null } | null;
  ov: { verdict: string; reason: string | null; narrative: string | null } | null;
};

export type CalendarRun = {
  ids: string[];
  from: string;
  to: string;
  n: number;
  runKind: "drop" | "hold";
  seg: "weekday" | "weekend" | "mixed";
  totCur: number;
  totRec: number;
  uniformPct: number | null;
  why: string[];
};

/** A prior decision on a night — the blue-dot history. Once a night is actioned
 * it stops being a live tile (Mark, 2026-07-22: "immediately after any push it
 * returns to a normal box"); its decision lives here instead. */
export type CalendarHistory = {
  /** What the engine recommended at decision time (rounded). */
  recommended: number | null;
  /** What the operator actually pushed/approved (rounded; may differ = edited). */
  decided: number | null;
  outcome: "pushed" | "ignored" | "skipped";
  edited: boolean;
  /** When the decision was taken — ISO. */
  at: string | null;
};

export type CalendarListing = {
  id: string;
  name: string;
  tags: string[];
  min: number | null;
  base: number | null;
  snoozedUntil: string | null;
  nights: CalendarNight[];
  runs: CalendarRun[];
  /** date → earned that night (NightFact revenueAllocated, ownerstay excluded). */
  booked: Record<string, number>;
  /** date → the booking's created-at ISO (earliest on that date) — lets the UI
   * tell a booking that landed AFTER a pushed rec (green dot) from a plain one. */
  bookedAt: Record<string, string>;
  /** date → the most recent prior decision on that night (blue-dot history). */
  history: Record<string, CalendarHistory>;
  /** date → CalendarRate.minStay (non-null rows only, any availability). */
  minStay: Record<string, number>;
  /** date → live rate, rounded — OPEN days only (available=true). */
  live: Record<string, number>;
};

export type CalendarClient = {
  id: string;
  name: string;
  currency: string;
  engine: string;
  allowBelowFloor: boolean;
  listings: CalendarListing[];
};

export type RecsCalendarPayload = {
  today: string;
  /** Days from today (exclusive upper bound) an operator may SET a price on —
   * the recs surfacing/tracking window. Context days beyond it are read-only. */
  settableDays: number;
  clients: CalendarClient[];
};

/** Midnight (UTC-encoded) of the LONDON calendar day for `now` — a page view
 * in the 00:00-01:00 BST hour must not start the window on yesterday.
 * (Same rule as loadRecsClientView's private helper.) */
export function londonToday(now: Date): Date {
  const [y, m, d] = londonDayOf(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The calendar's context window: London-today .. today+30, inclusive. */
export function calendarWindow(now: Date): { today: string; start: Date; end: Date } {
  const start = londonToday(now);
  return { today: toDateOnly(start), start, end: new Date(start.getTime() + CALENDAR_CONTEXT_DAYS * 86_400_000) };
}

/** Prisma Decimal (or anything numeric) → rounded number; null when absent. */
export function roundedOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Pure night mapping: RecsNightView → the prototype's tile shape. */
export function nightToCalendar(night: RecsNightView): CalendarNight {
  return {
    id: night.suggestionId,
    date: night.date,
    dow: night.dow,
    // recs-night rows always carry an oldValue (the generator requires it and
    // user-set rows record the live rate) — the ?? 0 is a type-level fallback.
    cur: night.currentPrice ?? 0,
    // Actioned rows surface the price the human actually approved (may be an
    // edited number) so a pushed tile still renders its FINAL price on reload.
    rec: night.approvedPrice ?? night.recommendedPrice,
    pct: night.changePct,
    kind: night.kind,
    sup: night.suppressed,
    why: night.whyShort,
    whyFull: night.why,
    comp: night.sizingComponents,
    floor: night.floor,
    floorUnknown: night.floorUnknown,
    status: night.status,
    actionedAt: night.actionedAt,
    push: night.push,
    ov: night.oversight
  };
}

/** Pure run mapping: RecsRunView → the prototype's ribbon shape. */
export function runToCalendar(run: RecsRunView): CalendarRun {
  return {
    ids: run.suggestionIds,
    from: run.dateFrom,
    to: run.dateTo,
    n: run.nightsCount,
    runKind: run.runKind,
    seg: run.segment,
    totCur: run.totalCurrent,
    totRec: run.totalProposed,
    uniformPct: run.uniformPct,
    why: run.why
  };
}

/** The frozen Min column: latest engine-snapshot min wins; a listing the
 * engine never reported falls back to the lowest floor its nights carry;
 * null when nothing is known (the UI shows a dash, never a guess). */
export function resolveListingMin(snapshotMin: number | null, nights: CalendarNight[]): number | null {
  if (snapshotMin !== null) return snapshotMin;
  const floors = nights.map((n) => n.floor).filter((f): f is number => f !== null);
  return floors.length > 0 ? Math.min(...floors) : null;
}

/** Sum occupied-night earnings per listing per date. Ownerstay rows are
 * occupied but earn nothing real — excluded, matching every revenue read in
 * the codebase. Multi-unit listings sum across factKeys on the same date. */
export function buildBookedByListing(
  rows: { listingId: string; date: Date; status: string | null; revenueAllocated: unknown }[]
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (row.status === "ownerstay") continue;
    const revenue = Number(row.revenueAllocated);
    if (!Number.isFinite(revenue)) continue;
    const byDate = out.get(row.listingId) ?? {};
    const date = toDateOnly(row.date);
    byDate[date] = (byDate[date] ?? 0) + revenue;
    out.set(row.listingId, byDate);
  }
  return out;
}

/** Earliest booking-created time per listing per date — for the "booked after a
 * pushed rec" green dot. Ownerstay excluded like the earnings map. */
export function buildBookedAtByListing(
  rows: { listingId: string; date: Date; status: string | null; bookingCreatedAt: Date | null }[]
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const row of rows) {
    if (row.status === "ownerstay" || !row.bookingCreatedAt) continue;
    const byDate = out.get(row.listingId) ?? {};
    const date = toDateOnly(row.date);
    const iso = row.bookingCreatedAt.toISOString();
    if (!byDate[date] || iso < byDate[date]) byDate[date] = iso;
    out.set(row.listingId, byDate);
  }
  return out;
}

/** A push that was attempted but did NOT verify (the engine read back a
 * different price) — status stays "approved" with a pushed-but-unverified
 * detail. These stay LIVE, retryable tiles; they must never be demoted to a
 * benign "skipped" history dot that hides the wrong engine price. */
export function isUnresolvedPush(night: RecsNightView): boolean {
  return (
    night.status === "approved" &&
    night.push !== null &&
    night.push.pushed === true &&
    night.push.verified === false &&
    !night.push.reverted
  );
}

/** A night the operator already decided on → its blue-dot history entry.
 * `null` for pending nights (they are still live tiles). */
export function historyFromNight(night: RecsNightView): CalendarHistory | null {
  if (night.status === "pending") return null;
  const recommended = roundedOrNull(night.recommendedPrice);
  const decided = roundedOrNull(night.approvedPrice);
  const outcome: CalendarHistory["outcome"] =
    night.status === "rejected"
      ? "ignored"
      : night.status === "applied"
        ? "pushed"
        : // approved but never went live (push skipped / not verified)
          "skipped";
  const edited = decided !== null && recommended !== null && decided !== recommended;
  return { recommended, decided, outcome, edited, at: night.actionedAt };
}

/** Split CalendarRate rows into the two context maps: minStay (any row that
 * has one — a booked date's min-stay is still true) and live (OPEN days only —
 * an unavailable date has no sellable price, so quoting one would mislead). */
export function buildRateContextByListing(
  rows: { listingId: string; date: Date; available: boolean; minStay: number | null; rate: unknown }[]
): Map<string, { minStay: Record<string, number>; live: Record<string, number> }> {
  const out = new Map<string, { minStay: Record<string, number>; live: Record<string, number> }>();
  for (const row of rows) {
    const entry = out.get(row.listingId) ?? { minStay: {}, live: {} };
    const date = toDateOnly(row.date);
    if (row.minStay !== null) entry.minStay[date] = row.minStay;
    if (row.available) {
      const rate = roundedOrNull(row.rate);
      if (rate !== null) entry.live[date] = rate;
    }
    out.set(row.listingId, entry);
  }
  return out;
}

export async function loadRecsCalendar(now = new Date()): Promise<RecsCalendarPayload> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  const window = calendarWindow(now);

  const clients: CalendarClient[] = [];
  for (const tenant of tenants) {
    // Demo tenants are sample data — never on the approvals calendar.
    if (tenant.name.startsWith("Demo")) continue;

    // The calendar is day-by-day, so far-out on-pace holds render too
    // (allHolds) — the list page's hide-them default exists to unclog a
    // QUEUE; a grid with gaps where pending rows exist would just confuse.
    const view = await loadRecsClientView(tenant.id, now, { allHolds: true });
    if (!view) continue;

    const [listings, nightFacts, calendarRates, snapshots, snoozes] = await Promise.all([
      prisma.listing.findMany({
        where: { tenantId: tenant.id, removedAt: null },
        select: { id: true, name: true, tags: true },
        orderBy: { name: "asc" }
      }),
      prisma.nightFact.findMany({
        where: { tenantId: tenant.id, date: { gte: window.start, lte: window.end }, isOccupied: true },
        select: { listingId: true, date: true, status: true, revenueAllocated: true, bookingCreatedAt: true }
      }),
      prisma.calendarRate.findMany({
        where: { tenantId: tenant.id, date: { gte: window.start, lte: window.end } },
        select: { listingId: true, date: true, available: true, minStay: true, rate: true }
      }),
      // Latest engine snapshot per listing → the frozen Min/Base columns.
      prisma.engineSnapshot.findMany({
        where: { tenantId: tenant.id, listingId: { not: null } },
        orderBy: { capturedAt: "desc" },
        distinct: ["listingId"],
        select: { listingId: true, min: true, base: true }
      }),
      // The view only carries snoozes for listings that HAVE nights; the
      // calendar shows every listing, so read the full map directly.
      readListingSnoozes(tenant.id, now)
    ]);

    const viewByListing = new Map(view.listings.map((l) => [l.listingId, l]));
    const snapshotByListing = new Map(snapshots.map((s) => [s.listingId as string, s]));
    const bookedByListing = buildBookedByListing(nightFacts);
    const bookedAtByListing = buildBookedAtByListing(nightFacts);
    const ratesByListing = buildRateContextByListing(calendarRates);

    clients.push({
      id: view.tenantId,
      name: view.name,
      currency: view.currency,
      engine: view.engine,
      allowBelowFloor: view.allowBelowFloor,
      listings: listings.map((listing) => {
        const viewListing = viewByListing.get(listing.id);
        const allViewNights = viewListing?.nights ?? [];
        // A cleanly-decided night (pushed ✓ / ignored) is NOT a live tile any
        // more — it drops to the blue-dot history and the tile returns to its
        // normal state. But a night whose push did NOT verify (a mismatch left
        // for review) MUST stay a live, retryable tile — never hide a wrong
        // engine price behind a benign "skipped" dot.
        const stillLive = (n: RecsNightView): boolean => n.status === "pending" || isUnresolvedPush(n);
        const nights = allViewNights.filter(stillLive).map(nightToCalendar);
        const history: Record<string, CalendarHistory> = {};
        for (const n of allViewNights) {
          if (stillLive(n)) continue; // a live tile, not a past decision
          const entry = historyFromNight(n);
          if (entry) history[n.date] = entry;
        }
        const snapshot = snapshotByListing.get(listing.id);
        const context = ratesByListing.get(listing.id);
        return {
          id: listing.id,
          name: listing.name,
          tags: listing.tags,
          min: resolveListingMin(roundedOrNull(snapshot?.min ?? null), nights),
          base: roundedOrNull(snapshot?.base ?? null),
          snoozedUntil: snoozes.get(listing.id) ?? null,
          nights,
          runs: (viewListing?.runs ?? [])
            .filter((run) => run.suggestionIds.every((id) => nights.some((n) => n.id === id)))
            .map(runToCalendar),
          booked: bookedByListing.get(listing.id) ?? {},
          bookedAt: bookedAtByListing.get(listing.id) ?? {},
          history,
          minStay: context?.minStay ?? {},
          live: context?.live ?? {}
        };
      })
    });
  }

  return { today: window.today, settableDays: CALENDAR_SETTABLE_DAYS, clients };
}
