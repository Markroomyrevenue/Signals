import { Prisma } from "@prisma/client";

import { FxConverter } from "@/lib/fx";
import { prisma } from "@/lib/prisma";
import { LEAD_TIME_BUCKETS, LOS_BUCKETS, matchesBucketSelection, parseBucketRanges } from "@/lib/metrics/buckets";
import {
  addUtcDays,
  diffUtcDays,
  fromDateOnly,
  matchesTemporalFilters,
  resolveBookingRange,
  resolveStayRange,
  toDateOnly
} from "@/lib/metrics/helpers";
import { MetricFilters } from "@/lib/metrics/types";

const INACTIVE_STATUSES = new Set(["cancelled", "canceled", "no-show", "no_show"]);

type DailyStayAggregate = {
  occupiedNights: number;
  stayRevenue: number;
};

type DailyAvailabilityAggregate = {
  availableNights: number;
  liveRateSum: number;
  liveRateCount: number;
};

type DailyBookingAggregate = {
  bookingsCreated: number;
  bookedRevenue: number;
  cancellations: number;
};

type BookingRow = {
  createdAt: Date;
  arrival: Date;
  nights: number;
  total: number;
  accommodationFare: number;
  currency: string;
  status: string;
  channel: string;
};

export type PaceDailyAggregate = {
  nightsOnBooks: number;
  revenueOnBooks: number;
};

function normalizeStatuses(statuses: string[] | undefined): string[] | undefined {
  if (!statuses || statuses.length === 0) return undefined;
  return statuses.map((status) => status.toLowerCase());
}

function rangesToIntFilters(
  field: "leadTimeDays" | "losNights",
  ranges: Array<{ min: number; max: number | null }>
): Prisma.NightFactWhereInput[] {
  return ranges.map((range) => {
    if (field === "leadTimeDays") {
      if (range.max === null) {
        return { leadTimeDays: { gte: range.min } };
      }
      return { leadTimeDays: { gte: range.min, lte: range.max } };
    }

    if (range.max === null) {
      return { losNights: { gte: range.min } };
    }

    return { losNights: { gte: range.min, lte: range.max } };
  });
}

function dateFromSnapshot(date: Date): Date {
  return new Date(`${toDateOnly(date)}T00:00:00Z`);
}

export class MetricDataLoader {
  private fx = new FxConverter();
  private stayDailyCache: Promise<Map<string, DailyStayAggregate>> | null = null;
  private availabilityDailyCache: Promise<Map<string, DailyAvailabilityAggregate>> | null = null;
  private bookingDailyCache: Promise<Map<string, DailyBookingAggregate>> | null = null;
  private bookingRowsCache: Promise<BookingRow[]> | null = null;

  constructor(
    private readonly tenantId: string,
    private readonly filters: MetricFilters,
    private readonly displayCurrency: string
  ) {}

  getStayRange(): { from: Date; to: Date } {
    return resolveStayRange(this.filters);
  }

  getBookingRange(): { from: Date; to: Date } {
    return resolveBookingRange(this.filters);
  }

  getGranularity(): "day" | "week" | "month" {
    return this.filters.granularity ?? "day";
  }

