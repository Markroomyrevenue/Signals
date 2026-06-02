/**
 * Booking-curve loader for the trial demand+occupancy redesign
 * (2026-05-26 — One Booking Curve).
 *
 * ## Why
 *
 * Two prior signals were both wrong, for the same reason: they read
 * raw forward booking data, which is lead-time-contaminated. A date
 * 90 days out has low fill because it is 90 days out, not because
 * demand is soft.
 *
 * The booking curve gives the typical forward fill at each lead time,
 * built from the tenant's (or building cluster's) own reservation
 * history. Both signals can then be judged against what's NORMAL for
 * a date that far out, not against raw fill.
 *
 * ## Grain
 *
 * Per Mark's checkpoint decision (2026-05-26): the demand signal is
 * computed at **building / cluster grain** (group: tag), not tenant-
 * wide. Tenant-wide aggregation dilutes building-level events into
 * "neutral." For Castle Buildings late-June: tenant-wide read -2% to
 * -13% pace (missed); building-grain reads +43% to +71% (caught).
 *
 * This module builds:
 *   - One curve per tenant (always).
 *   - One curve per `group:` tag that has ≥ `CURVE_MIN_GROUP_SIZE`
 *     single-unit listings AND ≥ `CURVE_MIN_OBSERVATIONS_PER_LEAD`
 *     observations per lead time. Below either threshold the group
 *     gets no curve and listings in it fall back to the tenant curve.
 *
 * ## Lead-time range
 *
 * Curve anchors at [0, 7, 14, 21, 28, 35, 42, 56, 70, 84, 98, 112,
 * 126, 154, 182, 210, 238] days. Covers the full 0-238d range
 * directly; pace queries between anchors interpolate linearly.
 * Cells beyond 238d clamp to curve[238].
 *
 * Per Mark's curve-extension decision: curve runs to 270d effective,
 * NOT clamped at 126d. We have the history (≥2 years of reservations
 * in trial tenants); the SQL just costs a bit more.
 *
 * ## Low-curve guard
 *
 * Per Mark: where the curve value is very low (deep far-future), the
 * pace ratio is unstable — small absolute differences blow up. When
 * `curve[L] < CURVE_LOW_VALUE_GUARD`, `computePaceDelta` returns null
 * so the demand multiplier falls back to its existing null-input
 * neutral path. The calendar/holiday layer continues to drive
 * far-future cells (Phase C demand fix, 2026-05-24).
 *
 * ## Trial-only
 *
 * Consumed only by the trial pricing-comparison agent. Production
 * paths untouched.
 */

import { prisma } from "@/lib/prisma";

// Lead-time anchors used for curve construction. Linear interpolation
// between anchors gives values at any lead time within the range.
// Beyond 238d we clamp to curve[238] (cells in [238, 270] rarely
// have stable data even on the curve itself).
export const CURVE_LEAD_TIMES = [
  0, 7, 14, 21, 28, 35, 42, 56, 70, 84, 98, 112, 126, 154, 182, 210, 238
] as const;

/**
 * Below this curve value the pace ratio is unstable — small absolute
 * differences blow up. `computePaceDelta` returns null at this depth.
 *
 * Calibrated 2026-05-26 PM after the first Phase-B verification run:
 * with the guard at 0.05, 91-180d cells (LF curve ~14-20% at those
 * leads) passed through the pace_delta computation and the +small
 * deltas divided by the small curve value inflated demand sharply
 * positive (overall mean Δ vs PL flipped from -1.2% to +12.6% on
 * 91-180d, n=2236). 0.15 returns near neutral on 91-180d cells (where
 * the curve is shallowest) while preserving the signal on 0-90d
 * cells where curve values sit comfortably above the threshold (LF
 * 14d = 69%, 56d = 41%, 84d = 30%).
 */
export const CURVE_LOW_VALUE_GUARD = 0.15;

/**
 * A group: tag must cover at least this many single-unit listings to
 * justify its own curve. Below: listings in the group fall back to
 * the tenant curve.
 */
export const CURVE_MIN_GROUP_SIZE = 3;

/**
 * A group: tag's curve must accumulate at least this many observations
 * per lead time anchor to be considered stable. Below: fall back to
 * tenant curve.
 */
export const CURVE_MIN_OBSERVATIONS_PER_LEAD = 500;

