/**
 * Actual-paid (promo/discount) signal — build prompt 07 Part B item 4
 * (reviews/observe-learn-2026-07/07-learning-granularity.md; Mark: the system
 * "should also be able to check actual reservation amount via Hostaway i.e.
 * there might be external promos active etc").
 *
 * Uses ONLY reservation data ALREADY synced from Hostaway (`Reservation`) plus
 * the rate scanner's own observations (`RateChange` / `RateState`). Nothing
 * under `src/lib/hostaway/**` is touched and no new API call is made.
 *
 * Why the fallback design (prod rawJson inspection, read-only, 2026-07-04):
 * the explicit discount fields in the synced payloads are too sparse to learn
 * from — `reservationCouponId` is set on 220 of 41,984 reservations and
 * `reservationFees` carries a "DISCOUNT - …" line on ~28 — so the signal is
 * computed as the prompt's fallback: gross nightly actually paid
 * (`accommodationFare / nights`, the same basis as `NightFact.revenueAllocated`)
 * vs the listed rate in force NEAR the booking time (nearest
 * `RateChange`/`RateState` observation). The gap is the promo/discount drag.
 *
 * IMPORTANT interpretation caveat, measured on prod (trailing 90d, 2026-07-04):
 * the gap per channel is dominated by STRUCTURAL wedges, not promos — median
 * paid/listed is ~0.74 on booking.com (VAT + channel pricing sit between the
 * listed rate and the accommodation fare), ~0.99 on Airbnb, ~0.72 on direct.
 * That is exactly why the learning is PER CHANNEL and why "heavy promo" is
 * judged RELATIVE to the booking's own channel-typical gap
 * (`HEAVY_PROMO_EXCESS_PCT` beyond the channel median), never against 0.
 *
 * Pure functions here are unit-tested; the DB wrapper is tenant-scoped and
 * read-only. The learning lands on the weekly settle (like net realised) and
 * feeds (a) the client profile per channel + per cohort, and (b) the ghost
 * scorer, so a night "filled" by a heavy external promo is not scored as a
 * full-rate win (`suggestion-scoring.ts`).
 */

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";

import { resolveCohortMemberships, type CohortListing } from "./cohorts";

/** Bookings CREATED in this trailing window feed the learning. */
export const PROMO_TRAILING_DAYS = 90;
/** A channel's gap statistics are published only at this many observations. */
export const MIN_CHANNEL_PROMO_N = 10;
/** A cohort promo cut is published only at this many observations. */
export const MIN_COHORT_PROMO_N = 10;
/**
 * A booking is a HEAVY promo when its own paid-vs-listed gap exceeds its
 * channel's median gap by at least this much (fraction of the listed rate).
 * Calibrated on prod (2026-07-04): the p50→p10 spread within a channel is
 * ~8-13pp (booking.com 0.74→0.62, airbnb 0.99→0.76), so 15pp beyond the
 * median flags the genuine discount tail (~8-15% of bookings per channel),
 * not the structural VAT/fee wedge.
 */
export const HEAVY_PROMO_EXCESS_PCT = 0.15;
/**
 * Absolute fallback when the channel has no baseline yet (fewer than
 * `MIN_CHANNEL_PROMO_N` observations): a paid-vs-listed gap this deep is
 * heavy on any channel — deeper than booking.com's structural ~26% median
 * wedge, the largest structural gap observed on prod.
 */
export const HEAVY_PROMO_ABS_FALLBACK_PCT = 0.3;

/** One price observation for a stay night, from `RateChange`. */
export type NightRateChange = {
  detectedAt: Date;
  oldValue: number | null;
  newValue: number | null;
};

