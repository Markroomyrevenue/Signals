/**
 * Ghost scorer (reviews/observe-learn-2026-07 — build prompt 03).
 *
 * Retrospectively settles every suggestion — shadow, superseded and pending —
 * whose stay date has passed by `SCORE_SETTLE_LAG_DAYS`+ days, recording on the
 * suggestion's `detail` JSON what actually happened:
 *
 * - `outcome`: `booked_no_action` | `expired_empty` | `cancelled_after_booking`;
 * - `realisedRate` (from `NightFact.revenueAllocated`) and
 *   `realisedVsProposed = realisedRate / proposedValue` when booked;
 * - `daysToBookingAfterSuggestion` from the reservation `createdAt`;
 * - `rateMovedAfter`: whether a price `RateChange` on that listing/night landed
 *   between the suggestion and the booking (the status quo acted anyway).
 *
 * Already-scored `booked_no_action` rows are RE-CHECKED for a late
 * `Reservation.cancelledAt` and flipped to `cancelled_after_booking`.
 *
 * Owner blocks (`NightFact.status = "ownerstay"`) and near-zero-revenue
 * artefact rows (`revenueAllocated <= MIN_REAL_REVENUE`) do NOT count as
 * bookings — the same exclusion used by `learnings.ts` and
 * `scripts/mine-drop-outcomes.ts`. A night occupied only by such rows is
 * skipped (`detail.scoreSkip`, reason `non_revenue_occupancy`) rather than
 * scored, because it was neither booked at a real rate nor genuinely empty
 * (audit finding F1, reviews/observe-learn-2026-07/BUILD-AUDIT-behaviour.md).
 *
 * This is the calibration engine for the pre-push period: it turns the silent
 * window's shadow suggestions into testable predictions. It applies no price
 * change anywhere — the only table it writes is `Suggestion.detail`. Runs on
 * the weekly settle path. Tenant-scoped throughout (CLAUDE.md rule).
 */

import type { Prisma } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";

import { UNKNOWN_CHANNEL_KEY, computePromoGap, isHeavyPromo } from "./actual-paid";
import { MIN_REAL_REVENUE } from "./drop-outcomes";

/** A night is scoreable once its stay date is this many days in the past. */
export const SCORE_SETTLE_LAG_DAYS = 2;
/** How far back (stay date) the scorer looks for unscored / re-checkable rows. */
export const SCORE_LOOKBACK_DAYS = 120;

export type SuggestionOutcome = "booked_no_action" | "expired_empty" | "cancelled_after_booking";

/**
 * A night the scorer refuses to settle: the only occupied facts are owner
 * blocks (`status = "ownerstay"`) or near-zero-revenue artefact rows
 * (`revenueAllocated <= MIN_REAL_REVENUE`). Such a night was neither booked at
 * a real rate nor genuinely empty, so counting it either way would distort the
 * calibration (audit finding F1). Persisted under `Suggestion.detail.scoreSkip`
 * and re-evaluated on later passes in case a sync correction supplies a real
 * booking. Same exclusion convention as `learnings.ts` and
 * `scripts/mine-drop-outcomes.ts`.
 */
export type SuggestionScoreSkip = {
  skipped: true;
  reason: "non_revenue_occupancy";
  skippedAt: string;
};

/** The score object persisted under `Suggestion.detail.score`. */
export type SuggestionScore = {
  outcome: SuggestionOutcome;
  /** Mean realised nightly revenue (NightFact.revenueAllocated) when booked. */
  realisedRate: number | null;
  /** realisedRate / proposedValue — >1 means it booked ABOVE the proposed drop. */
  realisedVsProposed: number | null;
  /** Whole days from the suggestion to the booking's createdAt (booked only). */
  daysToBookingAfterSuggestion: number | null;
  /** A price RateChange landed between suggestion and booking/stay. */
  rateMovedAfter: boolean;
  /** The booked reservation, kept so later passes can re-check cancelledAt. */
  reservationId: string | null;
  scoredAt: string;
  /** Set when a later pass flipped booked_no_action → cancelled_after_booking. */
  recheckedAt?: string;
  /** The booking's paid-vs-listed gap (1 − paid/listed) when known — the
   *  actual-paid signal (`actual-paid.ts`). Null when no rate observation
   *  lined up with the booking. */
  paidVsListedGapPct?: number | null;
  /** The booking's gap was heavy vs its channel-typical gap: an external
   *  promo/discount likely filled this night, so "booked anyway" is NOT a
   *  full-rate win. Counted separately in the calibration report. */
  heavyPromo?: boolean;
};