/**
 * Per-DoW partition — minimum observations per (DoW × lead-time anchor)
 * required to use the DoW-specific curve value. Below this gate the
 * lookup falls back to the all-DoW aggregate curve value for that
 * anchor (which the DoW multiplier in the daily-rate stack already
 * carries the level pattern for).
 *
 * Calibrated 2026-05-27: with 365d of history each DoW gets ~52
 * observations per listing per lead anchor; for a 9-listing group
 * (Castle Buildings) that's ~468 — sits just below the all-DoW gate
 * (500) when split 7 ways. The per-DoW gate at 300 lets Castle
 * Buildings keep its per-DoW curve. For thinner grains the lookup
 * falls back to the all-DoW value, and the DoW multiplier carries
 * the weekly pattern.
 */
export const CURVE_MIN_OBSERVATIONS_PER_LEAD_DOW = 300;

/**
 * Historical stay-date window used to build the curve.
 * 395 → 30 days ago = ~1 year of past stays, leaving a 30-day buffer
 * so very recent dates with not-yet-finalised bookings don't bias the curve.
 */
const HISTORICAL_WINDOW_START_DAYS_AGO = 395;
const HISTORICAL_WINDOW_END_DAYS_AGO = 30;

export type BookingCurve = {
  /** lead_time_days → expected fill fraction (0..1). All-DoW aggregate. */
  values: Map<number, number>;
  /** Observations per lead time anchor (sanity / diagnostic). All-DoW. */
  observations: Map<number, number>;
  /**
   * Per-DoW partition (2026-05-27 spec). Key 1: DoW (0=Sun … 6=Sat,
   * JS UTC day numbering). Key 2: lead-time anchor. Value: expected
   * fill at that (DoW, lead) pair. Built alongside the all-DoW
   * aggregate at no extra SQL cost.
   *
   * The per-cell lookup (`lookupCurveValue`) checks the DoW entry
   * first; falls back to the all-DoW aggregate when per-DoW
   * observations are below `CURVE_MIN_OBSERVATIONS_PER_LEAD_DOW`.
   */
  valuesByDow: Map<number, Map<number, number>>;
  /** Observations per (DoW × lead) anchor — gates the per-DoW lookup. */
  observationsByDow: Map<number, Map<number, number>>;
  /** Grain key — "tenant:<id>" or "group:<tag>". */
  grain: string;
  /** Number of single-unit listings that contributed to this curve. */
  listingCount: number;
  /** The actual listing IDs in this grain — used to compute grain-level forward fill per target date. */
  listingIds: string[];
};

export type BookingCurves = {
  tenantCurves: Map<string, BookingCurve>;
  /** group: tag → curve (only present when sample size justifies). */
  groupCurves: Map<string, BookingCurve>;
};

