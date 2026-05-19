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
  cellsCompared: number;
  agreement: number;
  ourHigher: number;
  ourLower: number;
  noHostawayRate: number;
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
  errors: string[];
};

const AGREE_THRESHOLD_PCT = 0.03;
const LARGE_DIVERGENCE_PCT = 0.15;
const PRE_OCC_TARGET_WITHIN_5_PCT = 0.05;
const PRE_OCC_TARGET_WITHIN_10_PCT = 0.10;

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
): Promise<{ trailing365dAdr: number | null; trailing365dOccupancy: number | null; ownSeasonalityByMonth: number[]; ownDoWIndex: number[] }> {
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setUTCFullYear(today.getUTCFullYear() - 1);

  // NightFact uses factKey="res:<id>" per reservation. Aggregate by date to
  // get one row per night (sum revenue across overlapping reservations is
  // rare in this schema; a night either has 0 or 1 occupying reservation).
  const facts = await prisma.nightFact.findMany({
    where: {
      tenantId,
      listingId,
      date: { gte: oneYearAgo, lt: today }
    },
    select: { date: true, isOccupied: true, revenueAllocated: true }
  });

  // Collapse duplicates per date (some schemas can have multiple factKeys).
  const byDate = new Map<string, { occupied: boolean; revenue: number }>();
  for (const f of facts) {
    const iso = f.date.toISOString().slice(0, 10);
    const cur = byDate.get(iso) ?? { occupied: false, revenue: 0 };
    cur.occupied = cur.occupied || f.isOccupied;
    cur.revenue += Number(f.revenueAllocated ?? 0);
    byDate.set(iso, cur);
  }
  const dateEntries = Array.from(byDate.entries()).map(([iso, v]) => ({ iso, ...v }));
  const occupiedDates = dateEntries.filter((d) => d.occupied);
  const totalNights = dateEntries.length;
  const totalRevenue = occupiedDates.reduce((s, d) => s + d.revenue, 0);
  const adr = occupiedDates.length > 0 ? totalRevenue / occupiedDates.length : null;
  const occ = totalNights > 0 ? occupiedDates.length / totalNights : null;

  // Monthly index: ADR per month vs annual median
  const monthSums = Array(12).fill(0);
  const monthCounts = Array(12).fill(0);
  for (const d of occupiedDates) {
    const m = new Date(`${d.iso}T00:00:00Z`).getUTCMonth();
    monthSums[m] += d.revenue;
    monthCounts[m] += 1;
  }
  const monthMeans = monthSums.map((s, i) => (monthCounts[i] === 0 ? null : s / monthCounts[i]));
  const meansList = monthMeans.filter((v): v is number => v !== null);
  const medianMean = meansList.length > 0 ? median(meansList) : null;
  const ownSeasonalityByMonth = monthMeans.map((mean) => (mean === null || medianMean === null || medianMean <= 0 ? 1.0 : mean / medianMean));

  // DoW index
  const dowSums = Array(7).fill(0);
  const dowCounts = Array(7).fill(0);
  for (const d of occupiedDates) {
    const dow = new Date(`${d.iso}T00:00:00Z`).getUTCDay();
    dowSums[dow] += d.revenue;
    dowCounts[dow] += 1;
  }
  const dowMeans = dowSums.map((s, i) => (dowCounts[i] === 0 ? null : s / dowCounts[i]));
  const dowMeansList = dowMeans.filter((v): v is number => v !== null);
  const dowMedian = dowMeansList.length > 0 ? median(dowMeansList) : null;
  const ownDoWIndex = dowMeans.map((mean) => (mean === null || dowMedian === null || dowMedian <= 0 ? 1.0 : mean / dowMedian));

  return { trailing365dAdr: adr, trailing365dOccupancy: occ, ownSeasonalityByMonth, ownDoWIndex };
}

