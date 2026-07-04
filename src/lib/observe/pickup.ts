/**
 * Pickup velocity — measuring the peer ladder's controls (build prompt 07
 * Part B item 5; granularity audit finding: `PeerControl.movedPickup` /
 * `controlPickup` had never been measured on any of 1,150+ rows, so learning
 * #1 was a permanent null — "evidence engine built, engine idle").
 *
 * On the weekly settle, every `PeerControl` row whose price-drop event is OLD
 * ENOUGH (the 7-day pickup window has fully elapsed, plus a sync-lag day) gets
 * its pickup measured and stored on the row:
 *
 * - `movedPickup`  — bookings gained by the SUBJECT listing covering the event
 *   stay date, created inside the window, per listing-day;
 * - `controlPickup` — the same across the row's RECORDED control set, per
 *   listing-day (null for rung-3 rows, which have no named control).
 *
 * The aggregate over measured rows WITH a control feeds the client profile as
 * learning #1 via the existing `pickupVelocity` pure core, with its n. A
 * booking that arrived in the window but was cancelled inside the same window
 * is not counted — it was never a kept pickup.
 *
 * Pure functions are unit-tested; the DB wrapper is tenant-scoped and writes
 * ONLY `PeerControl` rows (idempotent: measured rows are never re-measured).
 */

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";

import { pickupVelocity, type PickupVelocity } from "./learnings-core";

/** Bookings are counted for this many days after the price change. */
export const PICKUP_WINDOW_DAYS = 7;
/** Extra day after the window closes so the reservation sync has landed. */
export const PICKUP_SETTLE_LAG_DAYS = 1;
/** Rows measured per settle run (bounded job; the backlog drains weekly). */
export const PICKUP_MEASURE_BATCH = 500;
/** Learning #1 aggregates measured events from this trailing window. */
export const PICKUP_AGG_TRAILING_DAYS = 90;

/** Has the event's pickup window fully elapsed (plus the sync-lag day)? Pure. */
export function pickupWindowSettled(detectedAt: Date, now: Date): boolean {
  return addUtcDays(detectedAt, PICKUP_WINDOW_DAYS + PICKUP_SETTLE_LAG_DAYS).getTime() <= now.getTime();
}

export type PickupReservation = {
  listingId: string;
  createdAt: Date;
  cancelledAt: Date | null;
  /** Stay range, [arrival, departure). */
  arrival: Date;
  departure: Date;
};

/**
 * Bookings on `listingIds` covering `eventDate` that were CREATED inside the
 * pickup window after `detectedAt`, excluding bookings cancelled inside the
 * same window (never a kept pickup). Pure.
 */
export function countWindowBookings(args: {
  reservations: PickupReservation[];
  listingIds: ReadonlySet<string>;
  eventDate: Date;
  detectedAt: Date;
  windowDays?: number;
}): number {
  const windowDays = args.windowDays ?? PICKUP_WINDOW_DAYS;
  const windowEnd = addUtcDays(args.detectedAt, windowDays);
  const night = fromDateOnly(toDateOnly(args.eventDate)).getTime();
  let count = 0;
  for (const r of args.reservations) {
    if (!args.listingIds.has(r.listingId)) continue;
    if (r.arrival.getTime() > night || r.departure.getTime() <= night) continue;
    if (r.createdAt.getTime() <= args.detectedAt.getTime() || r.createdAt.getTime() > windowEnd.getTime()) continue;
    if (r.cancelledAt && r.cancelledAt.getTime() <= windowEnd.getTime()) continue;
    count += 1;
  }
  return count;
}

export type MeasuredPickup = {
  /** Subject bookings per listing-day over the window. */
  movedPickup: number;
  /** Control-set bookings per listing-day; null when the row has no control. */
  controlPickup: number | null;
  subjectBookings: number;
  controlBookings: number;
  controlCount: number;
};

/** Measure one control row's pickup from the loaded reservations. Pure. */
export function measurePickupForControl(args: {
  subjectListingId: string;
  controlListingIds: string[];
  eventDate: Date;
  detectedAt: Date;
  reservations: PickupReservation[];
  windowDays?: number;
}): MeasuredPickup {
  const windowDays = args.windowDays ?? PICKUP_WINDOW_DAYS;
  const subjectBookings = countWindowBookings({
    reservations: args.reservations,
    listingIds: new Set([args.subjectListingId]),
    eventDate: args.eventDate,
    detectedAt: args.detectedAt,
    windowDays
  });
  const controlCount = args.controlListingIds.length;
  const controlBookings =
    controlCount > 0
      ? countWindowBookings({
          reservations: args.reservations,
          listingIds: new Set(args.controlListingIds),
          eventDate: args.eventDate,
          detectedAt: args.detectedAt,
          windowDays
        })
      : 0;
  return {
    movedPickup: subjectBookings / windowDays,
    controlPickup: controlCount > 0 ? controlBookings / (windowDays * controlCount) : null,
    subjectBookings,
    controlBookings,
    controlCount
  };
}

export type PickupLearning = {
  /** Aggregate moved-vs-control velocity; null until an event has a control. */
  value: PickupVelocity | null;
  /** Measured events WITH a recorded control set (the learning's n). */
  eventsWithControl: number;
  /** All measured events in the trailing window (incl. rung-3, no control). */
  eventsMeasured: number;
  windowDays: number;
};

/**
 * Aggregate measured control rows into learning #1 via the `pickupVelocity`
 * core: only rows WITH a control contribute (a moved-only row has no honest
 * comparison), each weighted by its real listing-days. Pure.
 */
