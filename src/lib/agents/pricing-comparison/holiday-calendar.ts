/**
 * Recurring-holiday demand calendar — NI public holidays for the trial.
 *
 * **Why this exists (2026-05-24, overnight demand-horizon fix):**
 *
 * The cross-sectional pace signal in `cross-sectional-demand.ts` requires
 * a dense enough peer set to produce a stable ratio. Beyond ~120 days
 * out, portfolio fill on most dates is single-digit percent, the
 * peer-median denominator shrinks toward zero, and the
 * `target_fill / peer_median_fill - 1` ratio swings to the rails on
 * trivial absolute fluctuations (target with 2 nights vs peer median 1
 * night = +100% delta → pinned at +40% ceiling). The Phase B
 * `DEMAND_PACE_MIN_PEER_FILL` gate drops the pace signal to null on
 * those cells so the demand multiplier falls back to neutral.
 *
 * Phase C fills the resulting hole for KNOWN demand-bearing dates: NI
 * public holidays. Christmas / Boxing Day / NYE / the Twelfth /
 * August bank holiday weekend / etc. are predictable demand events
 * whose effect we can MEASURE from own booked history rather than
 * INFER from pace on an empty forward book.
 *
 * ## Sizing
 *
 * For each date-type (e.g. "christmas_period"):
 *   - Collect own NightFact rows over the past 730 days that fall
 *     inside the date-type's window across the past 2 occurrences.
 *   - Compute portfolio per-available-night revenue (RPAN) on those
 *     dates: `sum(revenue) / (supply × distinct_dates)`.
 *   - Do the same for "normal" comparison dates in the same calendar
 *     period (e.g. for Christmas: November / January excluding all
 *     other holiday windows).
 *   - Multiplier = RPAN(holiday) / RPAN(normal).
 *
 * RPAN is occupancy-adjusted by construction (revenue includes only
 * occupied nights; the denominator is total available supply-nights).
 *
 * **Relative-to-period** so the multiplier stacks on seasonality
 * without double-counting: comparing Christmas-period RPAN to other
 * winter-period RPAN cancels out the underlying winter seasonality.
 *
 * **Direction-agnostic** — we learn from data. Some holidays are
 * SOFT for city STR (Christmas Day itself often is — people stay
 * home, not in Airbnb). The cap is symmetric:
 * `[1 - HOLIDAY_DELTA_CAP, 1 + HOLIDAY_DELTA_CAP]`.
 *
 * ## Thin-sample guard
 *
 * 730 days of history → ~2 past occurrences of each annual holiday →
 * potentially ~6-10 booked-night data points per date-type. Below
 * `HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE` we fall back to
 * `HOLIDAY_DEFAULT_DELTA` (modest known-event lift) rather than a
 * wild learned number.
 *
 * ## Horizon handoff
 *
 * `computeDemandMultiplier` (trial-pricing.ts) takes a new optional
 * `calendarFallbackDelta` input. When the pace signals are both
 * gated out (Phase B sufficiency gate fired), the calendar delta
 * takes over. When pace has data, calendar is IGNORED — no
 * multiplicative double-count. The gate IS the switch.
 *
 * ## Source for NI public holidays
 *
 * Hardcoded from the UK government's official list
 * (https://www.gov.uk/bank-holidays — Northern Ireland tab) for
 * 2025/2026/2027. Coverage spans the trial window plus a year either
 * side so the date-type windows always have past occurrences to
 * learn from.
 *
 * ## Trial-only
 *
 * This file lives under `agents/pricing-comparison/` and is consumed
 * only by `agent.ts` (the trial pricing-comparison agent). Same
 * scope rule as `trial-events.ts`: cannot reach customer-facing
 * pricing under any code path.
 */

import { prisma } from "@/lib/prisma";

/** Symmetric cap on every learned holiday multiplier — modest by design. */
export const HOLIDAY_DELTA_CAP = 0.20;

/**
 * Below this number of booked-night data points across the past 2
 * occurrences of a date-type, we fall back to HOLIDAY_DEFAULT_DELTA
 * rather than trust a wild learned number.
 */
export const HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE = 8;

/**
 * Default delta when the learned signal is thin. Small positive lift
 * — known holiday demand exists even when we can't measure it
 * precisely — but tiny enough to never dominate. +5%.
 */
export const HOLIDAY_DEFAULT_DELTA = 0.05;

