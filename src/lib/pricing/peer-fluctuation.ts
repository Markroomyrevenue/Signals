/**
 * Peer-fluctuation pricing — the formal, push-ready model.
 *
 * Distinct from `peer-shape.ts` (which is a TEMPORARY trial model gated by
 * `hostawayPushEnabled`). Peer-fluctuation is gated by an explicit
 * `pricingMode === 'peer_fluctuation'` setting and a dedicated
 * `peerFluctuationPushEnabled` toggle. See BUILD-LOG.md (2026-04-29) for
 * the full decision record.
 *
 * Concept:
 *
 *   For each target listing T on each forward date D in [today, today+90]:
 *
 *     source pool S = every listing in the same tenant where
 *       pricingMode != 'peer_fluctuation' AND has 365d ADR data.
 *
 *     For each source listing s in S:
 *       listingAvg365(s) = mean nightly ADR of s over the last 365 days
 *           (filter: exclude cancelled / no-show / LOS > 14 nights, mirroring
 *            `deriveOwnHistoryBaseSignal`'s primary signal).
 *
 *       rate(s, D) = CalendarRate(s, D) when set and nonzero
 *                  = NightFact(s, D - 365d).achievedRate when CalendarRate
 *                    missing AND a same-date-LY booked night exists
 *                  = skip otherwise.
 *
 *       fluctuation(s, D) = (rate(s, D) - listingAvg365(s)) / listingAvg365(s)
 *
 *     avgFluctuation(D) = mean of fluctuation(s, D) across S (need >= 2
 *       sources or skip the date entirely).
 *
 *     avgFluctuation is clamped to ±50% (sanity cap).
 *
 *     finalRate(T, D) = max(userBase(T) × (1 + avgFluctuation(D)),  userMin(T))
 *
 * Hard rules (mirrors `peer-shape.ts`'s tenant-isolation contract):
 *   - Every Prisma query MUST filter by `tenantId`.
 *   - Subject (target) listing is excluded from the source pool.
 *   - Listings with `pricingMode === 'peer_fluctuation'` are also excluded
 *     from being sources for any other peer-fluctuation listing.
 *   - When fewer than 2 sources contribute on a date, we DON'T price that
 *     date — we skip it. Caller is expected to render `null` and the daily
 *     push worker is expected to log a "skipped, fewer than 2 sources"
 *     status for it.
 */
import type { PrismaClient } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";

/** Minimum number of source listings that must contribute a usable
 *  fluctuation value before the aggregator returns a result for a date.
 *  Stricter than peer-shape (which accepts 1) so we're not pushing a price
 *  shaped by a single noisy peer. */
export const PEER_FLUCTUATION_MIN_SOURCES_PER_DATE = 2;

/** Sanity cap on the aggregate fluctuation. ±50% means a runaway day from a
 *  single odd source can't pull the student-accom rate to silly numbers.
 *  When the cap engages we record the raw value in the diagnostic so the
 *  worker can log "cap engaged on date X". */
export const PEER_FLUCTUATION_SANITY_CAP = 0.5;

/** LOS upper bound (inclusive) for source 365d ADR observations. Mirrors
 *  the primary `deriveOwnHistoryBaseSignal` filter — short stays only;
 *  long-term stays don't reflect the daily curve. */
export const PEER_FLUCTUATION_HISTORY_MAX_LOS_NIGHTS_INCLUSIVE = 14;

/** Trailing window for source 365d ADR. */
export const PEER_FLUCTUATION_HISTORY_WINDOW_DAYS = 365;

/** One observation feeding a source listing's 365d ADR. */
export type PeerFluctuationHistoryRow = {
  listingId: string;
  /** Achieved nightly rate (booked) on this historical night. */
  rate: number;
  /** Total length of the stay this night belongs to, in nights. */
  losNights: number;
};

/** A live (forward) calendar-rate row, used as the primary fluctuation input. */
export type PeerFluctuationCalendarRow = {
  listingId: string;
  dateOnly: string;
  available: boolean;
  rate: number | null;
};

/** A booked-night row from exactly one year before the target date, used as
 *  fallback when CalendarRate is missing for the source on the forward
 *  date. (Spec A.2 step 2c.) */
export type PeerFluctuationLastYearRow = {
  listingId: string;
  /** dateOnly of the FORWARD date that this LY observation maps to (i.e.
   *  ly.dateOnly = ly.bookedDate + 365d). The aggregator joins on this key. */
  dateOnly: string;
  /** Achieved booked rate on the LY night. */
  rate: number;
  losNights: number;
};