/**
 * The listed rate in force at `bookedAt` for ONE stay night, from that night's
 * price-change series plus the scanner's current `RateState` rate:
 * - latest change detected at/before booking → its `newValue` (rate then live);
 * - else earliest change after booking → its `oldValue` (the rate that was in
 *   force until that change);
 * - else the scanned `stateRate` — valid because `RateState` rows exist only
 *   for scanned nights and a night with NO recorded change has held its
 *   current rate since scanning began (the booking window is bounded to the
 *   scanner's era by the caller).
 * Null when nothing was ever observed for the night. Pure.
 */
export function listedNightlyAtBooking(args: {
  changes: NightRateChange[];
  stateRate: number | null;
  bookedAt: Date;
}): number | null {
  let beforeBest: NightRateChange | null = null;
  let afterBest: NightRateChange | null = null;
  for (const change of args.changes) {
    if (change.detectedAt.getTime() <= args.bookedAt.getTime()) {
      if (!beforeBest || change.detectedAt.getTime() > beforeBest.detectedAt.getTime()) beforeBest = change;
    } else if (!afterBest || change.detectedAt.getTime() < afterBest.detectedAt.getTime()) {
      afterBest = change;
    }
  }
  const usable = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v > 0 ? v : null);
  if (beforeBest) {
    const v = usable(beforeBest.newValue);
    if (v !== null) return v;
  }
  if (afterBest) {
    const v = usable(afterBest.oldValue);
    if (v !== null) return v;
  }
  return usable(args.stateRate);
}

export type BookingPromoGap = {
  /** Gross nightly actually paid: accommodationFare / nights. */
  paidNightly: number;
  /** Mean listed rate in force near booking over the resolvable stay nights. */
  listedNightly: number;
  /** Stay nights with a resolvable listed rate (of `nights`). */
  nightsResolved: number;
  /** 1 − paid/listed: positive = paid below the listed rate (promo/discount drag). */
  gapPct: number;
};

/**
 * The promo/discount gap for one booking: gross nightly actually paid vs the
 * mean listed rate in force near the booking time across its stay nights.
 * Null when the fare/nights are unusable or NO stay night has a rate
 * observation. Pure.
 */
export function bookingPromoGap(args: {
  accommodationFare: number;
  nights: number;
  /** Per stay night: the night's change series + scanned state rate. */
  nightObservations: Array<{ changes: NightRateChange[]; stateRate: number | null }>;
  bookedAt: Date;
}): BookingPromoGap | null {
  if (!Number.isFinite(args.accommodationFare) || args.accommodationFare <= 0) return null;
  if (!Number.isFinite(args.nights) || args.nights <= 0) return null;
  const listed: number[] = [];
  for (const night of args.nightObservations) {
    const v = listedNightlyAtBooking({ changes: night.changes, stateRate: night.stateRate, bookedAt: args.bookedAt });
    if (v !== null) listed.push(v);
  }
  if (listed.length === 0) return null;
  const listedNightly = listed.reduce((s, v) => s + v, 0) / listed.length;
  if (listedNightly <= 0) return null;
  const paidNightly = args.accommodationFare / args.nights;
  return {
    paidNightly,
    listedNightly,
    nightsResolved: listed.length,
    gapPct: 1 - paidNightly / listedNightly
  };
}

export type ChannelPromoGap = {
  n: number;
  /** Median 1−paid/listed for the channel (includes the structural wedge). */
  medianGapPct: number;
  meanGapPct: number;
  /** Share of the channel's bookings flagged heavy vs the channel median. */
  heavyShare: number;
};

/** Bookings with no channel label pool under this key. */
export const UNKNOWN_CHANNEL_KEY = "unknown";