export type ReservationLite = { id: string; createdAt: Date; cancelledAt: Date | null };

export type ScoreNightInput = {
  /** When the suggestion was generated. */
  suggestedAt: Date;
  proposedValue: number | null;
  /** Occupied NightFacts for this listing/night (post-stay ⇒ realised). */
  occupiedFacts: Array<{ revenueAllocated: number; reservationId: string | null; status: string | null }>;
  /** Reservations linked from those facts, by id. */
  reservationsById: Map<string, ReservationLite>;
  /** Cancelled reservations that covered this night (arrival ≤ night < departure). */
  cancelledCovering: ReservationLite[];
  /** detectedAt of price RateChanges on this listing/night. */
  priceChangeTimes: Date[];
  /** Per-reservation actual-paid promo evidence (`gapPct` + heavy flag),
   *  precomputed by the caller. Optional — absent means unknown, not clean. */
  promoByReservationId?: Map<string, { gapPct: number; heavy: boolean }>;
  now: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Score one settled suggestion night. Pure.
 *
 * - REAL occupied fact(s) whose reservation is not cancelled ⇒
 *   `booked_no_action` (with `rateMovedAfter` flagging whether the status quo
 *   moved the price first — attribution is NOT solved here, only observed).
 *   "Real" excludes owner blocks (`status = "ownerstay"`) and near-zero-revenue
 *   artefact rows (`revenueAllocated <= MIN_REAL_REVENUE`), matching the
 *   convention in `learnings.ts` and `scripts/mine-drop-outcomes.ts` (F1).
 * - Occupied ONLY by owner blocks / artefact rows ⇒ skipped
 *   (`non_revenue_occupancy`): the night was not booked at a real rate, but it
 *   was not sellable-and-empty either, so neither outcome is honest.
 * - No live booking, but a reservation covering the night was created after the
 *   suggestion and later cancelled ⇒ `cancelled_after_booking`.
 * - Otherwise ⇒ `expired_empty`.
 */
export function scoreSuggestionNight(input: ScoreNightInput): SuggestionScore | SuggestionScoreSkip {
  const liveFacts = input.occupiedFacts.filter((f) => {
    if (!f.reservationId) return true; // occupied with no linked reservation — treat as live
    const res = input.reservationsById.get(f.reservationId);
    return !res?.cancelledAt;
  });
  // Owner blocks and near-zero-revenue artefacts are not real bookings.
  const realLiveFacts = liveFacts.filter(
    (f) => f.status !== "ownerstay" && f.revenueAllocated > MIN_REAL_REVENUE
  );

  const bookingFor = (facts: typeof liveFacts): ReservationLite | null => {
    const candidates = facts
      .map((f) => (f.reservationId ? input.reservationsById.get(f.reservationId) : undefined))
      .filter((r): r is ReservationLite => r !== undefined)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return candidates[0] ?? null;
  };

  const rateMovedBefore = (cutoff: Date | null): boolean =>
    input.priceChangeTimes.some(
      (t) => t.getTime() > input.suggestedAt.getTime() && (cutoff === null || t.getTime() <= cutoff.getTime())
    );

  if (realLiveFacts.length > 0) {
    const booking = bookingFor(realLiveFacts);
    const realisedRate = realLiveFacts.reduce((sum, f) => sum + f.revenueAllocated, 0) / realLiveFacts.length;
    const proposed = input.proposedValue;
    // Actual-paid evidence: was this booking won by an external promo/discount
    // (its paid-vs-listed gap heavy for its channel)? `realisedRate` is already
    // the actual paid nightly, so the ratio below is honest — the flag exists
    // so the calibration does not read a promo-filled night as "booked anyway,
    // drop unnecessary".
    const promo = booking ? input.promoByReservationId?.get(booking.id) : undefined;
    return {
      outcome: "booked_no_action",
      realisedRate,
      realisedVsProposed: proposed !== null && proposed > 0 ? realisedRate / proposed : null,
      daysToBookingAfterSuggestion: booking
        ? Math.max(0, Math.floor((booking.createdAt.getTime() - input.suggestedAt.getTime()) / DAY_MS))
        : null,
      rateMovedAfter: rateMovedBefore(booking?.createdAt ?? null),
      reservationId: booking?.id ?? null,
      scoredAt: input.now.toISOString(),
      paidVsListedGapPct: promo?.gapPct ?? null,
      heavyPromo: promo?.heavy ?? false
    };
  }

  // Occupied, but only by owner blocks / artefact rows: neither `booked_no_action`
  // nor `expired_empty` would be honest — skip, and let a later pass retry in
  // case the sync corrects the facts.
  if (liveFacts.length > 0) {
    return { skipped: true, reason: "non_revenue_occupancy", skippedAt: input.now.toISOString() };
  }

  const cancelled = input.cancelledCovering
    .filter((r) => r.createdAt.getTime() >= input.suggestedAt.getTime())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  if (cancelled) {
    return {
      outcome: "cancelled_after_booking",
      realisedRate: null,
      realisedVsProposed: null,
      daysToBookingAfterSuggestion: Math.max(
        0,
        Math.floor((cancelled.createdAt.getTime() - input.suggestedAt.getTime()) / DAY_MS)
      ),
      rateMovedAfter: rateMovedBefore(cancelled.createdAt),
      reservationId: cancelled.id,
      scoredAt: input.now.toISOString()
    };
  }

  return {
    outcome: "expired_empty",
    realisedRate: null,
    realisedVsProposed: null,
    daysToBookingAfterSuggestion: null,
    rateMovedAfter: rateMovedBefore(null),
    reservationId: null,
    scoredAt: input.now.toISOString()
  };
}

/**
 * Re-check a previously scored `booked_no_action` night: if its reservation now
 * carries `cancelledAt`, flip the outcome to `cancelled_after_booking` (the
 * realised fields are nulled — the revenue did not survive). Pure. Returns the
 * updated score, or null when nothing changed.
 */
export function recheckScoredCancellation(args: {
  score: SuggestionScore;
  reservation: { cancelledAt: Date | null } | null | undefined;
  now: Date;
}): SuggestionScore | null {
  if (args.score.outcome !== "booked_no_action") return null;
  if (!args.reservation?.cancelledAt) return null;
  return {
    ...args.score,
    outcome: "cancelled_after_booking",
    realisedRate: null,
    realisedVsProposed: null,
    recheckedAt: args.now.toISOString()
  };
}

/** Parse a `detail` JSON blob's `score`, if present and shaped like one. */
export function readScoreFromDetail(detail: unknown): SuggestionScore | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const score = (detail as { score?: unknown }).score;
  if (!score || typeof score !== "object" || Array.isArray(score)) return null;
  const s = score as Record<string, unknown>;
  if (typeof s.outcome !== "string" || typeof s.scoredAt !== "string") return null;
  return score as SuggestionScore;
}

