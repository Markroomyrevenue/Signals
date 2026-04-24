import { Reservation } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "no-show", "no_show"]);
const NON_BOOKED_STATUSES = new Set([
  ...CANCELLED_STATUSES,
  "declined",
  "expired",
  "inquiry",
  "inquirypreapproved",
  "inquirynotpossible"
]);

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fromDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function diffDays(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

function eachNight(arrival: Date, departure: Date): Date[] {
  const nights: Date[] = [];
  for (let cursor = new Date(arrival); cursor < departure; cursor = addUtcDays(cursor, 1)) {
    nights.push(new Date(cursor));
  }
  return nights;
}

function buildNightFactsForReservation(reservation: Reservation): Array<{
  tenantId: string;
  listingId: string;
  date: Date;
  factKey: string;
  reservationId: string;
  isOccupied: boolean;
  revenueAllocated: number;
  currency: string;
  channel: string | null;
  bookingCreatedAt: Date;
  leadTimeDays: number;
  losNights: number;
  status: string;
}> {
  const status = reservation.status.toLowerCase();
  const isOccupied = !NON_BOOKED_STATUSES.has(status);

  const arrival = reservation.arrival;
  const departure = reservation.departure;
  const computedNights = diffDays(arrival, departure);
  if (computedNights <= 0) {
    return [];
  }

  const losNights = reservation.nights > 0 ? reservation.nights : computedNights;
  const accommodationFare = Number(reservation.accommodationFare);
  // Non-booked statuses keep facts for auditability but should not contribute to stay revenue.
  const nightlyRevenue = !isOccupied ? 0 : (losNights > 0 ? accommodationFare / losNights : 0);

  const bookingCreatedDate = reservation.createdAt;
  const leadTimeDays = diffDays(fromDateOnly(toDateOnly(bookingCreatedDate)), arrival);

  return eachNight(arrival, departure).map((date) => ({
    tenantId: reservation.tenantId,
    listingId: reservation.listingId,
    date,
    factKey: `res:${reservation.id}`,
    reservationId: reservation.id,
    isOccupied,
    revenueAllocated: nightlyRevenue,
    currency: reservation.currency,
    channel: reservation.channel,
    bookingCreatedAt: bookingCreatedDate,
    leadTimeDays,
    losNights,
    status
  }));
}

type PartitionedFactTable = "night_facts" | "pace_snapshots";

async function ensurePartitionsForDateRange(
  tableName: PartitionedFactTable,
  startDate: Date,
  endExclusiveDate: Date
): Promise<void> {
  if (startDate >= endExclusiveDate) {
    return;
  }

  for (
    let monthStart = startOfUtcMonth(startDate);
    monthStart < endExclusiveDate;
    monthStart = addUtcMonths(monthStart, 1)
  ) {
    const monthStartDate = toDateOnly(monthStart);
    await prisma.$executeRaw`
      SELECT ensure_monthly_partition(${tableName}::text, ${monthStartDate}::date)
    `;
  }
}

export async function rebuildNightFactsForReservations(
  tenantId: string,
  reservationIds: string[]
): Promise<{ rowsUpserted: number; tenantId: string }> {
  const dedupedReservationIds = [...new Set(reservationIds)];
  if (dedupedReservationIds.length === 0) {
    return {
      tenantId,
      rowsUpserted: 0
    };
  }

  const touched = await prisma.reservation.findMany({
    where: {
      tenantId,
      id: { in: dedupedReservationIds }
    }
  });

  if (touched.length === 0) {
    return {
      tenantId,
      rowsUpserted: 0
    };
  }

  let earliestArrival = touched[0]?.arrival ?? null;
  let latestDeparture = touched[0]?.departure ?? null;
  for (const reservation of touched) {
    if (earliestArrival === null || reservation.arrival < earliestArrival) {
      earliestArrival = reservation.arrival;
    }
    if (latestDeparture === null || reservation.departure > latestDeparture) {
      latestDeparture = reservation.departure;
    }
  }

  if (earliestArrival !== null && latestDeparture !== null) {
    await ensurePartitionsForDateRange("night_facts", earliestArrival, latestDeparture);
  }

  for (let index = 0; index < dedupedReservationIds.length; index += 1000) {
    const chunk = dedupedReservationIds.slice(index, index + 1000);
    await prisma.nightFact.deleteMany({
      where: {
        tenantId,
        reservationId: { in: chunk }
      }
    });
  }

  const facts = touched.flatMap(buildNightFactsForReservation);
  for (let index = 0; index < facts.length; index += 1000) {
    const chunk = facts.slice(index, index + 1000);
    if (chunk.length === 0) continue;

    await prisma.nightFact.createMany({
      data: chunk,
      skipDuplicates: true
    });
  }

  return {
    tenantId,
    rowsUpserted: facts.length
  };
}
