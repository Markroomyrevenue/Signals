import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import {
  buildEffectivePricingAnchors,
  buildRecommendedBaseFromHistoryAndMarket,
  deriveOwnHistoryBaseSignal,
  getComparableMarketBenchmark,
  type PricingAnchorHistoryObservation
} from "@/lib/pricing/market-anchor";
import type { PricingMarketListingContext } from "@/lib/pricing/market-recommendations";
import {
  resolveOccupancyMultiplier,
  type PricingDayOfWeekAdjustment,
  type PricingGapNightAdjustment,
  type PricingLeadTimeAdjustment,
  type PricingLocalEvent,
  type PricingOccupancyScope,
  type PricingResolvedSettingsContext
} from "@/lib/pricing/settings";
import type { PricingCalendarCell, PricingCalendarResponse } from "@/lib/reports/pricing-calendar-types";
import {
  deriveCityFromListing,
  inferBedroomCount,
  listingAreaProfile,
  pricingConfidenceFromMarketContext,
  resolvePricingAdjustmentPct,
  resolvePricingAnchor,
  resolvePricingCalendarCellState,
  resolvePricingCalendarMarketData,
  type PricingAnchorCandidate
} from "@/lib/reports/pricing-domain";

type DailyTotals = {
  nights: number;
  revenueIncl: number;
  fees: number;
  inventoryNights: number;
};

type ListingMeta = {
  id: string;
  name: string;
  timezone: string;
  tags: string[];
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  publicAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  roomType: string | null;
  bedroomsNumber: number | null;
  bathroomsNumber: number | null;
  bedsNumber: number | null;
  personCapacity: number | null;
  guestsIncluded: number | null;
  minNights: number | null;
  cleaningFee: number | null;
  averageReviewRating: number | null;
};

type PricingCalendarCellStatus = {
  liveRate: number | null;
  available: boolean | null;
  minStay: number | null;
  maxStay: number | null;
};

type PricingCalendarHistory = {
  listingId: string;
  tags: string[];
  areaKey: string;
  areaLabel: string;
  bedroomCount: number | null;
  monthAdr: number | null;
  monthNights: number;
  weekdayAdrByWeekday: Map<number, number>;
  weekdayNightsByWeekday: Map<number, number>;
  currentMonthShortStayOccupancy: number | null;
  referenceMonthShortStayOccupancy: number | null;
  historicalAnchorObservations: PricingAnchorHistoryObservation[];
};

type PropertyDeepDiveRow = {
  listingId: string;
  listingName: string;
  health: "ahead" | "on_pace" | "behind";
  current: {
    nights: number;
    revenue: number;
    adr: number;
    occupancy: number;
  };
  reference: {
    nights: number;
    revenue: number;
    adr: number;
    occupancy: number;
  };
  delta: {
    nightsPct: number | null;
    revenuePct: number | null;
    adrPct: number | null;
    occupancyPts: number;
  };
  liveRate: number | null;
  liveVsCurrentAdrPct: number | null;
  liveVsReferenceAdrPct: number | null;
  pricing: {
    recommendedRate: number | null;
    anchorRate: number | null;
    historicalFloor: number | null;
    adjustmentPct: number | null;
    anchorSource: ReturnType<typeof resolvePricingAnchor>["anchorSource"];
    confidence: ReturnType<typeof resolvePricingAnchor>["confidence"];
    currentShortStayOccupancy: number | null;
    referenceShortStayOccupancy: number | null;
    note: string;
  };
};

type OccupancyTotals = {
  soldUnits: number;
  sellableUnits: number;
};

type PricingCalendarOccupancyMaps = {
  portfolioOccupancyByDate: Map<string, OccupancyTotals>;
  groupOccupancyByGroupDate: Map<string, Map<string, OccupancyTotals>>;
  propertyOccupancyByListingDate: Map<string, Map<string, OccupancyTotals>>;
};

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveRevenue(totals: DailyTotals, includeFees: boolean): number {
  if (includeFees) return totals.revenueIncl;
  return Math.max(0, totals.revenueIncl - totals.fees);
}

function resolveOccupancyPercent(totals: DailyTotals): number {
  if (totals.inventoryNights <= 0) return 0;
  const occupancy = (totals.nights / totals.inventoryNights) * 100;
  return roundTo2(Math.max(0, Math.min(100, occupancy)));
}

function computeDeltaPct(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return roundTo2(((current - previous) / previous) * 100);
}

function roundToIncrement(value: number | null, increment: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (!Number.isFinite(increment) || increment <= 1) return Math.round(value);
  return Math.round(value / increment) * increment;
}

function roundCurrencyOverride(value: number | null, increment: number): number | null {
  const rounded = roundToIncrement(value, increment);
  return rounded !== null ? roundTo2(rounded) : null;
}

function daysUntilDate(dateOnly: string, fromDateOnlyValue: string): number {
  return Math.round((fromDateOnly(dateOnly).getTime() - fromDateOnly(fromDateOnlyValue).getTime()) / (24 * 60 * 60 * 1000));
}

function monthNumberFromDateOnly(dateOnly: string): number {
  return Number(dateOnly.slice(5, 7));
}

function weekdayNumberFromDateOnly(dateOnly: string): number {
  return fromDateOnly(dateOnly).getUTCDay();
}

function manualSeasonalityAdjustmentPctForDate(
  adjustments: PricingDayOfWeekAdjustment[] | Array<{ month: number; adjustmentPct: number }>,
  dateOnly: string,
  fallbackPct: number,
  useDetailedAdjustments: boolean
): number {
  if (!useDetailedAdjustments) return fallbackPct;
  return (adjustments as Array<{ month: number; adjustmentPct: number }>).find((adjustment) => adjustment.month === monthNumberFromDateOnly(dateOnly))?.adjustmentPct ?? 0;
}

function manualDayOfWeekAdjustmentPctForDate(
  adjustments: PricingDayOfWeekAdjustment[],
  dateOnly: string,
  fallbackPct: number,
  useDetailedAdjustments: boolean
): number {
  if (!useDetailedAdjustments) return fallbackPct;
  return adjustments.find((adjustment) => adjustment.weekday === weekdayNumberFromDateOnly(dateOnly))?.adjustmentPct ?? 0;
}

