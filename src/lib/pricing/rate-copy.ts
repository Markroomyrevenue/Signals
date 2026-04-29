/**
 * Rate-copy pricing mode.
 *
 * The simplest possible "follow that listing" model:
 *   1. Source listing (e.g. Hostaway 514061) is the authority. Its
 *      Hostaway calendar rates are pulled into our `CalendarRate` table
 *      by the standard sync.
 *   2. Target listing (e.g. Hostaway 514009, multi-unit) copies the
 *      source's rate per-date.
 *   3. If the target is a multi-unit listing, the existing multi-unit
 *      occupancy lead-time matrix is applied on top of the copied rate.
 *      Single-unit targets just take the source rate verbatim.
 *   4. Final rate is floored at the user's minimum. Never below it.
 *   5. Min-stay (per-date) is the user's `minimumNightStay` setting,
 *      optionally overridden by an active manual override on that date.
 *
 * Per-date result is then pushed to Hostaway (rate + min-stay) by the
 * daily worker at 06:30 Europe/London.
 *
 * No peer set, no fluctuation factor, no market signal. The source
 * listing is on PriceLabs and that's what we trust.
 */

import type { PrismaClient } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { lookupMultiUnitOccupancyLeadTimeAdjustmentPct } from "@/lib/pricing/multi-unit-anchor";
import type { MultiUnitOccupancyCell } from "@/lib/pricing/multi-unit-occupancy";
import type { MultiUnitOccupancyLeadTimeMatrix } from "@/lib/pricing/settings";

export type RateCopyDailyResult = {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** Final pushable rate after occupancy multiplier + min floor. */
  rate: number;
  /** Min-stay to push to Hostaway for this date (null = don't push min-stay). */
  minStay: number | null;
  /** Source listing's live Hostaway rate for this date (the input, before our adjustments). */
  sourceRate: number;
  /** Multi-unit occupancy multiplier applied (1.0 if single-unit or no matrix data). */
  occupancyMultiplier: number;
  /** Whether the user-set min floor engaged on this date. */
  flooredAtMin: boolean;
  /** Whether this date pulled from an active manual override (rate, minStay, or both). */
  overrideApplied: { id: string; type: "fixed" | "percentage_delta"; value: number } | null;
};

export type RateCopySkipReason =
  | "no_source_rate"
  | "source_unavailable"
  | "missing_user_min"
  | "missing_target_base";

export type RateCopyByDate = Map<
  string,
  RateCopyDailyResult | { skipReason: RateCopySkipReason }
>;

function roundToIncrement(value: number, increment: number): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(increment) || increment <= 1) return Math.round(value);
  return Math.round(value / increment) * increment;
}

/**
 * Pure aggregator. The DB-backed loader (`computeRateCopyByDate`) reads
 * source CalendarRate + active overrides and calls this for unit testing.
 *
 * Per spec: rate = sourceRate × occupancyMultiplier, max(_, userMin).
 * Override layer: a fixed override REPLACES the rate (no min floor applied —
 * user's explicit choice). A percentage delta multiplies the post-multiplier
 * rate (still floored at user min). MinStay from override (if set)
 * supersedes the user-setting default.
 */
export type RateCopySourceRateRow = {
  date: string;
  rate: number | null;
  available: boolean;
};

export type RateCopyOverrideRow = {
  id: string;
  startDate: string;
  endDate: string;
  overrideType: "fixed" | "percentage_delta";
  overrideValue: number;
  minStay: number | null;
};

export type RateCopyParams = {
  sourceRates: RateCopySourceRateRow[];
  occupancyByDate?: Map<string, MultiUnitOccupancyCell> | null;
  /** When provided + occupancy data is available, applies the multi-unit lead-time × occupancy
   *  matrix per date. When null/undefined, occupancy multiplier is fixed at 1.0 (single-unit). */
  multiUnitMatrix?: MultiUnitOccupancyLeadTimeMatrix | null;
  /** Default min-stay for the target listing (from settings.minimumNightStay or listing.minNights). */
  targetDefaultMinStay: number | null;
  /** User's minimum price floor for the target. Required for any rate to be returned. */
  targetUserMin: number | null;
  /** Active manual overrides on the target listing for this calendar window. */
  overrides: RateCopyOverrideRow[];
  /** Rounding step (default 1). */
  roundingIncrement: number;
  /** Reference date for "days to check-in" used by the multi-unit matrix lookup. */
  todayDateOnly: string;
};

function findActiveOverride(
  overrides: RateCopyOverrideRow[],
  date: string
): RateCopyOverrideRow | null {
  // The supersede algorithm guarantees at most one active override per
  // (listing, date) at write time, so we just take the first match.
  for (const o of overrides) {
    if (o.startDate <= date && date <= o.endDate) return o;
  }
  return null;
}