function median(sortedAsc: number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

/**
 * Is this booking's gap a HEAVY promo? Relative to the channel median when a
 * baseline exists (the structural wedge cancels out); otherwise against the
 * absolute fallback floor. Pure.
 */
export function isHeavyPromo(gapPct: number, channelMedianGapPct: number | null): boolean {
  if (channelMedianGapPct === null) return gapPct >= HEAVY_PROMO_ABS_FALLBACK_PCT;
  return gapPct - channelMedianGapPct >= HEAVY_PROMO_EXCESS_PCT;
}

/**
 * Per-channel gap statistics with minimum-n suppression: channels below
 * `MIN_CHANNEL_PROMO_N` observations are omitted entirely (no noisy medians).
 * Pure.
 */
export function aggregatePromoGapsByChannel(
  rows: Array<{ channel: string | null; gapPct: number }>
): Record<string, ChannelPromoGap> {
  const byChannel = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.channel?.trim() || UNKNOWN_CHANNEL_KEY;
    const list = byChannel.get(key) ?? [];
    list.push(row.gapPct);
    byChannel.set(key, list);
  }
  const out: Record<string, ChannelPromoGap> = {};
  for (const [channel, gaps] of [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (gaps.length < MIN_CHANNEL_PROMO_N) continue;
    const sorted = [...gaps].sort((a, b) => a - b);
    const med = median(sorted);
    out[channel] = {
      n: gaps.length,
      medianGapPct: med,
      meanGapPct: gaps.reduce((s, v) => s + v, 0) / gaps.length,
      heavyShare: gaps.filter((g) => isHeavyPromo(g, med)).length / gaps.length
    };
  }
  return out;
}

export type CohortPromoGap = { n: number; medianGapPct: number };

/**
 * Promo-gap re-cuts along the cohort dimensions (group / size band / stock),
 * with minimum-n suppression. Crossover is expected — a booking counts in its
 * listing's group AND size band AND stock cohorts. City/tenant dimensions are
 * skipped (tenant is the whole set; city cuts belong to the anonymised global
 * path). Pure.
 */
export function aggregatePromoGapsByCohort(
  rows: Array<{ listingId: string; gapPct: number }>,
  listings: CohortListing[]
): Record<string, CohortPromoGap> {
  const membershipsByListing = new Map<string, string[]>();
  for (const listing of listings) {
    membershipsByListing.set(
      listing.id,
      resolveCohortMemberships(listing)
        .filter((m) => m.dimension === "group" || m.dimension === "size_band" || m.dimension === "stock")
        .map((m) => m.cohortKey)
    );
  }
  const byCohort = new Map<string, number[]>();
  for (const row of rows) {
    for (const key of membershipsByListing.get(row.listingId) ?? []) {
      const list = byCohort.get(key) ?? [];
      list.push(row.gapPct);
      byCohort.set(key, list);
    }
  }
  const out: Record<string, CohortPromoGap> = {};
  for (const [key, gaps] of [...byCohort.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (gaps.length < MIN_COHORT_PROMO_N) continue;
    out[key] = { n: gaps.length, medianGapPct: median([...gaps].sort((a, b) => a - b)) };
  }
  return out;
}

/** One booking's gap plus the channel it came through (scorer lookups). */
export type ReservationPromoGap = BookingPromoGap & { channel: string | null };

/** The promo-gap learning persisted on the client profile (weekly settle). */
export type PromoGapLearning = {
  computedAt: string;
  windowDays: number;
  /** Uncancelled bookings created in the window. */
  bookings: number;
  /** Of those, bookings with a resolvable listed rate (the gap sample). */
  withListedRate: number;
  byChannel: Record<string, ChannelPromoGap>;
  byCohort: Record<string, CohortPromoGap>;
};

/**
 * Compute the promo-gap learning for one tenant: every uncancelled booking
 * CREATED in the trailing window, its gross nightly paid vs the listed rate
 * near booking, aggregated per channel and per cohort with minimum-n
 * suppression. Tenant-scoped on every query; read-only. Returns the learning
 * plus the per-reservation gaps (the ghost scorer reuses them by id).
 */
export async function computePromoGap(args: {
  tenantId: string;
  now?: Date;
}): Promise<{ learning: PromoGapLearning; gapByReservationId: Map<string, ReservationPromoGap> }> {
  const { tenantId } = args;
  const now = args.now ?? new Date();
  const since = addUtcDays(fromDateOnly(toDateOnly(now)), -PROMO_TRAILING_DAYS);

  const reservations = await prisma.reservation.findMany({
    where: {
      tenantId,
      createdAt: { gte: since },
      cancelledAt: null,
      nights: { gt: 0 },
      accommodationFare: { gt: 0 }
    },
    select: {
      id: true,
      listingId: true,
      channel: true,
      createdAt: true,
      arrival: true,
      departure: true,
      nights: true,
      accommodationFare: true
    }
  });

  const empty: PromoGapLearning = {
    computedAt: now.toISOString(),
    windowDays: PROMO_TRAILING_DAYS,
    bookings: reservations.length,
    withListedRate: 0,
    byChannel: {},
    byCohort: {}
  };
  if (reservations.length === 0) return { learning: empty, gapByReservationId: new Map() };

  const listingIds = [...new Set(reservations.map((r) => r.listingId))];
  let minArrival = reservations[0].arrival;
  let maxDeparture = reservations[0].departure;
  for (const r of reservations) {
    if (r.arrival < minArrival) minArrival = r.arrival;
    if (r.departure > maxDeparture) maxDeparture = r.departure;
  }

  const [changes, states, listings] = await Promise.all([
    prisma.rateChange.findMany({
      where: {
        tenantId,
        lever: "price",
        listingId: { in: listingIds },
        date: { gte: minArrival, lt: maxDeparture }
      },
      select: { listingId: true, date: true, detectedAt: true, oldValue: true, newValue: true }
    }),
    prisma.rateState.findMany({
      where: { tenantId, listingId: { in: listingIds }, date: { gte: minArrival, lt: maxDeparture } },
      select: { listingId: true, date: true, rate: true }
    }),
    prisma.listing.findMany({
      where: { tenantId, id: { in: listingIds } },
      select: { id: true, tags: true, bedroomsNumber: true, city: true, unitCount: true }
    })
  ]);

  const changesByNight = new Map<string, NightRateChange[]>();
  for (const c of changes) {
    const key = `${c.listingId}|${toDateOnly(c.date)}`;
    const list = changesByNight.get(key) ?? [];
    list.push({
      detectedAt: c.detectedAt,
      oldValue: c.oldValue === null ? null : Number(c.oldValue),
      newValue: c.newValue === null ? null : Number(c.newValue)
    });
    changesByNight.set(key, list);
  }
  const stateByNight = new Map<string, number>();
  for (const s of states) stateByNight.set(`${s.listingId}|${toDateOnly(s.date)}`, Number(s.rate));

  const gapByReservationId = new Map<string, ReservationPromoGap>();
  const channelRows: Array<{ channel: string | null; gapPct: number }> = [];
  const cohortRows: Array<{ listingId: string; gapPct: number }> = [];
  for (const r of reservations) {
    const nightObservations: Array<{ changes: NightRateChange[]; stateRate: number | null }> = [];
    for (let cursor = new Date(r.arrival); cursor < r.departure; cursor = addUtcDays(cursor, 1)) {
      const key = `${r.listingId}|${toDateOnly(cursor)}`;
      nightObservations.push({
        changes: changesByNight.get(key) ?? [],
        stateRate: stateByNight.get(key) ?? null
      });
    }
    const gap = bookingPromoGap({
      accommodationFare: Number(r.accommodationFare),
      nights: r.nights,
      nightObservations,
      bookedAt: r.createdAt
    });
    if (!gap) continue;
    gapByReservationId.set(r.id, { ...gap, channel: r.channel });
    channelRows.push({ channel: r.channel, gapPct: gap.gapPct });
    cohortRows.push({ listingId: r.listingId, gapPct: gap.gapPct });
  }

  return {
    learning: {
      ...empty,
      withListedRate: gapByReservationId.size,
      byChannel: aggregatePromoGapsByChannel(channelRows),
      byCohort: aggregatePromoGapsByCohort(cohortRows, listings)
    },
    gapByReservationId
  };
}
