/**
 * Per-listing per-month forward-occupancy loader for the trial yield
 * multiplier (2026-05-26 fix).
 *
 * ## Why this exists
 *
 * The trial occupancy multiplier ladder (`lookupTrialOccupancyMultiplier`,
 * ×0.88 at 0–10% up to ×1.12 at 90–100%) was previously fed
 * `ownAgg.trailing365dOccupancy` — a backward-looking, near-static
 * per-listing average. So the multiplier was applying a roughly fixed
 * nudge per listing based on LAST YEAR'S average occupancy and was
 * NOT doing yield management at all.
 *
 * This helper produces the LIVE forward occupancy for the target
 * date's calendar month, which the agent passes as `scopeOccupancy`.
 * Result: a listing 90% booked for August gets the +12% rung on its
 * remaining August nights; one 25% booked for October gets the −10%
 * rung. Live scarcity pricing.
 *
 * ## Window
 *
 * `FORWARD_OCC_WINDOW = "calendar-month"`. For target date D the
 * window is `[max(snapshotDate, D.monthStart), D.monthEnd]`.
 *
 *   - **Calendar month** because it's the natural booking unit
 *     ("how booked is August?") and matches what PriceLabs appears
 *     to use as its horizon.
 *   - **`max(snapshot, monthStart)`** because we only care about
 *     remaining inventory: a target in the middle of May uses the
 *     remaining half of May, not the historical first half that
 *     already passed.
 *
 * ## Definition
 *
 *   - `booked` = distinct dates in window where the listing has an
 *     active reservation (created_at ≤ snapshot, not cancelled by
 *     snapshot, arrival ≤ date < departure). `ownerstay` excluded
 *     by status filter — consistent with the trailing-ADR helper.
 *   - `blocked` = distinct dates in window where `CalendarRate.available
 *     = false` AND NOT in the booked set. Captures owner-blocked,
 *     cleaning-blocked, maintenance-blocked.
 *   - `bookable_inventory` = `window_length − blocked`. Includes
 *     booked + available-bookable dates.
 *   - **`forward_occupancy = booked / bookable_inventory`**.
 *
 * If `bookable_inventory` = 0 (whole window blocked) the entry is
 * `null` so the downstream ladder falls back to its null-input
 * default (multiplier 1.0).
 *
 * ## Cost
 *
 * Two SQL round-trips per tenant per run (one reservations sweep,
 * one calendar_rates sweep). Per-cell lookup is `O(1)` Map.get().
 * Same shape as the existing `loadPortfolioForwardFill` in
 * `cross-sectional-demand.ts`.
 *
 * ## Trial-only
 *
 * Lives under `agents/pricing-comparison/` and is consumed only by
 * the trial comparison agent (`agent.ts`). The production pricing
 * path is untouched.
 */

import { prisma } from "@/lib/prisma";

/** The forward-occupancy window — kept as a named constant for the spec. */
export const FORWARD_OCC_WINDOW = "calendar-month" as const;

/** YYYY-MM key for the per-listing map. */
type MonthKey = string;

/** ISO date YYYY-MM-DD. */
type IsoDate = string;

/**
 * Map of listingId → monthKey ("YYYY-MM") → forward occupancy fraction (0..1)
 * or null when the window has no bookable inventory.
 */
export type ForwardOccupancyMap = Map<string, Map<MonthKey, number | null>>;

function monthKeyOf(iso: IsoDate): MonthKey {
  // "2026-08-15" → "2026-08"
  return iso.slice(0, 7);
}

function lastDayOfMonth(year: number, monthIndex0: number): number {
  // monthIndex0 ∈ 0..11. Day 0 of the next month = last day of this month.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * For a given month-key, return the inclusive forward-window
 * `[max(snapshot, monthStart), monthEnd]` as ISO strings.
 */
function windowForMonth(monthKey: MonthKey, snapshotIso: IsoDate): { startIso: IsoDate; endIso: IsoDate; lengthDays: number } | null {
  const [yStr, mStr] = monthKey.split("-");
  const year = Number(yStr);
  const monthIndex0 = Number(mStr) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex0)) return null;
  const monthStart = new Date(Date.UTC(year, monthIndex0, 1));
  const lastDay = lastDayOfMonth(year, monthIndex0);
  const monthEnd = new Date(Date.UTC(year, monthIndex0, lastDay));
  const snapshot = new Date(`${snapshotIso}T00:00:00Z`);
  const start = snapshot > monthStart ? snapshot : monthStart;
  if (start > monthEnd) return null; // entire month is in the past
  const startIso = start.toISOString().slice(0, 10);
  const endIso = monthEnd.toISOString().slice(0, 10);
  const lengthDays = Math.round((monthEnd.getTime() - start.getTime()) / 86400000) + 1;
  return { startIso, endIso, lengthDays };
}

/**
 * Set of all (listingId, ISO date) pairs the listing has bookable
 * inventory for in the horizon: i.e. NOT owner-blocked. Booked dates
 * ARE in this set (the booking consumed available inventory).
 */
type BookedSet = Set<string>; // key: `${listingId}|${iso}`
type BlockedSet = Set<string>; // key: `${listingId}|${iso}`

