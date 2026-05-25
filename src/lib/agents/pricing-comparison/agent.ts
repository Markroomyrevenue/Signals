/**
 * Daily pricing comparison agent — runs once per day for trial tenants.
 *
 * For each (tenant, active listing, target date in [today, today+90]):
 *   1. Compute our recommended rate via the trial-pricing module.
 *   2. Read the Hostaway live rate from CalendarRate (refreshed by sync).
 *   3. Classify (agree | our_higher | our_lower | no_hostaway_rate).
 *   4. Persist a PricingComparisonSnapshot row.
 *
 * The agent uses simplified inputs to the trial-pricing module — it does
 * NOT replicate the full daily pipeline from pricing-report-assembly.ts.
 * The point is to surface our model's view of the price for comparison,
 * not to deploy that price. Multi-unit listings are handled with their
 * own existing pipeline (they are out-of-scope for the trial — most
 * trial properties are single-unit).
 *
 * All Prisma queries scope to `tenantId` per the multi-tenant rule.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { eventAdjustmentForDate } from "@/lib/pricing/events";
import { createKeyDataProvider, type KeyDataProvider } from "@/lib/pricing/keydata-provider";
import { setTrialSimilarityActive } from "@/lib/pricing/market-anchor";
import {
  computeTrialDailyRate,
  type TrialDailyInput,
  type TrialMarketSnapshot,
  type TrialMode,
  type TrialQualityTier
} from "@/lib/pricing/trial-pricing";
import { listTrialTenants, type TrialTenantInfo } from "@/lib/pricing/trial-tenants";
import { resolvePricingSettings, type PricingResolvedSettings } from "@/lib/pricing/settings";
import { classifyDivergence, medianRateInWindow } from "@/lib/agents/pricing-comparison/divergence-cause";
import { getTrialLocalEventsForTenant } from "@/lib/agents/pricing-comparison/trial-events";
import {
  computeKdCrossSectionalDelta,
  computeOwnCrossSectionalDelta,
  loadPortfolioForwardFill
} from "@/lib/agents/pricing-comparison/cross-sectional-demand";
import {
  loadHolidayDemandFactors,
  resolveHolidayDelta
} from "@/lib/agents/pricing-comparison/holiday-calendar";
import {
  loadForwardOccupancyByListingMonth,
  resolveForwardOccupancy
} from "@/lib/agents/pricing-comparison/forward-occupancy";
import { computeRung1OccupancyAdjustedOwnAdr, SOLD_NIGHTS_FULL_CONFIDENCE } from "@/lib/pricing/trial-pricing";
import {
  loadTrailingPerListing,
  STATUSES_EXCLUDED_FROM_TRAILING_ADR,
  MAX_LOS_NIGHTS_FOR_TRAILING_ADR,
  TRAILING_WINDOW_DAYS
} from "@/lib/agents/pricing-comparison/trailing-adr";

export type ComparisonRunOptions = {
  /** ISO date for the snapshot (defaults to today in Europe/London) */
  snapshotDate?: string;
  /**
   * Cap forward horizon in days. Defaults to 270 (owner target —
   * 2026-05-19). Note that KeyData weekly market KPIs only cover the
   * first ~90 days, so demand-spike classification cannot fire on
   * cells beyond that — but the pre-occupancy agreement KPI can.
   */
  horizonDays?: number;
  /** Restrict to a specific tenant (useful for debugging) */
  tenantId?: string;
};

export type ComparisonRunSummary = {
  tenantId: string;
  tenantName: string;
  runId: string;
  snapshotDate: string;
  /** Total listings the tenant has after `status != inactive`, before any trial-scope filter. */
  listingsBeforeScopeFilter: number;
  /** Number of listings dynamically excluded by `isStudentAccomListing` on this run. */
  studentAccomExcluded: number;
  /** Number of multi-unit listings skipped (out-of-scope for trial). */
  multiUnitSkipped: number;
  /** Listings that actually entered the comparison loop. */
  listingsProcessed: number;
  /**
   * Cells included in the comparison, available-nights basis (2026-05-22+).
   * A cell is included only when the listing is bookable on that date
   * (CalendarRate.available === true AND rate > 0). Blocked / missing
   * cells are filtered out before classification — see
   * `unavailableCellsExcluded` for the dropped count.
   */
  cellsCompared: number;
  agreement: number;
  ourHigher: number;
  ourLower: number;
  /**
   * Kept on the summary for backward compatibility but zero by construction
   * since 2026-05-22 — the available-nights filter excludes no-rate cells
   * before they reach classification. See `unavailableCellsExcluded`.
   */
  noHostawayRate: number;
  /**
   * Cells dropped by the available-nights filter (2026-05-22+):
   * blocked nights, no-rate nights, and missing calendar rows. Excluded
   * before classification, KPI, band stats, and per-listing aggregates.
   */
  unavailableCellsExcluded: number;
  meanDeltaPct: number;
  medianAbsDeltaPct: number;
  largeDivergenceCount: number;
  /** Aggregate count of rows classified into each divergence cause. */
  divergenceCauseCounts: { demand: number; level: number; mixed: number; occupancy: number; spikeCaught: number; spikeMissed: number };
  /**
   * Pre-occupancy agreement — the trial KPI per owner's target (2026-05-19).
   * Measured against `rateWithoutOccupancy` (our recommendation stripped of
   * the occupancy multiplier) instead of the final `ourRate`. The goal is
   * ≥ 90% of (listing × date) cells within ±10% of PriceLabs at the base
   * level — i.e. "PriceLabs-equivalent before our occupancy logic kicks in".
   *
   * Cells with no rateWithoutOccupancy (no occupancy multiplier supplied)
   * fall back to comparing the raw ourRate so we don't drop them from the
   * denominator.
   */
  preOccAgreementWithin5Pct: number;
  preOccAgreementWithin10Pct: number;
  preOccCellsRated: number;
  /**
   * Mean signed pre-occupancy delta vs PL per booking-window band.
   * Negative = we under PL, positive = we over PL. Owner's headline
   * "are we 13% or 80% away" framing — gives directional context per
   * band that the binary within-±10% metric doesn't.
   *
   * Keys: "0-7d", "8-14d", "15-30d", "31-60d", "61-90d", "91-180d",
   * "181-270d". Missing keys mean no rated cells in that band.
   */
  preOccMeanDeltaByBand: Record<string, number>;
  preOccBandCounts: Record<string, number>;
  /**
   * Banded agreement distribution (2026-05-25 spec). Each field is the
   * SHARE of `preOccCellsRated` whose absolute pre-occupancy delta vs
   * PL falls in the band (within X is cumulative — within10 ≤ within15
   * ≤ ... ≤ within25; beyond25 + beyond50 are NOT cumulative — beyond50
   * is the strictly-broken tail; beyond25 is everything past 25%).
   *
   * Honest reporting — surfaces the shape of the curve so cells "13%
   * off because base sits on PL+8% with seasonality drift" are
   * distinguishable from cells "162% off because the engine is
   * broken". The existing within±10 KPI is preserved in
   * preOccAgreementWithin10Pct above; this is additive context.
   */
  preOccBands: {
    within10: number;
    within15: number;
    within20: number;
    within25: number;
    beyond25: number;
    beyond50: number;
  };
  /**
   * Same banded distribution broken down by booking-window band.
   * Keyed by the same BOOKING_WINDOW_BANDS as preOccBandCounts.
   * Per-band shares; the denominator is the per-band cell count
   * (NOT the tenant-wide count).
   */
  preOccBandsByBookingWindow: Record<
    string,
    { within10: number; within15: number; within20: number; within25: number; beyond25: number; beyond50: number; count: number }
  >;
  errors: string[];
};

const BOOKING_WINDOW_BANDS = ["0-7d", "8-14d", "15-30d", "31-60d", "61-90d", "91-180d", "181-270d"] as const;
type BookingWindowBand = typeof BOOKING_WINDOW_BANDS[number];

function bookingWindowBand(daysOut: number): BookingWindowBand {
  if (daysOut <= 7) return "0-7d";
  if (daysOut <= 14) return "8-14d";
  if (daysOut <= 30) return "15-30d";
  if (daysOut <= 60) return "31-60d";
  if (daysOut <= 90) return "61-90d";
  if (daysOut <= 180) return "91-180d";
  return "181-270d";
}

