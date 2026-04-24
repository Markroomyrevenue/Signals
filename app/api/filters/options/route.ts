import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { normalizeReservationChannel, normalizeReservationStatus } from "@/lib/hostaway/normalize";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const CURATED_CURRENCIES = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF"];
const STATUS_PRIORITY = ["new", "modified", "ownerstay", "cancelled", "inquiry", "inquirypreapproved", "inquirynotpossible", "expired", "declined"];

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [channels, statuses, listings, lifecycleRows, snapshotDates] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        tenantId: auth.tenantId,
        channel: {
          not: null
        }
      },
      distinct: ["channel"],
      select: {
        channel: true
      }
    }),
    prisma.reservation.findMany({
      where: {
        tenantId: auth.tenantId
      },
      distinct: ["status"],
      select: {
        status: true
      }
    }),
    prisma.listing.findMany({
      where: {
        tenantId: auth.tenantId
      },
      select: {
        id: true,
        name: true,
        tags: true
      },
      orderBy: {
        name: "asc"
      }
    }),
    prisma.reservation.groupBy({
      by: ["listingId"],
      where: {
        tenantId: auth.tenantId
      },
      _min: {
        arrival: true
      }
    }),
    prisma.paceSnapshot.findMany({
      where: {
        tenantId: auth.tenantId
      },
      distinct: ["snapshotDate"],
      orderBy: {
        snapshotDate: "desc"
      },
      select: {
        snapshotDate: true
      },
      take: 60
    })
  ]);

  const normalizedChannels = [...new Set(
    channels
      .map((row) => normalizeReservationChannel({ channel: row.channel }))
      .filter((value) => value !== "unknown")
  )].sort((a, b) => a.localeCompare(b));

  const statusOrder = new Map(STATUS_PRIORITY.map((status, index) => [status, index]));
  const normalizedStatuses = [...new Set(
    statuses
      .map((row) => normalizeReservationStatus(row.status))
      .filter((value) => value.length > 0)
  )].sort((a, b) => {
    const aRank = statusOrder.get(a);
    const bRank = statusOrder.get(b);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return a.localeCompare(b);
  });

  const firstBookedNightByListingId = new Map(
    lifecycleRows.map((row) => [row.listingId, row._min.arrival ? toDateOnly(row._min.arrival) : null] as const)
  );

  return NextResponse.json({
    channels: normalizedChannels,
    statuses: normalizedStatuses,
    listings: listings.map((listing) => ({
      ...listing,
      firstBookedNight: firstBookedNightByListingId.get(listing.id) ?? null
    })),
    currencies: CURATED_CURRENCIES,
    paceSnapshotDates: snapshotDates.map((row) => toDateOnly(row.snapshotDate))
  });
}