/** Trailing window for learning per-date-type multipliers (days). */
const LEARNING_WINDOW_DAYS = 730;

export type HolidayDateType =
  | "christmas_period"
  | "nye_period"
  | "twelfth"
  | "summer_bank_hol"
  | "may_early_bank_hol"
  | "may_spring_bank_hol"
  | "st_pats"
  | "easter_weekend";

/** A date range that belongs to a particular holiday date-type. */
export type HolidayPeriod = {
  dateType: HolidayDateType;
  startIso: string; // inclusive
  endIso: string; // inclusive
  /** Display name for the report. */
  label: string;
};

/**
 * NI public-holiday windows over the trial horizon. Each window covers
 * the demand-bearing days for a single occurrence of the date-type —
 * generally a long weekend (Sat-Mon) around a bank-holiday Monday,
 * or the actual cluster of dates around Christmas / NYE.
 *
 * Source: UK gov NI bank holidays, manually expanded to STR-relevant
 * windows (a bank-holiday Monday by itself does little for city STR
 * — it's the Sat/Sun/Mon long weekend that drives nights on the books).
 *
 * Updated 2026-05-24. Re-check yearly against the official list when
 * the trial-window crosses a new year boundary.
 */
export const NI_HOLIDAY_PERIODS: HolidayPeriod[] = [
  // ---- 2024 occurrences (for learning the multiplier from the 730d window) ----
  { dateType: "may_early_bank_hol", startIso: "2024-05-04", endIso: "2024-05-06", label: "Early May Bank Holiday (NI) 2024" },
  { dateType: "may_spring_bank_hol", startIso: "2024-05-25", endIso: "2024-05-27", label: "Spring Bank Holiday (NI) 2024" },
  { dateType: "twelfth", startIso: "2024-07-12", endIso: "2024-07-13", label: "Battle of the Boyne (NI) 2024" },
  { dateType: "summer_bank_hol", startIso: "2024-08-24", endIso: "2024-08-26", label: "August Bank Holiday (NI) 2024" },
  { dateType: "st_pats", startIso: "2024-03-16", endIso: "2024-03-18", label: "St Patrick's Day (NI) 2024" },
  { dateType: "easter_weekend", startIso: "2024-03-29", endIso: "2024-04-01", label: "Easter Weekend (NI) 2024" },
  { dateType: "christmas_period", startIso: "2024-12-24", endIso: "2024-12-26", label: "Christmas (NI) 2024" },
  { dateType: "nye_period", startIso: "2024-12-30", endIso: "2025-01-01", label: "NYE/NYD (NI) 2024-2025" },
  // ---- 2025 occurrences ----
  { dateType: "st_pats", startIso: "2025-03-15", endIso: "2025-03-17", label: "St Patrick's Day (NI) 2025" },
  { dateType: "easter_weekend", startIso: "2025-04-18", endIso: "2025-04-21", label: "Easter Weekend (NI) 2025" },
  { dateType: "may_early_bank_hol", startIso: "2025-05-03", endIso: "2025-05-05", label: "Early May Bank Holiday (NI) 2025" },
  { dateType: "may_spring_bank_hol", startIso: "2025-05-24", endIso: "2025-05-26", label: "Spring Bank Holiday (NI) 2025" },
  { dateType: "twelfth", startIso: "2025-07-12", endIso: "2025-07-14", label: "Battle of the Boyne (NI) 2025" },
  { dateType: "summer_bank_hol", startIso: "2025-08-23", endIso: "2025-08-25", label: "August Bank Holiday (NI) 2025" },
  { dateType: "christmas_period", startIso: "2025-12-24", endIso: "2025-12-26", label: "Christmas (NI) 2025" },
  { dateType: "nye_period", startIso: "2025-12-30", endIso: "2026-01-01", label: "NYE/NYD (NI) 2025-2026" },
  // ---- 2026 occurrences (the trial pricing horizon — primary targets) ----
  { dateType: "st_pats", startIso: "2026-03-16", endIso: "2026-03-18", label: "St Patrick's Day (NI) 2026" },
  { dateType: "easter_weekend", startIso: "2026-04-03", endIso: "2026-04-06", label: "Easter Weekend (NI) 2026" },
  { dateType: "may_early_bank_hol", startIso: "2026-05-02", endIso: "2026-05-04", label: "Early May Bank Holiday (NI) 2026" },
  { dateType: "may_spring_bank_hol", startIso: "2026-05-23", endIso: "2026-05-25", label: "Spring Bank Holiday (NI) 2026" },
  { dateType: "twelfth", startIso: "2026-07-11", endIso: "2026-07-13", label: "Battle of the Boyne (NI) 2026" },
  { dateType: "summer_bank_hol", startIso: "2026-08-29", endIso: "2026-08-31", label: "August Bank Holiday (NI) 2026" },
  { dateType: "christmas_period", startIso: "2026-12-24", endIso: "2026-12-26", label: "Christmas (NI) 2026" },
  { dateType: "nye_period", startIso: "2026-12-30", endIso: "2027-01-01", label: "NYE/NYD (NI) 2026-2027" },
  // ---- 2027 occurrences (forward edge of the horizon) ----
  { dateType: "st_pats", startIso: "2027-03-16", endIso: "2027-03-18", label: "St Patrick's Day (NI) 2027" },
  { dateType: "easter_weekend", startIso: "2027-03-26", endIso: "2027-03-29", label: "Easter Weekend (NI) 2027" },
  { dateType: "may_early_bank_hol", startIso: "2027-05-01", endIso: "2027-05-03", label: "Early May Bank Holiday (NI) 2027" },
  { dateType: "may_spring_bank_hol", startIso: "2027-05-29", endIso: "2027-05-31", label: "Spring Bank Holiday (NI) 2027" },
  { dateType: "twelfth", startIso: "2027-07-10", endIso: "2027-07-12", label: "Battle of the Boyne (NI) 2027" },
  { dateType: "summer_bank_hol", startIso: "2027-08-28", endIso: "2027-08-30", label: "August Bank Holiday (NI) 2027" },
  { dateType: "christmas_period", startIso: "2027-12-24", endIso: "2027-12-26", label: "Christmas (NI) 2027" },
  { dateType: "nye_period", startIso: "2027-12-30", endIso: "2028-01-01", label: "NYE/NYD (NI) 2027-2028" }
];