export function aggregateMeasuredPickups(
  rows: Array<{ movedPickup: number; controlPickup: number | null; controlCount: number }>,
  windowDays: number = PICKUP_WINDOW_DAYS
): PickupLearning {
  const withControl = rows.filter((r) => r.controlPickup !== null && r.controlCount > 0);
  if (withControl.length === 0) {
    return { value: null, eventsWithControl: 0, eventsMeasured: rows.length, windowDays };
  }
  let movedBookings = 0;
  let controlBookings = 0;
  let controlListingDays = 0;
  for (const row of withControl) {
    movedBookings += row.movedPickup * windowDays;
    controlBookings += (row.controlPickup as number) * windowDays * row.controlCount;
    controlListingDays += windowDays * row.controlCount;
  }
  return {
    value: pickupVelocity({
      movedBookings,
      movedListingDays: windowDays * withControl.length,
      controlBookings,
      controlListingDays
    }),
    eventsWithControl: withControl.length,
    eventsMeasured: rows.length,
    windowDays
  };
}

/**
 * Measure every settled-but-unmeasured `PeerControl` row for a tenant (bounded
 * batch). Writes ONLY `PeerControl.movedPickup`/`controlPickup` (+ a `detail`
 * merge recording the raw counts). Idempotent: measured rows are skipped by
 * the `movedPickup: null` filter. Tenant-scoped throughout.
 */
export async function measureSettledPickups(args: {
  tenantId: string;
  now?: Date;
}): Promise<{ measured: number; withControl: number }> {
  const { tenantId } = args;
  const now = args.now ?? new Date();

  const candidates = await prisma.peerControl.findMany({
    where: {
      tenantId,
      movedPickup: null,
      listingId: { not: null },
      rateChangeId: { not: null },
      eventDate: { not: null }
    },
    orderBy: { createdAt: "asc" },
    take: PICKUP_MEASURE_BATCH,
    select: { id: true, listingId: true, rateChangeId: true, eventDate: true, controlListingIds: true, detail: true }
  });
  if (candidates.length === 0) return { measured: 0, withControl: 0 };

  const changes = await prisma.rateChange.findMany({
    where: { tenantId, id: { in: [...new Set(candidates.map((c) => c.rateChangeId as string))] } },
    select: { id: true, detectedAt: true }
  });
  const detectedById = new Map(changes.map((c) => [c.id, c.detectedAt]));

  const settled = candidates.filter((c) => {
    const detectedAt = detectedById.get(c.rateChangeId as string);
    return detectedAt !== undefined && pickupWindowSettled(detectedAt, now);
  });
  if (settled.length === 0) return { measured: 0, withControl: 0 };

  // One tenant-scoped reservation load covering every window + stay date.
  const listingIds = new Set<string>();
  let minDetected: Date | null = null;
  let minEvent: Date | null = null;
  let maxEvent: Date | null = null;
  for (const row of settled) {
    listingIds.add(row.listingId as string);
    for (const id of row.controlListingIds) listingIds.add(id);
    const detectedAt = detectedById.get(row.rateChangeId as string) as Date;
    if (!minDetected || detectedAt < minDetected) minDetected = detectedAt;
    const event = row.eventDate as Date;
    if (!minEvent || event < minEvent) minEvent = event;
    if (!maxEvent || event > maxEvent) maxEvent = event;
  }
  const reservations = await prisma.reservation.findMany({
    where: {
      tenantId,
      listingId: { in: [...listingIds] },
      createdAt: { gt: minDetected as Date },
      arrival: { lte: maxEvent as Date },
      departure: { gt: minEvent as Date }
    },
    select: { listingId: true, createdAt: true, cancelledAt: true, arrival: true, departure: true }
  });

  let withControl = 0;
  for (const row of settled) {
    const detectedAt = detectedById.get(row.rateChangeId as string) as Date;
    const measured = measurePickupForControl({
      subjectListingId: row.listingId as string,
      controlListingIds: row.controlListingIds,
      eventDate: row.eventDate as Date,
      detectedAt,
      reservations
    });
    if (measured.controlPickup !== null) withControl += 1;
    const existingDetail =
      row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
        ? (row.detail as Record<string, unknown>)
        : {};
    await prisma.peerControl.updateMany({
      where: { id: row.id, tenantId },
      data: {
        movedPickup: measured.movedPickup,
        controlPickup: measured.controlPickup,
        detail: {
          ...existingDetail,
          pickup: {
            windowDays: PICKUP_WINDOW_DAYS,
            subjectBookings: measured.subjectBookings,
            controlBookings: measured.controlBookings,
            controlCount: measured.controlCount,
            measuredAt: now.toISOString()
          }
        }
      }
    });
  }
  return { measured: settled.length, withControl };
}

/**
 * Learning #1 — aggregate the measured peer-control pickups from the trailing
 * window into a moved-vs-control velocity with its n. Tenant-scoped,
 * read-only. Null `value` until at least one measured event has a control.
 */
export async function computePickupVelocity(tenantId: string, now = new Date()): Promise<PickupLearning> {
  const since = addUtcDays(fromDateOnly(toDateOnly(now)), -PICKUP_AGG_TRAILING_DAYS);
  const rows = await prisma.peerControl.findMany({
    where: { tenantId, movedPickup: { not: null }, createdAt: { gte: since } },
    select: { movedPickup: true, controlPickup: true, controlListingIds: true }
  });
  return aggregateMeasuredPickups(
    rows.map((r) => ({
      movedPickup: Number(r.movedPickup),
      controlPickup: r.controlPickup === null ? null : Number(r.controlPickup),
      controlCount: r.controlListingIds.length
    }))
  );
}