  async getStayDaily(): Promise<Map<string, DailyStayAggregate>> {
    if (this.stayDailyCache) return this.stayDailyCache;

    this.stayDailyCache = (async () => {
      const range = this.getStayRange();
      const bookingRange = this.getBookingRange();
      const leadRanges = parseBucketRanges(this.filters.leadTimeBuckets, LEAD_TIME_BUCKETS);
      const losRanges = parseBucketRanges(this.filters.losBuckets, LOS_BUCKETS);

      const whereAnd: Prisma.NightFactWhereInput[] = [
        {
          tenantId: this.tenantId,
          isOccupied: true,
          date: {
            gte: range.from,
            lte: range.to
          }
        }
      ];

      if (this.filters.listingIds && this.filters.listingIds.length > 0) {
        whereAnd.push({ listingId: { in: this.filters.listingIds } });
      }

      if (this.filters.channels && this.filters.channels.length > 0) {
        whereAnd.push({ channel: { in: this.filters.channels } });
      }

      const normalizedStatuses = normalizeStatuses(this.filters.statuses);
      if (normalizedStatuses && normalizedStatuses.length > 0) {
        whereAnd.push({ status: { in: normalizedStatuses } });
      }

      if (leadRanges.length > 0) {
        whereAnd.push({ OR: rangesToIntFilters("leadTimeDays", leadRanges) });
      }

      if (losRanges.length > 0) {
        whereAnd.push({ OR: rangesToIntFilters("losNights", losRanges) });
      }

      if (this.filters.dateMode === "booking" || this.filters.dateMode === "both") {
        whereAnd.push({
          bookingCreatedAt: {
            gte: bookingRange.from,
            lt: addUtcDays(bookingRange.to, 1)
          }
        });
      }

      const rows = await prisma.nightFact.findMany({
        where: {
          AND: whereAnd
        },
        select: {
          date: true,
          currency: true,
          revenueAllocated: true
        }
      });

      const grouped = new Map<string, { occupiedNights: number; revenueNative: number; currency: string; date: Date }>();

      for (const row of rows) {
        if (!matchesTemporalFilters(row.date, this.filters)) continue;

        const dateKey = toDateOnly(row.date);
        const key = `${dateKey}|${row.currency}`;
        const current = grouped.get(key) ?? {
          occupiedNights: 0,
          revenueNative: 0,
          currency: row.currency,
          date: row.date
        };

        current.occupiedNights += 1;
        current.revenueNative += Number(row.revenueAllocated);
        grouped.set(key, current);
      }

      const aggregate = new Map<string, DailyStayAggregate>();

      for (const [key, value] of grouped.entries()) {
        const [dateKey] = key.split("|");
        const convertedRevenue = await this.fx.convert(
          value.revenueNative,
          value.date,
          value.currency,
          this.displayCurrency
        );

        const current = aggregate.get(dateKey) ?? {
          occupiedNights: 0,
          stayRevenue: 0
        };

        current.occupiedNights += value.occupiedNights;
        current.stayRevenue += convertedRevenue;
        aggregate.set(dateKey, current);
      }

      return aggregate;
    })();

    return this.stayDailyCache;
  }

  async getAvailabilityDaily(): Promise<Map<string, DailyAvailabilityAggregate>> {
    if (this.availabilityDailyCache) return this.availabilityDailyCache;

    this.availabilityDailyCache = (async () => {
      const range = this.getStayRange();
      const rows = await prisma.calendarRate.findMany({
        where: {
          tenantId: this.tenantId,
          date: {
            gte: range.from,
            lte: range.to
          },
          ...(this.filters.listingIds && this.filters.listingIds.length > 0
            ? { listingId: { in: this.filters.listingIds } }
            : {})
        },
        select: {
          date: true,
          available: true,
          rate: true,
          currency: true
        }
      });

      const grouped = new Map<
        string,
        {
          availableNights: number;
          liveRateSumNative: number;
          liveRateCount: number;
          currency: string;
          date: Date;
        }
      >();

      for (const row of rows) {
        if (!matchesTemporalFilters(row.date, this.filters)) continue;
        if (!row.available) continue;

        const dateKey = toDateOnly(row.date);
        const key = `${dateKey}|${row.currency}`;
        const current = grouped.get(key) ?? {
          availableNights: 0,
          liveRateSumNative: 0,
          liveRateCount: 0,
          currency: row.currency,
          date: row.date
        };

        current.availableNights += 1;
        current.liveRateSumNative += Number(row.rate);
        current.liveRateCount += 1;
        grouped.set(key, current);
      }

      const aggregate = new Map<string, DailyAvailabilityAggregate>();

      for (const [key, value] of grouped.entries()) {
        const [dateKey] = key.split("|");
        const convertedRateSum = await this.fx.convert(
          value.liveRateSumNative,
          value.date,
          value.currency,
          this.displayCurrency
        );

        const current = aggregate.get(dateKey) ?? {
          availableNights: 0,
          liveRateSum: 0,
          liveRateCount: 0
        };

        current.availableNights += value.availableNights;
        current.liveRateSum += convertedRateSum;
        current.liveRateCount += value.liveRateCount;
        aggregate.set(dateKey, current);
      }

      return aggregate;
    })();

    return this.availabilityDailyCache;
  }