/**
 * Learned per-date-type demand factor for one tenant. `delta` is the
 * raw measured multiplier minus 1 (e.g. +0.15 means +15% over the
 * relative-period baseline). `samples` is the number of booked-night
 * data points used; below `HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE` we fall
 * back to `HOLIDAY_DEFAULT_DELTA` and set `fellBackToDefault: true`.
 */
export type HolidayDemandFactor = {
  dateType: HolidayDateType;
  delta: number; // capped to [-HOLIDAY_DELTA_CAP, +HOLIDAY_DELTA_CAP]
  rawDelta: number; // pre-cap
  samples: number;
  fellBackToDefault: boolean;
};

/**
 * Result of `loadHolidayDemandFactors`. `byDate` is the per-date
 * lookup the agent uses per cell; `byType` is the learned factor per
 * date-type (for the report).
 */
export type HolidayDemandFactors = {
  /** Map of target ISO date → {dateType, delta} for any date inside an NI holiday window. */
  byDate: Map<string, { dateType: HolidayDateType; delta: number; samples: number; fellBackToDefault: boolean; label: string }>;
  /** Per-date-type aggregate factor — surfaced on the report. */
  byType: Map<HolidayDateType, HolidayDemandFactor>;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function eachIsoInRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * For the trailing learning window, return the set of ISO dates that
 * fall inside ANY NI holiday window. Used to exclude them from the
 * "normal" baseline.
 */
function buildHolidayDateSet(periods: HolidayPeriod[], todayIso: string): { holidayByType: Map<HolidayDateType, Set<string>>; allHoliday: Set<string> } {
  const windowStart = new Date(`${todayIso}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - LEARNING_WINDOW_DAYS);
  const today = new Date(`${todayIso}T00:00:00Z`);
  const holidayByType = new Map<HolidayDateType, Set<string>>();
  const allHoliday = new Set<string>();
  for (const period of periods) {
    const periodStart = new Date(`${period.startIso}T00:00:00Z`);
    const periodEnd = new Date(`${period.endIso}T00:00:00Z`);
    // Include the period only if it's within the learning window (past 730d)
    if (periodEnd < windowStart || periodStart > today) continue;
    let typeSet = holidayByType.get(period.dateType);
    if (!typeSet) {
      typeSet = new Set();
      holidayByType.set(period.dateType, typeSet);
    }
    for (const iso of eachIsoInRange(period.startIso, period.endIso)) {
      const d = new Date(`${iso}T00:00:00Z`);
      if (d < windowStart || d > today) continue;
      typeSet.add(iso);
      allHoliday.add(iso);
    }
  }
  return { holidayByType, allHoliday };
}

/**
 * "Same calendar period" for relative-baseline computation. For
 * date-types in the cold half (Christmas/NYE), the baseline is other
 * cold months excluding holidays. For warm-half date-types (Twelfth,
 * Aug bank hol, Easter, etc.), the baseline is the same warm period.
 * This isolates the holiday effect from seasonal trend.
 */
const PERIOD_MONTHS_BY_TYPE: Record<HolidayDateType, number[]> = {
  christmas_period: [10, 11, 0, 1], // Nov, Dec, Jan, Feb (0-indexed)
  nye_period: [10, 11, 0, 1],
  twelfth: [5, 6, 7], // Jun, Jul, Aug
  summer_bank_hol: [6, 7, 8], // Jul, Aug, Sep
  may_early_bank_hol: [3, 4, 5], // Apr, May, Jun
  may_spring_bank_hol: [3, 4, 5],
  st_pats: [1, 2, 3], // Feb, Mar, Apr
  easter_weekend: [2, 3, 4] // Mar, Apr, May
};

/**
 * Load per-date-type learned demand factors for a tenant from the
 * trailing 730-day NightFact history.
 *
 * One SQL query per tenant per run (the aggregation collapses dates
 * to per-day per-listing revenue using the same exclusions as the
 * trailing-ADR helper). The function is read-only.
 */
export async function loadHolidayDemandFactors(args: {
  tenantId: string;
  todayIso: string;
}): Promise<HolidayDemandFactors> {
  const { tenantId, todayIso } = args;

  // Build the holiday-date sets and all-holiday union for the trailing window.
  const { holidayByType, allHoliday } = buildHolidayDateSet(NI_HOLIDAY_PERIODS, todayIso);

  // Trailing window in date form (UTC).
  const today = new Date(`${todayIso}T00:00:00Z`);
  const windowStart = new Date(today);
  windowStart.setUTCDate(today.getUTCDate() - LEARNING_WINDOW_DAYS);

  // Pull NightFact rows over the window. Same exclusions as
  // `trailing-adr.ts` (ownerstay excluded, multi-unit excluded via
  // listings.unit_count < 2, losNights ≤ 10).
  type Row = { listing_id: string; iso_date: string; revenue: number };
  const rows = (await prisma.$queryRaw`
    SELECT nf.listing_id::text AS listing_id,
           to_char(nf.date::date, 'YYYY-MM-DD') AS iso_date,
           SUM(nf.revenue_allocated)::float AS revenue
    FROM night_facts nf
    JOIN listings l ON l.id = nf.listing_id
    WHERE nf.tenant_id = ${tenantId}
      AND nf.date >= ${windowStart}::date
      AND nf.date < ${today}::date
      AND nf.is_occupied = true
      AND nf.revenue_allocated > 0
      AND nf.los_nights IS NOT NULL
      AND nf.los_nights <= 10
      AND COALESCE(nf.status, '') != 'ownerstay'
      AND COALESCE(l.unit_count, 1) < 2
    GROUP BY nf.listing_id, nf.date
  `) as Row[];

  // Per-date portfolio revenue + sold-listing count.
  type DayAgg = { revenue: number; soldListings: number };
  const dayAgg = new Map<string, DayAgg>();
  for (const r of rows) {
    const cur = dayAgg.get(r.iso_date) ?? { revenue: 0, soldListings: 0 };
    cur.revenue += Number(r.revenue ?? 0);
    cur.soldListings += 1;
    dayAgg.set(r.iso_date, cur);
  }

  // Active supply for the tenant (single-unit listings, non-inactive).
  const supplyRow = (await prisma.$queryRaw`
    SELECT COUNT(*)::int AS supply
    FROM listings
    WHERE tenant_id = ${tenantId}
      AND status != 'inactive'
      AND COALESCE(unit_count, 1) < 2
  `) as Array<{ supply: number }>;
  const supply = supplyRow[0]?.supply ?? 0;

  // For each date-type, compute (mean revenue per supply-night on holiday dates)
  // vs (mean revenue per supply-night on same-period non-holiday dates).
  const byType = new Map<HolidayDateType, HolidayDemandFactor>();

  for (const dateType of Object.keys(PERIOD_MONTHS_BY_TYPE) as HolidayDateType[]) {
    const periodMonths = new Set(PERIOD_MONTHS_BY_TYPE[dateType]);
    const holidayDates = holidayByType.get(dateType) ?? new Set<string>();

    // Holiday samples — sum revenue + count distinct dates inside the holiday set.
    let holidayRevenue = 0;
    let holidayDistinctDates = 0;
    let holidaySoldNightSamples = 0;
    for (const iso of holidayDates) {
      const agg = dayAgg.get(iso);
      if (!agg) {
        holidayDistinctDates += 1; // counts toward supply-night denominator even if no bookings
        continue;
      }
      holidayRevenue += agg.revenue;
      holidaySoldNightSamples += agg.soldListings;
      holidayDistinctDates += 1;
    }

    // Baseline: same-period non-holiday dates in the trailing window.
    let normalRevenue = 0;
    let normalDistinctDates = 0;
    let cursor = new Date(windowStart);
    const end = new Date(today);
    while (cursor < end) {
      const iso = cursor.toISOString().slice(0, 10);
      if (periodMonths.has(cursor.getUTCMonth()) && !allHoliday.has(iso)) {
        const agg = dayAgg.get(iso);
        normalRevenue += agg?.revenue ?? 0;
        normalDistinctDates += 1;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // RPAN — revenue per available night = revenue / (supply × distinct dates).
    const holidayRpan = supply > 0 && holidayDistinctDates > 0 ? holidayRevenue / (supply * holidayDistinctDates) : 0;
    const normalRpan = supply > 0 && normalDistinctDates > 0 ? normalRevenue / (supply * normalDistinctDates) : 0;

    let rawDelta: number;
    let fellBackToDefault: boolean;
    if (holidaySoldNightSamples < HOLIDAY_MIN_SOLD_NIGHTS_SAMPLE || normalRpan <= 0) {
      rawDelta = HOLIDAY_DEFAULT_DELTA;
      fellBackToDefault = true;
    } else {
      rawDelta = holidayRpan / normalRpan - 1;
      fellBackToDefault = false;
    }
    const delta = clamp(rawDelta, -HOLIDAY_DELTA_CAP, HOLIDAY_DELTA_CAP);
    byType.set(dateType, {
      dateType,
      delta,
      rawDelta,
      samples: holidaySoldNightSamples,
      fellBackToDefault
    });
  }

  // Build per-date lookup for the FORWARD window (today + 1 year).
  // The agent uses this map to look up whether a target cell is a
  // holiday date.
  const byDate = new Map<string, { dateType: HolidayDateType; delta: number; samples: number; fellBackToDefault: boolean; label: string }>();
  const forwardEnd = new Date(today);
  forwardEnd.setUTCFullYear(today.getUTCFullYear() + 2);
  for (const period of NI_HOLIDAY_PERIODS) {
    const periodEnd = new Date(`${period.endIso}T00:00:00Z`);
    const periodStart = new Date(`${period.startIso}T00:00:00Z`);
    // Forward-only: include periods that overlap with [today, today+2yrs].
    if (periodEnd < today || periodStart > forwardEnd) continue;
    const factor = byType.get(period.dateType);
    if (!factor) continue;
    for (const iso of eachIsoInRange(period.startIso, period.endIso)) {
      byDate.set(iso, {
        dateType: period.dateType,
        delta: factor.delta,
        samples: factor.samples,
        fellBackToDefault: factor.fellBackToDefault,
        label: period.label
      });
    }
  }

  return { byDate, byType };
}

/**
 * Pure resolver for tests. Given a date and the loaded factors,
 * returns the per-cell delta or null when the date isn't a holiday.
 */
export function resolveHolidayDelta(
  targetIso: string,
  factors: HolidayDemandFactors
): { dateType: HolidayDateType; delta: number; fellBackToDefault: boolean; label: string } | null {
  const hit = factors.byDate.get(targetIso);
  if (!hit) return null;
  return { dateType: hit.dateType, delta: hit.delta, fellBackToDefault: hit.fellBackToDefault, label: hit.label };
}