const AGREE_THRESHOLD_PCT = 0.03;
const LARGE_DIVERGENCE_PCT = 0.15;
const PRE_OCC_TARGET_WITHIN_5_PCT = 0.05;
const PRE_OCC_TARGET_WITHIN_10_PCT = 0.10;

/**
 * Classify a set of absolute delta-percentage values into the
 * agreement-distribution bands surfaced on the report (2026-05-25 spec).
 *
 * within-X bands are CUMULATIVE: a cell at 7% counts toward within10 AND
 * within15 AND within20 AND within25. beyond-X bands are STRICT TAILS:
 * a cell at 30% counts toward beyond25 but NOT beyond50.
 *
 * Exported for tests + the report renderer; keeps the math in one place
 * so the agent-loop counter increments and any future report-side
 * aggregations agree on the band boundaries.
 */
export function classifyAgreementBands(
  absDeltas: number[]
): { within10: number; within15: number; within20: number; within25: number; beyond25: number; beyond50: number; count: number } {
  let within10 = 0;
  let within15 = 0;
  let within20 = 0;
  let within25 = 0;
  let beyond25 = 0;
  let beyond50 = 0;
  for (const v of absDeltas) {
    if (!Number.isFinite(v) || v < 0) continue;
    if (v <= 0.10) within10 += 1;
    if (v <= 0.15) within15 += 1;
    if (v <= 0.20) within20 += 1;
    if (v <= 0.25) within25 += 1;
    if (v > 0.25) beyond25 += 1;
    if (v > 0.50) beyond50 += 1;
  }
  return { within10, within15, within20, within25, beyond25, beyond50, count: absDeltas.length };
}