async function loadCalendarRatesForRange(
  tenantId: string,
  listingId: string,
  startIso: string,
  endIso: string
): Promise<Map<string, number | null>> {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  const rows = await prisma.calendarRate.findMany({
    where: { tenantId, listingId, date: { gte: start, lt: end } },
    select: { date: true, rate: true, available: true }
  });
  const map = new Map<string, number | null>();
  for (const row of rows) {
    const iso = row.date.toISOString().slice(0, 10);
    const rate = Number(row.rate);
    map.set(iso, Number.isFinite(rate) && rate > 0 ? rate : null);
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
      seasonality: null,
      dayOfWeek: null,
      forwardPace: null,
      benchmarkSimilarity: 0.5,
      marketOcc25thPct: null,
      marketRpoMedian: null,
      marketRpoForDate: null,
      marketForwardOccForDate: null
    };
  }
  const [benchmark, seasonality, dow, forwardPace] = await Promise.all([
    provider.getMarketBenchmark({ marketKey: "belfast", bedrooms, qualityTier: "mid_scale" }),
    provider.getCitySeasonalityIndex({ marketKey: "belfast" }),
    provider.getCityDayOfWeekIndex({ marketKey: "belfast" }),
    provider.getForwardPace({ marketKey: "belfast", bedrooms, horizonDays: 90 })
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
    seasonality,
    dayOfWeek: dow,
    forwardPace,
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
  let noHostawayRate = 0;
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

  try {
    setTrialSimilarityActive(true);
    const provider = createKeyDataProvider();
    const listings = await fetchListingsForTenant(tenant.id);
    listingsBeforeScopeFilter = listings.length;

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
            ownSeasonalityIndex: ownAgg.ownSeasonalityByMonth[monthIndex] ?? null,
            ownDoWIndex: ownAgg.ownDoWIndex[dayOfWeek] ?? null,
            listingSizeAnchor: null,
            manualSeasonalityAdjPct:
              settings.seasonalityMonthlyAdjustments.find((a) => a.month === monthIndex + 1)?.adjustmentPct ?? 0,
            manualDoWAdjPct: settings.dayOfWeekAdjustments.find((a) => a.weekday === dayOfWeek)?.adjustmentPct ?? 0,
            localEventAdjPct: null,
            paceMultiplier: 1.0,
            scopeOccupancy: ownAgg.trailing365dOccupancy,
            userSetMinimum:
              settings.minimumPriceOverride !== null && Number.isFinite(settings.minimumPriceOverride)
                ? settings.minimumPriceOverride
                : null,
            roundingIncrement: settings.roundingIncrement,
            mode
          };

          const result = computeTrialDailyRate(input, dailyMarket);
          if (!result) continue;
          const hostawayRate = hostawayRates.get(targetIso) ?? null;
          const classification = classify(result.recommendedRate, hostawayRate);
          const deltaAbs = hostawayRate !== null ? result.recommendedRate - hostawayRate : null;
          const deltaPct = deltaAbs !== null && hostawayRate ? deltaAbs / hostawayRate : null;

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
            ourBreakdown: result.breakdown as never,
            ourOccupancyMultiplier: occupancyMultiplier,
            keyDataForwardOcc: dailyMarket.marketForwardOccForDate ?? null,
            keyDataForwardAdr: fwd?.forwardADR ?? null,
            keyDataForwardOccLy: fwdLY?.forwardOccupancyLY ?? null,
            keyDataForwardAdrLy: fwdLY?.forwardADRLY ?? null
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
          const lifts = classifyDivergence({
            ourRate,
            plRate,
            ourBaseline,
            plBaseline,
            ourOccupancyMultiplier,
            marketForwardOcc,
            marketForwardOccLy,
            marketForwardAdr,
            marketForwardAdrLy
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
    meanDeltaPct: meanDelta,
    medianAbsDeltaPct: medianAbsDelta,
    largeDivergenceCount,
    divergenceCauseCounts,
    preOccAgreementWithin5Pct: preOccCellsRated > 0 ? preOccWithin5 / preOccCellsRated : 0,
    preOccAgreementWithin10Pct: preOccCellsRated > 0 ? preOccWithin10 / preOccCellsRated : 0,
    preOccCellsRated,
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
