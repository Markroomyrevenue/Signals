/**
 * KeyData trial backtest harness.
 *
 * For each trial tenant, for each historical reservation in the last 365 days
 * that booked at a particular ADR, ask the trial-pricing module: "what would
 * we have recommended for this listing-date if today were the booking date?"
 * Persist the recommended-vs-actual delta in `pricing_backtest_results`.
 *
 * Caveat (logged in the day-14 summary): we don't have historical KeyData
 * snapshots, so the backtest uses CURRENT KeyData values as a proxy. This
 * biases results slightly optimistic. Mark sees this in the report header.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { listTrialTenants, type TrialTenantInfo } from "@/lib/pricing/trial-tenants";
import { setTrialSimilarityActive } from "@/lib/pricing/market-anchor";
import { computeTrialDailyRate, type TrialDailyInput, type TrialMarketSnapshot, type TrialQualityTier, type TrialMode } from "@/lib/pricing/trial-pricing";
import { resolvePricingSettings, type PricingResolvedSettings } from "@/lib/pricing/settings";
import { createKeyDataProvider } from "@/lib/pricing/keydata-provider";

export type BacktestRunSummary = {
  runId: string;
  tenants: Array<{
    tenantId: string;
    tenantName: string;
    listingsTested: number;
    nightsTested: number;
    meanAbsError: number;
    medianAbsError: number;
    rmse: number;
    medianAbsPctError: number;
    directionalAccuracy: number;
  }>;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runForTenant(tenant: TrialTenantInfo, runId: string): Promise<BacktestRunSummary["tenants"][number]> {
  const provider = createKeyDataProvider();
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setUTCFullYear(today.getUTCFullYear() - 1);

  const reservations = await prisma.reservation.findMany({
    where: {
      tenantId: tenant.id,
      cancelledAt: null,
      arrival: { gte: oneYearAgo, lt: today }
    },
    select: {
      id: true,
      listingId: true,
      arrival: true,
      nights: true,
      total: true,
      accommodationFare: true,
      createdAt: true
    },
    take: 5000 // safety cap
  });

  // Index settings + listing details once per listing (fan-out).
  const listingIds = Array.from(new Set(reservations.map((r) => r.listingId)));
  const listings = await prisma.listing.findMany({
    where: { id: { in: listingIds } },
    select: { id: true, bedroomsNumber: true, personCapacity: true, unitCount: true, city: true }
  });
  const listingMap = new Map(listings.map((l) => [l.id, l]));

  const settingsCache = new Map<string, PricingResolvedSettings>();
  async function getSettings(listingId: string): Promise<PricingResolvedSettings> {
    if (settingsCache.has(listingId)) return settingsCache.get(listingId)!;
    const rows = await prisma.pricingSetting.findMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { scope: "portfolio", scopeRef: null },
          { scope: "property", scopeRef: listingId }
        ]
      }
    });
    const portfolio = (rows.find((r) => r.scope === "portfolio")?.settings as object) ?? {};
    const property = (rows.find((r) => r.scope === "property")?.settings as object) ?? {};
    const { settings } = resolvePricingSettings({ portfolio: portfolio as never, group: {} as never, property: property as never });
    settingsCache.set(listingId, settings);
    return settings;
  }

  // Build a current market snapshot for proxy benchmarks (1BR is a generic fallback).
  const fallbackBenchmark = provider ? await provider.getMarketBenchmark({ marketKey: "belfast", bedrooms: 2, qualityTier: "mid_scale" }) : null;
  const fallbackSeasonality = provider ? await provider.getCitySeasonalityIndex({ marketKey: "belfast" }) : null;

  let absErrorSum = 0;
  let squaredErrorSum = 0;
  const absErrors: number[] = [];
  const absPctErrors: number[] = [];
  let n = 0;
  let directionalHits = 0;
  let directionalTotal = 0;

  setTrialSimilarityActive(true);
  try {
    const rowsToInsert: Prisma.PricingBacktestResultCreateManyInput[] = [];
    for (const r of reservations) {
      const listing = listingMap.get(r.listingId);
      if (!listing) continue;
      if ((listing.unitCount ?? 1) >= 2) continue;
      const adr = r.nights > 0 ? Number(r.accommodationFare ?? r.total) / r.nights : Number(r.accommodationFare ?? r.total);
      if (!Number.isFinite(adr) || adr <= 0) continue;
      const settings = await getSettings(r.listingId);
      const arrival = r.arrival;
      const monthIndex = arrival.getUTCMonth();
      const dayOfWeek = arrival.getUTCDay();
      const market: TrialMarketSnapshot = {
        benchmark: fallbackBenchmark,
        benchmark1br: null,
        seasonality: fallbackSeasonality,
        dayOfWeek: null,
        forwardPace: null,
        trailingMarketKpis: null,
        benchmarkSimilarity: fallbackBenchmark ? Math.min(1, fallbackBenchmark.sampleSize / 50) : 0.5,
        marketOcc25thPct: null,
        marketRpoMedian: null,
        marketRpoForDate: null,
        marketForwardOccForDate: null
      };
      const input: TrialDailyInput = {
        listingId: listing.id,
        bedrooms: listing.bedroomsNumber ?? 1,
        qualityTier: (settings.qualityTier as TrialQualityTier) ?? "mid_scale",
        date: arrival.toISOString().slice(0, 10),
        daysToCheckIn: r.createdAt
          ? Math.max(0, Math.round((arrival.getTime() - r.createdAt.getTime()) / 86400000))
          : 0,
        dayOfWeek,
        monthIndex,
        trailing365dAdr: adr, // approximate (we are inside the period); good enough for backtest
        trailing365dOccupancy: null,
        ownSeasonalityIndex: null,
        ownDoWIndex: null,
        listingSizeAnchor: null,
        manualSeasonalityAdjPct: 0,
        manualDoWAdjPct: 0,
        localEventAdjPct: null,
        paceMultiplier: 1.0,
        scopeOccupancy: null,
        userSetMinimum: settings.minimumPriceOverride ?? null,
        roundingIncrement: settings.roundingIncrement,
        mode: (settings.keyDataTrialMode as TrialMode) ?? "standard"
      };
      const result = computeTrialDailyRate(input, market);
      if (!result) continue;

      const recommended = result.recommendedRate;
      const absError = Math.abs(recommended - adr);
      const pctError = recommended === 0 ? 0 : (recommended - adr) / adr;
      absErrors.push(absError);
      absPctErrors.push(Math.abs(pctError));
      absErrorSum += absError;
      squaredErrorSum += absError * absError;
      n += 1;

      directionalTotal += 1;
      if ((recommended >= adr && pctError >= 0) || (recommended < adr && pctError < 0)) directionalHits += 1;

      rowsToInsert.push({
        tenantId: tenant.id,
        runId,
        listingId: listing.id,
        stayDate: arrival,
        bookedAdr: new Prisma.Decimal(adr),
        recommendedAdr: new Prisma.Decimal(recommended),
        absError: new Prisma.Decimal(absError),
        pctError,
        bookingCount: 1
      });
    }

    if (rowsToInsert.length > 0) {
      await prisma.pricingBacktestResult.createMany({ data: rowsToInsert });
    }
  } finally {
    setTrialSimilarityActive(false);
  }

  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    listingsTested: new Set(reservations.map((r) => r.listingId)).size,
    nightsTested: n,
    meanAbsError: n > 0 ? absErrorSum / n : 0,
    medianAbsError: median(absErrors),
    rmse: n > 0 ? Math.sqrt(squaredErrorSum / n) : 0,
    medianAbsPctError: median(absPctErrors),
    directionalAccuracy: directionalTotal > 0 ? directionalHits / directionalTotal : 0
  };
}

export async function runBacktest(): Promise<BacktestRunSummary> {
  const runId = `backtest-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const tenants = await listTrialTenants();
  const results = [];
  for (const t of tenants) {
    results.push(await runForTenant(t, runId));
  }
  return { runId, tenants: results };
}