function key(listingId: string, iso: IsoDate): string {
  return `${listingId}|${iso}`;
}

/**
 * Load per-listing per-month forward occupancy for the tenant's
 * single-unit listings over the horizon `[asOfIso, asOfIso + horizonDays]`.
 *
 * The map is dense — every month touched by the horizon gets an
 * entry per listing, even if the value is null (no bookable
 * inventory) or 0 (no bookings in window). Caller can use `.get()`
 * directly without null-checking the listing-level Map.
 */
export async function loadForwardOccupancyByListingMonth(args: {
  tenantId: string;
  listingIds: string[];
  asOfIso: IsoDate;
  horizonDays: number;
}): Promise<ForwardOccupancyMap> {
  const { tenantId, listingIds, asOfIso, horizonDays } = args;
  const out: ForwardOccupancyMap = new Map();
  for (const id of listingIds) out.set(id, new Map());
  if (listingIds.length === 0) return out;

  const asOf = new Date(`${asOfIso}T00:00:00Z`);
  const horizonEnd = new Date(asOf);
  horizonEnd.setUTCDate(asOf.getUTCDate() + horizonDays);

  // 1. Booked-date set: for each listing, the dates with an active reservation
  //    overlapping the date as-of snapshot. Same active-reservation filter
  //    as `loadPortfolioForwardFill` in cross-sectional-demand.ts.
  type BookedRow = { listing_id: string; iso_date: string };
  const bookedRows = (await prisma.$queryRaw`
    WITH stay_dates AS (
      SELECT generate_series(${asOfIso}::date, ${horizonEnd.toISOString().slice(0, 10)}::date, '1 day'::interval)::date AS d
    )
    SELECT DISTINCT r.listing_id::text AS listing_id,
                    sd.d::text AS iso_date
    FROM stay_dates sd
    CROSS JOIN reservations r
    WHERE r.tenant_id = ${tenantId}
      AND r.listing_id = ANY(${listingIds})
      AND r.created_at <= ${asOfIso}::timestamptz
      AND (r.cancelled_at IS NULL OR r.cancelled_at > ${asOfIso}::timestamptz)
      AND r.arrival <= sd.d
      AND r.departure > sd.d
      AND COALESCE(r.status, '') != 'ownerstay'
  `) as BookedRow[];
  const booked: BookedSet = new Set();
  for (const r of bookedRows) booked.add(key(r.listing_id, r.iso_date));

  // 2. Blocked-date set: per-listing dates where CalendarRate.available
  //    is false AND NOT in the booked set. Hostaway flips available=false
  //    on booked nights too, so we subtract the booked set to leave only
  //    owner-blocked / cleaning / maintenance.
  type CalRow = { listing_id: string; iso_date: string; available: boolean };
  const calRows = (await prisma.$queryRaw`
    SELECT listing_id::text AS listing_id,
           to_char(date::date, 'YYYY-MM-DD') AS iso_date,
           available
    FROM calendar_rates
    WHERE tenant_id = ${tenantId}
      AND listing_id = ANY(${listingIds})
      AND date >= ${asOfIso}::date
      AND date <= ${horizonEnd.toISOString().slice(0, 10)}::date
  `) as CalRow[];
  const blocked: BlockedSet = new Set();
  for (const r of calRows) {
    if (r.available !== false) continue;
    if (booked.has(key(r.listing_id, r.iso_date))) continue;
    blocked.add(key(r.listing_id, r.iso_date));
  }

  // 3. Per listing × month: count booked + blocked + total_days(window).
  // Iterate the union of months covered by the horizon.
  const monthKeys = new Set<MonthKey>();
  const cursor = new Date(asOf);
  while (cursor <= horizonEnd) {
    monthKeys.add(cursor.toISOString().slice(0, 7));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  for (const listingId of listingIds) {
    const listingMap = out.get(listingId)!;
    for (const monthKey of monthKeys) {
      const window = windowForMonth(monthKey, asOfIso);
      if (!window) {
        listingMap.set(monthKey, null);
        continue;
      }
      // Walk the window and count.
      let bookedCount = 0;
      let blockedCount = 0;
      const start = new Date(`${window.startIso}T00:00:00Z`);
      const end = new Date(`${window.endIso}T00:00:00Z`);
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const iso = d.toISOString().slice(0, 10);
        const k = key(listingId, iso);
        if (booked.has(k)) bookedCount += 1;
        else if (blocked.has(k)) blockedCount += 1;
      }
      const bookableInventory = window.lengthDays - blockedCount;
      const forwardOcc = bookableInventory > 0 ? bookedCount / bookableInventory : null;
      listingMap.set(monthKey, forwardOcc);
    }
  }

  return out;
}

/**
 * Pure resolver — given a loaded map and a target ISO date, return the
 * forward occupancy for the target's calendar month, or null when the
 * listing has no entry for that month (no bookable inventory or window
 * out of range).
 */
export function resolveForwardOccupancy(
  forwardOccMap: ForwardOccupancyMap,
  listingId: string,
  targetIso: IsoDate
): number | null {
  const listingMap = forwardOccMap.get(listingId);
  if (!listingMap) return null;
  const monthKey = monthKeyOf(targetIso);
  return listingMap.get(monthKey) ?? null;
}