type ReservationCell = { createdAtIso: string; cancelledAtIso: string | null };

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function eachIso(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const s = new Date(`${startIso}T00:00:00Z`);
  const e = new Date(`${endIso}T00:00:00Z`);
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Per-(listing, date) list of reservations that COVER that date.
 * Pulled once per (tenant, listing set, window); cell membership is
 * O(1) lookup afterwards.
 */
async function buildReservationCellIndex(
  tenantId: string,
  listingIds: string[],
  windowStartIso: string,
  windowEndIso: string
): Promise<Map<string, ReservationCell[]>> {
  const rows = await prisma.$queryRaw<Array<{
    listing_id: string;
    arrival: Date;
    departure: Date;
    created_at: Date;
    cancelled_at: Date | null;
  }>>`
    SELECT listing_id::text, arrival, departure, created_at, cancelled_at
    FROM reservations
    WHERE tenant_id = ${tenantId}
      AND listing_id = ANY(${listingIds})
      AND arrival <= ${windowEndIso}::date
      AND departure > ${windowStartIso}::date
      AND COALESCE(status, '') != 'ownerstay'
  `;
  const out = new Map<string, ReservationCell[]>();
  for (const r of rows) {
    const ar = r.arrival.toISOString().slice(0, 10);
    const dep = r.departure.toISOString().slice(0, 10);
    for (const iso of eachIso(ar, isoMinusDays(dep, 1))) {
      if (iso < windowStartIso || iso > windowEndIso) continue;
      const k = `${r.listing_id}|${iso}`;
      const cell = out.get(k) ?? [];
      cell.push({
        createdAtIso: r.created_at.toISOString().slice(0, 10),
        cancelledAtIso: r.cancelled_at ? r.cancelled_at.toISOString().slice(0, 10) : null
      });
      out.set(k, cell);
    }
  }
  return out;
}

function bookedAtObservation(cell: ReservationCell[] | undefined, observedAtIso: string): boolean {
  if (!cell) return false;
  for (const r of cell) {
    if (r.createdAtIso > observedAtIso) continue;
    if (r.cancelledAtIso !== null && r.cancelledAtIso <= observedAtIso) continue;
    return true;
  }
  return false;
}

/**
 * Build a curve for a specific set of listings (tenant or group).
 * Returns null when the set is empty or observations per lead are
 * insufficient.
 */
async function buildCurveForListingSet(args: {
  tenantId: string;
  listingIds: string[];
  asOfIso: string;
  grain: string;
}): Promise<BookingCurve | null> {
  const { tenantId, listingIds, asOfIso, grain } = args;
  if (listingIds.length === 0) return null;

  const historyStart = isoMinusDays(asOfIso, HISTORICAL_WINDOW_START_DAYS_AGO);
  const historyEnd = isoMinusDays(asOfIso, HISTORICAL_WINDOW_END_DAYS_AGO);
  const indexStart = isoMinusDays(historyStart, Math.max(...CURVE_LEAD_TIMES) + 30);
  const cellIndex = await buildReservationCellIndex(tenantId, listingIds, indexStart, historyEnd);
  const historicalDates = eachIso(historyStart, historyEnd);

  const values = new Map<number, number>();
  const observations = new Map<number, number>();
  // 2026-05-27 per-DoW partition: at each lead anchor, also accumulate
  // per (DoW × lead) so the cross-sectional pace signal compares
  // Friday-to-Friday-curve etc. instead of Friday-to-all-DoW-mean.
  const valuesByDow = new Map<number, Map<number, number>>();
  const observationsByDow = new Map<number, Map<number, number>>();
  for (let d = 0; d < 7; d++) {
    valuesByDow.set(d, new Map());
    observationsByDow.set(d, new Map());
  }

  for (const lead of CURVE_LEAD_TIMES) {
    let bookedAll = 0;
    let observedAll = 0;
    const bookedDow = [0, 0, 0, 0, 0, 0, 0];
    const observedDow = [0, 0, 0, 0, 0, 0, 0];
    for (const listingId of listingIds) {
      for (const stayIso of historicalDates) {
        const observedAtIso = isoMinusDays(stayIso, lead);
        if (observedAtIso < indexStart) continue;
        const dow = new Date(`${stayIso}T00:00:00Z`).getUTCDay();
        observedAll += 1;
        observedDow[dow] += 1;
        if (bookedAtObservation(cellIndex.get(`${listingId}|${stayIso}`), observedAtIso)) {
          bookedAll += 1;
          bookedDow[dow] += 1;
        }
      }
    }
    values.set(lead, observedAll > 0 ? bookedAll / observedAll : 0);
    observations.set(lead, observedAll);
    for (let d = 0; d < 7; d++) {
      valuesByDow.get(d)!.set(lead, observedDow[d] > 0 ? bookedDow[d] / observedDow[d] : 0);
      observationsByDow.get(d)!.set(lead, observedDow[d]);
    }
  }

  return { values, observations, valuesByDow, observationsByDow, grain, listingCount: listingIds.length, listingIds: [...listingIds] };
}

/**
 * Load tenant + group curves for a single tenant. Per Mark's
 * checkpoint: build a curve per group: tag where the sample size
 * justifies; fall back to tenant otherwise. Tenant curve is always
 * built.
 */
export async function loadBookingCurvesForTenant(args: {
  tenantId: string;
  asOfIso: string;
}): Promise<BookingCurves> {
  const { tenantId, asOfIso } = args;
  const out: BookingCurves = { tenantCurves: new Map(), groupCurves: new Map() };

  // All single-unit listings on this tenant.
  const listings = await prisma.listing.findMany({
    where: { tenantId, status: { not: "inactive" }, removedAt: null },
    select: { id: true, tags: true, unitCount: true }
  });
  const singleUnit = listings.filter((l) => (l.unitCount ?? 1) < 2);

  // Tenant curve — always.
  const tenantCurve = await buildCurveForListingSet({
    tenantId,
    listingIds: singleUnit.map((l) => l.id),
    asOfIso,
    grain: `tenant:${tenantId}`
  });
  if (tenantCurve) out.tenantCurves.set(tenantId, tenantCurve);

  // Per-group curves — collect every group: tag and the listings that have it.
  const groupToListings = new Map<string, string[]>();
  for (const l of singleUnit) {
    const groupTags = (l.tags ?? []).filter((t) => t.toLowerCase().startsWith("group:"));
    for (const tag of groupTags) {
      const arr = groupToListings.get(tag) ?? [];
      arr.push(l.id);
      groupToListings.set(tag, arr);
    }
  }

  for (const [tag, ids] of groupToListings) {
    if (ids.length < CURVE_MIN_GROUP_SIZE) continue;
    const curve = await buildCurveForListingSet({
      tenantId,
      listingIds: ids,
      asOfIso,
      grain: `group:${tag}`
    });
    if (!curve) continue;
    // Observations-per-lead gate: all anchors must clear the threshold.
    const minObs = Math.min(...Array.from(curve.observations.values()));
    if (minObs < CURVE_MIN_OBSERVATIONS_PER_LEAD) continue;
    out.groupCurves.set(tag, curve);
  }

  return out;
}

/**
 * Resolve which curve a listing should use for demand. Tries group: tags
 * in order of smallest-sibling-pool first (most specific). Falls back
 * to tenant curve.
 *
 * The "smallest sibling pool" heuristic is the same as `agent.ts`
 * comp-anchor selection — most specific tag wins. Listings without
 * any group: tag (or whose group tags didn't make a curve) use the
 * tenant curve.
 */
export function resolveBookingCurveForListing(args: {
  tenantId: string;
  tags: string[];
  curves: BookingCurves;
}): BookingCurve | null {
  const groupTags = (args.tags ?? []).filter((t) => t.toLowerCase().startsWith("group:"));
  // Find candidate group curves the listing belongs to, ordered by
  // listingCount (smallest first = most specific).
  const candidates: BookingCurve[] = [];
  for (const tag of groupTags) {
    const c = args.curves.groupCurves.get(tag);
    if (c) candidates.push(c);
  }
  candidates.sort((a, b) => a.listingCount - b.listingCount);
  if (candidates.length > 0) return candidates[0];
  return args.curves.tenantCurves.get(args.tenantId) ?? null;
}

function interpolate(anchors: Array<[number, number]>, leadDays: number): number {
  if (anchors.length === 0) return 0;
  if (leadDays <= anchors[0][0]) return anchors[0][1];
  if (leadDays >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [lLo, vLo] = anchors[i];
    const [lHi, vHi] = anchors[i + 1];
    if (leadDays >= lLo && leadDays <= lHi) {
      const t = (leadDays - lLo) / (lHi - lLo);
      return vLo + (vHi - vLo) * t;
    }
  }
  return anchors[anchors.length - 1][1];
}

/**
 * Linear interpolation between curve anchors. Lead values beyond the
 * last anchor clamp to that anchor's value (cells in [maxAnchor,
 * 270] rarely have stable absolute fill on the curve either).
 *
 * 2026-05-27 — `dow` parameter (optional). When supplied AND the per-
 * DoW observations at the nearest anchors clear
 * `CURVE_MIN_OBSERVATIONS_PER_LEAD_DOW`, the lookup reads the DoW-
 * specific curve. Otherwise (or when dow omitted) it falls back to
 * the all-DoW aggregate. The DoW multiplier in the daily-rate stack
 * carries the level pattern when the per-DoW fallback fires.
 */
export function lookupCurveValue(curve: BookingCurve, leadDays: number, dow?: number): {
  value: number;
  source: "dow" | "all-dow";
} {
  if (dow !== undefined && Number.isInteger(dow) && dow >= 0 && dow <= 6) {
    const dowAnchors = Array.from((curve.valuesByDow.get(dow) ?? new Map()).entries()).sort((a, b) => a[0] - b[0]);
    const dowObs = curve.observationsByDow.get(dow) ?? new Map();
    // Use per-DoW IF the nearest two anchors both clear the gate.
    // Simple check: the DoW-side has all anchors above the gate.
    if (dowAnchors.length > 0) {
      const minObs = Math.min(...Array.from(dowObs.values()) as number[]);
      if (minObs >= CURVE_MIN_OBSERVATIONS_PER_LEAD_DOW) {
        return { value: interpolate(dowAnchors as Array<[number, number]>, leadDays), source: "dow" };
      }
    }
  }
  const allAnchors = Array.from(curve.values.entries()).sort((a, b) => a[0] - b[0]);
  return { value: interpolate(allAnchors as Array<[number, number]>, leadDays), source: "all-dow" };
}

/**
 * Pace-vs-curve delta with the low-curve guard. Returns null when the
 * curve value is below CURVE_LOW_VALUE_GUARD — the ratio is unstable
 * at that depth and the upstream demand multiplier should fall back
 * to its null-input neutral path (the calendar/holiday layer takes
 * far-future cells from there).
 */
export function computePaceDelta(args: {
  actualFill: number;
  curveValue: number;
}): { delta: number | null; guardFired: boolean } {
  if (!Number.isFinite(args.actualFill) || !Number.isFinite(args.curveValue)) {
    return { delta: null, guardFired: false };
  }
  if (args.curveValue < CURVE_LOW_VALUE_GUARD) {
    return { delta: null, guardFired: true };
  }
  return { delta: (args.actualFill - args.curveValue) / args.curveValue, guardFired: false };
}

export type GrainForwardFill = {
  /** grain key — same shape as BookingCurve.grain */
  grain: string;
  /** date → bookedListings / totalListings */
  byDate: Map<string, { booked: number; total: number; fill: number }>;
};

/**
 * Per-(grain, date) forward fill — booked listings out of the grain's
 * total, observed as of `asOfIso`, for stay dates in [fromIso, toIso].
 *
 * One SQL aggregate per grain per tenant per run. The agent calls
 * this once per grain that has a curve; per-cell lookups are then
 * O(1) Map.get().
 *
 * Active-reservation filter matches `loadPortfolioForwardFill` and the
 * curve construction — same definition of "booked" everywhere.
 */
export async function loadGrainForwardFill(args: {
  tenantId: string;
  grain: string;
  listingIds: string[];
  asOfIso: string;
  fromIso: string;
  toIso: string;
}): Promise<GrainForwardFill> {
  const { tenantId, grain, listingIds, asOfIso, fromIso, toIso } = args;
  const byDate = new Map<string, { booked: number; total: number; fill: number }>();
  if (listingIds.length === 0) return { grain, byDate };

  const rows = (await prisma.$queryRaw`
    WITH stay_dates AS (
      SELECT generate_series(${fromIso}::date, ${toIso}::date, '1 day'::interval)::date AS d
    )
    SELECT sd.d::text AS stay_date,
           COUNT(DISTINCT (r.listing_id || sd.d::text))::int AS booked_listings
    FROM stay_dates sd
    LEFT JOIN reservations r
      ON r.tenant_id = ${tenantId}
     AND r.listing_id = ANY(${listingIds})
     AND r.created_at <= ${asOfIso}::timestamptz
     AND (r.cancelled_at IS NULL OR r.cancelled_at > ${asOfIso}::timestamptz)
     AND r.arrival <= sd.d
     AND r.departure > sd.d
     AND COALESCE(r.status, '') != 'ownerstay'
    GROUP BY sd.d
    ORDER BY sd.d
  `) as Array<{ stay_date: string; booked_listings: number }>;

  for (const r of rows) {
    const booked = r.booked_listings ?? 0;
    const total = listingIds.length;
    byDate.set(r.stay_date, { booked, total, fill: total > 0 ? booked / total : 0 });
  }
  return { grain, byDate };
}

/**
 * Per-cell pace resolver — given a listing's grain curve + the
 * pre-loaded grain forward fill + target date + snapshot date,
 * compute the pace_delta for the demand multiplier.
 *
 * Returns:
 *   - `delta`: the pace ratio (positive = ahead of curve = demand up)
 *   - `guardFired`: true when curve[L] < CURVE_LOW_VALUE_GUARD →
 *     pace_delta is null and the multiplier should fall back to
 *     null-input neutral
 *   - `actualFill` + `curveValue`: surfaced for the trial report so
 *     Mark can see what each cell was computed against
 */
export function resolvePaceDelta(args: {
  curve: BookingCurve | null;
  grainFill: GrainForwardFill | null;
  targetIso: string;
  asOfIso: string;
}): {
  delta: number | null;
  guardFired: boolean;
  actualFill: number | null;
  curveValue: number | null;
  curveSource: "dow" | "all-dow" | null;
  leadDays: number;
} {
  const leadDays = Math.round(
    (new Date(`${args.targetIso}T00:00:00Z`).getTime() - new Date(`${args.asOfIso}T00:00:00Z`).getTime()) / 86400000
  );
  if (!args.curve || !args.grainFill) {
    return { delta: null, guardFired: false, actualFill: null, curveValue: null, curveSource: null, leadDays };
  }
  const cell = args.grainFill.byDate.get(args.targetIso);
  if (!cell) {
    return { delta: null, guardFired: false, actualFill: null, curveValue: null, curveSource: null, leadDays };
  }
  // 2026-05-27 — feed the target's DoW so the lookup picks the per-DoW
  // curve where the sample-size gate clears. Pace now compares this
  // Friday's fill to the Friday curve, not the all-DoW mean.
  const targetDow = new Date(`${args.targetIso}T00:00:00Z`).getUTCDay();
  const { value: curveValue, source: curveSource } = lookupCurveValue(args.curve, leadDays, targetDow);
  const r = computePaceDelta({ actualFill: cell.fill, curveValue });
  return { delta: r.delta, guardFired: r.guardFired, actualFill: cell.fill, curveValue, curveSource, leadDays };
}