// ---- Calibration report (readout section) -----------------------------------

/** One scored suggestion, reduced to what the calibration report needs. */
export type ScoredSuggestionSummary = {
  outcome: SuggestionOutcome;
  oldValue: number | null;
  proposedValue: number | null;
  realisedVsProposed: number | null;
  rateMovedAfter: boolean;
  /** The booking was won by a heavy external promo/discount for its channel. */
  heavyPromo: boolean;
  /** Days between the suggestion's creation and its stay date. */
  leadDaysAtSuggestion: number | null;
  /** The listing's `group:` tags (cohort re-cuts; crossover expected). */
  groupKeys: string[];
  /** `size:<band>` for single-unit stock; null for multi-unit (not flat peers). */
  sizeBandKey: string | null;
};

export type CalibrationBucket = {
  label: string;
  n: number;
  /** Nights in this bucket that booked anyway (no drop was ever applied). */
  booked: number;
  bookedPct: number;
  /** Mean realisedRate/proposedValue over booked nights with both values. */
  avgRealisedVsProposed: number | null;
};

export type CalibrationReport = {
  scored: number;
  booked: number;
  /** Booked nights where no price RateChange landed in between either. */
  bookedNoRateMove: number;
  /** Booked nights won by a HEAVY external promo/discount for their channel —
   *  NOT full-rate wins, however good realisedVsProposed looks. */
  bookedHeavyPromo: number;
  /** Booked with no rate move AND no heavy promo: the honest "nothing acted
   *  and it still booked" evidence count. */
  bookedNoIntervention: number;
  expiredEmpty: number;
  cancelledAfterBooking: number;
  avgRealisedVsProposed: number | null;
  byDropSize: CalibrationBucket[];
  byLeadTime: CalibrationBucket[];
  /** Cohort re-cuts (build prompt 07 Part B): rows pooled per `group:` tag and
   *  per size band, with minimum-n suppression — a cell below
   *  `MIN_CALIBRATION_COHORT_N` is omitted, never shown as noise. */
  byGroup: CalibrationBucket[];
  bySizeBand: CalibrationBucket[];
};