function findLeadTimeAdjustment(rules: PricingLeadTimeAdjustment[], daysUntil: number): PricingLeadTimeAdjustment | null {
  return (
    [...rules]
      .sort((left, right) => left.maxDaysBefore - right.maxDaysBefore)
      .find((rule) => daysUntil >= rule.minDaysBefore && daysUntil <= rule.maxDaysBefore) ?? null
  );
}

function eventAdjustmentForDate(events: PricingLocalEvent[], dateOnly: string): PricingLocalEvent | null {
  return (
    events.find((event) => {
      if (event.dateSelectionMode === "multiple" && event.selectedDates && event.selectedDates.length > 0) {
        return event.selectedDates.includes(dateOnly);
      }
      return event.startDate <= dateOnly && event.endDate >= dateOnly;
    }) ?? null
  );
}

function gapAdjustmentForRun(rules: PricingGapNightAdjustment[], gapNights: number | null): PricingGapNightAdjustment | null {
  if (gapNights === null) return null;
  return rules.find((rule) => rule.gapNights === gapNights) ?? null;
}

function toPercentileRank(value: number | null, distribution: number[]): number | null {
  if (value === null || distribution.length === 0) return null;
  const lessOrEqual = distribution.filter((candidate) => candidate <= value).length;
  return Math.round((lessOrEqual / distribution.length) * 100);
}

function cloneEmptyTotals(): DailyTotals {
  return {
    nights: 0,
    revenueIncl: 0,
    fees: 0,
    inventoryNights: 0
  };
}

function deriveTypicalMinStay(calendarByDate: Map<string, PricingCalendarCellStatus>): number | null {
  const counts = new Map<number, number>();

  for (const cell of calendarByDate.values()) {
    if (cell.minStay === null || cell.minStay < 1) continue;
    counts.set(cell.minStay, (counts.get(cell.minStay) ?? 0) + 1);
  }

  let bestValue: number | null = null;
  let bestCount = -1;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount || (count === bestCount && (bestValue === null || value < bestValue))) {
      bestValue = value;
      bestCount = count;
    }
  }

  return bestValue;
}

function scoreRevenuePaceHealth(revenueDeltaPct: number | null): "ahead" | "on_pace" | "behind" {
  if (revenueDeltaPct === null) return "on_pace";
  if (revenueDeltaPct >= 5) return "ahead";
  if (revenueDeltaPct <= -5) return "behind";
  return "on_pace";
}