  async getBookingRows(): Promise<BookingRow[]> {
    if (this.bookingRowsCache) return this.bookingRowsCache;

    this.bookingRowsCache = (async () => {
      const range = this.getBookingRange();
      const toExclusive = addUtcDays(range.to, 1);
      const stayRange = this.getStayRange();

      const rows = await prisma.reservation.findMany({
        where: {
          tenantId: this.tenantId,
          createdAt: {
            gte: range.from,
            lt: toExclusive
          },
          ...(this.filters.dateMode === "stay" || this.filters.dateMode === "both"
            ? {
                arrival: {
                  lte: stayRange.to
                },
                departure: {
                  gt: stayRange.from
                }
              }
            : {}),
          ...(this.filters.listingIds && this.filters.listingIds.length > 0
            ? { listingId: { in: this.filters.listingIds } }
            : {}),
          ...(this.filters.channels && this.filters.channels.length > 0
            ? { channel: { in: this.filters.channels } }
            : {}),
          ...(this.filters.statuses && this.filters.statuses.length > 0
            ? { status: { in: this.filters.statuses.map((status) => status.toLowerCase()) } }
            : {})
        },
        select: {
          createdAt: true,
          arrival: true,
          nights: true,
          total: true,
          accommodationFare: true,
          currency: true,
          status: true,
          channel: true
        }
      });

      const filtered = rows
        .map((row) => ({
          createdAt: row.createdAt,
          arrival: row.arrival,
          nights: row.nights,
          total: Number(row.total),
          accommodationFare: Number(row.accommodationFare),
          currency: row.currency,
          status: row.status.toLowerCase(),
          channel: row.channel ?? "unknown"
        }))
        .filter((row) => {
          if (!matchesTemporalFilters(row.createdAt, this.filters)) {
            return false;
          }

          const leadTimeDays = diffUtcDays(row.createdAt, row.arrival);
          if (!matchesBucketSelection(leadTimeDays, this.filters.leadTimeBuckets, LEAD_TIME_BUCKETS)) {
            return false;
          }

          if (!matchesBucketSelection(row.nights, this.filters.losBuckets, LOS_BUCKETS)) {
            return false;
          }

          return true;
        });

      return filtered;
    })();

    return this.bookingRowsCache;
  }

  async getBookingDaily(): Promise<Map<string, DailyBookingAggregate>> {
    if (this.bookingDailyCache) return this.bookingDailyCache;

    this.bookingDailyCache = (async () => {
      const rows = await this.getBookingRows();
      const grouped = new Map<string, { bookingsCreated: number; bookedRevenueNative: number; cancellations: number; currency: string; date: Date }>();

      for (const row of rows) {
        const dateKey = toDateOnly(row.createdAt);
        const key = `${dateKey}|${row.currency}`;

        const current = grouped.get(key) ?? {
          bookingsCreated: 0,
          bookedRevenueNative: 0,
          cancellations: 0,
          currency: row.currency,
          date: dateFromSnapshot(row.createdAt)
        };

        current.bookingsCreated += 1;
        current.bookedRevenueNative += row.total;

        if (INACTIVE_STATUSES.has(row.status)) {
          current.cancellations += 1;
        }

        grouped.set(key, current);
      }

      const aggregate = new Map<string, DailyBookingAggregate>();

      for (const [key, value] of grouped.entries()) {
        const [dateKey] = key.split("|");
        const convertedRevenue = await this.fx.convert(
          value.bookedRevenueNative,
          value.date,
          value.currency,
          this.displayCurrency
        );

        const current = aggregate.get(dateKey) ?? {
          bookingsCreated: 0,
          bookedRevenue: 0,
          cancellations: 0
        };

        current.bookingsCreated += value.bookingsCreated;
        current.bookedRevenue += convertedRevenue;
        current.cancellations += value.cancellations;

        aggregate.set(dateKey, current);
      }

      return aggregate;
    })();

    return this.bookingDailyCache;
  }