/** Suggested-drop-size buckets (judge emits 5–25%). */
const DROP_SIZE_BUCKETS: Array<{ label: string; max: number }> = [
  { label: "<=10%", max: 0.1 },
  { label: "10-15%", max: 0.15 },
  { label: ">15%", max: Number.POSITIVE_INFINITY }
];

/** A cohort calibration cell needs at least this many scored rows to show. */
export const MIN_CALIBRATION_COHORT_N = 10;

/** Lead-time buckets for calibration (days from suggestion to stay). */
const CALIBRATION_LEAD_BUCKETS: Array<{ label: string; max: number }> = [
  { label: "0-3d", max: 3 },
  { label: "4-7d", max: 7 },
  { label: "8-14d", max: 14 },
  { label: "15-30d", max: 30 },
  { label: "31d+", max: Number.POSITIVE_INFINITY }
];

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function buildBucket(label: string, rows: ScoredSuggestionSummary[]): CalibrationBucket {
  const booked = rows.filter((r) => r.outcome === "booked_no_action");
  return {
    label,
    n: rows.length,
    booked: booked.length,
    bookedPct: rows.length > 0 ? booked.length / rows.length : 0,
    avgRealisedVsProposed: mean(
      booked.map((r) => r.realisedVsProposed).filter((v): v is number => v !== null)
    )
  };
}

/**
 * Assemble the calibration report from scored suggestions: the share that
 * booked anyway with no drop applied, at what realised rate vs the proposed
 * drop, bucketed by suggested drop size and by lead time — each with its `n`.
 * This is the graduation evidence: it replaces the day-30 leap of faith with
 * "here is what would have happened had we acted". Pure. Returns null when
 * nothing has been scored yet.
 */