function todayLondonIso(): string {
  // Europe/London ≡ UTC in winter, UTC+1 in summer. Use Intl to format.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetweenIso(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function classify(ourRate: number, hostawayRate: number | null): "agree" | "our_higher" | "our_lower" | "no_hostaway_rate" {
  if (hostawayRate === null || !Number.isFinite(hostawayRate) || hostawayRate <= 0) return "no_hostaway_rate";
  const deltaPct = (ourRate - hostawayRate) / hostawayRate;
  if (Math.abs(deltaPct) <= AGREE_THRESHOLD_PCT) return "agree";
  return deltaPct > 0 ? "our_higher" : "our_lower";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function loadOwnHistoryAggregates(
  tenantId: string,
  listingId: string
): Promise<{ trailing365dAdr: number | null; trailing365dOccupancy: number | null; ownDoWIndex: number[] }> {
  // Trailing ADR + occupancy come from the shared helper (single source
  // of truth, owner spec 2026-05-19): owner-stays excluded, stays > 10
  // nights excluded, denominators correct (calendar days for occupancy,
  // sold-night-count for ADR), cleaning fee already out via
  // accommodationFare.
  const trailing = await loadTrailingPerListing(tenantId, [listingId]);
  const entry = trailing.get(listingId);
  const adr = entry?.adr ?? null;
  const occ = entry?.occupancy ?? null;

  // DoW index — derived from the same filtered night set so it's
  // internally consistent with the ADR. (Monthly seasonality is no
  // longer computed per-listing; per 2026-05-21 spec it's portfolio-
  // aggregated — see loadOwnHistoryPortfolioSeasonality below.)
  const today = new Date();
  const windowStart = new Date(today);
  windowStart.setUTCDate(today.getUTCDate() - TRAILING_WINDOW_DAYS);
  const facts = await prisma.nightFact.findMany({
    where: {
      tenantId,
      listingId,
      date: { gte: windowStart, lt: today },
      isOccupied: true,
      revenueAllocated: { gt: 0 },
      losNights: { not: null, lte: MAX_LOS_NIGHTS_FOR_TRAILING_ADR }
    },
    select: { date: true, revenueAllocated: true, status: true }
  });
  const byDate = new Map<string, number>();
  for (const f of facts) {
    if (f.status && STATUSES_EXCLUDED_FROM_TRAILING_ADR.has(f.status.toLowerCase())) continue;
    const iso = f.date.toISOString().slice(0, 10);
    const cur = byDate.get(iso) ?? 0;
    byDate.set(iso, cur + Number(f.revenueAllocated ?? 0));
  }
  const dateEntries = Array.from(byDate.entries()).map(([iso, revenue]) => ({ iso, revenue }));

  const dowSums = Array(7).fill(0);
  const dowCounts = Array(7).fill(0);
  for (const d of dateEntries) {
    const dow = new Date(`${d.iso}T00:00:00Z`).getUTCDay();
    dowSums[dow] += d.revenue;
    dowCounts[dow] += 1;
  }
  const dowMeans = dowSums.map((s, i) => (dowCounts[i] === 0 ? null : s / dowCounts[i]));
  const dowMeansList = dowMeans.filter((v): v is number => v !== null);
  const dowMedian = dowMeansList.length > 0 ? median(dowMeansList) : null;
  const ownDoWIndex = dowMeans.map((mean) => (mean === null || dowMedian === null || dowMedian <= 0 ? 1.0 : mean / dowMedian));

  return { trailing365dAdr: adr, trailing365dOccupancy: occ, ownDoWIndex };
}

/**
 * Load portfolio-aggregated own-history monthly seasonality for one
 * tenant. Per 2026-05-21 spec — seasonality is a market property, not
 * a per-listing property; per-listing monthly samples are too thin
 * (~20-25 August nights/year per listing) to be stable. Aggregating
 * across all the tenant's listings gives a denser, more representative
 * signal AND lets us surface the per-month sample count to drive the
 * sample-gated own/KD blend in `blendSeasonality`.
 *
 * Uses the SAME trailing-window exclusions as `trailing-adr.ts`
 * (ownerstay excluded, stays > 10 nights excluded, isOccupied=true,
 * revenueAllocated>0) so the seasonality index is internally
 * consistent with the trailing-ADR base-price signal.
 *
 * Returns 12-element arrays indexed by `Date.getUTCMonth()` (0=Jan,
 * 11=Dec):
 *   - `ownSeasonalityByMonth[m]` = mean nightly revenue in month m /
 *     median across months (defaults to 1.0 when month has no data).
 *   - `ownSampleByMonth[m]` = total booked-night count for month m
 *     across all the tenant's listings over the trailing window.
 */
async function loadOwnHistoryPortfolioSeasonality(
  tenantId: string,
  listingIds: string[]
): Promise<{ ownSeasonalityByMonth: number[]; ownSampleByMonth: number[] }> {
  const zeroSeasonality = Array(12).fill(1.0);
  const zeroSample = Array(12).fill(0);
  if (listingIds.length === 0) {
    return { ownSeasonalityByMonth: zeroSeasonality, ownSampleByMonth: zeroSample };
  }

  const today = new Date();
  const windowStart = new Date(today);
  windowStart.setUTCDate(today.getUTCDate() - TRAILING_WINDOW_DAYS);

  // Same filter shape as `loadTrailingPerListing` so the aggregation
  // is identical at the night level. We need per-night revenue here to
  // compute month-of-year means, so we go back to `nightFact.findMany`
  // (the helper is keyed by listing only).
  const facts = await prisma.nightFact.findMany({
    where: {
      tenantId,
      listingId: { in: listingIds },
      date: { gte: windowStart, lt: today },
      isOccupied: true,
      revenueAllocated: { gt: 0 },
      losNights: { not: null, lte: MAX_LOS_NIGHTS_FOR_TRAILING_ADR }
    },
    select: { listingId: true, date: true, revenueAllocated: true, status: true }
  });

  // Collapse to (listingId × date) to defend against legacy duplicate
  // rows, then bucket each unique sold night by calendar month.
  const cellsByListing = new Map<string, Map<string, number>>();
  for (const f of facts) {
    if (f.status && STATUSES_EXCLUDED_FROM_TRAILING_ADR.has(f.status.toLowerCase())) continue;
    let inner = cellsByListing.get(f.listingId);
    if (!inner) {
      inner = new Map();
      cellsByListing.set(f.listingId, inner);
    }
    const iso = f.date.toISOString().slice(0, 10);
    const cur = inner.get(iso) ?? 0;
    inner.set(iso, cur + Number(f.revenueAllocated ?? 0));
  }

  const monthSums = Array(12).fill(0);
  const monthCounts = Array(12).fill(0);
  for (const dateMap of cellsByListing.values()) {
    for (const [iso, revenue] of dateMap) {
      if (revenue <= 0) continue;
      const m = new Date(`${iso}T00:00:00Z`).getUTCMonth();
      monthSums[m] += revenue;
      monthCounts[m] += 1;
    }
  }

  const monthMeans = monthSums.map((s, i) => (monthCounts[i] === 0 ? null : s / monthCounts[i]));
  const meansList = monthMeans.filter((v): v is number => v !== null);
  const medianMean = meansList.length > 0 ? median(meansList) : null;
  const ownSeasonalityByMonth = monthMeans.map((mean) =>
    mean === null || medianMean === null || medianMean <= 0 ? 1.0 : mean / medianMean
  );
  return { ownSeasonalityByMonth, ownSampleByMonth: monthCounts };
}

/**
 * Calendar cell carried into the comparison loop. `available` is the
 * per-night availability flag from CalendarRate — the trial comparison
 * restricts scoring to nights where `available === true` (a blocked
 * night still has a placeholder rate that would be pure noise in the
 * aggregates). Per the 2026-05-22 available-nights filter:
 *
 *   - `available === true`:  scoring cell — included in deltas, KPI,
 *     band stats, per-listing aggregates.
 *   - `available === false`: excluded (`unavailableCellsExcluded++`).
 *   - row missing entirely:  excluded (`unavailableCellsExcluded++`).
 *
 * The `rate` field is the live Hostaway calendar rate (the PriceLabs-
 * driven number we score against); preserved alongside `available`
 * because cells included for scoring still need it.
 */
type CalendarCell = { rate: number | null; available: boolean };

/**
 * Available-nights filter predicate (2026-05-22). Returns true when the
 * cell should be scored, false when it should be excluded. Exported so
 * the unit test can pin the contract without spinning up prisma.
 *
 *   - cell missing entirely         → excluded
 *   - available === false           → excluded (blocked night)
 *   - available === true, rate null → excluded (available but no PL rate)
 *   - available === true, rate > 0  → INCLUDED for scoring
 */
export function shouldIncludeCalendarCell(cell: CalendarCell | null | undefined): boolean {
  if (!cell) return false;
  if (cell.available !== true) return false;
  if (cell.rate === null) return false;
  return true;
}

async function loadCalendarRatesForRange(
  tenantId: string,
  listingId: string,
  startIso: string,
  endIso: string
): Promise<Map<string, CalendarCell>> {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  const rows = await prisma.calendarRate.findMany({
    where: { tenantId, listingId, date: { gte: start, lt: end } },
    select: { date: true, rate: true, available: true }
  });
  const map = new Map<string, CalendarCell>();
  for (const row of rows) {
    const iso = row.date.toISOString().slice(0, 10);
    const rate = Number(row.rate);
    map.set(iso, {
      rate: Number.isFinite(rate) && rate > 0 ? rate : null,
      // Defensive: treat null available as "unknown → excluded" so we
      // never score a date we're not sure about. The diagnostic shows
      // 0% null on both Belfast trial tenants, so this is belt-and-
      // braces rather than a regular code path.
      available: row.available === true
    });
  }
  return map;
}

async function fetchListingsForTenant(tenantId: string) {
  return prisma.listing.findMany({
    where: { tenantId, status: { not: "inactive" } },
    select: {
      id: true,
      name: true,
      bedroomsNumber: true,
      personCapacity: true,
      country: true,
      city: true,
      unitCount: true,
      tags: true
    }
  });
}

/**
 * Trial-scope filter that resolves Student-Accom group membership at
 * runtime. The exclusion is NOT a persistent toggle on each listing —
 * it's re-evaluated every daily run so when a listing is moved into the
 * Student-Accom group in future, it automatically drops out of the
 * trial, and vice-versa.
 *
 * Looks for `group:student accom` (case-insensitive, also accepts
 * "Student Accom", "Student Accommodation", "student-accom" variants)
 * on the listing's `tags` array. The exclusion only fires for Little
 * Feather Management — Stay Belfast Apartments has no such group.
 */
function isStudentAccomListing(tags: string[]): boolean {
  for (const tag of tags ?? []) {
    if (typeof tag !== "string") continue;
    const normalised = tag.trim().toLowerCase();
    if (!normalised.startsWith("group:")) continue;
    const label = normalised.slice("group:".length).trim().replace(/\s+/g, " ").replace(/[-_]/g, " ");
    if (label === "student accom" || label === "student accommodation" || label.startsWith("student accom")) {
      return true;
    }
  }
  return false;
}

async function loadSettingsForListing(
  tenantId: string,
  listingId: string,
  groupKey: string | null
): Promise<PricingResolvedSettings> {
  const rows = await prisma.pricingSetting.findMany({
    where: {
      tenantId,
      OR: [
        { scope: "portfolio", scopeRef: null },
        ...(groupKey ? [{ scope: "group", scopeRef: groupKey }] : []),
        { scope: "property", scopeRef: listingId }
      ]
    },
    select: { scope: true, settings: true }
  });
  const portfolio = (rows.find((r) => r.scope === "portfolio")?.settings as object) ?? {};
  const group = (rows.find((r) => r.scope === "group")?.settings as object) ?? {};
  const property = (rows.find((r) => r.scope === "property")?.settings as object) ?? {};
  const { settings } = resolvePricingSettings({
    portfolio: portfolio as never,
    group: group as never,
    property: property as never
  });
  return settings;
}

type ListingHydrated = Awaited<ReturnType<typeof fetchListingsForTenant>>[number] & {
  ownAggregates: Awaited<ReturnType<typeof loadOwnHistoryAggregates>>;
  settings: PricingResolvedSettings;
  groupKey: string | null;
};

async function buildTrialMarketSnapshot(provider: KeyDataProvider | null, bedrooms: number): Promise<TrialMarketSnapshot> {
  if (!provider) {
    return {
      benchmark: null,
      benchmark1br: null,
      seasonality: null,
      dayOfWeek: null,
      forwardPace: null,
      trailingMarketKpis: null,
      benchmarkSimilarity: 0.5,
      marketOcc25thPct: null,
      marketRpoMedian: null,
      marketRpoForDate: null,
      marketForwardOccForDate: null
    };
  }
  // Always fetch both the listing's bedroom-band benchmark AND the 1br
  // benchmark — the 1br is the denominator for the cross-bedroom size
  // ratio in computeTrialBase. When bedrooms === 1 we re-use the same
  // call. Both are cached 7d so the extra fetch is cheap.
  const benchmarkPromise = provider.getMarketBenchmark({ marketKey: "belfast", bedrooms, qualityTier: "mid_scale" });
  const benchmark1brPromise = bedrooms === 1
    ? benchmarkPromise
    : provider.getMarketBenchmark({ marketKey: "belfast", bedrooms: 1, qualityTier: "mid_scale" });
  const [benchmark, benchmark1br, seasonality, dow, forwardPace, trailingMarketKpis] = await Promise.all([
    benchmarkPromise,
    benchmark1brPromise,
    provider.getCitySeasonalityIndex({ marketKey: "belfast" }),
    provider.getCityDayOfWeekIndex({ marketKey: "belfast" }),
    provider.getForwardPace({ marketKey: "belfast", bedrooms, horizonDays: 90 }),
    provider.getTrailingMarketKpis({ marketKey: "belfast", bedrooms })
  ]);
  // Compute trailing-90-day market occupancy 25th percentile and RPO median
  // from the forwardPace.lastYearComparison series — same listings, different
  // window — used by the lead-time floor gate. If unavailable, defaults
  // to null and the gate falls back to safe behaviour.
  let marketOcc25thPct: number | null = null;
  let marketRpoMedian: number | null = null;
  if (forwardPace && forwardPace.lastYearComparison.length > 0) {
    const occVals = forwardPace.lastYearComparison.map((p) => p.forwardOccupancyLY).sort((a, b) => a - b);
    marketOcc25thPct = occVals[Math.floor(occVals.length * 0.25)];
    const rpoVals = forwardPace.lastYearComparison
      .map((p) => p.forwardADRLY * p.forwardOccupancyLY)
      .filter((v) => Number.isFinite(v));
    if (rpoVals.length > 0) {
      const sorted = [...rpoVals].sort((a, b) => a - b);
      marketRpoMedian = sorted[Math.floor(sorted.length / 2)];
    }
  }
  return {
    benchmark,
    benchmark1br,
    seasonality,
    dayOfWeek: dow,
    forwardPace,
    trailingMarketKpis,
    benchmarkSimilarity: benchmark ? Math.min(1, benchmark.sampleSize / 50) : 0.5,
    marketOcc25thPct,
    marketRpoMedian,
    marketRpoForDate: null,
    marketForwardOccForDate: null
  };
}

export async function runComparisonForTenant(
  tenant: TrialTenantInfo,
  options: ComparisonRunOptions = {}
): Promise<ComparisonRunSummary> {
  const snapshotDate = options.snapshotDate ?? todayLondonIso();
  const horizonDays = options.horizonDays ?? 270;
  const errors: string[] = [];

  // Persist a "running" run row first.
  const startedAt = new Date();
  const run = await prisma.pricingComparisonRun.create({
    data: {
      tenantId: tenant.id,
      snapshotDate: new Date(`${snapshotDate}T00:00:00Z`),
      startedAt,
      status: "running"
    }
  });

  let listingsProcessed = 0;
  let cellsCompared = 0;
  const deltaPctList: number[] = [];
  const absDeltaPctList: number[] = [];
  let agree = 0;
  let ourHigher = 0;
  let ourLower = 0;
  // 2026-05-22 — kept on the summary shape for backward compatibility
  // but always zero now. The available-nights filter folds "no PL rate"
  // and "blocked night" into a single exclusion (`unavailableCellsExcluded`),
  // because the operational meaning is the same: the cell isn't a valid
  // comparison.
  let noHostawayRate = 0;
  // Cells dropped before classification by the available-nights filter
  // (2026-05-22): blocked nights, no-rate nights, missing calendar rows.
  let unavailableCellsExcluded = 0;
  let largeDivergenceCount = 0;
  let studentAccomExcluded = 0;
  let multiUnitSkipped = 0;
  const divergenceCauseCounts = { demand: 0, level: 0, mixed: 0, occupancy: 0, spikeCaught: 0, spikeMissed: 0 };
  let listingsBeforeScopeFilter = 0;
  // Pre-occupancy agreement counters — see PRE_OCC_TARGET_*. Cells where
  // `rateWithoutOccupancy` is null fall back to the raw ourRate so they
  // still contribute to the denominator (cellsRated).
  let preOccCellsRated = 0;
  let preOccWithin5 = 0;
  let preOccWithin10 = 0;
  // Banded distribution counters (2026-05-25). Cumulative for
  // within-X; strict-tail for beyond-X.
  let preOccWithin15 = 0;
  let preOccWithin20 = 0;
  let preOccWithin25 = 0;
  let preOccBeyond25 = 0;
  let preOccBeyond50 = 0;
  // Per-band signed-delta accumulators for the headline "we're N% away
  // from PL in next-7-days" metric.
  const bandDeltaSum: Record<string, number> = {};
  const bandDeltaCount: Record<string, number> = {};
  // Per-booking-window banded distribution counters (2026-05-25).
  // Each entry maps booking-window band → counts per agreement band.
  const bandedCounters: Record<
    string,
    { within10: number; within15: number; within20: number; within25: number; beyond25: number; beyond50: number; count: number }
  > = {};

  try {
    setTrialSimilarityActive(true);
    const provider = createKeyDataProvider();
    const listings = await fetchListingsForTenant(tenant.id);
    listingsBeforeScopeFilter = listings.length;

    // Portfolio-aggregated own-history monthly seasonality (per
    // 2026-05-21 spec) — computed ONCE per tenant and reused for every
    // listing × every target date. Aggregating across the tenant's
    // listings smooths small-sample artifacts (the wild 3.19 single-
    // listing tail the per-listing version produced) and unlocks the
    // sample-gated own/KD blend inside `blendSeasonality` by surfacing
    // the per-month booked-night count.
    //
    // Note: includes ALL listings on the tenant — multi-unit and
    // student-accom rows are NOT filtered out here. Seasonality is a
    // market-shape property; using the broadest possible booked-night
    // base for the index is correct. The per-cell pricing path still
    // skips those listings via the existing filters.
    const portfolioSeasonality = await loadOwnHistoryPortfolioSeasonality(
      tenant.id,
      listings.map((l) => l.id)
    );

    // Trial-only local events (2026-05-22). Resolved ONCE per tenant
    // and re-used for every listing × every date. Lives in
    // src/lib/agents/pricing-comparison/trial-events.ts — a different
    // source from `settings.localEvents`, which feeds the production
    // calendar / push path. Loading Fleadh here cannot reach any
    // customer-facing Hostaway write (see the trial-events.ts file
    // header for the full push-path trace).
    const trialLocalEvents = getTrialLocalEventsForTenant(tenant);

    // Cross-sectional demand signal inputs (2026-05-22 rebuild).
    // Resolved ONCE per tenant per run, then per-cell lookups are
    // O(1) map reads. Own portfolio fill is reconstructed from
    // `reservations` directly (the legacy pace_snapshots table is
    // stale — last write 2026-04-24 per Phase 1 diagnostic). The KD
    // forward-pace is now daily (one row per date with listing_count
    // for the supply guard) and shared with the divergence-cause
    // classifier downstream.
    const horizonEndIso = dateStr(
      new Date(new Date(`${snapshotDate}T00:00:00Z`).getTime() + horizonDays * 86400000)
    );
    const portfolioFill = await loadPortfolioForwardFill({
      tenantId: tenant.id,
      asOfIso: snapshotDate,
      fromIso: snapshotDate,
      toIso: horizonEndIso
    });

    // Phase C (2026-05-24): NI public-holiday calendar layer for
    // far-future demand. Learned per-date-type multipliers from the
    // tenant's own NightFact history (relative to same-period
    // non-holiday dates). Per-cell lookup is O(1) Map.get(). Only
    // contributes when the pace sufficiency gate has dropped both
    // pace signals to null — clean horizon handoff, no double-count.
    const holidayDemandFactors = await loadHolidayDemandFactors({
      tenantId: tenant.id,
      todayIso: snapshotDate
    });

    // Forward-occupancy fix (2026-05-26): the trial yield ladder
    // (lookupTrialOccupancyMultiplier ×0.88-×1.12) and the lead-time-
    // floor gate (propertyOccLow) were both fed
    // `ownAgg.trailing365dOccupancy` — a backward-looking, near-static
    // per-listing average. Result: the multiplier was applying a roughly
    // FIXED nudge per listing based on last year's average, not
    // responding to live forward booking pressure.
    //
    // Per the 2026-05-26 spec, both consumers now read LIVE forward
    // occupancy for the target date's calendar month — booked dates ÷
    // bookable inventory (window length minus owner-blocked dates), as
    // of the snapshot.
    //
    // Per-listing per-month map; per-cell lookup is O(1) `.get()`.
    // Single source of truth for `scopeOccupancy` — see the file
    // header of forward-occupancy.ts for the full rationale and the
    // BUILD-LOG entry for the deliberate choice to share the forward
    // signal between the ladder + the lead-time-floor gate.
    const forwardOccByListingMonth = await loadForwardOccupancyByListingMonth({
      tenantId: tenant.id,
      listingIds: listings.map((l) => l.id),
      asOfIso: snapshotDate,
      horizonDays
    });

    // Four-rung base ladder inputs (2026-05-23). All resolved ONCE per
    // tenant per run; per-cell lookups are O(1) Map reads.
    //
    //   - Per-listing trailing 365d ADR / occupancy / soldNights — batch
    //     query (single round-trip via the shared trailing-adr helper).
    //   - KD trailing-12mo market median occupancy — the reference for
    //     the rung-1 occupancy-lift ratio. KD's trailing-market endpoint
    //     returns market-wide values not filtered by bedroom band, so a
    //     single call covers all bands. Falls back to null on KD outage.
    //   - Portfolio-median occupancy fallback — median of all the
    //     tenant's listings' trailing occupancies. Used when KD market
    //     median is null. Logged on the base breakdown row when the
    //     fallback fires.
    //   - KD P50 per bedroom band — needed to (a) classify each listing's
    //     ownADR against the cheap/in-band/at-market thresholds, and
    //     (b) pre-compute the rung-1 anchor for comp-anchor pool
    //     members. One call per UNIQUE bedroom band on the tenant.
    //   - Comp anchor (rung 3) per listing — mean rung-1 anchor across
    //     same-`group:`-tag + same-bedrooms siblings that have rich
    //     own history. Pre-computed for the whole tenant; per-cell
    //     resolution is a Map.get().
    const allListingIds = listings.map((l) => l.id);
    const trailingPerListingForLadder = await loadTrailingPerListing(tenant.id, allListingIds);
    const trailingMarket = provider
      ? await provider.getTrailingMarketKpis({ marketKey: "belfast", bedrooms: 1 })
      : null;
    const ladderMarketMedianOccupancy = trailingMarket?.trailingMedianOccupancy ?? null;
    const portfolioOccs: number[] = [];
    for (const l of listings) {
      const t = trailingPerListingForLadder.get(l.id);
      if (t?.occupancy !== null && t?.occupancy !== undefined && t.occupancy > 0) portfolioOccs.push(t.occupancy);
    }
    portfolioOccs.sort((a, b) => a - b);
    const ladderPortfolioMedianOccupancy = portfolioOccs.length > 0 ? portfolioOccs[Math.floor(portfolioOccs.length / 2)] : null;

    // Pre-fetch KD benchmark per unique bedroom band; cached 7d in
    // keydata_cache_entries so repeated runs are cheap.
    const uniqueBeds = Array.from(new Set(listings.map((l) => l.bedroomsNumber ?? 1)));
    const kdP50ByBeds = new Map<number, number | null>();
    for (const beds of uniqueBeds) {
      const bm = provider ? await provider.getMarketBenchmark({ marketKey: "belfast", bedrooms: beds, qualityTier: "mid_scale" }) : null;
      kdP50ByBeds.set(beds, bm?.p50 ?? null);
    }

    // Pre-compute rung-1 anchor for each rich-own-history listing.
    // Listings with soldNights < SOLD_NIGHTS_FULL_CONFIDENCE aren't
    // eligible to anchor a cluster — including a thin sibling would
    // poison the mean.
    const rung1AnchorByListing = new Map<string, number>();
    for (const l of listings) {
      const t = trailingPerListingForLadder.get(l.id);
      if (!t || t.adr === null || t.soldNights < SOLD_NIGHTS_FULL_CONFIDENCE) continue;
      const beds = l.bedroomsNumber ?? 1;
      const kdP50 = kdP50ByBeds.get(beds) ?? null;
      const r = computeRung1OccupancyAdjustedOwnAdr({
        ownAdr: t.adr,
        ownOccupancy: t.occupancy,
        kdP50,
        marketMedianOccupancy: ladderMarketMedianOccupancy,
        portfolioMedianOccupancy: ladderPortfolioMedianOccupancy
      });
      rung1AnchorByListing.set(l.id, r.value);
    }

    // Comp anchor per listing — two-tier resolution (2026-05-25 over-base fix):
    //   1. PREFERRED: siblings sharing ALL of the listing's `group:` tags
    //      AND same bedrooms AND with a rich-own-history rung-1 anchor.
    //      Intersection (not union) of tags so a listing with multiple
    //      group: tags (e.g. `group:Castle Buildings` + `group:CB +
    //      Templemore`) gets the most-specific comp set — its peers must
    //      share EVERY tag, not just any one. Without this, listings
    //      tagged `group:CB + Templemore` only (e.g. Templemore 3 1br)
    //      would pollute the Castle Buildings 1-bed comp pool and pull
    //      the cap below the calibration band.
    //   2. FALLBACK: when no group: tag siblings match (no group: tags at
    //      all, or no siblings share the full tag intersection), use the
    //      mean rung-1 anchor across ALL same-tenant + same-bedrooms
    //      listings with rich own history. Broader peer set; reflects
    //      the tenant's average comparable per bedroom band. Per the
    //      2026-05-25 over-base spec: lifts on budget listings without
    //      a tight group: comp set need SOME ceiling to stop the lift
    //      over-firing past comparable levels.
    //
    // The same comp anchor flows TWO ways inside computeTrialBase:
    //   - Rung 3 (comp inheritance): the residual when own confidence is
    //     partial (existing behaviour).
    //   - Rung 1 lift ceiling (2026-05-25): cap the in-band lift at
    //     max(own, comp) so a budget listing isn't lifted past peers.
    //
    // Self always excluded; rich-own-only (soldNights ≥ SOLD_NIGHTS_FULL_CONFIDENCE)
    // so thin comp data can't poison the mean.
    const compAnchorByListing = new Map<string, number | null>();
    for (const l of listings) {
      const targetBeds = l.bedroomsNumber ?? 1;
      const groupTags = (l.tags ?? []).filter((tag) => tag.toLowerCase().startsWith("group:"));

      // Tier 1: same group: tag intersection + same bedrooms.
      const groupSiblings: number[] = [];
      if (groupTags.length > 0) {
        for (const other of listings) {
          if (other.id === l.id) continue;
          if ((other.bedroomsNumber ?? 1) !== targetBeds) continue;
          const otherTags = (other.tags ?? []).filter((tag) => tag.toLowerCase().startsWith("group:"));
          // INTERSECTION: every group: tag on `l` must also appear on
          // `other`. Tags `other` has that `l` doesn't are fine — we're
          // checking the listing's-tags-are-a-subset relationship.
          const allShared = groupTags.every((tag) => otherTags.includes(tag));
          if (!allShared) continue;
          const r1 = rung1AnchorByListing.get(other.id);
          if (r1 !== undefined && r1 > 0) groupSiblings.push(r1);
        }
      }
      if (groupSiblings.length > 0) {
        const mean = groupSiblings.reduce((s, v) => s + v, 0) / groupSiblings.length;
        compAnchorByListing.set(l.id, mean);
        continue;
      }

      // Tier 2: same-tenant + same-bedrooms fallback (rich-own-only).
      const tenantBedsSiblings: number[] = [];
      for (const other of listings) {
        if (other.id === l.id) continue;
        if ((other.bedroomsNumber ?? 1) !== targetBeds) continue;
        const r1 = rung1AnchorByListing.get(other.id);
        if (r1 !== undefined && r1 > 0) tenantBedsSiblings.push(r1);
      }
      if (tenantBedsSiblings.length === 0) {
        compAnchorByListing.set(l.id, null);
      } else {
        const mean = tenantBedsSiblings.reduce((s, v) => s + v, 0) / tenantBedsSiblings.length;
        compAnchorByListing.set(l.id, mean);
      }
    }

    for (const listing of listings) {
      // Skip multi-unit listings — they have their own pipeline; trial scope is single-unit
      if ((listing.unitCount ?? 1) >= 2) {
        multiUnitSkipped += 1;
        continue;
      }
      // Dynamic Student-Accom exclusion — runtime filter, re-evaluated every
      // daily run so future moves into/out of the group take effect
      // automatically. Per the trial spec, exclusion is NOT persisted on
      // the listing.
      if (isStudentAccomListing(listing.tags ?? [])) {
        studentAccomExcluded += 1;
        continue;
      }
      try {
        const ownAgg = await loadOwnHistoryAggregates(tenant.id, listing.id);
        const groupKey = null; // trial keeps it simple; group resolution can be revisited
        const settings = await loadSettingsForListing(tenant.id, listing.id, groupKey);
        const snap = await buildTrialMarketSnapshot(provider, listing.bedroomsNumber ?? 1);
        // Cross-bedroom ratio size anchor (owner spec 2026-05-19):
        // size = ownAdr × (KD P50 for this band / KD P50 for 1br band).
        // The previous null caused computeTrialBase to short-circuit to
        // 100% own-history and silently zero out the 30% KD market
        // weight. Three conditions must hold to compute a real anchor:
        //   - we have ownAdr (NightFact trailing 365d > 0)
        //   - we have KD P50 for the listing's bedroom band
        //   - we have KD P50 for 1br as the denominator
        // Otherwise we pass null and computeTrialBase falls back per
        // its existing waterfall (own→market→size, in that order).
        const p50ThisBand = snap.benchmark?.p50 ?? null;
        const p50OneBr = snap.benchmark1br?.p50 ?? null;
        const ownAdrForSize = ownAgg.trailing365dAdr;
        const listingSizeAnchor: number | null =
          ownAdrForSize !== null && ownAdrForSize > 0 &&
          p50ThisBand !== null && p50ThisBand > 0 &&
          p50OneBr !== null && p50OneBr > 0
            ? ownAdrForSize * (p50ThisBand / p50OneBr)
            : null;
        const hostawayRates = await loadCalendarRatesForRange(
          tenant.id,
          listing.id,
          snapshotDate,
          dateStr(new Date(new Date(`${snapshotDate}T00:00:00Z`).getTime() + horizonDays * 86400000))
        );

        listingsProcessed += 1;
        const baseDate = new Date(`${snapshotDate}T00:00:00Z`);
        const rowsToCreate: Prisma.PricingComparisonSnapshotCreateManyInput[] = [];
        // First pass collects per-date computed/live rate pairs so the
        // second pass can compute ±14-day medians for the divergence-
        // cause classifier without an extra DB round-trip.
        const ourRateByDate = new Map<string, number>();
        const plRateByDate = new Map<string, number | null>();
        for (let i = 0; i < horizonDays; i++) {
          const target = new Date(baseDate);
          target.setUTCDate(baseDate.getUTCDate() + i);
          const targetIso = target.toISOString().slice(0, 10);
          const monthIndex = target.getUTCMonth();
          const dayOfWeek = target.getUTCDay();
          const daysToCheckIn = i;

          // Resolve forward-pace per-date market snapshot for the lead-time gate
          const fwd = snap.forwardPace?.perDate.find((p) => p.date === targetIso);
          const fwdLY = snap.forwardPace?.lastYearComparison.find((p) => p.date === targetIso);
          const dailyMarket: TrialMarketSnapshot = {
            ...snap,
            marketRpoForDate:
              fwdLY && Number.isFinite(fwdLY.forwardOccupancyLY) && Number.isFinite(fwdLY.forwardADRLY)
                ? fwdLY.forwardADRLY * fwdLY.forwardOccupancyLY
                : null,
            marketForwardOccForDate: fwd?.forwardOccupancy ?? null
          };

          const qualityTier: TrialQualityTier = (settings.qualityTier as TrialQualityTier) ?? "mid_scale";
          const mode: TrialMode = settings.keyDataTrialMode ?? "standard";

          // Resolve cross-sectional demand inputs for this cell.
          // Own = portfolio-aggregated fill vs same-month peer median;
          // KD = market revpar_adj vs same-month peer median, with the
          // supply guard applied.
          const ownXs = computeOwnCrossSectionalDelta({ targetIso, fill: portfolioFill });
          const kdXs = computeKdCrossSectionalDelta({ targetIso, forwardPace: snap.forwardPace });

          const input: TrialDailyInput = {
            listingId: listing.id,
            bedrooms: listing.bedroomsNumber ?? 1,
            qualityTier,
            date: targetIso,
            daysToCheckIn,
            dayOfWeek,
            monthIndex,
            trailing365dAdr: ownAgg.trailing365dAdr,
            trailing365dOccupancy: ownAgg.trailing365dOccupancy,
            // 2026-05-23 four-rung base ladder inputs.
            trailing365dSoldNights: trailingPerListingForLadder.get(listing.id)?.soldNights ?? 0,
            marketMedianOccupancy: ladderMarketMedianOccupancy,
            portfolioMedianOccupancy: ladderPortfolioMedianOccupancy,
            compAnchor: compAnchorByListing.get(listing.id) ?? null,
            // Manual anchor plumbed but unset on every trial listing today
            // (per spec). When the production webapp exposes a per-listing
            // `manualBaseAnchor` settings field, agent.ts will read it here.
            manualBaseAnchor: null,
            ownSeasonalityIndex: portfolioSeasonality.ownSeasonalityByMonth[monthIndex] ?? null,
            ownSeasonalitySampleSize: portfolioSeasonality.ownSampleByMonth[monthIndex] ?? null,
            ownDoWIndex: ownAgg.ownDoWIndex[dayOfWeek] ?? null,
            // Vestigial; the new base ladder ignores this term (it was a
            // redundant ownAdr scaling, not an independent signal).
            listingSizeAnchor,
            manualSeasonalityAdjPct:
              settings.seasonalityMonthlyAdjustments.find((a) => a.month === monthIndex + 1)?.adjustmentPct ?? 0,
            manualDoWAdjPct: settings.dayOfWeekAdjustments.find((a) => a.weekday === dayOfWeek)?.adjustmentPct ?? 0,
            // Resolve the trial-scoped event (Fleadh today) for this date.
            // null = no event covers `targetIso` → `eventMult = 1.0` in
            // `computeTrialDailyRate`. Same date-resolution semantics
            // (range + multiple/selectedDates) as `pricing-report-assembly.ts`
            // via the shared `eventAdjustmentForDate` helper.
            localEventAdjPct: eventAdjustmentForDate(trialLocalEvents, targetIso)?.adjustmentPct ?? null,
            demandCrossSectional: {
              ownDelta: ownXs.delta,
              ownPeerSampleSize: ownXs.peerSampleSize,
              ownTargetFill: ownXs.targetFill,
              ownPeerMedianFill: ownXs.peerMedianFill,
              kdRevparDelta: kdXs.revparDelta,
              kdAdrDelta: kdXs.adrDelta,
              kdSupplyDelta: kdXs.supplyDelta,
              kdEffectiveDelta: kdXs.effectiveDelta,
              kdSupplyGuardTriggered: kdXs.supplyGuardTriggered,
              kdPeerSampleSize: kdXs.peerSampleSize,
              // Phase C horizon handoff (2026-05-24): when the cell is
              // inside an NI holiday window, surface the learned delta.
              // computeDemandMultiplier IGNORES this when own/KD pace is
              // available (no double-count) and USES it when both pace
              // signals are gated out (the sufficiency gate fired).
              calendarFallbackDelta: resolveHolidayDelta(targetIso, holidayDemandFactors)?.delta ?? null,
              calendarFallbackLabel: resolveHolidayDelta(targetIso, holidayDemandFactors)?.label ?? null
            },
            paceMultiplier: 1.0,
            // 2026-05-26 forward-occupancy fix: scopeOccupancy is now
            // the listing's LIVE forward occupancy for the target's
            // calendar month (booked/bookable). Feeds both the yield
            // ladder AND the lead-time-floor propertyOccLow gate —
            // single, semantically-correct signal. See
            // forward-occupancy.ts for the full definition and the
            // BUILD-LOG for the explicit decision to share between
            // both consumers.
            scopeOccupancy: resolveForwardOccupancy(forwardOccByListingMonth, listing.id, targetIso),
            userSetMinimum:
              settings.minimumPriceOverride !== null && Number.isFinite(settings.minimumPriceOverride)
                ? settings.minimumPriceOverride
                : null,
            roundingIncrement: settings.roundingIncrement,
            mode
          };

          const result = computeTrialDailyRate(input, dailyMarket);
          if (!result) continue;
          // Available-nights filter (2026-05-22). A blocked night still
          // carries a stale placeholder rate in CalendarRate — including
          // it in the comparison generates noise in every aggregate
          // (tenant mean, trough, KPI, per-listing). Scope the
          // comparison to nights where the listing is actually bookable.
          //
          // Excluded:
          //   - row missing entirely for (listing, date)
          //   - available === false (calendar shows blocked)
          //   - available === true but no rate (no PL comparable)
          //
          // `noHostawayRate` is now zero by construction — the genuine
          // no-rate case is folded into `unavailableCellsExcluded` since
          // both classes of cell are excluded under the same rule. The
          // counter is kept on the summary shape for backward compat.
          const calCell = hostawayRates.get(targetIso) ?? null;
          if (!shouldIncludeCalendarCell(calCell)) {
            unavailableCellsExcluded += 1;
            continue;
          }
          // shouldIncludeCalendarCell guarantees calCell + rate non-null when true.
          const hostawayRate = (calCell as CalendarCell).rate as number;
          const classification = classify(result.recommendedRate, hostawayRate);
          const deltaAbs = result.recommendedRate - hostawayRate;
          const deltaPct = hostawayRate > 0 ? deltaAbs / hostawayRate : null;

          if (deltaPct !== null) {
            deltaPctList.push(deltaPct);
            absDeltaPctList.push(Math.abs(deltaPct));
            if (Math.abs(deltaPct) > LARGE_DIVERGENCE_PCT) largeDivergenceCount += 1;
          }
          if (classification === "agree") agree += 1;
          else if (classification === "our_higher") ourHigher += 1;
          else if (classification === "our_lower") ourLower += 1;
          else noHostawayRate += 1;

          ourRateByDate.set(targetIso, result.recommendedRate);
          plRateByDate.set(targetIso, hostawayRate);

          // Surface the occupancy multiplier separately on the row so
          // the classifier can use it to label "occupancy_driven" cells
          // — and so the report can show what our rate would have been
          // without it.
          const occupancyMultiplier =
            result.breakdown && typeof (result.breakdown as { occupancy?: number }).occupancy === "number"
              ? Number((result.breakdown as { occupancy: number }).occupancy)
              : null;
          // 31-90d trough diagnostic. Only populated for cells in the
          // owner-flagged underperforming band so the snapshot table
          // doesn't bloat. Outside the band the field is null.
          const inTroughBand = daysToCheckIn >= 31 && daysToCheckIn <= 90;
          const b = result.breakdown;
          const troughDiagnostic = inTroughBand
            ? {
                daysToCheckIn,
                base: b.base,
                recommendedMinimum: b.recommendedMinimum,
                multipliers: {
                  seasonality: {
                    own: b.seasonalityOwn,
                    kd: b.seasonalityKd,
                    blended: b.seasonality,
                    clamped: b.seasonalityCeilingHit || b.seasonalityFloorHit,
                    ceilingHit: b.seasonalityCeilingHit,
                    floorHit: b.seasonalityFloorHit,
                    // 2026-05-21 — sample-gated blend instrumentation:
                    // surface the per-month own booked-night count, the
                    // chosen own/kd weights, and the gate decision so the
                    // trough-section report can show whether the cell
                    // landed on own-led (≥30 nights) or KD-led weights.
                    ownSampleSize: b.seasonalityOwnSampleSize,
                    ownSampleAboveGate: b.seasonalityOwnSampleAboveGate,
                    ownWeight: b.seasonalityBlend.ownWeight,
                    marketWeight: b.seasonalityBlend.marketWeight
                  },
                  dayOfWeek: {
                    own: b.dayOfWeekOwn,
                    kd: b.dayOfWeekKd,
                    blended: b.dayOfWeek,
                    clamped: b.dayOfWeekCeilingHit || b.dayOfWeekFloorHit,
                    ceilingHit: b.dayOfWeekCeilingHit,
                    floorHit: b.dayOfWeekFloorHit
                  },
                  demand: {
                    dominantSignal: b.demandDominantSignal,
                    rawDemandDelta: b.demandRawDelta,
                    passThrough: b.demandPassThrough,
                    finalMultiplier: b.demand,
                    ceilingHit: b.demandCeilingHit,
                    floorHit: b.demandFloorHit,
                    // 2026-05-22 — cross-sectional rebuild: per-side
                    // inputs to the demand blend. Surfaces the supply
                    // guard, peer sample sizes, and own/kd deltas so
                    // the trough section can attribute the lift.
                    ownDelta: b.demandOwnDelta,
                    ownPeerSampleSize: b.demandOwnPeerSampleSize,
                    ownTargetFill: b.demandOwnTargetFill,
                    ownPeerMedianFill: b.demandOwnPeerMedianFill,
                    kdRevparDelta: b.demandKdRevparDelta,
                    kdAdrDelta: b.demandKdAdrDelta,
                    kdSupplyDelta: b.demandKdSupplyDelta,
                    kdEffectiveDelta: b.demandKdEffectiveDelta,
                    kdSupplyGuardTriggered: b.demandKdSupplyGuardTriggered,
                    kdPeerSampleSize: b.demandKdPeerSampleSize,
                    ownWeight: b.demandOwnWeight,
                    kdWeight: b.demandKdWeight
                  },
                  occupancy: {
                    bucketLowPct: b.occupancyBucketMin,
                    bucketHighPct: b.occupancyBucketMax,
                    multiplier: b.occupancy,
                    mode: b.ladderMode
                  },
                  leadTimeFloor: {
                    engaged: b.leadTimeGate.engaged,
                    gate: {
                      propertyOccLow: b.leadTimeGate.propertyOccLow,
                      marketOccLow: b.leadTimeGate.marketOccLow,
                      marketRpoBelowMedian: b.leadTimeGate.marketRpoBelowMedian
                    }
                  },
                  // 2026-05-22: events lever (Fleadh today). `multiplier`
                  // is the resolved eventMult (1.0 = no event); `adjPct`
                  // is the underlying adjustmentPct (null = no event
                  // covered this date). Surfaces in the trough section
                  // and the new Fleadh / events block.
                  events: {
                    multiplier: b.events,
                    adjPct: input.localEventAdjPct
                  }
                },
                finalRate: result.recommendedRate,
                plRate: hostawayRate,
                delta: deltaAbs,
                deltaPct
              }
            : null;
          // Inject the diagnostic into the breakdown payload so the
          // snapshot row carries it (renderer reads from ourBreakdown).
          const enrichedBreakdown = {
            ...(result.breakdown as object),
            troughDiagnostic
          };
          rowsToCreate.push({
            tenantId: tenant.id,
            snapshotDate: new Date(`${snapshotDate}T00:00:00Z`),
            listingId: listing.id,
            targetDate: target,
            ourRate: new Prisma.Decimal(result.recommendedRate),
            hostawayRate: hostawayRate !== null ? new Prisma.Decimal(hostawayRate) : null,
            deltaAbs: deltaAbs !== null ? new Prisma.Decimal(deltaAbs) : null,
            deltaPct,
            windowDays: daysBetweenIso(snapshotDate, targetIso),
            classification,
            ourBreakdown: enrichedBreakdown as never,
            ourOccupancyMultiplier: occupancyMultiplier,
            keyDataForwardOcc: dailyMarket.marketForwardOccForDate ?? null,
            keyDataForwardAdr: fwd?.forwardADR ?? null,
            keyDataForwardOccLy: fwdLY?.forwardOccupancyLY ?? null,
            keyDataForwardAdrLy: fwdLY?.forwardADRLY ?? null,
            keyDataForwardRevparAdj: fwd?.forwardRevparAdj ?? null,
            keyDataForwardRevparAdjLy: fwdLY?.forwardRevparAdjLy ?? null,
            keyDataForwardBookingWindow: fwd?.forwardBookingWindow ?? null,
            keyDataForwardBookingWindowMedian: snap.forwardPace?.forwardBookingWindowMedian ?? null
          });
          cellsCompared += 1;
        }

        // Second pass: classify divergence cause for every row using
        // ±14-day medians from this run's own rate maps.
        const ourRateRows = Array.from(ourRateByDate.entries()).map(([date, rate]) => ({ date, rate }));
        const plRateRows = Array.from(plRateByDate.entries()).map(([date, rate]) => ({ date, rate }));
        for (const row of rowsToCreate) {
          const dateIso = row.targetDate instanceof Date ? row.targetDate.toISOString().slice(0, 10) : String(row.targetDate);
          const ourRate = Number(row.ourRate);
          const plRateRaw = row.hostawayRate;
          if (plRateRaw === null || plRateRaw === undefined) continue;
          const plRate = Number(plRateRaw);
          if (!Number.isFinite(plRate) || plRate <= 0) continue;
          const ourBaseline = medianRateInWindow(ourRateRows, dateIso, 14, 3);
          const plBaseline = medianRateInWindow(plRateRows, dateIso, 14, 3);
          if (ourBaseline === null || plBaseline === null) continue;
          const ourOccupancyMultiplier =
            typeof row.ourOccupancyMultiplier === "number" && Number.isFinite(row.ourOccupancyMultiplier)
              ? row.ourOccupancyMultiplier
              : null;
          // Thread the KeyData market YoY signals into the classifier so
          // it can flag the cell as demand_spike_caught/missed when the
          // market is verifiably hot on both axes (occ + ADR vs LY).
          const marketForwardOcc =
            typeof row.keyDataForwardOcc === "number" && Number.isFinite(row.keyDataForwardOcc)
              ? row.keyDataForwardOcc
              : null;
          const marketForwardOccLy =
            typeof row.keyDataForwardOccLy === "number" && Number.isFinite(row.keyDataForwardOccLy)
              ? row.keyDataForwardOccLy
              : null;
          const marketForwardAdr =
            typeof row.keyDataForwardAdr === "number" && Number.isFinite(row.keyDataForwardAdr)
              ? row.keyDataForwardAdr
              : null;
          const marketForwardAdrLy =
            typeof row.keyDataForwardAdrLy === "number" && Number.isFinite(row.keyDataForwardAdrLy)
              ? row.keyDataForwardAdrLy
              : null;
          const marketBookingWindow =
            typeof row.keyDataForwardBookingWindow === "number" && Number.isFinite(row.keyDataForwardBookingWindow)
              ? row.keyDataForwardBookingWindow
              : null;
          const marketBookingWindowMedian =
            typeof row.keyDataForwardBookingWindowMedian === "number" && Number.isFinite(row.keyDataForwardBookingWindowMedian)
              ? row.keyDataForwardBookingWindowMedian
              : null;
          const marketForwardRevparAdj =
            typeof row.keyDataForwardRevparAdj === "number" && Number.isFinite(row.keyDataForwardRevparAdj)
              ? row.keyDataForwardRevparAdj
              : null;
          const marketForwardRevparAdjLy =
            typeof row.keyDataForwardRevparAdjLy === "number" && Number.isFinite(row.keyDataForwardRevparAdjLy)
              ? row.keyDataForwardRevparAdjLy
              : null;
          const lifts = classifyDivergence({
            ourRate,
            plRate,
            ourBaseline,
            plBaseline,
            ourOccupancyMultiplier,
            marketForwardOcc,
            marketForwardOccLy,
            marketForwardAdr,
            marketForwardAdrLy,
            marketForwardRevparAdj,
            marketForwardRevparAdjLy,
            marketBookingWindow,
            marketBookingWindowMedian
          });
          if (!lifts) continue;
          row.ourLift = lifts.ourLift;
          row.plLift = lifts.plLift;
          row.liftDelta = lifts.liftDelta;
          row.divergenceCause = lifts.divergenceCause;
          if (lifts.rateWithoutOccupancy !== null && Number.isFinite(lifts.rateWithoutOccupancy)) {
            row.rateWithoutOccupancy = new Prisma.Decimal(lifts.rateWithoutOccupancy);
          }
          if (lifts.divergenceCause === "demand_disagreement") divergenceCauseCounts.demand += 1;
          else if (lifts.divergenceCause === "level_disagreement") divergenceCauseCounts.level += 1;
          else if (lifts.divergenceCause === "mixed") divergenceCauseCounts.mixed += 1;
          else if (lifts.divergenceCause === "occupancy_driven") divergenceCauseCounts.occupancy += 1;
          else if (lifts.divergenceCause === "demand_spike_caught") divergenceCauseCounts.spikeCaught += 1;
          else if (lifts.divergenceCause === "demand_spike_missed") divergenceCauseCounts.spikeMissed += 1;

          // Pre-occupancy agreement check (the trial KPI). When the
          // classifier supplied a rateWithoutOccupancy we use that;
          // otherwise we fall back to ourRate so the cell still
          // contributes to the denominator. plRate is already validated
          // above (continue if null/non-finite/<=0).
          const compareRate =
            typeof lifts.rateWithoutOccupancy === "number" && Number.isFinite(lifts.rateWithoutOccupancy) && lifts.rateWithoutOccupancy > 0
              ? lifts.rateWithoutOccupancy
              : ourRate;
          const preOccDeltaPct = (compareRate - plRate) / plRate;
          const absPreOcc = Math.abs(preOccDeltaPct);
          preOccCellsRated += 1;
          if (absPreOcc <= PRE_OCC_TARGET_WITHIN_5_PCT) preOccWithin5 += 1;
          if (absPreOcc <= PRE_OCC_TARGET_WITHIN_10_PCT) preOccWithin10 += 1;
          // Banded distribution (2026-05-25 spec). Cumulative bands for
          // within-X; strict-tail counts for beyond-X.
          if (absPreOcc <= 0.15) preOccWithin15 += 1;
          if (absPreOcc <= 0.20) preOccWithin20 += 1;
          if (absPreOcc <= 0.25) preOccWithin25 += 1;
          if (absPreOcc > 0.25) preOccBeyond25 += 1;
          if (absPreOcc > 0.50) preOccBeyond50 += 1;
          // Bucket the signed delta by booking-window band for the
          // headline per-band-mean metric.
          const win = typeof row.windowDays === "number" ? row.windowDays : 0;
          const band = bookingWindowBand(win);
          bandDeltaSum[band] = (bandDeltaSum[band] ?? 0) + preOccDeltaPct;
          bandDeltaCount[band] = (bandDeltaCount[band] ?? 0) + 1;
          // Per-booking-window banded distribution counters.
          let bd = bandedCounters[band];
          if (!bd) {
            bd = { within10: 0, within15: 0, within20: 0, within25: 0, beyond25: 0, beyond50: 0, count: 0 };
            bandedCounters[band] = bd;
          }
          bd.count += 1;
          if (absPreOcc <= 0.10) bd.within10 += 1;
          if (absPreOcc <= 0.15) bd.within15 += 1;
          if (absPreOcc <= 0.20) bd.within20 += 1;
          if (absPreOcc <= 0.25) bd.within25 += 1;
          if (absPreOcc > 0.25) bd.beyond25 += 1;
          if (absPreOcc > 0.50) bd.beyond50 += 1;
        }
        if (rowsToCreate.length > 0) {
          await prisma.pricingComparisonSnapshot.createMany({ data: rowsToCreate });
        }
      } catch (err) {
        errors.push(`listing ${listing.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    setTrialSimilarityActive(false);
  }

  const meanDelta = deltaPctList.length > 0 ? deltaPctList.reduce((s, v) => s + v, 0) / deltaPctList.length : 0;
  const medianAbsDelta = absDeltaPctList.length > 0 ? median(absDeltaPctList) : 0;
  const status = errors.length === 0 ? "succeeded" : errors.length > listingsProcessed ? "failed" : "succeeded";

  await prisma.pricingComparisonRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      status,
      listingsProcessed,
      cellsCompared,
      errorsCount: errors.length,
      errorMessage: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null
    }
  });

  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    runId: run.id,
    snapshotDate,
    listingsBeforeScopeFilter,
    studentAccomExcluded,
    multiUnitSkipped,
    listingsProcessed,
    cellsCompared,
    agreement: cellsCompared > 0 ? agree / cellsCompared : 0,
    ourHigher,
    ourLower,
    noHostawayRate,
    unavailableCellsExcluded,
    meanDeltaPct: meanDelta,
    medianAbsDeltaPct: medianAbsDelta,
    largeDivergenceCount,
    divergenceCauseCounts,
    preOccAgreementWithin5Pct: preOccCellsRated > 0 ? preOccWithin5 / preOccCellsRated : 0,
    preOccAgreementWithin10Pct: preOccCellsRated > 0 ? preOccWithin10 / preOccCellsRated : 0,
    preOccCellsRated,
    preOccMeanDeltaByBand: Object.fromEntries(
      BOOKING_WINDOW_BANDS.map((band) => {
        const count = bandDeltaCount[band] ?? 0;
        const mean = count > 0 ? bandDeltaSum[band] / count : 0;
        return [band, mean];
      })
    ),
    preOccBandCounts: Object.fromEntries(
      BOOKING_WINDOW_BANDS.map((band) => [band, bandDeltaCount[band] ?? 0])
    ),
    preOccBands: {
      within10: preOccCellsRated > 0 ? preOccWithin10 / preOccCellsRated : 0,
      within15: preOccCellsRated > 0 ? preOccWithin15 / preOccCellsRated : 0,
      within20: preOccCellsRated > 0 ? preOccWithin20 / preOccCellsRated : 0,
      within25: preOccCellsRated > 0 ? preOccWithin25 / preOccCellsRated : 0,
      beyond25: preOccCellsRated > 0 ? preOccBeyond25 / preOccCellsRated : 0,
      beyond50: preOccCellsRated > 0 ? preOccBeyond50 / preOccCellsRated : 0
    },
    preOccBandsByBookingWindow: Object.fromEntries(
      BOOKING_WINDOW_BANDS.map((band) => {
        const bd = bandedCounters[band];
        const count = bd?.count ?? 0;
        return [
          band,
          {
            within10: count > 0 ? (bd?.within10 ?? 0) / count : 0,
            within15: count > 0 ? (bd?.within15 ?? 0) / count : 0,
            within20: count > 0 ? (bd?.within20 ?? 0) / count : 0,
            within25: count > 0 ? (bd?.within25 ?? 0) / count : 0,
            beyond25: count > 0 ? (bd?.beyond25 ?? 0) / count : 0,
            beyond50: count > 0 ? (bd?.beyond50 ?? 0) / count : 0,
            count
          }
        ];
      })
    ),
    errors
  };
}

export async function runComparisonForAllTrialTenants(
  options: ComparisonRunOptions = {}
): Promise<ComparisonRunSummary[]> {
  const tenants = options.tenantId
    ? (await listTrialTenants()).filter((t) => t.id === options.tenantId)
    : await listTrialTenants();
  const results: ComparisonRunSummary[] = [];
  for (const t of tenants) {
    results.push(await runComparisonForTenant(t, options));
  }
  return results;
}