export function computeRateCopyByDateFromRows(params: RateCopyParams): RateCopyByDate {
  const out: RateCopyByDate = new Map();
  if (params.targetUserMin === null || !Number.isFinite(params.targetUserMin) || params.targetUserMin <= 0) {
    for (const src of params.sourceRates) {
      out.set(src.date, { skipReason: "missing_user_min" });
    }
    return out;
  }

  const todayDate = fromDateOnly(params.todayDateOnly);

  for (const src of params.sourceRates) {
    if (!src.available || src.rate === null || !Number.isFinite(src.rate) || src.rate <= 0) {
      out.set(src.date, { skipReason: "no_source_rate" });
      continue;
    }
    const targetDate = fromDateOnly(src.date);
    const daysOut = Math.max(
      0,
      Math.round((targetDate.getTime() - todayDate.getTime()) / (24 * 60 * 60 * 1000))
    );

    // Multi-unit occupancy multiplier (1.0 for single-unit)
    let occupancyMultiplier = 1.0;
    if (params.multiUnitMatrix && params.occupancyByDate) {
      const occCell = params.occupancyByDate.get(src.date);
      if (occCell && occCell.unitsTotal > 0) {
        const occPct = occCell.occupancyPct;
        const adjPct = lookupMultiUnitOccupancyLeadTimeAdjustmentPct({
          matrix: params.multiUnitMatrix,
          occupancyPct: occPct,
          leadTimeDays: daysOut
        });
        if (adjPct !== null && Number.isFinite(adjPct)) {
          occupancyMultiplier = 1 + adjPct / 100;
        }
      }
    }

    let rate = src.rate * occupancyMultiplier;

    const override = findActiveOverride(params.overrides, src.date);
    let overrideApplied: RateCopyDailyResult["overrideApplied"] = null;

    if (override) {
      if (override.overrideType === "fixed") {
        rate = override.overrideValue;
        overrideApplied = { id: override.id, type: "fixed", value: override.overrideValue };
      } else {
        rate = rate * (1 + override.overrideValue);
        overrideApplied = { id: override.id, type: "percentage_delta", value: override.overrideValue };
      }
    }

    let flooredAtMin = false;
    // Fixed overrides bypass min floor by spec. Everything else respects it.
    if (override?.overrideType !== "fixed") {
      if (rate < params.targetUserMin) {
        rate = params.targetUserMin;
        flooredAtMin = true;
      }
    }

    rate = roundToIncrement(rate, params.roundingIncrement);

    // Min-stay: override.minStay if set on this date's active override; else the
    // target listing's default min-stay (from settings).
    const minStay = override?.minStay ?? params.targetDefaultMinStay;

    out.set(src.date, {
      date: src.date,
      rate,
      minStay,
      sourceRate: src.rate,
      occupancyMultiplier,
      flooredAtMin,
      overrideApplied
    });
  }
  return out;
}

/**
 * DB-backed loader: reads source listing's CalendarRate, target's active
 * overrides, and (if multi-unit) target's occupancy data. Tenant-scoped
 * by construction — every query filters by tenantId.
 */
export async function computeRateCopyByDate(params: {
  prisma: PrismaClient;
  tenantId: string;
  sourceListingId: string;
  targetListingId: string;
  fromDate: string;
  toDate: string;
  /** Multi-unit matrix from target's resolved settings. Pass null for single-unit. */
  multiUnitMatrix: MultiUnitOccupancyLeadTimeMatrix | null;
  /** Target's resolved min-stay setting (may be null). */
  targetDefaultMinStay: number | null;
  /** Target's user-set min price (basePriceOverride × 0.7 fallback handled by caller). */
  targetUserMin: number | null;
  /** Multi-unit occupancy by date (passed in by the caller, who already builds
   *  this for the calendar). null/empty for single-unit. */
  occupancyByDate: Map<string, MultiUnitOccupancyCell> | null;
  roundingIncrement: number;
  /** Defaults to today UTC. */
  todayDateOnly?: string;
}): Promise<RateCopyByDate> {
  const today = params.todayDateOnly ?? toDateOnly(new Date());
  const start = fromDateOnly(params.fromDate);
  const end = fromDateOnly(params.toDate);

  // 1. Source's CalendarRate for the window
  const sourceRows = await params.prisma.calendarRate.findMany({
    where: {
      tenantId: params.tenantId,
      listingId: params.sourceListingId,
      date: { gte: start, lte: end }
    },
    select: { date: true, rate: true, available: true }
  });

  // 2. Target's active manual overrides for the window
  const overrideRows = await params.prisma.pricingManualOverride.findMany({
    where: {
      tenantId: params.tenantId,
      listingId: params.targetListingId,
      removedAt: null,
      startDate: { lte: end },
      endDate: { gte: start }
    },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      overrideType: true,
      overrideValue: true,
      minStay: true
    }
  });

  // 3. Materialize per-date source rates over the full window so missing
  //    dates surface as "no_source_rate" rather than just absent.
  const sourceByDate = new Map<string, RateCopySourceRateRow>();
  for (const row of sourceRows) {
    const dateKey = toDateOnly(row.date);
    const rateNum = row.rate === null ? null : Number(row.rate);
    sourceByDate.set(dateKey, {
      date: dateKey,
      rate: rateNum !== null && Number.isFinite(rateNum) ? rateNum : null,
      available: row.available
    });
  }
  const sourceRates: RateCopySourceRateRow[] = [];
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    const dateKey = toDateOnly(cursor);
    sourceRates.push(sourceByDate.get(dateKey) ?? { date: dateKey, rate: null, available: false });
  }

  const overrides: RateCopyOverrideRow[] = overrideRows.map((o) => ({
    id: o.id,
    startDate: toDateOnly(o.startDate),
    endDate: toDateOnly(o.endDate),
    overrideType: o.overrideType as "fixed" | "percentage_delta",
    overrideValue: o.overrideValue,
    minStay: o.minStay
  }));

  return computeRateCopyByDateFromRows({
    sourceRates,
    occupancyByDate: params.occupancyByDate,
    multiUnitMatrix: params.multiUnitMatrix,
    targetDefaultMinStay: params.targetDefaultMinStay,
    targetUserMin: params.targetUserMin,
    overrides,
    roundingIncrement: params.roundingIncrement,
    todayDateOnly: today
  });
}
