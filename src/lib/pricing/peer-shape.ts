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

/** Default minimum number of peers with a usable rate on a given date
 *  before we trust the aggregated factor. Below this we fall back to
 *  base price (factor = 1).
 */
const DEFAULT_MIN_PEERS_PER_DATE = 3;

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

export type PeerShapeFactorEntry = {
  /** Aggregate factor (mean of available peers' factors on this date). */
  factor: number;
  /** How many peers contributed to the factor on this date. */
  peerCount: number;
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
  historicalRows: PeerCalendarRateRow[];
  forwardRows: PeerCalendarRateRow[];
  fromDate: string;
  toDate: string;
  minPeersPerDate?: number;
}): Map<string, PeerShapeFactorEntry | null> {
  const minPeersPerDate = params.minPeersPerDate ?? DEFAULT_MIN_PEERS_PER_DATE;

  // 1. Compute per-peer yearly ADR over AVAILABLE nights only.
  type Acc = { totalRate: number; nights: number };
  const perPeerHistory = new Map<string, Acc>();
  for (const row of params.historicalRows) {
    if (!row.available) continue;
    if (row.rate === null || !Number.isFinite(row.rate) || row.rate <= 0) continue;
    const acc = perPeerHistory.get(row.listingId) ?? { totalRate: 0, nights: 0 };
    acc.totalRate += row.rate;
    acc.nights += 1;
    perPeerHistory.set(row.listingId, acc);
  }
  const yearlyAdrByPeer = new Map<string, number>();
  for (const [peerId, acc] of perPeerHistory.entries()) {
    if (acc.nights <= 0) continue;
    yearlyAdrByPeer.set(peerId, acc.totalRate / acc.nights);
  }

  // 2. For each date in the forward window, compute mean factor across
  //    AVAILABLE peers that have a yearly ADR.
  const factorAccByDate = new Map<string, { factorSum: number; count: number }>();
  for (const row of params.forwardRows) {
    if (!row.available) continue;
    if (row.rate === null || !Number.isFinite(row.rate) || row.rate <= 0) continue;
    const yearlyAdr = yearlyAdrByPeer.get(row.listingId);
    if (yearlyAdr === undefined || yearlyAdr <= 0) continue;
    const factor = row.rate / yearlyAdr;
    if (!Number.isFinite(factor) || factor <= 0) continue;
    const existing = factorAccByDate.get(row.dateOnly) ?? { factorSum: 0, count: 0 };
    existing.factorSum += factor;
    existing.count += 1;
    factorAccByDate.set(row.dateOnly, existing);
  }

  // 3. Build the output map for every date in [fromDate, toDate].
  const out = new Map<string, PeerShapeFactorEntry | null>();
  const start = fromDateOnly(params.fromDate);
  const end = fromDateOnly(params.toDate);
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    const dateKey = toDateOnly(cursor);
    const acc = factorAccByDate.get(dateKey);
    if (!acc || acc.count < minPeersPerDate) {
      out.set(dateKey, null);
      continue;
    }
    out.set(dateKey, {
      factor: acc.factorSum / acc.count,
      peerCount: acc.count
    });
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

  // Two queries — one for the trailing window (per-peer ADR), one for the
  // forward range (per-date factor). Both filter by tenantId AND restrict
  // to the peer id allowlist as a defence-in-depth measure on top of the
  // tenant filter.
  const [historicalRowsRaw, forwardRowsRaw] = await Promise.all([
    params.prisma.calendarRate.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: peerIds },
        date: { gte: historyStart, lt: historyEnd }
      },
      select: { listingId: true, date: true, available: true, rate: true }
    }),
    params.prisma.calendarRate.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: peerIds },
        date: { gte: forwardStart, lte: forwardEnd }
      },
      select: { listingId: true, date: true, available: true, rate: true }
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

  return computePeerShapeFactorByDateFromRows({
    historicalRows: historicalRowsRaw.map(rowToShape),
    forwardRows: forwardRowsRaw.map(rowToShape),
    fromDate: params.fromDate,
    toDate: params.toDate,
    minPeersPerDate: params.minPeersPerDate
  });
}
