/**
 * Peer-shape pricing — TEMPORARY MODEL FOR LIVE-PUSH LISTINGS.
 *
 * This module bridges listings going live with Hostaway push enabled. The
 * owner explicitly asked for it as a stop-gap so newly onboarded listings
 * piggy-back on the *trend* of the rest of the portfolio (which is still
 * priced by another tool) instead of being driven by occupancy / seasonality
 * / demand multipliers. Once Hostaway integration is stable and the team has
 * confidence in the standard recommendation, this branch should be reviewed
 * and (likely) removed in favour of the canonical pricing pipeline.
 *
 * Concept (per owner spec):
 *   For listing L on date D where `hostawayPushEnabled === true`,
 *     factor_P(D) = peer_nightly_rate_P(D) / yearly_adr_P
 *   averaged across every other listing P in the same tenant. The user's
 *   saved base price is the anchor; the portfolio's peer rates only shape
 *   the *direction* of the daily curve (cheaper Tuesdays, busier weekends,
 *   summer premium etc).
 *
 * Hard rules:
 *   - Tenant-isolated: every Prisma query MUST filter by tenantId.
 *   - Subject listing is excluded from its own peer set.
 *   - Only AVAILABLE peer-nights count, both for yearly ADR and for the
 *     per-date factor. Blocked / off-market nights are dropped.
 *   - When fewer than 3 peers have a value for a given date, the factor
 *     entry is null and the caller falls back to the user's base price.
 */
import type { PrismaClient } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";

/** Minimum number of peers with a usable rate on a given date before we
 *  trust the aggregated factor. Owner spec (2026-04-28): "Always fall
 *  back on peer fluctuation on price even if only 1 unit on 1 night
 *  available" — so a single contributing peer is enough.
 */
const DEFAULT_MIN_PEERS_PER_DATE = 1;

/** Maximum stay length (in nights, exclusive) for booked peer rates that
 *  feed the fallback factor. Owner spec: "discount any reservations that
 *  are 7 nights or more so that we aren't taking into account a long
 *  term stay rate." So we keep stays of 1..6 nights and drop ≥7.
 */
const DEFAULT_BOOKED_FALLBACK_MAX_LOS_NIGHTS_EXCLUSIVE = 7;

/** Default trailing window for the peer's yearly ADR. */
const DEFAULT_YEARLY_ADR_WINDOW_DAYS = 365;

/**
 * One row read from `calendar_rates`. Plain shape so the pure aggregator
 * can be tested without Prisma.
 */
export type PeerCalendarRateRow = {
  listingId: string;
  dateOnly: string;
  available: boolean;
  rate: number | null;
};

/**
 * One booked peer-night used to compute the peer's BOOKED yearly ADR.
 * Owner spec (2026-04-28): yearly ADR should be the booked-night ADR
 * over the trailing 365 days, NOT the available-calendar ADR — this
 * gives "true fluctuation value of the properties bookings". Stays of
 * 7+ nights are dropped (long-term rates aren't representative).
 */
export type PeerHistoricalBookedNightRow = {
  listingId: string;
  /** Booked nightly rate for this peer on this historical night. */
  rate: number;
  /** Total length of the stay this night belongs to, in nights. */
  losNights: number;
};

/**
 * One booked peer-night used for the fallback factor when a date has no
 * AVAILABLE peer rates. Owner spec: discount stays of 7 nights or more
 * (long-term rates aren't representative of the daily curve).
 */
export type PeerBookedNightRow = {
  listingId: string;
  dateOnly: string;
  /** Booked nightly rate for this peer on this date (achieved). */
  rate: number;
  /** Total length of the stay this night belongs to, in nights. */
  losNights: number;
};

export type PeerShapeFactorEntry = {
  /** Aggregate factor (mean of available peers' factors on this date). */
  factor: number;
  /** How many peers contributed to the factor on this date. */
  peerCount: number;
  /** "available" when the factor is built from peers that were available
   *  for sale; "booked-fallback" when no peers were available and we used
   *  short-stay booked peer rates instead. */
  source: "available" | "booked-fallback";
};

/**
 * Pure aggregator: given calendar_rates rows for the peers (NOT the subject)
 * and the analysis window, compute the mean factor per date. Designed for
 * easy unit testing without a Prisma instance.
 *
 * - `historicalRows` cover the trailing 365d window for each peer; we use
 *   them to compute each peer's yearly ADR over its AVAILABLE nights only.
 * - `forwardRows` cover the date range we want a factor for (the calendar
 *   month). For each date we look at peers that are AVAILABLE on that
 *   date and compute factor_P(D) = rate / yearly_adr_P.
 * - Subject listing must already be EXCLUDED from both row sets by the
 *   caller.
 * - Returns `null` factor entry when fewer than `minPeersPerDate` peers
 *   contribute on a given date — caller treats that as factor = 1 (just
 *   use base).
 */