export type PeerFluctuationResultEntry = {
  /** Mean fluctuation across contributing sources, post-cap. */
  fluctuation: number;
  /** Pre-cap fluctuation (for diagnostics). Equals `fluctuation` unless the
   *  ±50% sanity cap engaged — in which case the raw value is preserved here
   *  and the worker can log it. */
  fluctuationRaw: number;
  /** True when the ±50% cap engaged on this date. */
  capEngaged: boolean;
  /** How many sources contributed usable fluctuation values. Always >=
   *  PEER_FLUCTUATION_MIN_SOURCES_PER_DATE (else this entry would be null). */
  sourceCount: number;
};

export type PeerFluctuationSkipReason =
  | "insufficient_sources"
  | "no_history"
  | "no_target_base";

/** Map keyed by dateOnly. `null` = skipped this date (record the reason). */
export type PeerFluctuationByDate = Map<
  string,
  PeerFluctuationResultEntry | { skipReason: PeerFluctuationSkipReason }
>;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Pure aggregator: given source listings' 365d booked nights, their forward
 * calendar rates, and a same-date-LY booked-night map, compute the
 * fluctuation per forward date. No DB / network calls — designed for unit
 * tests against fixture data.
 *
 * Subject (target) listing must already be EXCLUDED from `historyRows`,
 * `forwardRows`, and `lastYearRows` by the caller.
 */
export function computePeerFluctuationByDateFromRows(params: {
  historyRows: PeerFluctuationHistoryRow[];
  forwardRows: PeerFluctuationCalendarRow[];
  lastYearRows: PeerFluctuationLastYearRow[];
  fromDate: string;
  toDate: string;
  minSourcesPerDate?: number;
  sanityCap?: number;
  historyMaxLosNightsInclusive?: number;
}): PeerFluctuationByDate {
  const minSources = params.minSourcesPerDate ?? PEER_FLUCTUATION_MIN_SOURCES_PER_DATE;
  const sanityCap = params.sanityCap ?? PEER_FLUCTUATION_SANITY_CAP;
  const historyMaxLos =
    params.historyMaxLosNightsInclusive ?? PEER_FLUCTUATION_HISTORY_MAX_LOS_NIGHTS_INCLUSIVE;

  // 1. Build per-source 365d ADR (mean nightly achieved rate over the
  //    history window, restricted to short stays).
  type Acc = { totalRate: number; nights: number };
  const perSourceHistory = new Map<string, Acc>();
  for (const row of params.historyRows) {
    if (!isFiniteNumber(row.rate) || row.rate <= 0) continue;
    if (!isFiniteNumber(row.losNights) || row.losNights <= 0 || row.losNights > historyMaxLos) continue;
    const acc = perSourceHistory.get(row.listingId) ?? { totalRate: 0, nights: 0 };
    acc.totalRate += row.rate;
    acc.nights += 1;
    perSourceHistory.set(row.listingId, acc);
  }
  const adrBySource = new Map<string, number>();
  for (const [sourceId, acc] of perSourceHistory.entries()) {
    if (acc.nights <= 0) continue;
    const adr = acc.totalRate / acc.nights;
    if (!Number.isFinite(adr) || adr <= 0) continue;
    adrBySource.set(sourceId, adr);
  }

  // 2. Index forward calendar rates and LY fallback rates by (date, source).
  //    Spec A.2 step 2c: prefer CalendarRate, then last-year-same-date booked.
  const forwardByDate = new Map<string, Map<string, number>>(); // date → source → rate
  for (const row of params.forwardRows) {
    if (!row.available) continue;
    if (row.rate === null || !isFiniteNumber(row.rate) || row.rate <= 0) continue;
    const peer = forwardByDate.get(row.dateOnly) ?? new Map<string, number>();
    peer.set(row.listingId, row.rate);
    forwardByDate.set(row.dateOnly, peer);
  }
  const lastYearByDate = new Map<string, Map<string, number>>(); // forwardDate → source → ly rate
  for (const row of params.lastYearRows) {
    if (!isFiniteNumber(row.rate) || row.rate <= 0) continue;
    if (!isFiniteNumber(row.losNights) || row.losNights <= 0 || row.losNights > historyMaxLos) continue;
    const peer = lastYearByDate.get(row.dateOnly) ?? new Map<string, number>();
    // If the same source has multiple LY bookings on the same date (rare —
    // possible if multi-unit), keep the first; both should be similar.
    if (!peer.has(row.listingId)) peer.set(row.listingId, row.rate);
    lastYearByDate.set(row.dateOnly, peer);
  }

  // 3. For every date in [fromDate, toDate], compute the per-source
  //    fluctuation and aggregate.
  const out: PeerFluctuationByDate = new Map();
  const start = fromDateOnly(params.fromDate);
  const end = fromDateOnly(params.toDate);

  if (adrBySource.size === 0) {
    for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
      out.set(toDateOnly(cursor), { skipReason: "no_history" });
    }
    return out;
  }

  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    const dateKey = toDateOnly(cursor);
    const forwardForDate = forwardByDate.get(dateKey) ?? new Map<string, number>();
    const lyForDate = lastYearByDate.get(dateKey) ?? new Map<string, number>();

    let fluctSum = 0;
    let fluctCount = 0;
    for (const [sourceId, adr] of adrBySource.entries()) {
      const liveRate = forwardForDate.get(sourceId);
      const fallbackRate = liveRate === undefined ? lyForDate.get(sourceId) : undefined;
      const usedRate = liveRate ?? fallbackRate;
      if (usedRate === undefined || !isFiniteNumber(usedRate) || usedRate <= 0) continue;
      const fluct = (usedRate - adr) / adr;
      if (!Number.isFinite(fluct)) continue;
      fluctSum += fluct;
      fluctCount += 1;
    }

    if (fluctCount < minSources) {
      out.set(dateKey, { skipReason: "insufficient_sources" });
      continue;
    }

    const raw = fluctSum / fluctCount;
    const capped = clamp(raw, -sanityCap, sanityCap);
    out.set(dateKey, {
      fluctuation: capped,
      fluctuationRaw: raw,
      capEngaged: capped !== raw,
      sourceCount: fluctCount
    });
  }

  return out;
}

