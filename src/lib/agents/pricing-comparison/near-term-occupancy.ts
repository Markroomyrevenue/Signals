/**
 * Per-listing near-term forward fill — feeds the trial occupancy
 * multiplier ladder (2026-05-26 redesign, Mark's checkpoint decision).
 *
 * ## Why this exists (and why it's separate from booking-curve.ts)
 *
 * The 2026-05-26 demand+occupancy redesign split the signals into two
 * distinct ones:
 *
 *   - **Demand** (booking-curve.ts) — tenant or building-grain pace
 *     vs the curve; date-level signal; ALL lead times.
 *   - **Occupancy** (THIS FILE) — per-listing remaining-inventory
 *     scarcity in the NEAR-TERM window; only fires when the target
 *     date sits within `OCCUPANCY_NEAR_TERM_LEAD_DAYS` (14d).
 *
 * The previous occupancy attempt (commit 6dd7665, reverted) fed raw
 * forward occupancy at the target date's calendar-month grain — that
 * was lead-time-contaminated (months 6+ out are structurally empty,
 * lead time not demand). It discounted the whole forward book; the
 * within-±10% KPI went 23% → 20% live.
 *
 * The lead-time gate (≤14d) avoids the contamination at source: in
 * the next 14 days, the listing's fill IS its scarcity signal. There
 * is no curve normalisation here on purpose — the curve at L≤14 is
 * itself ~65-83% (LF tenant), which would compress the signal range.
 * Raw fill is the right input near check-in.
 *
 * ## Definition
 *
 *   - Window = `[asOfIso, asOfIso + OCCUPANCY_NEAR_TERM_LEAD_DAYS]`.
 *   - Per listing: count of distinct dates in the window where an
 *     active reservation covers the date (same active-reservation
 *     filter as cross-sectional-demand.ts + booking-curve.ts).
 *   - `nearTermFill = bookedCount / window_length_days`.
 *
 * Window length is fixed (the same 14-day window for every cell with
 * lead ≤ 14d), not centered on the target. Operating intent: "how
 * booked am I for the next two weeks?" — that's the listing-level
 * scarcity signal the ladder rewards.
 *
 * ## When to apply
 *
 * Agent passes `scopeOccupancy = nearTermFill` ONLY when target
 * leadDays ≤ OCCUPANCY_NEAR_TERM_LEAD_DAYS; otherwise null. The
 * downstream `lookupTrialOccupancyMultiplier` returns multiplier 1.0
 * on null input (yield-neutral). `computeLeadTimeFloor`'s
 * propertyOccLow gate also handles null gracefully (returns false →
 * floor doesn't engage).
 *
 * Trial-only.
 */

import { prisma } from "@/lib/prisma";

/**
 * Target date's lead time threshold for the occupancy multiplier to
 * activate. Beyond this the multiplier is neutral 1.0 — yield is the
 * demand signal's job at long lead, not occupancy's. Matches Mark's
 * "late signal" framing.
 */
export const OCCUPANCY_NEAR_TERM_LEAD_DAYS = 14;

/**
 * Map of listingId → near-term forward fill (0..1).
 * `null` when the window has no bookable inventory (or listing has
 * no reservation data); downstream ladder treats this as neutral.
 */
export type NearTermOccupancyMap = Map<string, number | null>;

/**
 * Load per-listing forward fill for the next OCCUPANCY_NEAR_TERM_LEAD_DAYS
 * for the tenant's single-unit listings. Single SQL aggregate per
 * tenant per run.
 */
export async function loadNearTermOccupancyForTenant(args: {
  tenantId: string;
  listingIds: string[];
  asOfIso: string;
}): Promise<NearTermOccupancyMap> {
  const { tenantId, listingIds, asOfIso } = args;
  const out: NearTermOccupancyMap = new Map();
  for (const id of listingIds) out.set(id, null);
  if (listingIds.length === 0) return out;

  const asOf = new Date(`${asOfIso}T00:00:00Z`);
  const windowEnd = new Date(asOf);
  windowEnd.setUTCDate(asOf.getUTCDate() + OCCUPANCY_NEAR_TERM_LEAD_DAYS);
  const windowEndIso = windowEnd.toISOString().slice(0, 10);

  type Row = { listing_id: string; booked_days: number };
  const rows = (await prisma.$queryRaw`
    WITH stay_dates AS (
      SELECT generate_series(${asOfIso}::date, ${windowEndIso}::date, '1 day'::interval)::date AS d
    )
    SELECT r.listing_id::text AS listing_id,
           COUNT(DISTINCT sd.d)::int AS booked_days
    FROM stay_dates sd
    JOIN reservations r
      ON r.tenant_id = ${tenantId}
     AND r.listing_id = ANY(${listingIds})
     AND r.created_at <= ${asOfIso}::timestamptz
     AND (r.cancelled_at IS NULL OR r.cancelled_at > ${asOfIso}::timestamptz)
     AND r.arrival <= sd.d
     AND r.departure > sd.d
     AND COALESCE(r.status, '') != 'ownerstay'
    GROUP BY r.listing_id
  `) as Row[];

  for (const r of rows) {
    out.set(r.listing_id, r.booked_days / OCCUPANCY_NEAR_TERM_LEAD_DAYS);
  }
  return out;
}

/**
 * Pure resolver — given a loaded map + a target ISO + the snapshot
 * date, return the scopeOccupancy value to feed the multiplier.
 * Returns null when target lead is beyond the near-term threshold
 * (multiplier falls through to neutral 1.0).
 */
export function resolveNearTermOccupancy(args: {
  map: NearTermOccupancyMap;
  listingId: string;
  targetIso: string;
  asOfIso: string;
}): number | null {
  const leadDays = Math.round(
    (new Date(`${args.targetIso}T00:00:00Z`).getTime() - new Date(`${args.asOfIso}T00:00:00Z`).getTime()) / 86400000
  );
  if (leadDays < 0 || leadDays > OCCUPANCY_NEAR_TERM_LEAD_DAYS) return null;
  return args.map.get(args.listingId) ?? null;
}