export function computePeerShapeFactorByDateFromRows(params: {
  /** @deprecated kept for the legacy "calendar-rates yearly ADR" model;
   *  prefer `historicalBookedNights` per owner spec 2026-04-28. When
   *  both are provided, booked nights take precedence. */
  historicalRows?: PeerCalendarRateRow[];
  /** Booked nights from the trailing 365 days for each peer, used to
   *  build the BOOKED yearly ADR (the peer's actually-achieved price).
   *  Stays of 7+ nights are dropped (same cutoff as the booked-fallback
   *  layer). Owner spec: "available nights price / booked 365 day ADR
   *  so we get the true fluctuation value of the properties bookings". */
  historicalBookedNights?: PeerHistoricalBookedNightRow[];
  forwardRows: PeerCalendarRateRow[];
  /** Optional booked-peer-night rows for the same forward window. Used
   *  ONLY when a given date has zero AVAILABLE peer rates. Stays of
   *  `losNights >= bookedFallbackMaxLosNightsExclusive` (default 7) are
   *  dropped. */
  bookedFallbackRows?: PeerBookedNightRow[];
  fromDate: string;
  toDate: string;
  minPeersPerDate?: number;
  /** Inclusive lower / exclusive upper bound on stay length when using
   *  booked-fallback rates. Default keeps 1..6 nights and drops 7+. */
  bookedFallbackMaxLosNightsExclusive?: number;
}): Map<string, PeerShapeFactorEntry | null> {
  const minPeersPerDate = params.minPeersPerDate ?? DEFAULT_MIN_PEERS_PER_DATE;
  const bookedFallbackMaxLos =
    params.bookedFallbackMaxLosNightsExclusive ?? DEFAULT_BOOKED_FALLBACK_MAX_LOS_NIGHTS_EXCLUSIVE;

  // 1. Per-peer yearly ADR. Owner spec: BOOKED-night ADR over the
  //    trailing 365 days, drop stays >= 7 nights. The `historicalRows`
  //    (calendar-rate-derived) input is kept as a legacy fallback for
  //    callers that pre-date the booked-ADR switch.
  type Acc = { totalRate: number; nights: number };
  const perPeerHistory = new Map<string, Acc>();
  if (params.historicalBookedNights && params.historicalBookedNights.length > 0) {
    for (const row of params.historicalBookedNights) {
      if (!Number.isFinite(row.rate) || row.rate <= 0) continue;
      if (!Number.isFinite(row.losNights) || row.losNights <= 0) continue;
      if (row.losNights >= bookedFallbackMaxLos) continue; // drop long stays
      const acc = perPeerHistory.get(row.listingId) ?? { totalRate: 0, nights: 0 };
      acc.totalRate += row.rate;
      acc.nights += 1;
      perPeerHistory.set(row.listingId, acc);
    }
  } else if (params.historicalRows) {
    // Legacy path — calendar-rate ADR (deprecated).
    for (const row of params.historicalRows) {
      if (!row.available) continue;
      if (row.rate === null || !Number.isFinite(row.rate) || row.rate <= 0) continue;
      const acc = perPeerHistory.get(row.listingId) ?? { totalRate: 0, nights: 0 };
      acc.totalRate += row.rate;
      acc.nights += 1;
      perPeerHistory.set(row.listingId, acc);
    }
  }
  const yearlyAdrByPeer = new Map<string, number>();
  for (const [peerId, acc] of perPeerHistory.entries()) {
    if (acc.nights <= 0) continue;
    yearlyAdrByPeer.set(peerId, acc.totalRate / acc.nights);
  }

  // 2. Primary layer: for each date, mean factor across AVAILABLE peers.
  const availableAcc = new Map<string, { factorSum: number; count: number }>();
  for (const row of params.forwardRows) {
    if (!row.available) continue;
    if (row.rate === null || !Number.isFinite(row.rate) || row.rate <= 0) continue;
    const yearlyAdr = yearlyAdrByPeer.get(row.listingId);
    if (yearlyAdr === undefined || yearlyAdr <= 0) continue;
    const factor = row.rate / yearlyAdr;
    if (!Number.isFinite(factor) || factor <= 0) continue;
    const existing = availableAcc.get(row.dateOnly) ?? { factorSum: 0, count: 0 };
    existing.factorSum += factor;
    existing.count += 1;
    availableAcc.set(row.dateOnly, existing);
  }

  // 3. Fallback layer: short-stay booked peer rates. Each (peer, date)
  //    contributes at most ONE rate per date; if a peer has multiple
  //    booked stays for the same date (rare, possible for multi-unit
  //    listings), average them first then count as one peer.
  const bookedFallbackAccByDate = new Map<string, { factorSum: number; count: number }>();
  if (params.bookedFallbackRows && params.bookedFallbackRows.length > 0) {
    // Group by (date, peer) so multi-unit peer with multiple bookings on
    // the same date doesn't get over-counted.
    const grouped = new Map<string, Map<string, { totalRate: number; nights: number }>>();
    for (const row of params.bookedFallbackRows) {
      if (!Number.isFinite(row.rate) || row.rate <= 0) continue;
      if (!Number.isFinite(row.losNights) || row.losNights <= 0) continue;
      if (row.losNights >= bookedFallbackMaxLos) continue;
      const peerMap = grouped.get(row.dateOnly) ?? new Map<string, { totalRate: number; nights: number }>();
      const acc = peerMap.get(row.listingId) ?? { totalRate: 0, nights: 0 };
      acc.totalRate += row.rate;
      acc.nights += 1;
      peerMap.set(row.listingId, acc);
      grouped.set(row.dateOnly, peerMap);
    }
    for (const [dateKey, peerMap] of grouped.entries()) {
      for (const [peerId, acc] of peerMap.entries()) {
        if (acc.nights <= 0) continue;
        const yearlyAdr = yearlyAdrByPeer.get(peerId);
        if (yearlyAdr === undefined || yearlyAdr <= 0) continue;
        const peerRate = acc.totalRate / acc.nights;
        const factor = peerRate / yearlyAdr;
        if (!Number.isFinite(factor) || factor <= 0) continue;
        const existing = bookedFallbackAccByDate.get(dateKey) ?? { factorSum: 0, count: 0 };
        existing.factorSum += factor;
        existing.count += 1;
        bookedFallbackAccByDate.set(dateKey, existing);
      }
    }
  }

  // 4. Build the output map for every date in [fromDate, toDate]. Prefer
  //    the AVAILABLE layer; only use booked-fallback when zero peers
  //    were available on that date.
  const out = new Map<string, PeerShapeFactorEntry | null>();
  const start = fromDateOnly(params.fromDate);
  const end = fromDateOnly(params.toDate);
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    const dateKey = toDateOnly(cursor);
    const primary = availableAcc.get(dateKey);
    if (primary && primary.count >= minPeersPerDate) {
      out.set(dateKey, {
        factor: primary.factorSum / primary.count,
        peerCount: primary.count,
        source: "available"
      });
      continue;
    }
    const fallback = bookedFallbackAccByDate.get(dateKey);
    if (fallback && fallback.count >= minPeersPerDate) {
      out.set(dateKey, {
        factor: fallback.factorSum / fallback.count,
        peerCount: fallback.count,
        source: "booked-fallback"
      });
      continue;
    }
    out.set(dateKey, null);
  }
  return out;
}

