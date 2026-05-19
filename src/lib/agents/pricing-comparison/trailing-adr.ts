/**
 * Shared trailing-ADR / occupancy helper, single source of truth for the
 * trial's "what did this listing actually do over the last 365 days"
 * aggregation. Per owner spec (2026-05-19):
 *
 *   ADR  = sum(revenueAllocated over the trailing 365 days)
 *         /
 *         count(nights actually sold to a paying guest with a rate)
 *
 *   Occupancy = count(sold nights) / 365 (calendar days, NOT
 *               "days with any NightFact row")
 *
 * Exclusions applied at the night level:
 *   - status === "ownerstay" — owner's own bookings, not paying guests
 *   - losNights > 10 — long stays priced at a different (lower) rate
 *     that drags the trailing ADR down. They aren't representative of
 *     what we'd charge a typical 2-5 night stay.
 *   - isOccupied = false — already-excluded statuses (cancelled, etc.)
 *   - revenueAllocated <= 0 — defensive guard against £0 nights that
 *     would dilute ADR without contributing revenue
 *
 * NOTE on cleaning fee: NightFact.revenueAllocated is already
 * `accommodationFare / losNights`. accommodationFare is Hostaway's
 * rent-only field, so cleaning fees are structurally NOT in the
 * trailing ADR. PriceLabs prices the same way (nightly rate excluding
 * cleaning fee). No subtraction needed here.
 */

import { prisma } from "@/lib/prisma";

/** Statuses that should never count toward trailing ADR or occupancy. */
export const STATUSES_EXCLUDED_FROM_TRAILING_ADR = new Set<string>(["ownerstay"]);

/** Max nights-of-stay considered "typical" — longer ones price differently. */
export const MAX_LOS_NIGHTS_FOR_TRAILING_ADR = 10;

/** Trailing window length in days (calendar). */
export const TRAILING_WINDOW_DAYS = 365;

export type TrailingPerListing = {
  /** ADR over trailing 365d, computed against sold-night denominator. */
  adr: number | null;
  /** Occupancy over trailing 365d, denominator = calendar days. */
  occupancy: number | null;
  /** Count of nights that survived all filters. */
  soldNights: number;
  /** Sum of revenueAllocated across those nights (cleaning fee excluded). */
  revenue: number;
  /** Set of trailing date ISO strings (YYYY-MM-DD) that counted as sold. */
  soldDateSet: Set<string>;
};

/**
 * Load trailing-365-day aggregates for one or many listings. Caller can
 * pass a single listingId or a list; the result is a Map keyed by
 * listingId. Returns an empty entry per requested listing even when
 * there were zero qualifying nights so callers can distinguish "no
 * coverage" from "missing key".
 */
export async function loadTrailingPerListing(
  tenantId: string,
  listingIds: string[]
): Promise<Map<string, TrailingPerListing>> {
  const out = new Map<string, TrailingPerListing>();
  for (const id of listingIds) {
    out.set(id, { adr: null, occupancy: null, soldNights: 0, revenue: 0, soldDateSet: new Set() });
  }
  if (listingIds.length === 0) return out;

  const today = new Date();
  const windowStart = new Date(today);
  windowStart.setUTCDate(today.getUTCDate() - TRAILING_WINDOW_DAYS);

  const facts = await prisma.nightFact.findMany({
    where: {
      tenantId,
      listingId: { in: listingIds },
      date: { gte: windowStart, lt: today },
      isOccupied: true,
      revenueAllocated: { gt: 0 },
      // NightFact.losNights is nullable. Postgres `not: { gt: 10 }` matches
      // null too — but be defensive: filter out null AND > MAX.
      losNights: { not: null, lte: MAX_LOS_NIGHTS_FOR_TRAILING_ADR }
    },
    select: { listingId: true, date: true, revenueAllocated: true, status: true }
  });

  // Collapse to (listingId × date) so that overlapping NightFact rows
  // for the same night (rare — should never happen given factKey
  // uniqueness, but possible across legacy sync runs) don't double-
  // count revenue or nights.
  type Cell = { revenue: number; status: string | null };
  const byListing = new Map<string, Map<string, Cell>>();
  for (const f of facts) {
    if (f.status && STATUSES_EXCLUDED_FROM_TRAILING_ADR.has(f.status.toLowerCase())) continue;
    let inner = byListing.get(f.listingId);
    if (!inner) {
      inner = new Map();
      byListing.set(f.listingId, inner);
    }
    const iso = f.date.toISOString().slice(0, 10);
    const cur = inner.get(iso) ?? { revenue: 0, status: null };
    cur.revenue += Number(f.revenueAllocated ?? 0);
    cur.status = f.status ?? cur.status;
    inner.set(iso, cur);
  }

  for (const [listingId, dateMap] of byListing) {
    let revenue = 0;
    const soldDateSet = new Set<string>();
    for (const [iso, cell] of dateMap) {
      if (cell.revenue <= 0) continue;
      revenue += cell.revenue;
      soldDateSet.add(iso);
    }
    const soldNights = soldDateSet.size;
    out.set(listingId, {
      adr: soldNights > 0 ? revenue / soldNights : null,
      occupancy: soldNights > 0 ? soldNights / TRAILING_WINDOW_DAYS : null,
      soldNights,
      revenue,
      soldDateSet
    });
  }

  return out;
}