/**
 * DB-backed loader. Tenant-isolated by construction: every Prisma `where`
 * clause includes `tenantId`. Excludes the subject listing AND every other
 * peer-fluctuation listing in the tenant from the source pool, per
 * BUILD-LOG.md 2026-04-29 decision #2.
 */
export async function computePeerFluctuationByDate(params: {
  tenantId: string;
  subjectListingId: string;
  fromDate: string;
  toDate: string;
  prisma: PrismaClient;
  /** Listing IDs in the same tenant whose property-scope `pricingMode` is
   *  `'peer_fluctuation'`. Caller computes this once per assembly run; the
   *  loader simply excludes them from the source pool. */
  excludePeerFluctuationListingIds: string[];
  /** Override default 365 if needed (used by tests). */
  historyWindowDays?: number;
  /** Override default 2 if needed. */
  minSourcesPerDate?: number;
  /** Override default ±50% if needed. */
  sanityCap?: number;
  /** Defaults to today (UTC) if omitted. */
  todayDateOnly?: string;
}): Promise<PeerFluctuationByDate> {
  const today = params.todayDateOnly ?? toDateOnly(new Date());
  const historyWindowDays = Math.max(
    1,
    Math.round(params.historyWindowDays ?? PEER_FLUCTUATION_HISTORY_WINDOW_DAYS)
  );

  // Source pool = same tenant, NOT the subject, NOT peer-fluctuation.
  const exclusion = new Set<string>([
    params.subjectListingId,
    ...params.excludePeerFluctuationListingIds
  ]);
  const sourceListings = await params.prisma.listing.findMany({
    where: {
      tenantId: params.tenantId,
      id: { notIn: [...exclusion] }
    },
    select: { id: true }
  });
  const sourceIds = sourceListings.map((listing) => listing.id);

  const start = fromDateOnly(params.fromDate);
  const end = fromDateOnly(params.toDate);

  if (sourceIds.length === 0) {
    const out: PeerFluctuationByDate = new Map();
    for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
      out.set(toDateOnly(cursor), { skipReason: "no_history" });
    }
    return out;
  }

  // --- 365d historical booked nights for ADR ---
  const historyEnd = fromDateOnly(today);
  const historyStart = addUtcDays(historyEnd, -historyWindowDays);

  // --- LY booked nights (target_date - 365) keyed by FORWARD date ---
  // We pull the same booked-night table over the date range
  // [forwardStart - 365d, forwardEnd - 365d] and re-key each row by adding
  // 365 days to its date.
  const lyStart = addUtcDays(start, -365);
  const lyEnd = addUtcDays(end, -365);

  const [historyRowsRaw, forwardRowsRaw, lastYearRowsRaw] = await Promise.all([
    params.prisma.nightFact.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: sourceIds },
        date: { gte: historyStart, lt: historyEnd },
        isOccupied: true,
        status: { notIn: ["cancelled", "canceled", "no_show", "no-show"] }
      },
      select: { listingId: true, revenueAllocated: true, losNights: true }
    }),
    params.prisma.calendarRate.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: sourceIds },
        date: { gte: start, lte: end }
      },
      select: { listingId: true, date: true, available: true, rate: true }
    }),
    params.prisma.nightFact.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: sourceIds },
        date: { gte: lyStart, lte: lyEnd },
        isOccupied: true,
        status: { notIn: ["cancelled", "canceled", "no_show", "no-show"] }
      },
      select: { listingId: true, date: true, revenueAllocated: true, losNights: true }
    })
  ]);

  function decimalToNumber(v: number | { toString: () => string } | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const n = Number(v.toString());
    return Number.isFinite(n) ? n : null;
  }

  const historyRows: PeerFluctuationHistoryRow[] = [];
  for (const row of historyRowsRaw) {
    const rate = decimalToNumber(row.revenueAllocated);
    if (rate === null || rate <= 0) continue;
    const los = typeof row.losNights === "number" ? row.losNights : 0;
    if (!Number.isFinite(los) || los <= 0) continue;
    historyRows.push({ listingId: row.listingId, rate, losNights: los });
  }

  const forwardRows: PeerFluctuationCalendarRow[] = forwardRowsRaw.map((row) => ({
    listingId: row.listingId,
    dateOnly: toDateOnly(row.date),
    available: row.available,
    rate: decimalToNumber(row.rate)
  }));

  const lastYearRows: PeerFluctuationLastYearRow[] = [];
  for (const row of lastYearRowsRaw) {
    const rate = decimalToNumber(row.revenueAllocated);
    if (rate === null || rate <= 0) continue;
    const los = typeof row.losNights === "number" ? row.losNights : 0;
    if (!Number.isFinite(los) || los <= 0) continue;
    // Re-key into the forward window by adding 365 days.
    const forwardDate = toDateOnly(addUtcDays(row.date, 365));
    if (forwardDate < params.fromDate || forwardDate > params.toDate) continue;
    lastYearRows.push({ listingId: row.listingId, dateOnly: forwardDate, rate, losNights: los });
  }

  return computePeerFluctuationByDateFromRows({
    historyRows,
    forwardRows,
    lastYearRows,
    fromDate: params.fromDate,
    toDate: params.toDate,
    minSourcesPerDate: params.minSourcesPerDate,
    sanityCap: params.sanityCap
  });
}