export function buildPropertyDeepDiveRows(params: {
  scopedListingIds: string[];
  listingMetadata: ListingMeta[];
  listingNameById: Map<string, string>;
  currentTotals: Map<string, DailyTotals>;
  referenceTotals: Map<string, DailyTotals>;
  paceStatusReferenceTotals: Map<string, DailyTotals>;
  lyStayedTotals: Map<string, DailyTotals>;
  liveRateByListing: Map<string, number>;
  liveRateByListingDate: Map<string, Map<string, number>>;
  currentByListingDaily: Map<string, Map<string, DailyTotals>>;
  currentShortStayTotals: Map<string, DailyTotals>;
  lyStayedShortStayTotals: Map<string, DailyTotals>;
  includeFees: boolean;
  periodMode: "past" | "future" | "mixed";
  periodStart: Date;
  periodEnd: Date;
  today: Date;
  daysUntilPeriodStart: number;
}): PropertyDeepDiveRow[] {
  const pricingCandidates: PricingAnchorCandidate[] = params.listingMetadata.map((listing) => {
    const referenceShortStayTotals = params.lyStayedShortStayTotals.get(listing.id) ?? cloneEmptyTotals();
    const referenceShortStayRevenue = resolveRevenue(referenceShortStayTotals, false);
    const referenceShortStayAdr =
      referenceShortStayTotals.nights > 0 ? roundTo2(referenceShortStayRevenue / referenceShortStayTotals.nights) : null;
    const areaProfile = listingAreaProfile(listing);

    return {
      listingId: listing.id,
      tags: listing.tags,
      areaKey: areaProfile.areaKey,
      bedroomCount: inferBedroomCount(listing),
      historyAdr: referenceShortStayAdr,
      historyNights: roundTo2(referenceShortStayTotals.nights)
    };
  });

  const rows: PropertyDeepDiveRow[] = params.scopedListingIds
    .map((listingId) => {
      const current = params.currentTotals.get(listingId) ?? cloneEmptyTotals();
      const reference = params.referenceTotals.get(listingId) ?? cloneEmptyTotals();
      const paceStatusReference = params.paceStatusReferenceTotals.get(listingId) ?? cloneEmptyTotals();
      const lyStayedReference = params.lyStayedTotals.get(listingId) ?? cloneEmptyTotals();

      const currentRevenue = resolveRevenue(current, params.includeFees);
      const referenceRevenue = resolveRevenue(reference, params.includeFees);
      const paceStatusReferenceRevenue = resolveRevenue(paceStatusReference, params.includeFees);
      const currentAdr = current.nights > 0 ? currentRevenue / current.nights : 0;
      const referenceAdr = reference.nights > 0 ? referenceRevenue / reference.nights : 0;
      const lyStayedRevenue = resolveRevenue(lyStayedReference, params.includeFees);
      const lyStayedAdr = lyStayedReference.nights > 0 ? lyStayedRevenue / lyStayedReference.nights : 0;
      const currentOccupancy = resolveOccupancyPercent(current);
      const referenceOccupancy = resolveOccupancyPercent(reference);

      const deltaRevenuePct = computeDeltaPct(currentRevenue, referenceRevenue);
      const paceStatusRevenueDeltaPct = computeDeltaPct(currentRevenue, paceStatusReferenceRevenue);
      const deltaNightsPct = computeDeltaPct(current.nights, reference.nights);
      const deltaAdrPct = computeDeltaPct(currentAdr, referenceAdr);
      const deltaOccupancyPts = roundTo2(currentOccupancy - referenceOccupancy);

      const health = scoreRevenuePaceHealth(paceStatusRevenueDeltaPct);

      const liveRate = params.liveRateByListing.get(listingId) ?? null;
      let remainingLiveRevenue = 0;
      let remainingLiveNights = 0;
      if (params.periodMode !== "past") {
        const listingCurrentDaily = params.currentByListingDaily.get(listingId) ?? new Map<string, DailyTotals>();
        const listingLiveRateByDate = params.liveRateByListingDate.get(listingId) ?? new Map<string, number>();
        for (let cursor = fromDateOnly(toDateOnly(params.periodStart)); cursor <= params.periodEnd; cursor = addUtcDays(cursor, 1)) {
          if (cursor <= params.today) continue;

          const dateKey = toDateOnly(cursor);
          const daily = listingCurrentDaily.get(dateKey) ?? cloneEmptyTotals();
          const inventoryNights = Math.max(daily.nights, daily.inventoryNights);
          const unbookedNights = Math.max(0, inventoryNights - daily.nights);
          if (unbookedNights <= 0) continue;

          const dayLiveRate = listingLiveRateByDate.get(dateKey);
          if (dayLiveRate === undefined) continue;

          remainingLiveNights += unbookedNights;
          remainingLiveRevenue += dayLiveRate * unbookedNights;
        }
      }

      const calendarAdr =
        current.nights + remainingLiveNights > 0
          ? roundTo2((currentRevenue + remainingLiveRevenue) / (current.nights + remainingLiveNights))
          : null;
      const listingMeta = params.listingMetadata.find((listing) => listing.id === listingId);
      const currentShortStay = params.currentShortStayTotals.get(listingId) ?? cloneEmptyTotals();
      const referenceShortStay = params.lyStayedShortStayTotals.get(listingId) ?? cloneEmptyTotals();
      const currentShortStayOccupancy = currentShortStay.inventoryNights > 0 ? resolveOccupancyPercent(currentShortStay) : null;
      const referenceShortStayOccupancy =
        referenceShortStay.inventoryNights > 0 ? resolveOccupancyPercent(referenceShortStay) : null;
      const referenceShortStayRevenue = resolveRevenue(referenceShortStay, false);
      const ownShortStayAdr = referenceShortStay.nights > 0 ? roundTo2(referenceShortStayRevenue / referenceShortStay.nights) : null;
      const listingAreaProfileValue = listingMeta ? listingAreaProfile(listingMeta) : { areaKey: "unknown", areaLabel: "Unknown" };
      const pricingAnchor = resolvePricingAnchor({
        listingId,
        listingTags: listingMeta?.tags ?? [],
        listingAreaKey: listingAreaProfileValue.areaKey,
        listingBedroomCount: listingMeta ? inferBedroomCount(listingMeta) : null,
        ownHistoryAdr: ownShortStayAdr,
        ownHistoryNights: roundTo2(referenceShortStay.nights),
        liveRate,
        candidates: pricingCandidates
      });
      const adjustmentPct =
        params.periodMode === "past"
          ? null
          : resolvePricingAdjustmentPct({
              daysUntilPeriodStart: params.daysUntilPeriodStart,
              currentOccupancy: currentShortStayOccupancy,
              referenceOccupancy: referenceShortStayOccupancy
            });
      const recommendedRate =
        params.periodMode === "past" || pricingAnchor.anchorRate === null
          ? null
          : roundTo2(pricingAnchor.anchorRate * (1 + (adjustmentPct ?? 0) / 100));
      const occupancyMessage =
        adjustmentPct === null
          ? "There is not enough short-stay occupancy history yet to apply a pacing adjustment."
          : adjustmentPct < 0
            ? "Short-stay pace is behind last year, so the recommendation leans more aggressive."
            : adjustmentPct > 0
              ? "Short-stay pace is ahead of last year, so the recommendation carries a premium."
              : "Short-stay pace is broadly in line with last year, so the recommendation stays close to the anchor.";
      const pricingNote =
        params.periodMode === "past"
          ? "Pricing guidance is only shown for mixed or forward-looking periods."
          : `${pricingAnchor.notePrefix} ${occupancyMessage} Excludes stays of 14+ nights and strips one-off cleaning and guest fees from the anchor.`;

      return {
        listingId,
        listingName: params.listingNameById.get(listingId) ?? listingId,
        health,
        current: {
          nights: roundTo2(current.nights),
          revenue: roundTo2(currentRevenue),
          adr: roundTo2(currentAdr),
          occupancy: currentOccupancy
        },
        reference: {
          nights: roundTo2(reference.nights),
          revenue: roundTo2(referenceRevenue),
          adr: roundTo2(referenceAdr),
          occupancy: referenceOccupancy
        },
        delta: {
          nightsPct: deltaNightsPct,
          revenuePct: deltaRevenuePct,
          adrPct: deltaAdrPct,
          occupancyPts: deltaOccupancyPts
        },
        liveRate,
        liveVsCurrentAdrPct: liveRate !== null ? computeDeltaPct(liveRate, currentAdr) : null,
        liveVsReferenceAdrPct: calendarAdr !== null ? computeDeltaPct(calendarAdr, lyStayedAdr) : null,
        pricing: {
          recommendedRate,
          anchorRate: pricingAnchor.anchorRate,
          historicalFloor: pricingAnchor.historicalFloor,
          adjustmentPct,
          anchorSource: pricingAnchor.anchorSource,
          confidence: pricingAnchor.confidence,
          currentShortStayOccupancy,
          referenceShortStayOccupancy,
          note: pricingNote
        }
      };
    })
    .filter(
      (row) =>
        row.current.nights > 0 ||
        row.current.revenue > 0 ||
        row.reference.nights > 0 ||
        row.reference.revenue > 0 ||
        row.liveRate !== null ||
        row.pricing.anchorRate !== null
    );

  rows.sort((a, b) => {
    const rank = (value: PropertyDeepDiveRow["health"]) => (value === "behind" ? 0 : value === "on_pace" ? 1 : 2);
    const healthSort = rank(a.health) - rank(b.health);
    if (healthSort !== 0) return healthSort;
    return (a.delta.revenuePct ?? 0) - (b.delta.revenuePct ?? 0);
  });

  return rows;
}