  async getBookingWindowBuckets(): Promise<
    Map<
      string,
      {
        adr: number;
        avgLos: number;
        bookedNights: number;
        bookedRevenue: number;
      }
    >
  > {
    const rows = await this.getBookingRows();
    const includeInactive = Boolean(this.filters.statuses && this.filters.statuses.length > 0);

    const accumulator = new Map<
      string,
      {
        revenue: number;
        nights: number;
        losTotal: number;
        count: number;
      }
    >();

    for (const row of rows) {
      if (!includeInactive && INACTIVE_STATUSES.has(row.status)) {
        continue;
      }

      const leadTimeDays = diffUtcDays(row.createdAt, row.arrival);
      const bucket = LEAD_TIME_BUCKETS.find((item) => {
        if (leadTimeDays < item.min) return false;
        if (item.max === null) return true;
        return leadTimeDays <= item.max;
      });

      if (!bucket) continue;
      if (this.filters.leadTimeBuckets && this.filters.leadTimeBuckets.length > 0) {
        if (!this.filters.leadTimeBuckets.includes(bucket.id)) {
          continue;
        }
      }

      const bookingDate = dateFromSnapshot(row.createdAt);
      const convertedFare = await this.fx.convert(
        row.accommodationFare,
        bookingDate,
        row.currency,
        this.displayCurrency
      );

      const current = accumulator.get(bucket.id) ?? {
        revenue: 0,
        nights: 0,
        losTotal: 0,
        count: 0
      };

      current.revenue += convertedFare;
      current.nights += Math.max(1, row.nights);
      current.losTotal += row.nights;
      current.count += 1;
      accumulator.set(bucket.id, current);
    }

    const output = new Map<string, { adr: number; avgLos: number; bookedNights: number; bookedRevenue: number }>();

    for (const bucket of LEAD_TIME_BUCKETS) {
      const data = accumulator.get(bucket.id);
      if (!data || data.count === 0) {
        output.set(bucket.id, { adr: 0, avgLos: 0, bookedNights: 0, bookedRevenue: 0 });
        continue;
      }

      output.set(bucket.id, {
        adr: data.nights > 0 ? data.revenue / data.nights : 0,
        avgLos: data.losTotal / data.count,
        bookedNights: data.nights,
        bookedRevenue: data.revenue
      });
    }

    return output;
  }

  async getBookedNightsByLosBucket(): Promise<Map<string, number>> {
    const rows = await this.getBookingRows();
    const includeInactive = Boolean(this.filters.statuses && this.filters.statuses.length > 0);
    const output = new Map<string, number>(LOS_BUCKETS.map((bucket) => [bucket.id, 0]));

    for (const row of rows) {
      if (!includeInactive && INACTIVE_STATUSES.has(row.status)) {
        continue;
      }

      const bucket = LOS_BUCKETS.find((item) => {
        if (row.nights < item.min) return false;
        if (item.max === null) return true;
        return row.nights <= item.max;
      });

      if (!bucket) continue;
      if (this.filters.losBuckets && this.filters.losBuckets.length > 0) {
        if (!this.filters.losBuckets.includes(bucket.id)) {
          continue;
        }
      }

      output.set(bucket.id, (output.get(bucket.id) ?? 0) + Math.max(1, row.nights));
    }

    return output;
  }

  async getChannelMixBookings(): Promise<Map<string, number>> {
    const rows = await this.getBookingRows();
    const output = new Map<string, number>();

    for (const row of rows) {
      const channel = row.channel || "unknown";
      output.set(channel, (output.get(channel) ?? 0) + 1);
    }

    return output;
  }

