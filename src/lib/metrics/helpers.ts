import { addDays, addMonths, addWeeks, format, startOfMonth, startOfWeek } from "date-fns";

import { MetricFilters, MetricGrain } from "@/lib/metrics/types";

export function fromDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function resolveStayRange(filters: MetricFilters): { from: Date; to: Date } {
  if (filters.stayDateFrom && filters.stayDateTo) {
    return {
      from: fromDateOnly(filters.stayDateFrom),
      to: fromDateOnly(filters.stayDateTo)
    };
  }

  const to = new Date();
  const from = addDays(to, -90);
  return {
    from: fromDateOnly(toDateOnly(from)),
    to: fromDateOnly(toDateOnly(to))
  };
}

export function resolveBookingRange(filters: MetricFilters): { from: Date; to: Date } {
  if (filters.bookingDateFrom && filters.bookingDateTo) {
    return {
      from: fromDateOnly(filters.bookingDateFrom),
      to: fromDateOnly(filters.bookingDateTo)
    };
  }

  const to = new Date();
  const from = addDays(to, -90);
  return {
    from: fromDateOnly(toDateOnly(from)),
    to: fromDateOnly(toDateOnly(to))
  };
}

function seasonForMonth(month: number): "winter" | "spring" | "summer" | "autumn" {
  if ([12, 1, 2].includes(month)) return "winter";
  if ([3, 4, 5].includes(month)) return "spring";
  if ([6, 7, 8].includes(month)) return "summer";
  return "autumn";
}

export function matchesTemporalFilters(date: Date, filters: MetricFilters): boolean {
  const dayOfWeek = date.getUTCDay();
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  const season = seasonForMonth(month);

  if (filters.daysOfWeek && filters.daysOfWeek.length > 0 && !filters.daysOfWeek.includes(dayOfWeek)) {
    return false;
  }

  if (filters.months && filters.months.length > 0 && !filters.months.includes(month)) {
    return false;
  }

  if (filters.years && filters.years.length > 0 && !filters.years.includes(year)) {
    return false;
  }

  if (filters.seasons && filters.seasons.length > 0 && !filters.seasons.includes(season)) {
    return false;
  }

  return true;
}

export function dateToBucket(date: Date, grain: MetricGrain): string {
  if (grain === "day") return format(date, "yyyy-MM-dd");
  if (grain === "week") return format(startOfWeek(date, { weekStartsOn: 1 }), "yyyy-MM-dd");
  return format(startOfMonth(date), "yyyy-MM");
}

export function rangeToBuckets(from: Date, to: Date, grain: MetricGrain): string[] {
  const start = new Date(from);
  const end = new Date(to);
  const buckets: string[] = [];

  if (grain === "day") {
    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
      buckets.push(format(cursor, "yyyy-MM-dd"));
    }
    return buckets;
  }

  if (grain === "week") {
    for (let cursor = startOfWeek(start, { weekStartsOn: 1 }); cursor <= end; cursor = addWeeks(cursor, 1)) {
      buckets.push(format(cursor, "yyyy-MM-dd"));
    }
    return buckets;
  }

  for (let cursor = startOfMonth(start); cursor <= end; cursor = addMonths(cursor, 1)) {
    buckets.push(format(cursor, "yyyy-MM"));
  }

  return buckets;
}

export function diffUtcDays(start: Date, end: Date): number {
  const startDay = fromDateOnly(toDateOnly(start));
  const endDay = fromDateOnly(toDateOnly(end));
  return Math.max(0, Math.round((endDay.getTime() - startDay.getTime()) / (24 * 60 * 60 * 1000)));
}