export function assembleCalibration(rows: ScoredSuggestionSummary[]): CalibrationReport | null {
  if (rows.length === 0) return null;
  const booked = rows.filter((r) => r.outcome === "booked_no_action");
  const dropPctOf = (r: ScoredSuggestionSummary): number | null =>
    r.oldValue !== null && r.oldValue > 0 && r.proposedValue !== null ? 1 - r.proposedValue / r.oldValue : null;

  const byDropSize = DROP_SIZE_BUCKETS.map((bucket, i) => {
    const min = i === 0 ? -Infinity : DROP_SIZE_BUCKETS[i - 1].max;
    return buildBucket(
      bucket.label,
      rows.filter((r) => {
        const drop = dropPctOf(r);
        return drop !== null && drop > min && drop <= bucket.max;
      })
    );
  }).filter((b) => b.n > 0);

  const byLeadTime = CALIBRATION_LEAD_BUCKETS.map((bucket, i) => {
    const min = i === 0 ? -1 : CALIBRATION_LEAD_BUCKETS[i - 1].max;
    return buildBucket(
      bucket.label,
      rows.filter(
        (r) => r.leadDaysAtSuggestion !== null && r.leadDaysAtSuggestion > min && r.leadDaysAtSuggestion <= bucket.max
      )
    );
  }).filter((b) => b.n > 0);

  // Cohort re-cuts with minimum-n suppression. A row counts in EVERY group it
  // belongs to (crossover expected) and in exactly one size band.
  const groupRows = new Map<string, ScoredSuggestionSummary[]>();
  const bandRows = new Map<string, ScoredSuggestionSummary[]>();
  for (const r of rows) {
    for (const key of r.groupKeys) {
      const list = groupRows.get(key) ?? [];
      list.push(r);
      groupRows.set(key, list);
    }
    if (r.sizeBandKey) {
      const list = bandRows.get(r.sizeBandKey) ?? [];
      list.push(r);
      bandRows.set(r.sizeBandKey, list);
    }
  }
  const cohortBuckets = (map: Map<string, ScoredSuggestionSummary[]>): CalibrationBucket[] =>
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, subset]) => buildBucket(label, subset))
      .filter((b) => b.n >= MIN_CALIBRATION_COHORT_N);

  return {
    scored: rows.length,
    booked: booked.length,
    bookedNoRateMove: booked.filter((r) => !r.rateMovedAfter).length,
    bookedHeavyPromo: booked.filter((r) => r.heavyPromo).length,
    bookedNoIntervention: booked.filter((r) => !r.rateMovedAfter && !r.heavyPromo).length,
    expiredEmpty: rows.filter((r) => r.outcome === "expired_empty").length,
    cancelledAfterBooking: rows.filter((r) => r.outcome === "cancelled_after_booking").length,
    avgRealisedVsProposed: mean(
      booked.map((r) => r.realisedVsProposed).filter((v): v is number => v !== null)
    ),
    byDropSize,
    byLeadTime,
    byGroup: cohortBuckets(groupRows),
    bySizeBand: cohortBuckets(bandRows)
  };
}

/**
 * Reduce a Suggestion row (with a persisted score) to a calibration summary.
 * `cohorts` carries the listing's group tags + size band for the report's
 * cohort re-cuts (omitted rows simply join no cohort cell). Returns null when
 * the row has no score yet. Pure.
 */
export function summariseScoredSuggestion(
  row: {
    oldValue: number | null;
    proposedValue: number | null;
    dateFrom: Date;
    createdAt: Date;
    detail: unknown;
  },
  cohorts?: { groupKeys?: string[]; sizeBandKey?: string | null }
): ScoredSuggestionSummary | null {
  const score = readScoreFromDetail(row.detail);
  if (!score) return null;
  return {
    outcome: score.outcome,
    oldValue: row.oldValue,
    proposedValue: row.proposedValue,
    realisedVsProposed: score.realisedVsProposed ?? null,
    rateMovedAfter: score.rateMovedAfter === true,
    heavyPromo: score.heavyPromo === true,
    leadDaysAtSuggestion: Math.max(0, Math.floor((row.dateFrom.getTime() - row.createdAt.getTime()) / DAY_MS)),
    groupKeys: cohorts?.groupKeys ?? [],
    sizeBandKey: cohorts?.sizeBandKey ?? null
  };
}

export type ScoreSettledResult = {
  tenantId: string;
  /** Suggestions newly scored this pass. */
  scored: number;
  /** booked_no_action rows flipped to cancelled_after_booking on re-check. */
  rechecked: number;
  /** Nights left unscored (non-revenue occupancy only); retried on later passes. */
  skipped: number;
  outcomes: Record<SuggestionOutcome, number>;
};

/**
 * Score every settled-but-unscored suggestion for a tenant, and re-check
 * previously booked outcomes for late cancellations. Writes ONLY
 * `Suggestion.detail` (merging `score` into the existing JSON). Tenant-scoped
 * on every query; read-only against NightFact / Reservation / RateChange.
 */
