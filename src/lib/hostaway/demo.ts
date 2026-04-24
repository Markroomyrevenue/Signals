import {
  FetchReservationsArgs,
  HostawayCalendarRate,
  HostawayGateway,
  HostawayListing,
  HostawayPageResult,
  HostawayReservation
} from "@/lib/hostaway/types";

const DEMO_LISTINGS: HostawayListing[] = [
  { id: "1001", name: "Shoreline Apartment", status: "active", timezone: "Europe/London", tags: ["coastal", "2br"] },
  { id: "1002", name: "City Loft", status: "active", timezone: "Europe/London", tags: ["urban", "1br"] },
  { id: "1003", name: "Country Cottage", status: "active", timezone: "Europe/London", tags: ["family", "pet-friendly"] }
];

function dateIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function buildDemoReservations(): HostawayReservation[] {
  const today = toDate(dateIso(new Date()));
  const start = addDays(today, -760);
  const totalStayDays = 1180;
  const reservations: HostawayReservation[] = [];

  for (let i = 0; i < totalStayDays; i += 1) {
    const listing = DEMO_LISTINGS[i % DEMO_LISTINGS.length];
    const arrival = addDays(start, i);
    const nights = 1 + (i % 6);
    const departure = addDays(arrival, nights);
    const createdAt = addDays(arrival, -(2 + (i % 45)));
    const totalPrice = 90 * nights + (i % 5) * 12;
    const isCancelled = i % 11 === 0;

    reservations.push({
      id: `demo-res-${i + 1}`,
      listingMapId: listing.id,
      channel: i % 3 === 0 ? "airbnb" : i % 3 === 1 ? "bookingcom" : "direct",
      status: isCancelled ? "cancelled" : "booked",
      insertedOn: createdAt.toISOString(),
      confirmedOn: createdAt.toISOString(),
      arrivalDate: dateIso(arrival),
      departureDate: dateIso(departure),
      nights,
      guests: 1 + (i % 4),
      currency: "GBP",
      totalPrice,
      accommodationFare: totalPrice,
      cleaningFee: 20,
      taxes: totalPrice * 0.08,
      commission: totalPrice * 0.12,
      updatedOn: addDays(createdAt, 1).toISOString(),
      raw: { demo: true }
    });
  }

  return reservations;
}

const DEMO_RESERVATIONS = buildDemoReservations();

function filterReservations(args: FetchReservationsArgs): HostawayReservation[] {
  let rows = DEMO_RESERVATIONS;

  if (args.updatedSince || args.latestActivityStart || args.latestActivityEnd) {
    const updatedSince = args.updatedSince ? new Date(args.updatedSince) : null;
    const latestActivityStart = args.latestActivityStart ? toDate(args.latestActivityStart) : null;
    const latestActivityEnd = args.latestActivityEnd ? toDate(args.latestActivityEnd) : null;
    rows = rows.filter((reservation) => {
      const updatedAt = new Date(reservation.updatedOn ?? reservation.insertedOn ?? 0);
      if (updatedSince && updatedAt < updatedSince) return false;
      if (latestActivityStart && updatedAt < latestActivityStart) return false;
      if (latestActivityEnd && updatedAt > latestActivityEnd) return false;
      return true;
    });
  }

  if (args.dateRange) {
    const from = toDate(args.dateRange.from);
    const to = toDate(args.dateRange.to);
    rows = rows.filter((reservation) => {
      const arrival = toDate(reservation.arrivalDate);
      const departure = toDate(reservation.departureDate);
      return arrival <= to && departure >= from;
    });
  }

  if (args.afterId) {
    const anchorIndex = rows.findIndex((reservation) => reservation.id === args.afterId);
    if (anchorIndex >= 0) {
      rows = rows.slice(anchorIndex + 1);
    }
  }

  return rows;
}

function paginate<T>(items: T[], page = 1, pageSize = 200): HostawayPageResult<T> {
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  return {
    items: pageItems,
    page,
    hasMore: start + pageSize < items.length
  };
}

export function createDemoHostawayGateway(): HostawayGateway {
  return {
    async fetchListings(page = 1) {
      return paginate(DEMO_LISTINGS, page, 200);
    },

    async fetchReservations(args = {}) {
      const page = args.page ?? 1;
      const rows = filterReservations(args);
      return paginate(rows, page, 200);
    },

    async fetchCalendarRates(listingId: string, dateFrom: string, dateTo: string): Promise<HostawayCalendarRate[]> {
      const listing = DEMO_LISTINGS.find((item) => item.id === listingId);
      if (!listing) return [];

      const rows: HostawayCalendarRate[] = [];
      const from = toDate(dateFrom);
      const to = toDate(dateTo);

      for (let cursor = new Date(from); cursor <= to; cursor = addDays(cursor, 1)) {
        const day = cursor.getUTCDay();
        const baseRate = listingId === "1001" ? 140 : listingId === "1002" ? 120 : 160;
        const weekendPremium = day === 5 || day === 6 ? 25 : 0;

        rows.push({
          date: dateIso(cursor),
          available: day !== 2,
          minStay: 1,
          maxStay: 30,
          rate: baseRate + weekendPremium,
          currency: "GBP",
          raw: { demo: true, listingId }
        });
      }

      return rows;
    }
  };
}
