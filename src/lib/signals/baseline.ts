/**
 * Yearly-ADR baseline for the rate scanner.
 *
 * The "% of yearly ADR" context on each price change is anchored on the
 * trailing-365d median of the listing's *booked* nightly rates. We read this
 * from NightFact (read-only) — `revenueAllocated` on an occupied night is the
 * per-night achieved rate.
 */

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";

import { MIN_NIGHTS_FOR_BASELINE, YEARLY_ADR_TRAILING_DAYS } from "./config";

/** Median of a numeric list. Returns null on an empty list. Pure. */
export function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Median of booked nightly rates, with the min-nights guard applied. Returns
 * null when there are too few usable (positive, finite) nights to trust the
 * signal. Pure — the DB wrapper below feeds it `revenueAllocated` values.
 */
export function yearlyAdrMedianFromNightlyRates(rawValues: number[]): number | null {
  const usable = rawValues.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length < MIN_NIGHTS_FOR_BASELINE) return null;
  return computeMedian(usable);
}

/**
 * Trailing-365d median of `NightFact.revenueAllocated` for occupied nights,
 * scoped to (tenantId, listingId). Returns null when there are fewer than
 * `MIN_NIGHTS_FOR_BASELINE` booked nights.
 *
 * Read-only: a single `findMany` selecting one column. Tenant-scoped.
 */
export async function computeYearlyAdrMedian(tenantId: string, listingId: string): Promise<number | null> {
  const today = fromDateOnly(toDateOnly(new Date()));
  const since = addUtcDays(today, -YEARLY_ADR_TRAILING_DAYS);

  const rows = await prisma.nightFact.findMany({
    where: {
      tenantId,
      listingId,
      isOccupied: true,
      date: { gte: since }
    },
    select: { revenueAllocated: true }
  });

  return yearlyAdrMedianFromNightlyRates(rows.map((row) => Number(row.revenueAllocated)));
}