export async function scoreSettledSuggestions(args: { tenantId: string; now?: Date }): Promise<ScoreSettledResult> {
  const { tenantId } = args;
  const now = args.now ?? new Date();
  const today = fromDateOnly(toDateOnly(now));
  const settleCutoff = addUtcDays(today, -SCORE_SETTLE_LAG_DAYS);
  const lookbackStart = addUtcDays(today, -SCORE_LOOKBACK_DAYS);

  const candidates = await prisma.suggestion.findMany({
    where: {
      tenantId,
      lever: "price",
      listingId: { not: null },
      dateTo: { gte: lookbackStart, lte: settleCutoff }
    },
    select: {
      id: true,
      listingId: true,
      dateFrom: true,
      createdAt: true,
      proposedValue: true,
      detail: true
    }
  });

  const unscored = candidates.filter((c) => readScoreFromDetail(c.detail) === null);
  const bookedScored = candidates
    .map((c) => ({ row: c, score: readScoreFromDetail(c.detail) }))
    .filter(
      (c): c is { row: (typeof candidates)[number]; score: SuggestionScore } =>
        c.score !== null && c.score.outcome === "booked_no_action" && typeof c.score.reservationId === "string"
    );

  const result: ScoreSettledResult = {
    tenantId,
    scored: 0,
    rechecked: 0,
    skipped: 0,
    outcomes: { booked_no_action: 0, expired_empty: 0, cancelled_after_booking: 0 }
  };
  if (unscored.length === 0 && bookedScored.length === 0) return result;

  // Actual-paid promo evidence for the bookings that filled the nights being
  // scored: one tenant-scoped computation per settle (trailing 90d of created
  // bookings vs the listed rate near booking). Heavy = the booking's gap beats
  // its channel-typical gap by HEAVY_PROMO_EXCESS_PCT (structural VAT/fee
  // wedges cancel out); channels without a baseline use the absolute floor.
  const promoByReservationId = new Map<string, { gapPct: number; heavy: boolean }>();
  if (unscored.length > 0) {
    const promo = await computePromoGap({ tenantId, now });
    for (const [id, gap] of promo.gapByReservationId) {
      const channelKey = gap.channel?.trim() || UNKNOWN_CHANNEL_KEY;
      const med = promo.learning.byChannel[channelKey]?.medianGapPct ?? null;
      promoByReservationId.set(id, { gapPct: gap.gapPct, heavy: isHeavyPromo(gap.gapPct, med) });
    }
  }

  const listingIds = [...new Set(unscored.map((c) => c.listingId as string))];
  const nightDates = [...new Set(unscored.map((c) => toDateOnly(c.dateFrom)))].map((d) => fromDateOnly(d));

  const [facts, cancelledReservations, rateChanges, recheckReservations] = await Promise.all([
    listingIds.length > 0
      ? prisma.nightFact.findMany({
          where: { tenantId, listingId: { in: listingIds }, date: { in: nightDates }, isOccupied: true },
          select: { listingId: true, date: true, revenueAllocated: true, reservationId: true, status: true }
        })
      : Promise.resolve([]),
    listingIds.length > 0
      ? prisma.reservation.findMany({
          where: {
            tenantId,
            listingId: { in: listingIds },
            cancelledAt: { not: null },
            arrival: { lte: settleCutoff },
            departure: { gt: lookbackStart }
          },
          select: { id: true, listingId: true, arrival: true, departure: true, createdAt: true, cancelledAt: true }
        })
      : Promise.resolve([]),
    listingIds.length > 0
      ? prisma.rateChange.findMany({
          where: { tenantId, lever: "price", listingId: { in: listingIds }, date: { in: nightDates } },
          select: { listingId: true, date: true, detectedAt: true }
        })
      : Promise.resolve([]),
    bookedScored.length > 0
      ? prisma.reservation.findMany({
          where: { tenantId, id: { in: [...new Set(bookedScored.map((c) => c.score.reservationId as string))] } },
          select: { id: true, createdAt: true, cancelledAt: true }
        })
      : Promise.resolve([])
  ]);

  // Reservations linked from the occupied facts (tenant-scoped fetch).
  const linkedIds = [...new Set(facts.map((f) => f.reservationId).filter((id): id is string => id !== null))];
  const linkedReservations = linkedIds.length
    ? await prisma.reservation.findMany({
        where: { tenantId, id: { in: linkedIds } },
        select: { id: true, createdAt: true, cancelledAt: true }
      })
    : [];
  const reservationsById = new Map<string, ReservationLite>(linkedReservations.map((r) => [r.id, r]));

  const factsByNight = new Map<
    string,
    Array<{ revenueAllocated: number; reservationId: string | null; status: string | null }>
  >();
  for (const f of facts) {
    const key = `${f.listingId}|${toDateOnly(f.date)}`;
    const list = factsByNight.get(key) ?? [];
    list.push({ revenueAllocated: Number(f.revenueAllocated), reservationId: f.reservationId, status: f.status });
    factsByNight.set(key, list);
  }
  const changesByNight = new Map<string, Date[]>();
  for (const rc of rateChanges) {
    const key = `${rc.listingId}|${toDateOnly(rc.date)}`;
    const list = changesByNight.get(key) ?? [];
    list.push(rc.detectedAt);
    changesByNight.set(key, list);
  }

  const detailObject = (detail: unknown): Record<string, unknown> =>
    detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
  const detailWithScore = (detail: unknown, score: SuggestionScore): Prisma.InputJsonValue => {
    // A real score supersedes any earlier non_revenue_occupancy skip marker.
    const { scoreSkip: _dropped, ...rest } = detailObject(detail);
    return { ...rest, score } as Prisma.InputJsonValue;
  };
  const detailWithSkip = (detail: unknown, skip: SuggestionScoreSkip): Prisma.InputJsonValue =>
    ({ ...detailObject(detail), scoreSkip: skip }) as Prisma.InputJsonValue;
  const hasSkipMarker = (detail: unknown, reason: SuggestionScoreSkip["reason"]): boolean => {
    const marker = detailObject(detail).scoreSkip;
    return (
      !!marker &&
      typeof marker === "object" &&
      !Array.isArray(marker) &&
      (marker as { reason?: unknown }).reason === reason
    );
  };

  for (const row of unscored) {
    const nightStr = toDateOnly(row.dateFrom);
    const night = fromDateOnly(nightStr);
    const key = `${row.listingId}|${nightStr}`;
    const score = scoreSuggestionNight({
      suggestedAt: row.createdAt,
      proposedValue: row.proposedValue === null ? null : Number(row.proposedValue),
      occupiedFacts: factsByNight.get(key) ?? [],
      reservationsById,
      cancelledCovering: cancelledReservations.filter(
        (r) =>
          r.listingId === row.listingId &&
          r.arrival.getTime() <= night.getTime() &&
          r.departure.getTime() > night.getTime()
      ),
      priceChangeTimes: changesByNight.get(key) ?? [],
      promoByReservationId,
      now
    });
    if ("skipped" in score) {
      // Non-revenue occupancy only (owner block / artefact rows): leave the row
      // unscored so a later pass can settle it if the facts are corrected, but
      // persist the reason once so the gap is auditable.
      if (!hasSkipMarker(row.detail, score.reason)) {
        await prisma.suggestion.updateMany({
          where: { id: row.id, tenantId },
          data: { detail: detailWithSkip(row.detail, score) }
        });
      }
      result.skipped += 1;
      continue;
    }
    await prisma.suggestion.updateMany({
      where: { id: row.id, tenantId },
      data: { detail: detailWithScore(row.detail, score) }
    });
    result.scored += 1;
    result.outcomes[score.outcome] += 1;
  }

  // Late-cancellation re-check for previously booked outcomes.
  const recheckById = new Map(recheckReservations.map((r) => [r.id, r]));
  for (const { row, score } of bookedScored) {
    const updated = recheckScoredCancellation({
      score,
      reservation: recheckById.get(score.reservationId as string),
      now
    });
    if (!updated) continue;
    await prisma.suggestion.updateMany({
      where: { id: row.id, tenantId },
      data: { detail: detailWithScore(row.detail, updated) }
    });
    result.rechecked += 1;
  }

  return result;
}