export function buildPricingCalendarHistoryByListingId(params: {
  listingMetadata: ListingMeta[];
  currentShortStayDaily: Map<string, Map<string, DailyTotals>>;
  lyShortStayDaily: Map<string, Map<string, DailyTotals>>;
  historicalAnchorObservationsByListingId: Map<string, PricingAnchorHistoryObservation[]>;
  monthStart: Date;
  monthEnd: Date;
  lyStart: Date;
  lyEnd: Date;
  daysInMonth: number;
  sumListingTotalsForRange: (args: {
    listingIds: string[];
    byListingDaily: Map<string, Map<string, DailyTotals>>;
    from: Date;
    to: Date;
  }) => Map<string, DailyTotals>;
}): Map<string, PricingCalendarHistory> {
  const pricingHistoryByListingId = new Map<string, PricingCalendarHistory>();

  for (const listing of params.listingMetadata) {
    const areaProfile = listingAreaProfile(listing);
    const bedroomCount = inferBedroomCount(listing);
    const currentTotals = params.sumListingTotalsForRange({
      listingIds: [listing.id],
      byListingDaily: params.currentShortStayDaily,
      from: params.monthStart,
      to: params.monthEnd
    }).get(listing.id) ?? cloneEmptyTotals();
    const lyTotals = params.sumListingTotalsForRange({
      listingIds: [listing.id],
      byListingDaily: params.lyShortStayDaily,
      from: params.lyStart,
      to: params.lyEnd
    }).get(listing.id) ?? cloneEmptyTotals();
    const lyRevenue = resolveRevenue(lyTotals, false);

    pricingHistoryByListingId.set(listing.id, {
      listingId: listing.id,
      tags: listing.tags,
      areaKey: areaProfile.areaKey,
      areaLabel: areaProfile.areaLabel,
      bedroomCount,
      monthAdr: lyTotals.nights > 0 ? roundTo2(lyRevenue / lyTotals.nights) : null,
      monthNights: roundTo2(lyTotals.nights),
      weekdayAdrByWeekday: new Map<number, number>(),
      weekdayNightsByWeekday: new Map<number, number>(),
      currentMonthShortStayOccupancy: roundTo2((currentTotals.nights / Math.max(1, params.daysInMonth)) * 100),
      referenceMonthShortStayOccupancy: lyTotals.nights > 0 ? roundTo2((lyTotals.nights / Math.max(1, params.daysInMonth)) * 100) : null,
      historicalAnchorObservations: params.historicalAnchorObservationsByListingId.get(listing.id) ?? []
    });
  }

  return pricingHistoryByListingId;
}

export function buildPricingCalendarOccupancyMaps(params: {
  listingMetadata: ListingMeta[];
  pricingSettingsByListingId: Map<string, PricingResolvedSettingsContext>;
  calendarCellsByListingDate: Map<string, Map<string, PricingCalendarCellStatus>>;
  bookedNightRatesByListingDate: Map<string, Map<string, number>>;
  monthDays: Date[];
}): PricingCalendarOccupancyMaps {
  const portfolioOccupancyByDate = new Map<string, OccupancyTotals>();
  const groupOccupancyByGroupDate = new Map<string, Map<string, OccupancyTotals>>();
  const propertyOccupancyByListingDate = new Map<string, Map<string, OccupancyTotals>>();

  for (const listing of params.listingMetadata) {
    const settingsContext = params.pricingSettingsByListingId.get(listing.id);
    const calendarByDate = params.calendarCellsByListingDate.get(listing.id) ?? new Map<string, PricingCalendarCellStatus>();
    const bookedByDate = params.bookedNightRatesByListingDate.get(listing.id) ?? new Map<string, number>();
    const listingOccupancy = new Map<string, OccupancyTotals>();

    for (const day of params.monthDays) {
      const dateKey = toDateOnly(day);
      const bookedRate = bookedByDate.get(dateKey) ?? null;
      const calendarCell = calendarByDate.get(dateKey) ?? {
        liveRate: null,
        available: null,
        minStay: null,
        maxStay: null
      };
      const state = resolvePricingCalendarCellState(bookedRate, calendarCell.available);
      const soldUnits = state === "booked" ? 1 : 0;
      const sellableUnits = state === "booked" || state === "available" ? 1 : 0;

      listingOccupancy.set(dateKey, { soldUnits, sellableUnits });
      propertyOccupancyByListingDate.set(listing.id, listingOccupancy);

      const portfolioTotals = portfolioOccupancyByDate.get(dateKey) ?? { soldUnits: 0, sellableUnits: 0 };
      portfolioTotals.soldUnits += soldUnits;
      portfolioTotals.sellableUnits += sellableUnits;
      portfolioOccupancyByDate.set(dateKey, portfolioTotals);

      if (settingsContext?.resolvedGroupKey) {
        const groupTotalsByDate = groupOccupancyByGroupDate.get(settingsContext.resolvedGroupKey) ?? new Map<string, OccupancyTotals>();
        const groupTotals = groupTotalsByDate.get(dateKey) ?? { soldUnits: 0, sellableUnits: 0 };
        groupTotals.soldUnits += soldUnits;
        groupTotals.sellableUnits += sellableUnits;
        groupTotalsByDate.set(dateKey, groupTotals);
        groupOccupancyByGroupDate.set(settingsContext.resolvedGroupKey, groupTotalsByDate);
      }
    }
  }

  return {
    portfolioOccupancyByDate,
    groupOccupancyByGroupDate,
    propertyOccupancyByListingDate
  };
}