/**
 * Loads peer-shape factors from the live DB.
 *
 * Tenant-safe: every query filters by `tenantId`. Subject listing is
 * excluded from its own peer set.
 *
 * Returns a Map keyed by dateOnly. When fewer than 3 peers contribute on
 * a given date the entry is `null` and the caller should treat it as
 * factor = 1 (i.e. use base price unmodified).
 */
export async function computePeerShapeFactorByDate(params: {
  tenantId: string;
  subjectListingId: string;
  fromDate: string;
  toDate: string;
  prisma: PrismaClient;
  /** Defaults to 365 if omitted. */
  yearlyAdrWindowDays?: number;
  /** Defaults to today (UTC) if omitted. */
  todayDateOnly?: string;
  /** Defaults to 3 if omitted. */
  minPeersPerDate?: number;
}): Promise<Map<string, PeerShapeFactorEntry | null>> {
  const today = params.todayDateOnly ?? toDateOnly(new Date());
  const yearlyWindowDays = Math.max(1, Math.round(params.yearlyAdrWindowDays ?? DEFAULT_YEARLY_ADR_WINDOW_DAYS));
  const historyEnd = fromDateOnly(today);
  const historyStart = addUtcDays(historyEnd, -yearlyWindowDays);
  const forwardStart = fromDateOnly(params.fromDate);
  const forwardEnd = fromDateOnly(params.toDate);

  // Pull every peer listing in the tenant EXCEPT the subject.
  const peerListings = await params.prisma.listing.findMany({
    where: {
      tenantId: params.tenantId,
      id: { not: params.subjectListingId }
    },
    select: { id: true }
  });
  const peerIds = peerListings.map((listing) => listing.id);
  if (peerIds.length === 0) {
    // No peers at all → every date gets a null entry so caller falls back.
    const out = new Map<string, PeerShapeFactorEntry | null>();
    for (let cursor = forwardStart; cursor <= forwardEnd; cursor = addUtcDays(cursor, 1)) {
      out.set(toDateOnly(cursor), null);
    }
    return out;
  }

  // Four queries:
  //   1. Forward AVAILABLE peer rates (per-date primary factor)
  //   2. Forward booked peer-nights (per-date booked-fallback factor)
  //   3. Trailing 365d booked peer-nights (BOOKED yearly ADR — owner spec
  //      2026-04-28; replaces the old calendar-rate ADR)
  // Every query filters by tenantId AND restricts to the peer id
  // allowlist (defence-in-depth).
  const [forwardRowsRaw, bookedFallbackRowsRaw, historicalBookedRowsRaw] = await Promise.all([
    params.prisma.calendarRate.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: peerIds },
        date: { gte: forwardStart, lte: forwardEnd }
      },
      select: { listingId: true, date: true, available: true, rate: true }
    }),
    // Booked peer nights for the FORWARD window — fallback factor when
    // zero available peers contribute on a date. LOS filter applied in
    // the aggregator.
    params.prisma.nightFact.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: peerIds },
        date: { gte: forwardStart, lte: forwardEnd },
        isOccupied: true,
        status: { notIn: ["cancelled", "canceled", "no_show", "no-show"] }
      },
      select: { listingId: true, date: true, revenueAllocated: true, losNights: true }
    }),
    // Booked peer nights for the TRAILING 365d — used to compute each
    // peer's BOOKED yearly ADR. Owner spec: "available nights price /
    // booked 365 day ADR so we get the true fluctuation value of the
    // properties bookings". Long stays (LOS >= 7) dropped in the
    // aggregator.
    params.prisma.nightFact.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: peerIds },
        date: { gte: historyStart, lt: historyEnd },
        isOccupied: true,
        status: { notIn: ["cancelled", "canceled", "no_show", "no-show"] }
      },
      select: { listingId: true, revenueAllocated: true, losNights: true }
    })
  ]);

  function rowToShape(row: {
    listingId: string;
    date: Date;
    available: boolean;
    rate: number | { toString: () => string } | null;
  }): PeerCalendarRateRow {
    let rateNumber: number | null = null;
    if (row.rate !== null && row.rate !== undefined) {
      const candidate = typeof row.rate === "number" ? row.rate : Number(row.rate.toString());
      rateNumber = Number.isFinite(candidate) ? candidate : null;
    }
    return {
      listingId: row.listingId,
      dateOnly: toDateOnly(row.date),
      available: row.available,
      rate: rateNumber
    };
  }

  function bookedRowToShape(row: {
    listingId: string;
    date: Date;
    revenueAllocated: number | { toString: () => string } | null;
    losNights: number | null;
  }): PeerBookedNightRow | null {
    if (row.revenueAllocated === null || row.revenueAllocated === undefined) return null;
    const rate = typeof row.revenueAllocated === "number" ? row.revenueAllocated : Number(row.revenueAllocated.toString());
    if (!Number.isFinite(rate) || rate <= 0) return null;
    const los = typeof row.losNights === "number" ? row.losNights : 0;
    if (!Number.isFinite(los) || los <= 0) return null;
    return {
      listingId: row.listingId,
      dateOnly: toDateOnly(row.date),
      rate,
      losNights: los
    };
  }

  const bookedFallbackRows = bookedFallbackRowsRaw
    .map(bookedRowToShape)
    .filter((row): row is PeerBookedNightRow => row !== null);

  function historicalBookedRowToShape(row: {
    listingId: string;
    revenueAllocated: number | { toString: () => string } | null;
    losNights: number | null;
  }): PeerHistoricalBookedNightRow | null {
    if (row.revenueAllocated === null || row.revenueAllocated === undefined) return null;
    const rate =
      typeof row.revenueAllocated === "number" ? row.revenueAllocated : Number(row.revenueAllocated.toString());
    if (!Number.isFinite(rate) || rate <= 0) return null;
    const los = typeof row.losNights === "number" ? row.losNights : 0;
    if (!Number.isFinite(los) || los <= 0) return null;
    return { listingId: row.listingId, rate, losNights: los };
  }

  const historicalBookedNights = historicalBookedRowsRaw
    .map(historicalBookedRowToShape)
    .filter((row): row is PeerHistoricalBookedNightRow => row !== null);

  return computePeerShapeFactorByDateFromRows({
    historicalBookedNights,
    forwardRows: forwardRowsRaw.map(rowToShape),
    bookedFallbackRows,
    fromDate: params.fromDate,
    toDate: params.toDate,
    minPeersPerDate: params.minPeersPerDate
  });
}
