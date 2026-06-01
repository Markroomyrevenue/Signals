/**
 * Signals rate scanner — booking ↔ change attribution.
 *
 * Links a freshly-landed booking to the rate change that most plausibly drove
 * it: a change on the *same stay-date* whose `detectedAt` falls within
 * `ATTRIBUTION_WINDOW_HOURS` before the booking was created. The volume of these
 * `{change → booking}` pairs is the teachable signal the scanner exists to grow.
 *
 * Read-only outside the signals tables: reads `Reservation` (no writes) and
 * `RateChange`, writes only `BookingRateContext`. Tenant-scoped throughout.
 */

import { toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";

import { ATTRIBUTION_WINDOW_HOURS } from "./config";

const HOUR_MS = 60 * 60 * 1000;

/** A candidate `RateChange` for one stay-date, as loaded from the DB. */
export type ChangeCandidate = {
  id: string;
  date: Date;
  lever: string;
  detectedAt: Date;
};

/** One booking↔change link to persist, before it becomes a `BookingRateContext`. */
export type AttributionDraft = {
  stayDate: string; // yyyy-mm-dd
  rateChangeId: string;
  leverChanged: string;
  hoursSinceChange: number;
};

/**
 * Pure attribution rule: for one booking, keep the closest qualifying change
 * per stay-date.
 *
 * A change qualifies when its `detectedAt` lies in
 * `[bookingCreatedAt - windowHours, bookingCreatedAt]`. When several changes on
 * the same stay-date qualify, the latest one (closest to the booking) wins.
 */
export function selectAttributions(args: {
  bookingCreatedAt: Date;
  candidates: ChangeCandidate[];
  windowHours?: number;
}): AttributionDraft[] {
  const { bookingCreatedAt, candidates } = args;
  const windowMs = (args.windowHours ?? ATTRIBUTION_WINDOW_HOURS) * HOUR_MS;
  const bookingMs = bookingCreatedAt.getTime();
  const lowerBound = bookingMs - windowMs;

  const closestByStayDate = new Map<string, ChangeCandidate>();
  for (const candidate of candidates) {
    const detectedMs = candidate.detectedAt.getTime();
    if (detectedMs < lowerBound || detectedMs > bookingMs) continue; // outside the window
    const stayDate = toDateOnly(candidate.date);
    const current = closestByStayDate.get(stayDate);
    if (!current || candidate.detectedAt.getTime() > current.detectedAt.getTime()) {
      closestByStayDate.set(stayDate, candidate);
    }
  }

  return [...closestByStayDate.entries()].map(([stayDate, candidate]) => ({
    stayDate,
    rateChangeId: candidate.id,
    leverChanged: candidate.lever,
    hoursSinceChange: (bookingMs - candidate.detectedAt.getTime()) / HOUR_MS
  }));
}

/**
 * Attribute bookings that landed in the last `ATTRIBUTION_WINDOW_HOURS` to the
 * rate changes that preceded them, writing one `BookingRateContext` per matched
 * (reservation, stay-date) pair.
 *
 * Cancelled reservations are intentionally included — a later cancellation does
 * not undo the fact that the booking landed against a given change (consistent
 * with the existing cancelled-booking pace logic). The `@@unique` on
 * `BookingRateContext` makes re-runs idempotent.
 */
export async function attributeRecentBookings(args: {
  tenantId: string;
  scanId?: string;
}): Promise<{ matched: number }> {
  const { tenantId } = args;
  const now = new Date();
  const windowStart = new Date(now.getTime() - ATTRIBUTION_WINDOW_HOURS * HOUR_MS);

  const reservations = await prisma.reservation.findMany({
    where: { tenantId, createdAt: { gte: windowStart } },
    select: { id: true, listingId: true, createdAt: true, arrival: true, departure: true }
  });

  let matched = 0;
  for (const reservation of reservations) {
    const candidates = await prisma.rateChange.findMany({
      where: {
        tenantId,
        listingId: reservation.listingId,
        date: { gte: reservation.arrival, lt: reservation.departure },
        detectedAt: {
          gte: new Date(reservation.createdAt.getTime() - ATTRIBUTION_WINDOW_HOURS * HOUR_MS),
          lte: reservation.createdAt
        }
      },
      select: { id: true, date: true, lever: true, detectedAt: true }
    });

    const drafts = selectAttributions({ bookingCreatedAt: reservation.createdAt, candidates });

    for (const draft of drafts) {
      await prisma.bookingRateContext.upsert({
        where: {
          tenantId_reservationId_stayDate_rateChangeId: {
            tenantId,
            reservationId: reservation.id,
            stayDate: new Date(`${draft.stayDate}T00:00:00Z`),
            rateChangeId: draft.rateChangeId
          }
        },
        create: {
          tenantId,
          listingId: reservation.listingId,
          reservationId: reservation.id,
          stayDate: new Date(`${draft.stayDate}T00:00:00Z`),
          rateChangeId: draft.rateChangeId,
          bookingCreatedAt: reservation.createdAt,
          hoursSinceChange: draft.hoursSinceChange,
          leverChanged: draft.leverChanged
        },
        update: {
          hoursSinceChange: draft.hoursSinceChange,
          leverChanged: draft.leverChanged
        }
      });
      matched += 1;
    }
  }

  return { matched };
}