/**
 * Apply a peer-fluctuation result to a target listing's user-set base + min,
 * returning the final pushable rate or null if the date should be skipped.
 *
 * Rounding policy mirrors the peer-shape branch: a single
 * `roundToIncrement` pass after the `(1 + fluctuation)` multiplication and
 * before the min floor. This intentionally allows the min floor to land
 * exactly on the user's saved minimum (no rounding-up past it).
 */
export function applyPeerFluctuation(input: {
  fluctuation: PeerFluctuationResultEntry | { skipReason: PeerFluctuationSkipReason };
  userBase: number;
  userMin: number | null;
  roundingIncrement: number;
}):
  | { finalRate: number; skipped: false }
  | { finalRate: null; skipped: true; skipReason: PeerFluctuationSkipReason } {
  if ("skipReason" in input.fluctuation) {
    return { finalRate: null, skipped: true, skipReason: input.fluctuation.skipReason };
  }
  const raw = input.userBase * (1 + input.fluctuation.fluctuation);
  const rounded = roundToIncrement(raw, input.roundingIncrement);
  const floored =
    input.userMin !== null && rounded < input.userMin ? input.userMin : rounded;
  return { finalRate: floored, skipped: false };
}

function roundToIncrement(value: number, increment: number): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(increment) || increment <= 1) return Math.round(value);
  return Math.round(value / increment) * increment;
}