  async getPaceForSnapshot(snapshotDate?: string): Promise<{
    snapshotDate: string;
    daily: Map<string, PaceDailyAggregate>;
  }> {
    const targetSnapshotDate = snapshotDate ?? this.filters.paceSnapshotDate ?? (await this.getLatestSnapshotDate());
    if (!targetSnapshotDate) {
      return {
        snapshotDate: "",
        daily: new Map()
      };
    }

    const range = this.getStayRange();
    const rows = await prisma.paceSnapshot.findMany({
      where: {
        tenantId: this.tenantId,
        snapshotDate: fromDateOnly(targetSnapshotDate),
        stayDate: {
          gte: range.from,
          lte: range.to
        },
        ...(this.filters.listingIds && this.filters.listingIds.length > 0
          ? { listingId: { in: this.filters.listingIds } }
          : {})
      },
      select: {
        stayDate: true,
        nightsOnBooks: true,
        revenueOnBooks: true,
        currency: true
      }
    });

    const grouped = new Map<string, { nights: number; revenueNative: number; currency: string; date: Date }>();

    for (const row of rows) {
      if (!matchesTemporalFilters(row.stayDate, this.filters)) continue;

      const dateKey = toDateOnly(row.stayDate);
      const key = `${dateKey}|${row.currency}`;
      const current = grouped.get(key) ?? {
        nights: 0,
        revenueNative: 0,
        currency: row.currency,
        date: row.stayDate
      };

      current.nights += row.nightsOnBooks;
      current.revenueNative += Number(row.revenueOnBooks);
      grouped.set(key, current);
    }

    const aggregate = new Map<string, PaceDailyAggregate>();

    for (const [key, value] of grouped.entries()) {
      const [dateKey] = key.split("|");
      const convertedRevenue = await this.fx.convert(
        value.revenueNative,
        value.date,
        value.currency,
        this.displayCurrency
      );

      const current = aggregate.get(dateKey) ?? {
        nightsOnBooks: 0,
        revenueOnBooks: 0
      };

      current.nightsOnBooks += value.nights;
      current.revenueOnBooks += convertedRevenue;
      aggregate.set(dateKey, current);
    }

    return {
      snapshotDate: targetSnapshotDate,
      daily: aggregate
    };
  }

  async getPickupBetweenSnapshots(startSnapshotDate?: string, endSnapshotDate?: string): Promise<{
    startSnapshotDate: string;
    endSnapshotDate: string;
    daily: Map<string, { pickupNights: number }>;
  }> {
    let startSnapshot = startSnapshotDate ?? this.filters.pickupSnapshotStart;
    let endSnapshot = endSnapshotDate ?? this.filters.pickupSnapshotEnd;

    if (!startSnapshot || !endSnapshot) {
      const snapshots = await this.getLatestSnapshotDates(2);
      endSnapshot = endSnapshot ?? snapshots[0];
      startSnapshot = startSnapshot ?? snapshots[1];
    }

    if (!startSnapshot || !endSnapshot) {
      return {
        startSnapshotDate: "",
        endSnapshotDate: "",
        daily: new Map()
      };
    }

    const [start, end] = await Promise.all([
      this.getPaceForSnapshot(startSnapshot),
      this.getPaceForSnapshot(endSnapshot)
    ]);

    const output = new Map<string, { pickupNights: number }>();
    const keys = new Set<string>([...start.daily.keys(), ...end.daily.keys()]);

    for (const key of keys) {
      const startValue = start.daily.get(key)?.nightsOnBooks ?? 0;
      const endValue = end.daily.get(key)?.nightsOnBooks ?? 0;
      output.set(key, {
        pickupNights: endValue - startValue
      });
    }

    return {
      startSnapshotDate: start.snapshotDate,
      endSnapshotDate: end.snapshotDate,
      daily: output
    };
  }

  async getLatestSnapshotDate(): Promise<string | null> {
    const list = await this.getLatestSnapshotDates(1);
    return list[0] ?? null;
  }

  async getLatestSnapshotDates(limit: number): Promise<string[]> {
    const rows = await prisma.paceSnapshot.findMany({
      where: {
        tenantId: this.tenantId
      },
      distinct: ["snapshotDate"],
      orderBy: {
        snapshotDate: "desc"
      },
      take: limit,
      select: {
        snapshotDate: true
      }
    });

    return rows.map((row) => toDateOnly(row.snapshotDate));
  }
}