export function buildPricingCalendarRows(params: {
  listingMetadata: ListingMeta[];
  pricingSettingsByListingId: Map<string, PricingResolvedSettingsContext>;
  pricingHistoryByListingId: Map<string, PricingCalendarHistory>;
  marketContexts: Map<string, PricingMarketListingContext>;
  calendarCellsByListingDate: Map<string, Map<string, PricingCalendarCellStatus>>;
  bookedNightRatesByListingDate: Map<string, Map<string, number>>;
  monthDays: Date[];
  occupancyMaps: PricingCalendarOccupancyMaps;
  todayDateOnlyValue: string;
  lastYearMonthStartDateOnly: string;
  lastYearMonthEndDateOnly: string;
  displayCurrency: string;
}): PricingCalendarResponse["rows"] {
  return params.listingMetadata.map((listing) => {
    const settingsContext = params.pricingSettingsByListingId.get(listing.id);
    if (!settingsContext) {
      throw new Error(`Missing pricing settings context for listing ${listing.id}`);
    }

    const listingHistory = params.pricingHistoryByListingId.get(listing.id) ?? {
      listingId: listing.id,
      tags: listing.tags,
      areaKey: listingAreaProfile(listing).areaKey,
      areaLabel: listingAreaProfile(listing).areaLabel,
      bedroomCount: inferBedroomCount(listing),
      monthAdr: null,
      monthNights: 0,
      weekdayAdrByWeekday: new Map<number, number>(),
      weekdayNightsByWeekday: new Map<number, number>(),
      currentMonthShortStayOccupancy: null,
      referenceMonthShortStayOccupancy: null,
      historicalAnchorObservations: []
    };
    const marketContext = params.marketContexts.get(listing.id) ?? null;
    const derivedCity = deriveCityFromListing(listing);
    const hasResolvableLocation = derivedCity !== "Unknown" || listing.latitude !== null || listing.longitude !== null;
    const calendarByDate = params.calendarCellsByListingDate.get(listing.id) ?? new Map<string, PricingCalendarCellStatus>();
    const bookedByDate = params.bookedNightRatesByListingDate.get(listing.id) ?? new Map<string, number>();
    const typicalMinStay = deriveTypicalMinStay(calendarByDate) ?? Math.max(2, listing.minNights ?? 2);
    const rowHistoryFloor =
      listingHistory.monthAdr !== null && listingHistory.monthNights >= 7 ? roundTo2(listingHistory.monthAdr) : null;
    const fallbackBaseValue =
      rowHistoryFloor !== null ? roundToIncrement(rowHistoryFloor, settingsContext.settings.roundingIncrement) : null;
    const fallbackMinimumValue =
      fallbackBaseValue !== null
        ? roundToIncrement(
            Math.min(
              fallbackBaseValue * settingsContext.settings.minimumPriceFactor,
              fallbackBaseValue * (1 - settingsContext.settings.minimumPriceAbsoluteGapPct / 100)
            ),
            settingsContext.settings.roundingIncrement
          )
        : null;
    let basePriceSuggestion = marketContext?.baseSuggested ?? {
      value: fallbackBaseValue,
      source: rowHistoryFloor !== null ? "listing_history_fallback" : "insufficient_data",
      breakdown: [
        { label: "History ADR", amount: rowHistoryFloor, unit: "currency" as const },
        { label: "Final", amount: fallbackBaseValue, unit: "currency" as const }
      ]
    };
    let minimumPriceSuggestion = marketContext?.minimumSuggested ?? {
      value: fallbackMinimumValue,
      source: rowHistoryFloor !== null ? "listing_history_fallback" : "insufficient_data",
      breakdown: [
        { label: "Base", amount: fallbackBaseValue, unit: "currency" as const },
        { label: "Floor factor", amount: settingsContext.settings.minimumPriceFactor, unit: "multiplier" as const },
        { label: "Final", amount: fallbackMinimumValue, unit: "currency" as const }
      ]
    };
    const manualBaseValue = roundCurrencyOverride(settingsContext.settings.basePriceOverride, settingsContext.settings.roundingIncrement);
    const manualMinimumValue = roundCurrencyOverride(settingsContext.settings.minimumPriceOverride, settingsContext.settings.roundingIncrement);
    const ownHistorySignal = deriveOwnHistoryBaseSignal({
      observations: listingHistory.historicalAnchorObservations,
      targetDates: params.monthDays.map((day) => toDateOnly(day)),
      samePeriodStartDate: params.lastYearMonthStartDateOnly,
      samePeriodEndDate: params.lastYearMonthEndDateOnly,
      todayDateOnly: params.todayDateOnlyValue,
      preferredLosNights: typicalMinStay,
      displayCurrency: params.displayCurrency
    });

    if (!hasResolvableLocation && manualBaseValue === null && ownHistorySignal.ownHistoryBasePrice === null) {
      basePriceSuggestion = {
        value: null,
        source: "insufficient_data",
        breakdown: [{ label: "Location required", amount: null, unit: "currency" as const }]
      };
      minimumPriceSuggestion = {
        value: null,
        source: "insufficient_data",
        breakdown: [{ label: "Location required", amount: null, unit: "currency" as const }]
      };
    }
    const systemRecommendedBasePrice = basePriceSuggestion.value;
    const provisionalRecommendedBasePrice = ownHistorySignal.provisionalRecommendedBasePrice ?? systemRecommendedBasePrice;
    const subjectProfile = {
      listingId: listing.id,
      listingName: listing.name,
      marketLabel: marketContext?.marketLabel ?? (derivedCity !== "Unknown" ? derivedCity : null),
      country: listing.country,
      region: listing.state,
      locality: listing.city,
      district: null,
      roomType: listing.roomType,
      bedroomsNumber: listing.bedroomsNumber,
      personCapacity: listing.personCapacity,
      propertySize: null,
      qualityTier: settingsContext.settings.qualityTier
    };
    // Market benchmarks are derived entirely from cached comparable pricing data and cached
    // listing metadata, so manual overrides can be market-aware without triggering live fetches.
    const marketBenchmark = getComparableMarketBenchmark({
      subject: subjectProfile,
      comparables: marketContext?.anchorBenchmarkComparables ?? [],
      provisionalBasePrice: provisionalRecommendedBasePrice,
      displayCurrency: params.displayCurrency
    });
    const finalRecommendedBasePrice = buildRecommendedBaseFromHistoryAndMarket({
      ownHistoryBasePrice: ownHistorySignal.ownHistoryBasePrice,
      ownHistoryConfidence: ownHistorySignal.ownHistoryConfidence,
      marketBenchmarkBasePrice: marketBenchmark.marketBenchmarkBasePrice,
      fallbackBasePrice: systemRecommendedBasePrice,
      roundingIncrement: settingsContext.settings.roundingIncrement
    }).finalRecommendedBasePrice;
    basePriceSuggestion = {
      value: finalRecommendedBasePrice,
      source: basePriceSuggestion.source,
      breakdown: [
        ...(ownHistorySignal.ownHistoryBasePrice !== null
          ? [{ label: "Own history", amount: ownHistorySignal.ownHistoryBasePrice, unit: "currency" as const }]
          : []),
        ...(marketBenchmark.marketBenchmarkBasePrice !== null
          ? [{ label: "Market benchmark", amount: marketBenchmark.marketBenchmarkBasePrice, unit: "currency" as const }]
          : []),
        ...(systemRecommendedBasePrice !== null && systemRecommendedBasePrice !== finalRecommendedBasePrice
          ? [{ label: "Roomy Recommended base", amount: systemRecommendedBasePrice, unit: "currency" as const }]
          : []),
        { label: "Final", amount: finalRecommendedBasePrice, unit: "currency" as const }
      ]
    };
    const derivedMinimumFromRecommendedBase =
      finalRecommendedBasePrice !== null
        ? roundToIncrement(
            Math.min(
              finalRecommendedBasePrice * settingsContext.settings.minimumPriceFactor,
              finalRecommendedBasePrice * (1 - settingsContext.settings.minimumPriceAbsoluteGapPct / 100)
            ),
            settingsContext.settings.roundingIncrement
          )
        : null;
    const alignedRecommendedMinimumValue =
      minimumPriceSuggestion.value !== null && finalRecommendedBasePrice !== null
        ? roundToIncrement(
            Math.min(minimumPriceSuggestion.value, finalRecommendedBasePrice * 0.95),
            settingsContext.settings.roundingIncrement
          )
        : minimumPriceSuggestion.value ?? derivedMinimumFromRecommendedBase;
    minimumPriceSuggestion = {
      value: alignedRecommendedMinimumValue,
      source: minimumPriceSuggestion.source,
      breakdown: [
        ...(minimumPriceSuggestion.value !== null
          ? [{ label: "Roomy Recommended minimum", amount: minimumPriceSuggestion.value, unit: "currency" as const }]
          : []),
        ...(derivedMinimumFromRecommendedBase !== null
          ? [{ label: "Base-derived floor", amount: derivedMinimumFromRecommendedBase, unit: "currency" as const }]
          : []),
        ...(finalRecommendedBasePrice !== null
          ? [{ label: "Base alignment cap", amount: roundTo2(finalRecommendedBasePrice * 0.95), unit: "currency" as const }]
          : []),
        { label: "Final", amount: alignedRecommendedMinimumValue, unit: "currency" as const }
      ]
    };
    // Recommended values stay as the system recommendation. Current/raw/effective anchors are
    // modelled separately so the UI can show the user's saved override without changing the
    // downstream formula or pretending the market safeguard does not exist.
    const pricingAnchors = buildEffectivePricingAnchors({
      subject: subjectProfile,
      rawUserBasePrice: manualBaseValue,
      rawUserMinimumPrice: manualMinimumValue,
      recommendedBasePrice: basePriceSuggestion.value,
      recommendedMinimumPrice: minimumPriceSuggestion.value,
      ownHistoryBasePrice: ownHistorySignal.ownHistoryBasePrice,
      ownHistoryConfidence: ownHistorySignal.ownHistoryConfidence,
      ownHistorySampleSize: ownHistorySignal.ownHistorySampleSize,
      ownHistoryExplanation: ownHistorySignal.ownHistoryExplanation,
      ownHistorySummaryText: ownHistorySignal.ownHistorySummaryText,
      ownHistoryConfidenceLabel: ownHistorySignal.ownHistoryConfidenceLabel,
      provisionalRecommendedBasePrice,
      finalRecommendedBasePrice,
      marketBenchmarkBasePrice: marketBenchmark.marketBenchmarkBasePrice,
      marketBenchmarkMinimumPrice: marketBenchmark.marketBenchmarkMinimumPrice,
      comparatorCount: marketBenchmark.comparatorCount,
      comparatorConfidence: marketBenchmark.comparatorConfidence,
      pricePositionedComparatorCount: marketBenchmark.pricePositionedComparatorCount,
      pricePositionedComparatorConfidence: marketBenchmark.pricePositionedComparatorConfidence,
      pricePositioningSummaryText: marketBenchmark.pricePositioningSummaryText,
      marketRangeLow: marketBenchmark.marketRangeLow,
      marketRangeHigh: marketBenchmark.marketRangeHigh,
      marketMedianComparableBase: marketBenchmark.marketMedianComparableBase,
      displayCurrency: params.displayCurrency
    });
    const rowBasePrice = pricingAnchors.effectiveBasePrice;
    const rowMinimumPrice = pricingAnchors.effectiveMinimumPrice;
    const rowMaximumPrice = null;
    const rowAnchorBaseSource = manualBaseValue !== null ? "manual_override" : basePriceSuggestion.source;
    const confidence = pricingConfidenceFromMarketContext(marketContext?.comparableCount ?? 0, rowAnchorBaseSource);
    const marketData = resolvePricingCalendarMarketData({
      hasMarketContext: marketContext !== undefined && marketContext !== null,
      hasResolvableLocation,
      basePriceValue: rowBasePrice
    });

    const rawCellContexts = params.monthDays.map((day) => {
      const dateKey = toDateOnly(day);
      const bookedRate = bookedByDate.get(dateKey) ?? null;
      const calendarCell = calendarByDate.get(dateKey) ?? {
        liveRate: null,
        available: null,
        minStay: null,
        maxStay: null
      };
      const marketDay = marketContext?.days.get(dateKey) ?? null;
      const state = resolvePricingCalendarCellState(bookedRate, calendarCell.available);
      return {
        dateKey,
        bookedRate,
        calendarCell,
        marketDay,
        state
      };
    });
    const gapRunLengths = rawCellContexts.map((cellContext, index) => {
      if (cellContext.state === "booked") return null;
      let start = index;
      let end = index;
      while (start > 0 && rawCellContexts[start - 1]?.state !== "booked") start -= 1;
      while (end < rawCellContexts.length - 1 && rawCellContexts[end + 1]?.state !== "booked") end += 1;
      return end - start + 1;
    });

    const cells = rawCellContexts.map((cellContext, index) => {
      const { dateKey, bookedRate, calendarCell, marketDay } = cellContext;
      const state = cellContext.state === "unknown" && dateKey >= params.todayDateOnlyValue ? "unavailable" : cellContext.state;
      const effectiveMinStay = Math.max(1, calendarCell.minStay ?? 1, settingsContext.settings.minimumNightStay ?? 1, typicalMinStay);
      const requestedOccupancyScope = settingsContext.settings.occupancyScope;
      const effectiveOccupancyScope: PricingOccupancyScope =
        requestedOccupancyScope === "group" && settingsContext.resolvedGroupKey ? "group" : "portfolio";
      const scopeTotals =
        effectiveOccupancyScope === "portfolio"
          ? params.occupancyMaps.portfolioOccupancyByDate.get(dateKey) ?? { soldUnits: 0, sellableUnits: 0 }
          : effectiveOccupancyScope === "group"
            ? params.occupancyMaps.groupOccupancyByGroupDate.get(settingsContext.resolvedGroupKey ?? "")?.get(dateKey) ?? { soldUnits: 0, sellableUnits: 0 }
            : params.occupancyMaps.propertyOccupancyByListingDate.get(listing.id)?.get(dateKey) ?? { soldUnits: 0, sellableUnits: 0 };
      const dailyOccupancyPct = scopeTotals.sellableUnits > 0 ? roundTo2((scopeTotals.soldUnits / scopeTotals.sellableUnits) * 100) : null;
      const occupancyMultiplier = resolveOccupancyMultiplier(settingsContext.settings, dailyOccupancyPct);
      const rawSeasonalityMultiplier = marketDay?.seasonalityMultiplier ?? 1;
      const rawDayOfWeekMultiplier = marketDay?.dayOfWeekMultiplier ?? 1;
      const rawMarketDemandMultiplier = marketDay?.demandMultiplier ?? 1;
      const paceMultiplier = marketDay?.paceMultiplier ?? 1;
      const seasonalityManualAdjustmentPct =
        settingsContext.settings.seasonalityManualAdjustmentEnabled
          ? manualSeasonalityAdjustmentPctForDate(
              settingsContext.settings.seasonalityMonthlyAdjustments,
              dateKey,
              settingsContext.settings.seasonalityManualAdjustmentPct,
              settingsContext.sources.seasonalityMonthlyAdjustments !== "default"
            )
          : 0;
      const dayOfWeekManualAdjustmentPct =
        settingsContext.settings.dayOfWeekManualAdjustmentEnabled
          ? manualDayOfWeekAdjustmentPctForDate(
              settingsContext.settings.dayOfWeekAdjustments,
              dateKey,
              settingsContext.settings.dayOfWeekManualAdjustmentPct,
              settingsContext.sources.dayOfWeekAdjustments !== "default"
            )
          : 0;
      const seasonalityManualMultiplier = settingsContext.settings.seasonalityManualAdjustmentEnabled ? 1 + seasonalityManualAdjustmentPct / 100 : 1;
      const dayOfWeekManualMultiplier = settingsContext.settings.dayOfWeekManualAdjustmentEnabled ? 1 + dayOfWeekManualAdjustmentPct / 100 : 1;
      const demandManualMultiplier = settingsContext.settings.demandManualAdjustmentEnabled ? 1 + settingsContext.settings.demandManualAdjustmentPct / 100 : 1;
      const seasonalityMultiplier = roundTo2(rawSeasonalityMultiplier * seasonalityManualMultiplier);
      const dayOfWeekMultiplier = roundTo2(rawDayOfWeekMultiplier * dayOfWeekManualMultiplier);
      const marketDemandMultiplier = roundTo2(rawMarketDemandMultiplier * demandManualMultiplier);
      const localEvent = eventAdjustmentForDate(settingsContext.settings.localEvents, dateKey);
      const localEventMultiplier = localEvent ? roundTo2(1 + localEvent.adjustmentPct / 100) : 1;
      const leadTimeRule = findLeadTimeAdjustment(settingsContext.settings.lastMinuteAdjustments, daysUntilDate(dateKey, params.todayDateOnlyValue));
      const leadTimeMultiplier = leadTimeRule ? roundTo2(1 + leadTimeRule.adjustmentPct / 100) : 1;
      const gapRule = gapAdjustmentForRun(settingsContext.settings.gapNightAdjustments, gapRunLengths[index]);
      const gapMultiplier = gapRule ? roundTo2(1 + gapRule.adjustmentPct / 100) : 1;
      const benchmarkFloor =
        rowHistoryFloor !== null && settingsContext.settings.lastYearBenchmarkFloorPct !== null
          ? roundToIncrement(
              rowHistoryFloor * (settingsContext.settings.lastYearBenchmarkFloorPct / 100),
              settingsContext.settings.roundingIncrement
            )
          : null;

      let recommendedRate =
        state !== "booked" && rowBasePrice !== null
          ? rowBasePrice *
            seasonalityMultiplier *
            dayOfWeekMultiplier *
            marketDemandMultiplier *
            localEventMultiplier *
            leadTimeMultiplier *
            gapMultiplier *
            (occupancyMultiplier ?? 1) *
            paceMultiplier
          : null;
      if (recommendedRate !== null && rowMinimumPrice !== null) {
        recommendedRate = Math.max(recommendedRate, rowMinimumPrice);
      }
      if (recommendedRate !== null && benchmarkFloor !== null) {
        recommendedRate = Math.max(recommendedRate, benchmarkFloor);
      }
      if (recommendedRate !== null && rowMaximumPrice !== null) {
        recommendedRate = Math.min(recommendedRate, rowMaximumPrice);
      }
      recommendedRate = roundToIncrement(recommendedRate, settingsContext.settings.roundingIncrement);
      if (recommendedRate !== null && rowMinimumPrice !== null) {
        recommendedRate = Math.max(recommendedRate, rowMinimumPrice);
      }
      if (recommendedRate !== null && benchmarkFloor !== null) {
        recommendedRate = Math.max(recommendedRate, benchmarkFloor);
      }
      if (recommendedRate !== null && rowMaximumPrice !== null) {
        recommendedRate = Math.min(recommendedRate, rowMaximumPrice);
      }
      recommendedRate = recommendedRate !== null ? roundTo2(recommendedRate) : null;

      const adjustmentPct =
        rowBasePrice !== null && rowBasePrice > 0 && recommendedRate !== null
          ? roundTo2(((recommendedRate - rowBasePrice) / rowBasePrice) * 100)
          : null;
      const livePercentile =
        marketDay?.comparisonRates && marketDay.comparisonRates.length > 0
          ? toPercentileRank(calendarCell.liveRate, marketDay.comparisonRates)
          : null;
      const recommendedPercentile =
        marketDay?.comparisonRates && marketDay.comparisonRates.length > 0
          ? toPercentileRank(recommendedRate, marketDay.comparisonRates)
          : null;
      const breakdown =
        state !== "booked" && recommendedRate !== null
          ? [
              { label: "Base", amount: rowBasePrice, unit: "currency" as const },
              { label: "Seasonality", amount: seasonalityMultiplier, unit: "multiplier" as const },
              { label: "DOW", amount: dayOfWeekMultiplier, unit: "multiplier" as const },
              { label: "Demand", amount: marketDemandMultiplier, unit: "multiplier" as const },
              ...(localEvent ? [{ label: localEvent.name, amount: localEventMultiplier, unit: "multiplier" as const }] : []),
              ...(leadTimeRule ? [{ label: "Last minute", amount: leadTimeMultiplier, unit: "multiplier" as const }] : []),
              ...(gapRule ? [{ label: `${gapRule.gapNights}n gap`, amount: gapMultiplier, unit: "multiplier" as const }] : []),
              { label: "Occupancy", amount: dailyOccupancyPct, unit: "percent" as const },
              { label: "Occ mult", amount: occupancyMultiplier ?? 1, unit: "multiplier" as const },
              { label: "Pace", amount: paceMultiplier, unit: "multiplier" as const },
              ...(benchmarkFloor !== null ? [{ label: "LY floor", amount: benchmarkFloor, unit: "currency" as const }] : []),
              ...(rowMinimumPrice !== null ? [{ label: "Min", amount: rowMinimumPrice, unit: "currency" as const }] : []),
              ...(rowMaximumPrice !== null ? [{ label: "Max", amount: rowMaximumPrice, unit: "currency" as const }] : []),
              { label: "Final", amount: recommendedRate, unit: "currency" as const }
            ]
          : [];

      return {
        date: dateKey,
        state,
        liveRate: calendarCell.liveRate,
        bookedRate,
        available: calendarCell.available,
        minStay: effectiveMinStay,
        maxStay: calendarCell.maxStay,
        recommendedRate,
        recommendedBaseRate: rowBasePrice,
        minimumSuggestedRate: rowMinimumPrice,
        anchorRate: rowBasePrice,
        areaAverageRate: marketContext?.yearlyMedianRate ?? rowHistoryFloor,
        baseSource: rowAnchorBaseSource,
        marketMedianRate: marketDay?.comparableMedianRate ?? null,
        historicalFloor: benchmarkFloor ?? rowMinimumPrice,
        adjustmentPct,
        anchorSource: rowAnchorBaseSource,
        confidence,
        currentMonthShortStayOccupancy: listingHistory.currentMonthShortStayOccupancy,
        referenceMonthShortStayOccupancy: listingHistory.referenceMonthShortStayOccupancy,
        marketOccupancy: marketDay?.marketOccupancy ?? null,
        marketAverageDailyRate: marketDay?.marketAverageDailyRate ?? null,
        marketFuturePacing: marketDay?.marketFuturePacing ?? null,
        seasonalityPct: marketDay?.seasonalityPct ?? null,
        seasonalityMultiplier,
        dayOfWeekPct: marketDay?.dayOfWeekPct ?? null,
        dayOfWeekMultiplier,
        marketDemandTier: marketDay?.marketDemandTier ?? "normal",
        marketDemandIndex: marketDay?.marketDemandIndex ?? 0,
        marketDemandMultiplier,
        dailyOccupancyPct,
        occupancyMultiplier,
        paceMultiplier,
        maximumPrice: rowMaximumPrice,
        effectiveOccupancyScope,
        comparableCount: marketContext?.comparableCount ?? 0,
        comparableRateCount: marketDay?.comparableRateCount ?? 0,
        recommendedPercentile,
        livePercentile,
        demandBand: marketDay?.demandBand ?? 3,
        breakdown
      } satisfies PricingCalendarCell;
    });

    return {
      listingId: listing.id,
      listingName: listing.name,
      marketLabel: marketContext?.marketLabel ?? (derivedCity !== "Unknown" ? derivedCity : null),
      marketScopeLabel: marketContext?.marketScopeLabel ?? null,
      comparableCount: marketContext?.comparableCount ?? 0,
      comparisonLosNights: marketContext?.comparisonLosNights ?? null,
      marketDataStatus: marketData.status,
      marketDataMessage: marketData.message,
      basePriceSuggestion,
      minimumPriceSuggestion,
      pricingAnchors,
      settings: {
        resolvedGroupName: settingsContext.resolvedGroupName,
        qualityTier: settingsContext.settings.qualityTier,
        occupancyScope: settingsContext.settings.occupancyScope === "group" && settingsContext.resolvedGroupKey ? "group" : "portfolio",
        seasonalitySensitivityMode: settingsContext.settings.seasonalitySensitivityMode,
        dayOfWeekSensitivityMode: settingsContext.settings.dayOfWeekSensitivityMode,
        demandSensitivityMode: settingsContext.settings.demandSensitivityMode,
        paceEnabled: settingsContext.settings.paceEnabled,
        sources: {
          basePriceOverride: settingsContext.sources.basePriceOverride,
          minimumPriceOverride: settingsContext.sources.minimumPriceOverride,
          qualityTier: settingsContext.sources.qualityTier,
          minimumPriceFactor: settingsContext.sources.minimumPriceFactor,
          seasonalitySensitivityMode: settingsContext.sources.seasonalitySensitivityMode,
          dayOfWeekSensitivityMode: settingsContext.sources.dayOfWeekSensitivityMode,
          demandSensitivityMode: settingsContext.sources.demandSensitivityMode,
          occupancyScope: settingsContext.sources.occupancyScope,
          paceEnabled: settingsContext.sources.paceEnabled,
          roundingIncrement: settingsContext.sources.roundingIncrement
        }
      },
      cells
    };
  });
}
