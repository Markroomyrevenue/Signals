import { Prisma } from "@prisma/client";

import { FxConverter } from "@/lib/fx";
import { expandChannelFilterValues } from "@/lib/hostaway/normalize";
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import type { PricingAnchorHistoryObservation } from "@/lib/pricing/market-anchor";
import { buildMarketPricingContexts } from "@/lib/pricing/market-recommendations";
import {
  DEFAULT_PRICING_SETTINGS,
  PricingDayOfWeekAdjustment,
  PricingDemandTier,
  PricingGapNightAdjustment,
  PricingLeadTimeAdjustment,
  PricingLocalEvent,
  PricingOccupancyScope,
  PricingQualityTier,
  PricingSeasonalityAdjustment,
  PricingSensitivityMode,
  PricingSettingSource,
  loadResolvedPricingSettings,
  resolveOccupancyMultiplier
} from "@/lib/pricing/settings";
import { prisma } from "@/lib/prisma";
import type {
  PricingCalendarCell,
  PricingCalendarResponse,
  PricingConfidence
} from "@/lib/reports/pricing-calendar-types";
import {
  buildPricingCalendarHistoryByListingId,
  buildPricingCalendarOccupancyMaps,
  buildPricingCalendarRows,
  buildPropertyDeepDiveRows
} from "@/lib/reports/pricing-report-assembly";
import {
  cityFromAddress,
  deriveCityFromListing,
  inferBedroomCount,
  listingAreaProfile,
  pricingConfidenceFromMarketContext,
  resolvePricingAdjustmentPct,
  resolvePricingAnchor,
  resolvePricingCalendarCellState,
  resolvePricingCalendarMarketData,
  type PricingAnchorCandidate,
  type PricingAnchorSource
} from "@/lib/reports/pricing-domain";
import {
  BookWindowRequest,
  HomeDashboardRequest,
  PricingCalendarRequest,
  PropertyDeepDiveRequest,
  ReservationsReportRequest,
  ReportsRequest
} from "@/lib/reports/schemas";

type Granularity = ReportsRequest["granularity"];
type BookWindowMode = BookWindowRequest["mode"];
type PropertyDeepDiveGranularity = PropertyDeepDiveRequest["granularity"];
type PropertyDeepDiveCompareMode = PropertyDeepDiveRequest["compareMode"];

type DailyTotals = {
  nights: number;
  revenueIncl: number;
  fees: number;
  inventoryNights: number;
};

const NO_LISTING_MATCH_ID = "__roomy_no_listing__";

type ReportSeries = {
  nights: number[];
  revenue: number[];
  adr: number[];
  occupancy: number[];
  inventory: number[];
};

type ComparisonScopeMeta = {
  totalListings: number;
  appliedListings: number;
  activeBeforeDate: string | null;
};

type HeadlineWindowTotals = {
  current: { revenue: number; reservations: number; nights: number };
  lastYear: { revenue: number; reservations: number; nights: number };
};

export type ReportResponse = {
  buckets: string[];
  current: ReportSeries;
  lastYear: ReportSeries;
  meta: {
    displayCurrency: string;
    snapshotDateUsed: string | null;
    snapshotDateLyUsed: string | null;
    comparisonScope?: ComparisonScopeMeta;
  };
};

export type BookWindowBucket = {
  key: string;
  label: string;
  nights: number;
  nightsPct: number;
  adr: number;
  cancellationPct: number;
  avgLos: number;
  reservations: number;
  cancelledReservations: number;
};

export type BookWindowReportResponse = {
  mode: BookWindowMode;
  lookbackDays: number;
  dateFrom: string;
  dateTo: string;
  buckets: BookWindowBucket[];
  meta: {
    displayCurrency: string;
    totalNights: number;
    totalReservations: number;
    includeFees: boolean;
  };
};

export type HomeDashboardResponse = {
  headline: {
    booked: {
      today: HeadlineWindowTotals;
      yesterday: HeadlineWindowTotals;
      thisWeek: HeadlineWindowTotals;
      thisMonth: HeadlineWindowTotals;
      custom: HeadlineWindowTotals;
    };
    arrivals: {
      today: HeadlineWindowTotals;
      yesterday: HeadlineWindowTotals;
      thisWeek: HeadlineWindowTotals;
      thisMonth: HeadlineWindowTotals;
      custom: HeadlineWindowTotals;
    };
    stayed: {
      today: HeadlineWindowTotals;
      yesterday: HeadlineWindowTotals;
      thisWeek: HeadlineWindowTotals;
      thisMonth: HeadlineWindowTotals;
      custom: HeadlineWindowTotals;
    };
  };
  focusFinder: {
    underperformingMonths: Array<{
      bucket: string;
      label: string;
      currentRevenue: number;
      lastYearRevenue: number;
      revenueDeltaPct: number | null;
      currentAdr: number;
      lastYearAdr: number;
      adrDeltaPct: number | null;
      currentOccupancy: number;
      lastYearOccupancy: number;
      occupancyDeltaPts: number;
    }>;
    underperformingWeeks: Array<{
      bucket: string;
      label: string;
      currentRevenue: number;
      lastYearRevenue: number;
      revenueDeltaPct: number | null;
      currentAdr: number;
      lastYearAdr: number;
      adrDeltaPct: number | null;
      currentOccupancy: number;
      lastYearOccupancy: number;
      occupancyDeltaPts: number;
    }>;
    adrOpportunityMonths: Array<{
      bucket: string;
      label: string;
      liveAdr: number;
      lastYearAdr: number;
      adrDeltaPct: number | null;
    }>;
    highDemandDates: Array<{
      date: string;
      revenue: number;
      reservations: number;
      nights: number;
    }>;
  };
  propertyDetective: Array<{
    listingId: string;
    listingName: string;
    reasonKeys: string[];
    reason: string;
    severity: "high" | "medium";
  }>;
  meta: {
    displayCurrency: string;
    includeFees: boolean;
    generatedAt: string;
    comparisonScope: ComparisonScopeMeta;
  };
};

export type ReservationsReportRow = {
  id: string;
  guestName: string | null;
  listingId: string;
  listingName: string;
  status: string;
  bookingDate: string;
  checkInDate: string;
  nights: number;
  totalPrice: number;
  adr: number;
  channel: string | null;
  lastYearSameWeekdayAdr: number | null;
  adrDeltaPct: number | null;
};

export type ReservationsReportResponse = {
  period: {
    bookingDateFrom: string;
    bookingDateTo: string;
  };
  summary: {
    reservations: number;
    nights: number;
    revenue: number;
    adr: number;
  };
  rows: ReservationsReportRow[];
  meta: {
    displayCurrency: string;
    includeFees: boolean;
    comparisonScope: ComparisonScopeMeta;
  };
};

export type PropertyDeepDiveRow = {
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
    anchorSource: PricingAnchorSource;
    confidence: PricingConfidence;
    currentShortStayOccupancy: number | null;
    referenceShortStayOccupancy: number | null;
    note: string;
  };
};

export type PropertyDeepDiveResponse = {
  granularity: PropertyDeepDiveGranularity;
  compareMode: PropertyDeepDiveCompareMode;
  period: {
    start: string;
    end: string;
    mode: "past" | "future" | "mixed";
    label: string;
  };
  rows: PropertyDeepDiveRow[];
  meta: {
    displayCurrency: string;
    includeFees: boolean;
    paceReferenceCutoffDate: string;
    comparisonScope: ComparisonScopeMeta;
  };
};

type ReportBaseParams = {
  tenantId: string;
  request: ReportsRequest;
  displayCurrency: string;
};

type BookWindowBaseParams = {
  tenantId: string;
  request: BookWindowRequest;
  displayCurrency: string;
};

type HomeDashboardBaseParams = {
  tenantId: string;
  request: HomeDashboardRequest;
  displayCurrency: string;
};

type ReservationsReportBaseParams = {
  tenantId: string;
  request: ReservationsReportRequest;
  displayCurrency: string;
};

type PropertyDeepDiveBaseParams = {
  tenantId: string;
  request: PropertyDeepDiveRequest;
  displayCurrency: string;
};

type PricingCalendarBaseParams = {
  tenantId: string;
  request: PricingCalendarRequest;
  displayCurrency: string;
};

type NightFactDailyRow = {
  date: Date;
  currency: string;
  nights: number | bigint;
  revenueIncl: Prisma.Decimal | number | string | null;
  feesAllocated: Prisma.Decimal | number | string | null;
};

type ReservationBookingDailyRow = {
  date: Date;
  currency: string;
  nights: number | bigint;
  revenueIncl: Prisma.Decimal | number | string | null;
  feesAllocated: Prisma.Decimal | number | string | null;
};

type CalendarInventoryDailyRow = {
  date: Date;
  inventoryNights: number | bigint;
};

type ListingLifecycleBookedRow = {
  listingId: string;
  firstBookedNight: Date;
};

type ListingLifecycleStayedRow = {
  listingId: string;
  firstStayedRevenueDate: Date;
};

type BookWindowRawRow = {
  bucketIndex: number | bigint;
  bucketKey: string;
  fxDate: Date;
  currency: string;
  nights: number | bigint;
  reservations: number | bigint;
  cancelledReservations: number | bigint;
  revenueIncl: Prisma.Decimal | number | string | null;
  feesAllocated: Prisma.Decimal | number | string | null;
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

type ListingDailyStayRow = {
  listingId: string;
  date: Date;
  currency: string;
  nights: number | bigint;
  revenueIncl: Prisma.Decimal | number | string | null;
  feesAllocated: Prisma.Decimal | number | string | null;
};

type ListingDailyInventoryRow = {
  listingId: string;
  date: Date;
  inventoryNights: number | bigint;
};

type PricingAnchorHistoryRow = {
  listingId: string;
  date: Date;
  currency: string;
  leadTimeDays: number | null;
  losNights: number | null;
  status: string | null;
  achievedRate: Prisma.Decimal | number | string | null;
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

type BookedNightRateRow = {
  listingId: string;
  date: Date;
  currency: string;
  bookedRateTotal: Prisma.Decimal | number | string | null;
  nightCount: number | bigint;
};

type BookingHeadlineRawRow = {
  date: Date;
  currency: string;
  reservations: number | bigint;
  nights: number | bigint;
  revenueIncl: Prisma.Decimal | number | string | null;
  feesAllocated: Prisma.Decimal | number | string | null;
};

type BookingHeadlineTotals = {
  reservations: number;
  nights: number;
  revenueIncl: number;
  fees: number;
};

type StayHeadlineRawRow = {
  date: Date;
  currency: string;
  reservations: number | bigint;
  nights: number | bigint;
  revenueIncl: Prisma.Decimal | number | string | null;
  feesAllocated: Prisma.Decimal | number | string | null;
};

type ReservationListRawRow = {
  id: string;
  listingId: string;
  listingName: string;
  status: string;
  guestName: string | null;
  bookingDate: Date;
  arrival: Date;
  departure: Date;
  nights: number | bigint;
  currency: string;
  total: Prisma.Decimal | number | string | null;
  cleaningFee: Prisma.Decimal | number | string | null;
  guestFee: Prisma.Decimal | number | string | null;
  channel: string | null;
};

type LiveRateRawRow = {
  listingId: string;
  date: Date;
  currency: string;
  rateTotal: Prisma.Decimal | number | string | null;
  rateCount: number | bigint;
};

const BOOK_WINDOW_BUCKETS: Array<{ index: number; key: string; label: string }> = [
  { index: 0, key: "0-1", label: "0-1 Days" },
  { index: 1, key: "2-3", label: "2-3 Days" },
  { index: 2, key: "4-7", label: "4-7 Days" },
  { index: 3, key: "8-14", label: "8-14 Days" },
  { index: 4, key: "15-30", label: "15-30 Days" },
  { index: 5, key: "31-60", label: "31-60 Days" },
  { index: 6, key: "61-90", label: "61-90 Days" },
  { index: 7, key: "91-120", label: "91-120 Days" },
  { index: 8, key: "121+", label: "121+ Days" }
];

function emptyDailyTotals(): DailyTotals {
  return {
    nights: 0,
    revenueIncl: 0,
    fees: 0,
    inventoryNights: 0
  };
}

function startOfUtcWeek(date: Date): Date {
  const copy = fromDateOnly(toDateOnly(date));
  const weekdayOffset = (copy.getUTCDay() + 6) % 7;
  return addUtcDays(copy, -weekdayOffset);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcWeeks(date: Date, weeks: number): Date {
  return addUtcDays(date, weeks * 7);
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function addUtcMonthsClamped(date: Date, months: number): Date {
  const targetYear = date.getUTCFullYear();
  const targetMonth = date.getUTCMonth() + months;
  const targetDay = date.getUTCDate();
  const maxDayInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(targetDay, maxDayInTargetMonth)));
}

function addUtcYearsClamped(date: Date, years: number): Date {
  const targetYear = date.getUTCFullYear() + years;
  const targetMonth = date.getUTCMonth();
  const targetDay = date.getUTCDate();
  const maxDayInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(targetDay, maxDayInTargetMonth)));
}

function monthBucketLabel(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function bucketLabelForDate(date: Date, granularity: Granularity): string {
  if (granularity === "day") {
    return toDateOnly(date);
  }
  if (granularity === "week") {
    return toDateOnly(startOfUtcWeek(date));
  }
  return monthBucketLabel(startOfUtcMonth(date));
}

function rangeToBucketLabels(from: Date, to: Date, granularity: Granularity): string[] {
  const labels: string[] = [];
  let cursor =
    granularity === "day"
      ? fromDateOnly(toDateOnly(from))
      : granularity === "week"
        ? startOfUtcWeek(from)
        : startOfUtcMonth(from);

  while (cursor <= to) {
    labels.push(
      granularity === "day" ? toDateOnly(cursor) : granularity === "week" ? toDateOnly(cursor) : monthBucketLabel(cursor)
    );
    cursor =
      granularity === "day"
        ? addUtcDays(cursor, 1)
        : granularity === "week"
          ? addUtcWeeks(cursor, 1)
          : addUtcMonths(cursor, 1);
  }

  return labels;
}

function foldDailyToBuckets(daily: Map<string, DailyTotals>, granularity: Granularity): Map<string, DailyTotals> {
  const output = new Map<string, DailyTotals>();

  for (const [dateKey, value] of daily.entries()) {
    const label = bucketLabelForDate(fromDateOnly(dateKey), granularity);
    const current = output.get(label) ?? emptyDailyTotals();
    current.nights += value.nights;
    current.revenueIncl += value.revenueIncl;
    current.fees += value.fees;
    current.inventoryNights += value.inventoryNights;
    output.set(label, current);
  }

  return output;
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function asNumber(value: Prisma.Decimal | number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value instanceof Prisma.Decimal) {
    return value.toNumber();
  }
  return 0;
}

function isMissingGuestFeeColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return message.includes("guest_fee") && (message.includes("does not exist") || message.includes("unknown column"));
}

function toGuestFeeColumnMigrationError(): Error {
  const guidance = "Database column `reservations.guest_fee` is missing. Run `npm run db:deploy` and restart dev + worker.";
  console.error(`[reports] ${guidance}`);
  return new Error(guidance);
}

function isMissingAttentionSuppressionTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("attention_task_suppressions") && message.includes("does not exist");
}

function toAttentionSuppressionMigrationError(): Error {
  const guidance = "Database table `attention_task_suppressions` is missing. Run `npx prisma db push` and restart dev.";
  console.error(`[reports] ${guidance}`);
  return new Error(guidance);
}

function resolveRevenue(totals: DailyTotals, includeFees: boolean): number {
  if (includeFees) {
    return totals.revenueIncl;
  }

  return Math.max(0, totals.revenueIncl - totals.fees);
}

function resolveOccupancyPercent(totals: DailyTotals): number {
  if (totals.inventoryNights <= 0) {
    return 0;
  }

  const occupancy = (totals.nights / totals.inventoryNights) * 100;
  return roundTo2(Math.max(0, Math.min(100, occupancy)));
}

function normalizeFilterValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))];
}

function computeDeltaPct(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return roundTo2(((current - previous) / previous) * 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToIncrement(value: number | null, increment: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (!Number.isFinite(increment) || increment <= 1) {
    return Math.round(value);
  }

  return Math.round(value / increment) * increment;
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
  adjustments: PricingSeasonalityAdjustment[],
  dateOnly: string,
  fallbackPct: number,
  useDetailedAdjustments: boolean
): number {
  if (!useDetailedAdjustments) return fallbackPct;
  return adjustments.find((adjustment) => adjustment.month === monthNumberFromDateOnly(dateOnly))?.adjustmentPct ?? 0;
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

function findLeadTimeAdjustment(
  rules: PricingLeadTimeAdjustment[],
  daysUntil: number
): PricingLeadTimeAdjustment | null {
  return (
    [...rules]
      .sort((left, right) => left.maxDaysBefore - right.maxDaysBefore)
      .find((rule) => daysUntil >= rule.minDaysBefore && daysUntil <= rule.maxDaysBefore) ?? null
  );
}

function eventAdjustmentForDate(events: PricingLocalEvent[], dateOnly: string): PricingLocalEvent | null {
  return events.find((event) => event.startDate <= dateOnly && event.endDate >= dateOnly) ?? null;
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
function resolveMonthOccupancyPercent(totals: DailyTotals, daysInMonth: number): number | null {
  if (daysInMonth <= 0 || totals.nights <= 0) {
    return totals.nights > 0 && daysInMonth > 0 ? roundTo2((totals.nights / daysInMonth) * 100) : null;
  }

  return roundTo2((totals.nights / daysInMonth) * 100);
}

function startOfPeriod(date: Date, granularity: PropertyDeepDiveGranularity): Date {
  return granularity === "week" ? startOfUtcWeek(date) : startOfUtcMonth(date);
}

function addPeriods(date: Date, granularity: PropertyDeepDiveGranularity, periods: number): Date {
  return granularity === "week" ? addUtcWeeks(date, periods) : addUtcMonths(date, periods);
}

function endOfPeriod(startDate: Date, granularity: PropertyDeepDiveGranularity): Date {
  if (granularity === "week") {
    return addUtcDays(startDate, 6);
  }

  const nextMonth = addUtcMonths(startDate, 1);
  return addUtcDays(nextMonth, -1);
}

function cloneEmptyTotals(): DailyTotals {
  return {
    nights: 0,
    revenueIncl: 0,
    fees: 0,
    inventoryNights: 0
  };
}

function extractPositiveIntegerFromJson(raw: Prisma.JsonValue, aliases: string[]): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  for (const alias of aliases) {
    const candidate = (raw as Record<string, unknown>)[alias];
    if (candidate === null || candidate === undefined) continue;

    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }

  return null;
}

function resolveCalendarStayValue(primary: number | null | undefined, raw: Prisma.JsonValue, aliases: string[]): number | null {
  if (typeof primary === "number" && Number.isFinite(primary) && primary > 0) {
    return Math.round(primary);
  }

  return extractPositiveIntegerFromJson(raw, aliases);
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

function sumDailyTotalsWithinRange(daily: Map<string, DailyTotals>, from: Date, to: Date): DailyTotals {
  const totals = cloneEmptyTotals();

  for (let cursor = fromDateOnly(toDateOnly(from)); cursor <= to; cursor = addUtcDays(cursor, 1)) {
    const row = daily.get(toDateOnly(cursor));
    if (!row) continue;
    addTotals(totals, row);
  }

  return totals;
}

function listingIdsOrNoMatch(listingIds: string[]): string[] {
  return listingIds.length > 0 ? listingIds : [NO_LISTING_MATCH_ID];
}

function initListingDailyMap(listingIds: string[]): Map<string, Map<string, DailyTotals>> {
  const output = new Map<string, Map<string, DailyTotals>>();
  for (const listingId of listingIds) {
    output.set(listingId, new Map<string, DailyTotals>());
  }
  return output;
}

async function loadListingMetadata(tenantId: string, listingIds: string[]): Promise<ListingMeta[]> {
  if (listingIds.length === 0) return [];

  const rows = await prisma.listing.findMany({
    where: {
      tenantId,
      id: { in: listingIds }
    },
    select: {
      id: true,
      name: true,
      timezone: true,
      tags: true,
      country: true,
      state: true,
      city: true,
      address: true,
      publicAddress: true,
      latitude: true,
      longitude: true,
      roomType: true,
      bedroomsNumber: true,
      bathroomsNumber: true,
      bedsNumber: true,
      personCapacity: true,
      guestsIncluded: true,
      minNights: true,
      cleaningFee: true,
      averageReviewRating: true
    },
    orderBy: {
      name: "asc"
    }
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    tags: row.tags,
    country: row.country,
    state: row.state,
    city: row.city,
    address: row.address,
    publicAddress: row.publicAddress,
    latitude: row.latitude !== null ? asNumber(row.latitude) : null,
    longitude: row.longitude !== null ? asNumber(row.longitude) : null,
    roomType: row.roomType,
    bedroomsNumber: row.bedroomsNumber,
    bathroomsNumber: row.bathroomsNumber !== null ? asNumber(row.bathroomsNumber) : null,
    bedsNumber: row.bedsNumber,
    personCapacity: row.personCapacity,
    guestsIncluded: row.guestsIncluded,
    minNights: row.minNights,
    cleaningFee: row.cleaningFee !== null ? asNumber(row.cleaningFee) : null,
    averageReviewRating: row.averageReviewRating !== null ? asNumber(row.averageReviewRating) : null
  }));
}

async function groupNightFactsDailyByListing(params: {
  tenantId: string;
  stayDateFrom: Date;
  stayDateTo: Date;
  listingIds: string[];
  channels: string[];
  statuses: string[];
  displayCurrency: string;
  bookingCreatedAtCutoff?: Date;
  excludeMissingBookingCreatedAt?: boolean;
  includeCancelledAfterCutoff?: boolean;
  maxLosNightsExclusive?: number;
}): Promise<Map<string, Map<string, DailyTotals>>> {
  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`nf.tenant_id = ${params.tenantId}`,
    Prisma.sql`nf.date >= ${params.stayDateFrom}::date`,
    Prisma.sql`nf.date <= ${params.stayDateTo}::date`
  ];

  if (params.listingIds.length > 0) {
    whereClauses.push(Prisma.sql`nf.listing_id IN (${Prisma.join(params.listingIds)})`);
  }

  if (params.channels.length > 0) {
    const channelFilters = expandChannelFilterValues(params.channels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (params.statuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.status, '')) IN (${Prisma.join(params.statuses)})`);
  }

  if (params.maxLosNightsExclusive) {
    whereClauses.push(Prisma.sql`COALESCE(nf.los_nights, 0) < ${params.maxLosNightsExclusive}`);
  }

  if (params.bookingCreatedAtCutoff) {
    if (params.excludeMissingBookingCreatedAt) {
      whereClauses.push(Prisma.sql`nf.booking_created_at IS NOT NULL`);
    }

    whereClauses.push(Prisma.sql`DATE(nf.booking_created_at) <= ${params.bookingCreatedAtCutoff}::date`);

    if (params.includeCancelledAfterCutoff) {
      whereClauses.push(Prisma.sql`(
        nf.is_occupied = true
        OR (
          COALESCE(nf.status, '') IN ('cancelled', 'canceled')
          AND r.cancelled_at IS NOT NULL
          AND r.cancelled_at > ${params.bookingCreatedAtCutoff}::date
        )
      )`);
    } else {
      whereClauses.push(Prisma.sql`nf.is_occupied = true`);
    }
  } else {
    whereClauses.push(Prisma.sql`nf.is_occupied = true`);
  }

  const stayRows = await prisma.$queryRaw<ListingDailyStayRow[]>(Prisma.sql`
    SELECT
      nf.listing_id AS "listingId",
      nf.date AS "date",
      nf.currency AS "currency",
      COUNT(*)::int AS "nights",
      COALESCE(SUM(
        CASE
          WHEN COALESCE(nf.los_nights, 0) > 0 AND COALESCE(r.total, 0) > 0
            THEN COALESCE(r.total, 0) / nf.los_nights
          ELSE COALESCE(nf.revenue_allocated, 0)
        END
      ), 0)::numeric(18, 6) AS "revenueIncl",
      COALESCE(
        SUM(
          CASE
            WHEN COALESCE(nf.los_nights, 0) > 0 AND COALESCE(r.total, 0) > 0
              THEN LEAST(
                COALESCE(r.total, 0),
                GREATEST(0, COALESCE(r.cleaning_fee, 0) + COALESCE(r.guest_fee, 0))
              ) / nf.los_nights
            ELSE 0
          END
        ),
        0
      )::numeric(18, 6) AS "feesAllocated"
    FROM night_facts nf
    LEFT JOIN reservations r ON r.id = nf.reservation_id
    WHERE ${Prisma.join(whereClauses, " AND ")}
    GROUP BY nf.listing_id, nf.date, nf.currency
    ORDER BY nf.listing_id ASC, nf.date ASC
  `).catch((error: unknown) => {
    if (isMissingGuestFeeColumnError(error)) {
      throw toGuestFeeColumnMigrationError();
    }

    throw error;
  });

  const inventoryWhereClauses: Prisma.Sql[] = [
    Prisma.sql`cr.tenant_id = ${params.tenantId}`,
    Prisma.sql`cr.date >= ${params.stayDateFrom}::date`,
    Prisma.sql`cr.date <= ${params.stayDateTo}::date`
  ];
  if (params.listingIds.length > 0) {
    inventoryWhereClauses.push(Prisma.sql`cr.listing_id IN (${Prisma.join(params.listingIds)})`);
  }

  const inventoryRows = await prisma.$queryRaw<ListingDailyInventoryRow[]>(Prisma.sql`
    SELECT
      cr.listing_id AS "listingId",
      cr.date AS "date",
      COUNT(*)::int AS "inventoryNights"
    FROM calendar_rates cr
    WHERE ${Prisma.join(inventoryWhereClauses, " AND ")}
    GROUP BY cr.listing_id, cr.date
    ORDER BY cr.listing_id ASC, cr.date ASC
  `);

  const output = initListingDailyMap(params.listingIds);
  const fx = new FxConverter();

  for (const row of stayRows) {
    const listingDaily = output.get(row.listingId) ?? new Map<string, DailyTotals>();
    const dateKey = toDateOnly(row.date);
    const convertedRevenue = await fx.convert(
      asNumber(row.revenueIncl),
      row.date,
      row.currency,
      params.displayCurrency
    );
    const convertedFees = await fx.convert(
      asNumber(row.feesAllocated),
      row.date,
      row.currency,
      params.displayCurrency
    );

    const current = listingDaily.get(dateKey) ?? cloneEmptyTotals();
    current.nights += asNumber(row.nights);
    current.revenueIncl += convertedRevenue;
    current.fees += convertedFees;
    listingDaily.set(dateKey, current);
    output.set(row.listingId, listingDaily);
  }

  for (const row of inventoryRows) {
    const listingDaily = output.get(row.listingId) ?? new Map<string, DailyTotals>();
    const dateKey = toDateOnly(row.date);
    const current = listingDaily.get(dateKey) ?? cloneEmptyTotals();
    current.inventoryNights += asNumber(row.inventoryNights);
    listingDaily.set(dateKey, current);
    output.set(row.listingId, listingDaily);
  }

  for (const listingId of params.listingIds) {
    const listingDaily = output.get(listingId) ?? new Map<string, DailyTotals>();
    for (let cursor = fromDateOnly(toDateOnly(params.stayDateFrom)); cursor <= params.stayDateTo; cursor = addUtcDays(cursor, 1)) {
      const dateKey = toDateOnly(cursor);
      const current = listingDaily.get(dateKey) ?? cloneEmptyTotals();
      const fallbackInventory = current.inventoryNights > 0 ? current.inventoryNights : 1;
      current.inventoryNights = Math.max(current.nights, fallbackInventory);
      listingDaily.set(dateKey, current);
    }
    output.set(listingId, listingDaily);
  }

  return output;
}

async function loadPricingAnchorHistoryByListing(params: {
  tenantId: string;
  stayDateFrom: Date;
  stayDateTo: Date;
  listingIds: string[];
  channels: string[];
  statuses: string[];
  displayCurrency: string;
}): Promise<Map<string, PricingAnchorHistoryObservation[]>> {
  const output = new Map<string, PricingAnchorHistoryObservation[]>();
  if (params.listingIds.length === 0) {
    return output;
  }

  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`nf.tenant_id = ${params.tenantId}`,
    Prisma.sql`nf.date >= ${params.stayDateFrom}::date`,
    Prisma.sql`nf.date <= ${params.stayDateTo}::date`,
    Prisma.sql`nf.listing_id IN (${Prisma.join(params.listingIds)})`,
    Prisma.sql`nf.is_occupied = true`,
    Prisma.sql`COALESCE(nf.los_nights, 0) > 0`,
    Prisma.sql`COALESCE(nf.los_nights, 0) <= 14`,
    Prisma.sql`LOWER(COALESCE(nf.status, '')) NOT IN ('cancelled', 'canceled', 'no-show', 'no_show')`
  ];

  if (params.channels.length > 0) {
    const channelFilters = expandChannelFilterValues(params.channels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (params.statuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.status, '')) IN (${Prisma.join(params.statuses)})`);
  }

  const rows = await prisma.$queryRaw<PricingAnchorHistoryRow[]>(Prisma.sql`
    SELECT
      nf.listing_id AS "listingId",
      nf.date AS "date",
      nf.currency AS "currency",
      nf.lead_time_days AS "leadTimeDays",
      nf.los_nights AS "losNights",
      nf.status AS "status",
      CASE
        WHEN COALESCE(nf.los_nights, 0) > 0 AND COALESCE(r.accommodation_fare, 0) > 0
          THEN COALESCE(r.accommodation_fare, 0) / nf.los_nights
        ELSE COALESCE(nf.revenue_allocated, 0)
      END::numeric(18, 6) AS "achievedRate"
    FROM night_facts nf
    LEFT JOIN reservations r ON r.id = nf.reservation_id
    WHERE ${Prisma.join(whereClauses, " AND ")}
    ORDER BY nf.listing_id ASC, nf.date ASC
  `);

  const fx = new FxConverter();

  for (const row of rows) {
    const achievedRate = asNumber(row.achievedRate);
    if (!Number.isFinite(achievedRate) || achievedRate <= 0) continue;

    const convertedRate = await fx.convert(
      achievedRate,
      row.date,
      row.currency,
      params.displayCurrency
    );
    if (!Number.isFinite(convertedRate) || convertedRate <= 0) continue;

    const listingRows = output.get(row.listingId) ?? [];
    listingRows.push({
      stayDate: toDateOnly(row.date),
      achievedRate: roundTo2(convertedRate),
      nightCount: 1,
      leadTimeDays: row.leadTimeDays !== null ? asNumber(row.leadTimeDays) : null,
      losNights: row.losNights !== null ? asNumber(row.losNights) : null,
      status: row.status
    });
    output.set(row.listingId, listingRows);
  }

  for (const listingId of params.listingIds) {
    if (!output.has(listingId)) {
      output.set(listingId, []);
    }
  }

  return output;
}

function sumListingTotalsForRange(params: {
  listingIds: string[];
  byListingDaily: Map<string, Map<string, DailyTotals>>;
  from: Date;
  to: Date;
}): Map<string, DailyTotals> {
  const output = new Map<string, DailyTotals>();

  for (const listingId of params.listingIds) {
    const daily = params.byListingDaily.get(listingId) ?? new Map<string, DailyTotals>();
    const totals = cloneEmptyTotals();

    for (let cursor = fromDateOnly(toDateOnly(params.from)); cursor <= params.to; cursor = addUtcDays(cursor, 1)) {
      const dateKey = toDateOnly(cursor);
      const row = daily.get(dateKey);
      if (!row) continue;
      totals.nights += row.nights;
      totals.revenueIncl += row.revenueIncl;
      totals.fees += row.fees;
      totals.inventoryNights += row.inventoryNights;
    }

    output.set(listingId, totals);
  }

  return output;
}

function foldListingDailyToBuckets(params: {
  listingIds: string[];
  byListingDaily: Map<string, Map<string, DailyTotals>>;
  granularity: Granularity;
}): Map<string, Map<string, DailyTotals>> {
  const output = new Map<string, Map<string, DailyTotals>>();

  for (const listingId of params.listingIds) {
    const daily = params.byListingDaily.get(listingId) ?? new Map<string, DailyTotals>();
    const bucketMap = new Map<string, DailyTotals>();

    for (const [dateKey, totals] of daily.entries()) {
      const bucket = bucketLabelForDate(fromDateOnly(dateKey), params.granularity);
      const current = bucketMap.get(bucket) ?? cloneEmptyTotals();
      current.nights += totals.nights;
      current.revenueIncl += totals.revenueIncl;
      current.fees += totals.fees;
      current.inventoryNights += totals.inventoryNights;
      bucketMap.set(bucket, current);
    }

    output.set(listingId, bucketMap);
  }

  return output;
}

function buildLikeForLikeBucketComparisons(params: {
  listingIds: string[];
  currentBuckets: string[];
  referenceBuckets: string[];
  currentByListingBucket: Map<string, Map<string, DailyTotals>>;
  referenceByListingBucket: Map<string, Map<string, DailyTotals>>;
  eligibilityByListingBucket: Map<string, Map<string, DailyTotals>>;
  includeFees: boolean;
  labelForBucket: (bucket: string) => string;
}): Array<{
  bucket: string;
  label: string;
  currentRevenue: number;
  lastYearRevenue: number;
  revenueDeltaPct: number | null;
  currentAdr: number;
  lastYearAdr: number;
  adrDeltaPct: number | null;
  currentOccupancy: number;
  lastYearOccupancy: number;
  occupancyDeltaPts: number;
}> {
  return params.currentBuckets.map((bucket, index) => {
    const referenceBucket = params.referenceBuckets[index] ?? "";
    const currentTotals = cloneEmptyTotals();
    const referenceTotals = cloneEmptyTotals();

    for (const listingId of params.listingIds) {
      const eligibilityTotals = params.eligibilityByListingBucket.get(listingId)?.get(referenceBucket) ?? cloneEmptyTotals();
      const eligibilityRevenue = resolveRevenue(eligibilityTotals, params.includeFees);
      if (eligibilityTotals.nights <= 0 && eligibilityRevenue <= 0) {
        continue;
      }

      addTotals(currentTotals, params.currentByListingBucket.get(listingId)?.get(bucket) ?? cloneEmptyTotals());
      addTotals(referenceTotals, params.referenceByListingBucket.get(listingId)?.get(referenceBucket) ?? cloneEmptyTotals());
    }

    const currentRevenue = resolveRevenue(currentTotals, params.includeFees);
    const lastYearRevenue = resolveRevenue(referenceTotals, params.includeFees);
    const currentAdr = currentTotals.nights > 0 ? currentRevenue / currentTotals.nights : 0;
    const lastYearAdr = referenceTotals.nights > 0 ? lastYearRevenue / referenceTotals.nights : 0;
    const currentOccupancy = resolveOccupancyPercent(currentTotals);
    const lastYearOccupancy = resolveOccupancyPercent(referenceTotals);

    return {
      bucket,
      label: params.labelForBucket(bucket),
      currentRevenue: roundTo2(currentRevenue),
      lastYearRevenue: roundTo2(lastYearRevenue),
      revenueDeltaPct: computeDeltaPct(currentRevenue, lastYearRevenue),
      currentAdr: roundTo2(currentAdr),
      lastYearAdr: roundTo2(lastYearAdr),
      adrDeltaPct: computeDeltaPct(currentAdr, lastYearAdr),
      currentOccupancy,
      lastYearOccupancy,
      occupancyDeltaPts: roundTo2(currentOccupancy - lastYearOccupancy)
    };
  });
}

function buildLiveUnbookedDailyByListing(params: {
  listingIds: string[];
  from: Date;
  to: Date;
  currentByListingDaily: Map<string, Map<string, DailyTotals>>;
  liveRateByListingDate: Map<string, Map<string, number>>;
}): Map<string, Map<string, DailyTotals>> {
  const output = new Map<string, Map<string, DailyTotals>>();
  if (params.from > params.to) {
    return output;
  }

  for (const listingId of params.listingIds) {
    const currentDaily = params.currentByListingDaily.get(listingId) ?? new Map<string, DailyTotals>();
    const liveRateByDate = params.liveRateByListingDate.get(listingId) ?? new Map<string, number>();
    const listingOutput = new Map<string, DailyTotals>();

    for (let cursor = fromDateOnly(toDateOnly(params.from)); cursor <= params.to; cursor = addUtcDays(cursor, 1)) {
      const dateKey = toDateOnly(cursor);
      const current = currentDaily.get(dateKey) ?? cloneEmptyTotals();
      const inventoryNights = Math.max(current.nights, current.inventoryNights);
      const unbookedNights = Math.max(0, inventoryNights - current.nights);
      const liveRate = liveRateByDate.get(dateKey);

      if (unbookedNights <= 0 || liveRate === undefined) {
        continue;
      }

      listingOutput.set(dateKey, {
        nights: unbookedNights,
        revenueIncl: liveRate * unbookedNights,
        fees: 0,
        inventoryNights: unbookedNights
      });
    }

    output.set(listingId, listingOutput);
  }

  return output;
}

function buildAdrBucketComparisons(params: {
  listingIds: string[];
  currentBuckets: string[];
  referenceBuckets: string[];
  currentByListingBucket: Map<string, Map<string, DailyTotals>>;
  referenceByListingBucket: Map<string, Map<string, DailyTotals>>;
  includeFees: boolean;
  labelForBucket: (bucket: string) => string;
}): Array<{
  bucket: string;
  label: string;
  liveAdr: number;
  lastYearAdr: number;
  adrDeltaPct: number | null;
}> {
  return params.currentBuckets.map((bucket, index) => {
    const referenceBucket = params.referenceBuckets[index] ?? "";
    const currentTotals = cloneEmptyTotals();
    const referenceTotals = cloneEmptyTotals();

    for (const listingId of params.listingIds) {
      const referenceListingTotals = params.referenceByListingBucket.get(listingId)?.get(referenceBucket) ?? cloneEmptyTotals();
      const referenceRevenue = resolveRevenue(referenceListingTotals, params.includeFees);
      if (referenceListingTotals.nights <= 0 && referenceRevenue <= 0) {
        continue;
      }

      addTotals(currentTotals, params.currentByListingBucket.get(listingId)?.get(bucket) ?? cloneEmptyTotals());
      addTotals(referenceTotals, referenceListingTotals);
    }

    const currentRevenue = resolveRevenue(currentTotals, params.includeFees);
    const lastYearRevenue = resolveRevenue(referenceTotals, params.includeFees);
    const liveAdr = currentTotals.nights > 0 ? currentRevenue / currentTotals.nights : 0;
    const lastYearAdr = referenceTotals.nights > 0 ? lastYearRevenue / referenceTotals.nights : 0;

    return {
      bucket,
      label: params.labelForBucket(bucket),
      liveAdr: roundTo2(liveAdr),
      lastYearAdr: roundTo2(lastYearAdr),
      adrDeltaPct: computeDeltaPct(liveAdr, lastYearAdr)
    };
  });
}

async function groupBookingHeadlineDaily(params: {
  tenantId: string;
  bookingDateFrom: Date;
  bookingDateTo: Date;
  listingIds: string[];
  channels: string[];
  statuses: string[];
  displayCurrency: string;
}): Promise<Map<string, BookingHeadlineTotals>> {
  const bookingDateTextSql = Prisma.sql`COALESCE(
    NULLIF(r.raw_json ->> 'reservationDate', ''),
    NULLIF(r.raw_json ->> 'reservation_date', ''),
    NULLIF(r.raw_json ->> 'bookedOn', ''),
    NULLIF(r.raw_json ->> 'booked_on', ''),
    NULLIF(r.raw_json ->> 'bookingCreatedDate', ''),
    NULLIF(r.raw_json ->> 'booking_created_date', ''),
    NULLIF(r.raw_json ->> 'createdAt', ''),
    NULLIF(r.raw_json ->> 'created_at', '')
  )`;
  const bookingDateSql = Prisma.sql`
    DATE(
      COALESCE(
        CASE
          WHEN ${bookingDateTextSql} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN REPLACE(${bookingDateTextSql}, ' ', 'T')::timestamptz
          ELSE NULL
        END,
        r.created_at
      )
    )
  `;
  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`r.tenant_id = ${params.tenantId}`,
    Prisma.sql`${bookingDateSql} >= ${params.bookingDateFrom}::date`,
    Prisma.sql`${bookingDateSql} <= ${params.bookingDateTo}::date`
  ];

  if (params.listingIds.length > 0) {
    whereClauses.push(Prisma.sql`r.listing_id IN (${Prisma.join(params.listingIds)})`);
  }

  if (params.channels.length > 0) {
    const channelFilters = expandChannelFilterValues(params.channels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(r.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (params.statuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(r.status, '')) IN (${Prisma.join(params.statuses)})`);
  }

  const rows = await prisma.$queryRaw<BookingHeadlineRawRow[]>(Prisma.sql`
    SELECT
      ${bookingDateSql} AS "date",
      r.currency AS "currency",
      COUNT(*)::int AS "reservations",
      COALESCE(SUM(COALESCE(r.nights, 0)), 0)::int AS "nights",
      COALESCE(SUM(COALESCE(r.total, 0)), 0)::numeric(18, 6) AS "revenueIncl",
      COALESCE(
        SUM(
          LEAST(
            COALESCE(r.total, 0),
            GREATEST(0, COALESCE(r.cleaning_fee, 0) + COALESCE(r.guest_fee, 0))
          )
        ),
        0
      )::numeric(18, 6) AS "feesAllocated"
    FROM reservations r
    WHERE ${Prisma.join(whereClauses, " AND ")}
    GROUP BY 1, r.currency
    ORDER BY 1 ASC
  `).catch((error: unknown) => {
    if (isMissingGuestFeeColumnError(error)) {
      throw toGuestFeeColumnMigrationError();
    }

    throw error;
  });

  const output = new Map<string, BookingHeadlineTotals>();
  const fx = new FxConverter();

  for (const row of rows) {
    const dateKey = toDateOnly(row.date);
    const convertedRevenue = await fx.convert(
      asNumber(row.revenueIncl),
      row.date,
      row.currency,
      params.displayCurrency
    );
    const convertedFees = await fx.convert(
      asNumber(row.feesAllocated),
      row.date,
      row.currency,
      params.displayCurrency
    );

    const current = output.get(dateKey) ?? {
      reservations: 0,
      nights: 0,
      revenueIncl: 0,
      fees: 0
    };
    current.reservations += asNumber(row.reservations);
    current.nights += asNumber(row.nights);
    current.revenueIncl += convertedRevenue;
    current.fees += convertedFees;
    output.set(dateKey, current);
  }

  return output;
}

async function groupStayHeadlineDaily(params: {
  tenantId: string;
  stayDateFrom: Date;
  stayDateTo: Date;
  listingIds: string[];
  channels: string[];
  statuses: string[];
  displayCurrency: string;
}): Promise<Map<string, BookingHeadlineTotals>> {
  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`nf.tenant_id = ${params.tenantId}`,
    Prisma.sql`nf.date >= ${params.stayDateFrom}::date`,
    Prisma.sql`nf.date <= ${params.stayDateTo}::date`,
    Prisma.sql`nf.is_occupied = true`
  ];

  if (params.listingIds.length > 0) {
    whereClauses.push(Prisma.sql`nf.listing_id IN (${Prisma.join(params.listingIds)})`);
  }

  if (params.channels.length > 0) {
    const channelFilters = expandChannelFilterValues(params.channels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (params.statuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.status, '')) IN (${Prisma.join(params.statuses)})`);
  }

  const rows = await prisma.$queryRaw<StayHeadlineRawRow[]>(Prisma.sql`
    SELECT
      nf.date AS "date",
      nf.currency AS "currency",
      COUNT(DISTINCT nf.reservation_id)::int AS "reservations",
      COUNT(*)::int AS "nights",
      COALESCE(SUM(
        CASE
          WHEN COALESCE(nf.los_nights, 0) > 0 AND COALESCE(r.total, 0) > 0
            THEN COALESCE(r.total, 0) / nf.los_nights
          ELSE COALESCE(nf.revenue_allocated, 0)
        END
      ), 0)::numeric(18, 6) AS "revenueIncl",
      COALESCE(
        SUM(
          CASE
            WHEN COALESCE(nf.los_nights, 0) > 0 AND COALESCE(r.total, 0) > 0
              THEN LEAST(
                COALESCE(r.total, 0),
                GREATEST(0, COALESCE(r.cleaning_fee, 0) + COALESCE(r.guest_fee, 0))
              ) / nf.los_nights
            ELSE 0
          END
        ),
        0
      )::numeric(18, 6) AS "feesAllocated"
    FROM night_facts nf
    LEFT JOIN reservations r ON r.id = nf.reservation_id
    WHERE ${Prisma.join(whereClauses, " AND ")}
    GROUP BY nf.date, nf.currency
    ORDER BY nf.date ASC
  `).catch((error: unknown) => {
    if (isMissingGuestFeeColumnError(error)) {
      throw toGuestFeeColumnMigrationError();
    }

    throw error;
  });

  const output = new Map<string, BookingHeadlineTotals>();
  const fx = new FxConverter();
  for (const row of rows) {
    const dateKey = toDateOnly(row.date);
    const convertedRevenue = await fx.convert(
      asNumber(row.revenueIncl),
      row.date,
      row.currency,
      params.displayCurrency
    );
    const convertedFees = await fx.convert(
      asNumber(row.feesAllocated),
      row.date,
      row.currency,
      params.displayCurrency
    );

    const current = output.get(dateKey) ?? {
      reservations: 0,
      nights: 0,
      revenueIncl: 0,
      fees: 0
    };
    current.reservations += asNumber(row.reservations);
    current.nights += asNumber(row.nights);
    current.revenueIncl += convertedRevenue;
    current.fees += convertedFees;
    output.set(dateKey, current);
  }

  return output;
}

async function groupLiveRateAverageByListing(params: {
  tenantId: string;
  from: Date;
  to: Date;
  listingIds: string[];
  displayCurrency: string;
}): Promise<Map<string, number>> {
  if (params.from > params.to || params.listingIds.length === 0) {
    return new Map<string, number>();
  }

  const rows = await prisma.$queryRaw<LiveRateRawRow[]>(Prisma.sql`
    SELECT
      cr.listing_id AS "listingId",
      cr.date AS "date",
      cr.currency AS "currency",
      COALESCE(SUM(COALESCE(cr.rate, 0)), 0)::numeric(18, 6) AS "rateTotal",
      COUNT(*)::int AS "rateCount"
    FROM calendar_rates cr
    WHERE
      cr.tenant_id = ${params.tenantId}
      AND cr.listing_id IN (${Prisma.join(params.listingIds)})
      AND cr.date >= ${params.from}::date
      AND cr.date <= ${params.to}::date
      AND COALESCE(cr.available, true) = true
    GROUP BY cr.listing_id, cr.date, cr.currency
    ORDER BY cr.listing_id ASC, cr.date ASC
  `);

  const fx = new FxConverter();
  const totalsByListing = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const convertedTotal = await fx.convert(
      asNumber(row.rateTotal),
      row.date,
      row.currency,
      params.displayCurrency
    );
    const count = asNumber(row.rateCount);
    const current = totalsByListing.get(row.listingId) ?? { total: 0, count: 0 };
    current.total += convertedTotal;
    current.count += count;
    totalsByListing.set(row.listingId, current);
  }

  const output = new Map<string, number>();
  for (const [listingId, totals] of totalsByListing.entries()) {
    output.set(listingId, totals.count > 0 ? roundTo2(totals.total / totals.count) : 0);
  }

  return output;
}

async function groupLiveRateAverageByListingDate(params: {
  tenantId: string;
  from: Date;
  to: Date;
  listingIds: string[];
  displayCurrency: string;
}): Promise<Map<string, Map<string, number>>> {
  if (params.from > params.to || params.listingIds.length === 0) {
    return new Map<string, Map<string, number>>();
  }

  const rows = await prisma.$queryRaw<LiveRateRawRow[]>(Prisma.sql`
    SELECT
      cr.listing_id AS "listingId",
      cr.date AS "date",
      cr.currency AS "currency",
      COALESCE(SUM(COALESCE(cr.rate, 0)), 0)::numeric(18, 6) AS "rateTotal",
      COUNT(*)::int AS "rateCount"
    FROM calendar_rates cr
    WHERE
      cr.tenant_id = ${params.tenantId}
      AND cr.listing_id IN (${Prisma.join(params.listingIds)})
      AND cr.date >= ${params.from}::date
      AND cr.date <= ${params.to}::date
      AND COALESCE(cr.available, true) = true
    GROUP BY cr.listing_id, cr.date, cr.currency
    ORDER BY cr.listing_id ASC, cr.date ASC
  `);

  const fx = new FxConverter();
  const output = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const count = asNumber(row.rateCount);
    if (count <= 0) continue;

    const convertedTotal = await fx.convert(
      asNumber(row.rateTotal),
      row.date,
      row.currency,
      params.displayCurrency
    );
    const dayAverage = roundTo2(convertedTotal / count);
    const dateKey = toDateOnly(row.date);

    const listingMap = output.get(row.listingId) ?? new Map<string, number>();
    listingMap.set(dateKey, dayAverage);
    output.set(row.listingId, listingMap);
  }

  return output;
}

async function groupCalendarCellStatusByListingDate(params: {
  tenantId: string;
  from: Date;
  to: Date;
  listingIds: string[];
  displayCurrency: string;
}): Promise<Map<string, Map<string, PricingCalendarCellStatus>>> {
  if (params.from > params.to || params.listingIds.length === 0) {
    return new Map<string, Map<string, PricingCalendarCellStatus>>();
  }

  const rows = await prisma.calendarRate.findMany({
    where: {
      tenantId: params.tenantId,
      listingId: { in: params.listingIds },
      date: {
        gte: params.from,
        lte: params.to
      }
    },
    select: {
      listingId: true,
      date: true,
      available: true,
      minStay: true,
      maxStay: true,
      rate: true,
      currency: true,
      rawJson: true
    },
    orderBy: [{ listingId: "asc" }, { date: "asc" }]
  });

  const fx = new FxConverter();
  const output = new Map<string, Map<string, PricingCalendarCellStatus>>();

  for (const row of rows) {
    const convertedRate = await fx.convert(asNumber(row.rate), row.date, row.currency, params.displayCurrency);
    const listingMap = output.get(row.listingId) ?? new Map<string, PricingCalendarCellStatus>();
    listingMap.set(toDateOnly(row.date), {
      liveRate: roundTo2(convertedRate),
      available: row.available,
      minStay: resolveCalendarStayValue(row.minStay, row.rawJson, ["minStay", "minStayNights", "min_stay", "minimumStay"]),
      maxStay: resolveCalendarStayValue(row.maxStay, row.rawJson, ["maxStay", "maxStayNights", "max_stay", "maximumStay"])
    });
    output.set(row.listingId, listingMap);
  }

  return output;
}

async function groupBookedNightRateByListingDate(params: {
  tenantId: string;
  from: Date;
  to: Date;
  listingIds: string[];
  channels: string[];
  statuses: string[];
  displayCurrency: string;
}): Promise<Map<string, Map<string, number>>> {
  if (params.from > params.to || params.listingIds.length === 0) {
    return new Map<string, Map<string, number>>();
  }

  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`nf.tenant_id = ${params.tenantId}`,
    Prisma.sql`nf.date >= ${params.from}::date`,
    Prisma.sql`nf.date <= ${params.to}::date`,
    Prisma.sql`nf.is_occupied = true`,
    Prisma.sql`nf.listing_id IN (${Prisma.join(params.listingIds)})`
  ];

  if (params.channels.length > 0) {
    const channelFilters = expandChannelFilterValues(params.channels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (params.statuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.status, '')) IN (${Prisma.join(params.statuses)})`);
  }

  const rows = await prisma.$queryRaw<BookedNightRateRow[]>(Prisma.sql`
    SELECT
      nf.listing_id AS "listingId",
      nf.date AS "date",
      nf.currency AS "currency",
      COALESCE(
        SUM(
          CASE
            WHEN COALESCE(nf.los_nights, 0) > 0 AND COALESCE(r.accommodation_fare, 0) > 0
              THEN COALESCE(r.accommodation_fare, 0) / nf.los_nights
            ELSE COALESCE(nf.revenue_allocated, 0)
          END
        ),
        0
      )::numeric(18, 6) AS "bookedRateTotal",
      COUNT(*)::int AS "nightCount"
    FROM night_facts nf
    LEFT JOIN reservations r ON r.id = nf.reservation_id
    WHERE ${Prisma.join(whereClauses, " AND ")}
    GROUP BY nf.listing_id, nf.date, nf.currency
    ORDER BY nf.listing_id ASC, nf.date ASC
  `);

  const fx = new FxConverter();
  const working = new Map<string, Map<string, { total: number; nights: number }>>();

  for (const row of rows) {
    const convertedTotal = await fx.convert(
      asNumber(row.bookedRateTotal),
      row.date,
      row.currency,
      params.displayCurrency
    );
    const nightCount = asNumber(row.nightCount);
    const listingMap = working.get(row.listingId) ?? new Map<string, { total: number; nights: number }>();
    const dateKey = toDateOnly(row.date);
    const current = listingMap.get(dateKey) ?? { total: 0, nights: 0 };
    current.total += convertedTotal;
    current.nights += nightCount;
    listingMap.set(dateKey, current);
    working.set(row.listingId, listingMap);
  }

  const output = new Map<string, Map<string, number>>();
  for (const [listingId, listingMap] of working.entries()) {
    const resolved = new Map<string, number>();
    for (const [dateKey, totals] of listingMap.entries()) {
      if (totals.nights <= 0) continue;
      resolved.set(dateKey, roundTo2(totals.total / totals.nights));
    }
    output.set(listingId, resolved);
  }

  return output;
}

function seriesFromBucketLabels(
  bucketLabels: string[],
  bucketMap: Map<string, DailyTotals>,
  includeFees: boolean
): ReportSeries {
  const nights: number[] = [];
  const revenue: number[] = [];
  const adr: number[] = [];
  const occupancy: number[] = [];
  const inventory: number[] = [];

  for (const label of bucketLabels) {
    const totals = bucketMap.get(label) ?? emptyDailyTotals();
    const resolvedRevenue = resolveRevenue(totals, includeFees);
    nights.push(roundTo2(totals.nights));
    revenue.push(roundTo2(resolvedRevenue));
    adr.push(totals.nights > 0 ? roundTo2(resolvedRevenue / totals.nights) : 0);
    occupancy.push(resolveOccupancyPercent(totals));
    inventory.push(roundTo2(totals.inventoryNights));
  }

  return { nights, revenue, adr, occupancy, inventory };
}

function alignedLySeries(
  currentBucketLabels: string[],
  lyBucketLabels: string[],
  lyBucketMap: Map<string, DailyTotals>,
  includeFees: boolean
): ReportSeries {
  const nights: number[] = [];
  const revenue: number[] = [];
  const adr: number[] = [];
  const occupancy: number[] = [];
  const inventory: number[] = [];

  for (let index = 0; index < currentBucketLabels.length; index += 1) {
    const lyLabel = lyBucketLabels[index];
    const totals = lyLabel
      ? lyBucketMap.get(lyLabel) ?? emptyDailyTotals()
      : emptyDailyTotals();
    const resolvedRevenue = resolveRevenue(totals, includeFees);
    nights.push(roundTo2(totals.nights));
    revenue.push(roundTo2(resolvedRevenue));
    adr.push(totals.nights > 0 ? roundTo2(resolvedRevenue / totals.nights) : 0);
    occupancy.push(resolveOccupancyPercent(totals));
    inventory.push(roundTo2(totals.inventoryNights));
  }

  return { nights, revenue, adr, occupancy, inventory };
}

async function resolveScopedListingIds(tenantId: string, requestedListingIds: string[]): Promise<string[]> {
  const dedupedRequested = [...new Set(requestedListingIds)];
  if (dedupedRequested.length > 0) {
    const listings = await prisma.listing.findMany({
      where: {
        tenantId,
        id: { in: dedupedRequested }
      },
      select: { id: true }
    });

    return listings.map((listing) => listing.id);
  }

  const listings = await prisma.listing.findMany({
    where: { tenantId },
    select: { id: true }
  });

  return listings.map((listing) => listing.id);
}

async function loadListingLifecycleDates(params: {
  tenantId: string;
  listingIds: string[];
}): Promise<
  Map<
    string,
    {
      firstBookedNight: Date | null;
      firstStayedRevenueDate: Date | null;
    }
  >
> {
  if (params.listingIds.length === 0) {
    return new Map();
  }

  const [bookedRows, stayedRows] = await Promise.all([
    prisma.$queryRaw<ListingLifecycleBookedRow[]>(Prisma.sql`
      SELECT
        r.listing_id AS "listingId",
        MIN(r.arrival)::date AS "firstBookedNight"
      FROM reservations r
      WHERE
        r.tenant_id = ${params.tenantId}
        AND r.listing_id IN (${Prisma.join(params.listingIds)})
      GROUP BY r.listing_id
    `),
    prisma.$queryRaw<ListingLifecycleStayedRow[]>(Prisma.sql`
      SELECT
        nf.listing_id AS "listingId",
        MIN(nf.date)::date AS "firstStayedRevenueDate"
      FROM night_facts nf
      WHERE
        nf.tenant_id = ${params.tenantId}
        AND nf.listing_id IN (${Prisma.join(params.listingIds)})
        AND nf.is_occupied = true
        AND COALESCE(nf.revenue_allocated, 0) > 0
      GROUP BY nf.listing_id
    `)
  ]);

  const lifecycleByListing = new Map<
    string,
    {
      firstBookedNight: Date | null;
      firstStayedRevenueDate: Date | null;
    }
  >();

  for (const listingId of params.listingIds) {
    lifecycleByListing.set(listingId, {
      firstBookedNight: null,
      firstStayedRevenueDate: null
    });
  }

  for (const row of bookedRows) {
    const current = lifecycleByListing.get(row.listingId);
    if (current) {
      current.firstBookedNight = row.firstBookedNight;
    }
  }

  for (const row of stayedRows) {
    const current = lifecycleByListing.get(row.listingId);
    if (current) {
      current.firstStayedRevenueDate = row.firstStayedRevenueDate;
    }
  }

  return lifecycleByListing;
}

function filterListingIdsByActiveBeforeDate(params: {
  listingIds: string[];
  lifecycleByListing: Map<
    string,
    {
      firstBookedNight: Date | null;
      firstStayedRevenueDate: Date | null;
    }
  >;
  activeBeforeDate: Date | null;
}): string[] {
  const activeBeforeDate = params.activeBeforeDate;
  if (!activeBeforeDate) {
    return params.listingIds;
  }

  return params.listingIds.filter((listingId) => {
    const firstBookedNight = params.lifecycleByListing.get(listingId)?.firstBookedNight;
    if (!firstBookedNight) {
      return false;
    }

    return firstBookedNight <= activeBeforeDate;
  });
}

async function resolveComparisonListingScope(params: {
  tenantId: string;
  requestedListingIds: string[];
  activeBeforeDate?: Date | null;
}): Promise<{
  scopedListingIds: string[];
  comparisonListingIds: string[];
  lifecycleByListing: Map<
    string,
    {
      firstBookedNight: Date | null;
      firstStayedRevenueDate: Date | null;
    }
  >;
  comparisonScope: ComparisonScopeMeta;
}> {
  const scopedListingIds = await resolveScopedListingIds(params.tenantId, params.requestedListingIds);
  const lifecycleByListing = await loadListingLifecycleDates({
    tenantId: params.tenantId,
    listingIds: scopedListingIds
  });
  const comparisonListingIds = filterListingIdsByActiveBeforeDate({
    listingIds: scopedListingIds,
    lifecycleByListing,
    activeBeforeDate: params.activeBeforeDate ?? null
  });

  return {
    scopedListingIds,
    comparisonListingIds,
    lifecycleByListing,
    comparisonScope: {
      totalListings: scopedListingIds.length,
      appliedListings: comparisonListingIds.length,
      activeBeforeDate: params.activeBeforeDate ? toDateOnly(params.activeBeforeDate) : null
    }
  };
}

function addTotals(target: DailyTotals, source: DailyTotals): void {
  target.nights += source.nights;
  target.revenueIncl += source.revenueIncl;
  target.fees += source.fees;
  target.inventoryNights += source.inventoryNights;
}

function isComparableForReferenceDate(firstStayedRevenueDate: Date | null, referenceDate: Date): boolean {
  if (!firstStayedRevenueDate) return false;
  return firstStayedRevenueDate <= referenceDate;
}

function applyPaceLifecycleGateByListing(params: {
  listingIds: string[];
  currentFrom: Date;
  currentTo: Date;
  currentByListingDaily: Map<string, Map<string, DailyTotals>>;
  referenceByListingDaily: Map<string, Map<string, DailyTotals>>;
  gateCurrent?: boolean;
  lifecycleByListing: Map<
    string,
    {
      firstBookedNight: Date | null;
      firstStayedRevenueDate: Date | null;
    }
  >;
}): {
  currentByListingDaily: Map<string, Map<string, DailyTotals>>;
  referenceByListingDaily: Map<string, Map<string, DailyTotals>>;
} {
  const gatedCurrent = initListingDailyMap(params.listingIds);
  const gatedReference = initListingDailyMap(params.listingIds);

  for (const listingId of params.listingIds) {
    const firstStayedRevenueDate = params.lifecycleByListing.get(listingId)?.firstStayedRevenueDate ?? null;
    const currentDaily = params.currentByListingDaily.get(listingId) ?? new Map<string, DailyTotals>();
    const referenceDaily = params.referenceByListingDaily.get(listingId) ?? new Map<string, DailyTotals>();
    const nextCurrent = new Map<string, DailyTotals>();
    const nextReference = new Map<string, DailyTotals>();

    for (let cursor = fromDateOnly(toDateOnly(params.currentFrom)); cursor <= params.currentTo; cursor = addUtcDays(cursor, 1)) {
      const currentDateKey = toDateOnly(cursor);
      const referenceDate = addUtcYearsClamped(cursor, -1);
      const referenceDateKey = toDateOnly(referenceDate);
      const includeListing = isComparableForReferenceDate(firstStayedRevenueDate, referenceDate);

      nextCurrent.set(
        currentDateKey,
        params.gateCurrent === false
          ? { ...(currentDaily.get(currentDateKey) ?? cloneEmptyTotals()) }
          : includeListing
            ? { ...(currentDaily.get(currentDateKey) ?? cloneEmptyTotals()) }
            : cloneEmptyTotals()
      );
      nextReference.set(
        referenceDateKey,
        includeListing ? { ...(referenceDaily.get(referenceDateKey) ?? cloneEmptyTotals()) } : cloneEmptyTotals()
      );
    }

    gatedCurrent.set(listingId, nextCurrent);
    gatedReference.set(listingId, nextReference);
  }

  return {
    currentByListingDaily: gatedCurrent,
    referenceByListingDaily: gatedReference
  };
}

export function resolvePropertyDeepDiveComparisonData(params: {
  scopedListingIds: string[];
  currentDaily: Map<string, Map<string, DailyTotals>>;
  lyStayedDaily: Map<string, Map<string, DailyTotals>>;
  lyPaceDaily: Map<string, Map<string, DailyTotals>>;
  lifecycleByListing: Map<
    string,
    {
      firstBookedNight: Date | null;
      firstStayedRevenueDate: Date | null;
    }
  >;
  periodStart: Date;
  periodEnd: Date;
  lyStart: Date;
  lyEnd: Date;
  today: Date;
  compareMode: PropertyDeepDiveCompareMode;
  periodMode: PropertyDeepDiveResponse["period"]["mode"];
}): {
  currentByListingDaily: Map<string, Map<string, DailyTotals>>;
  currentTotals: Map<string, DailyTotals>;
  referenceTotals: Map<string, DailyTotals>;
  paceStatusReferenceTotals: Map<string, DailyTotals>;
  lyStayedTotals: Map<string, DailyTotals>;
} {
  const gatedPacePeriod = applyPaceLifecycleGateByListing({
    listingIds: params.scopedListingIds,
    currentFrom: params.periodStart,
    currentTo: params.periodEnd,
    currentByListingDaily: params.currentDaily,
    referenceByListingDaily: params.lyPaceDaily,
    gateCurrent: false,
    lifecycleByListing: params.lifecycleByListing
  });

  // Keep the visible current-year side raw so newly onboarded properties still
  // show their actual performance even when there is no comparable last-year data yet.
  const currentByListingDaily = params.currentDaily;
  const currentTotals = sumListingTotalsForRange({
    listingIds: params.scopedListingIds,
    byListingDaily: currentByListingDaily,
    from: params.periodStart,
    to: params.periodEnd
  });
  const lyStayedTotals = sumListingTotalsForRange({
    listingIds: params.scopedListingIds,
    byListingDaily: params.lyStayedDaily,
    from: params.lyStart,
    to: params.lyEnd
  });
  const paceStatusReferenceTotals =
    params.periodMode === "past"
      ? lyStayedTotals
      : params.periodMode === "future"
        ? sumListingTotalsForRange({
            listingIds: params.scopedListingIds,
            byListingDaily: gatedPacePeriod.referenceByListingDaily,
            from: params.lyStart,
            to: params.lyEnd
          })
        : (() => {
            const totalsByListing = new Map<string, DailyTotals>();
            for (const listingId of params.scopedListingIds) {
              const stayedDailyByDate = params.lyStayedDaily.get(listingId) ?? new Map<string, DailyTotals>();
              const paceDailyByDate = gatedPacePeriod.referenceByListingDaily.get(listingId) ?? new Map<string, DailyTotals>();
              const totals = cloneEmptyTotals();
              for (
                let cursor = fromDateOnly(toDateOnly(params.periodStart));
                cursor <= params.periodEnd;
                cursor = addUtcDays(cursor, 1)
              ) {
                const lyDate = addUtcYearsClamped(cursor, -1);
                const lyDateKey = toDateOnly(lyDate);
                const sourceRow =
                  cursor <= params.today
                    ? stayedDailyByDate.get(lyDateKey) ?? cloneEmptyTotals()
                    : paceDailyByDate.get(lyDateKey) ?? cloneEmptyTotals();
                totals.nights += sourceRow.nights;
                totals.revenueIncl += sourceRow.revenueIncl;
                totals.fees += sourceRow.fees;
                totals.inventoryNights += sourceRow.inventoryNights;
              }
              totalsByListing.set(listingId, totals);
            }
            return totalsByListing;
          })();

  let referenceTotals: Map<string, DailyTotals>;
  if (params.periodMode === "past" || params.compareMode === "ly_stayed") {
    referenceTotals = lyStayedTotals;
  } else {
    referenceTotals = paceStatusReferenceTotals;
  }

  return {
    currentByListingDaily,
    currentTotals,
    referenceTotals,
    paceStatusReferenceTotals,
    lyStayedTotals
  };
}

function aggregateListingDaily(params: {
  listingIds: string[];
  byListingDaily: Map<string, Map<string, DailyTotals>>;
  from: Date;
  to: Date;
}): Map<string, DailyTotals> {
  const aggregated = new Map<string, DailyTotals>();

  for (let cursor = fromDateOnly(toDateOnly(params.from)); cursor <= params.to; cursor = addUtcDays(cursor, 1)) {
    const dateKey = toDateOnly(cursor);
    const totals = cloneEmptyTotals();

    for (const listingId of params.listingIds) {
      const row = params.byListingDaily.get(listingId)?.get(dateKey);
      if (!row) continue;
      addTotals(totals, row);
    }

    aggregated.set(dateKey, totals);
  }

  return aggregated;
}

async function groupNightFactsDaily(params: {
  tenantId: string;
  stayDateFrom: Date;
  stayDateTo: Date;
  listingIds: string[];
  channels: string[];
  statuses: string[];
  displayCurrency: string;
  bookingCreatedAtCutoff?: Date;
  excludeMissingBookingCreatedAt?: boolean;
  includeCancelledAfterCutoff?: boolean;
}): Promise<Map<string, DailyTotals>> {
  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`nf.tenant_id = ${params.tenantId}`,
    Prisma.sql`nf.date >= ${params.stayDateFrom}::date`,
    Prisma.sql`nf.date <= ${params.stayDateTo}::date`
  ];

  if (params.listingIds.length > 0) {
    whereClauses.push(Prisma.sql`nf.listing_id IN (${Prisma.join(params.listingIds)})`);
  }

  if (params.channels.length > 0) {
    const channelFilters = expandChannelFilterValues(params.channels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (params.statuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(nf.status, '')) IN (${Prisma.join(params.statuses)})`);
  }

  if (params.bookingCreatedAtCutoff) {
    if (params.excludeMissingBookingCreatedAt) {
      whereClauses.push(Prisma.sql`nf.booking_created_at IS NOT NULL`);
    }

    whereClauses.push(Prisma.sql`DATE(nf.booking_created_at) <= ${params.bookingCreatedAtCutoff}::date`);

    if (params.includeCancelledAfterCutoff) {
      // For YoY pace comparison: include bookings that were LIVE at the cutoff date.
      // This means:
      //   - currently active bookings (is_occupied = true), OR
      //   - bookings that were cancelled AFTER the cutoff date (they were still live at cutoff)
      // Bookings cancelled ON or BEFORE the cutoff are excluded (they weren't on the books).
      whereClauses.push(Prisma.sql`(
        nf.is_occupied = true
        OR (
          COALESCE(nf.status, '') IN ('cancelled', 'canceled')
          AND r.cancelled_at IS NOT NULL
          AND r.cancelled_at > ${params.bookingCreatedAtCutoff}::date
        )
      )`);
    } else {
      whereClauses.push(Prisma.sql`nf.is_occupied = true`);
    }
  } else {
    // No cutoff: only show currently active bookings
    whereClauses.push(Prisma.sql`nf.is_occupied = true`);
  }

  const rows = await prisma.$queryRaw<NightFactDailyRow[]>(Prisma.sql`
    SELECT
      nf.date AS "date",
      nf.currency AS "currency",
      COUNT(*)::int AS "nights",
      COALESCE(SUM(
        CASE
          WHEN COALESCE(nf.los_nights, 0) > 0 AND COALESCE(r.total, 0) > 0
            THEN COALESCE(r.total, 0) / nf.los_nights
          ELSE COALESCE(nf.revenue_allocated, 0)
        END
      ), 0)::numeric(18, 6) AS "revenueIncl",
      COALESCE(
        SUM(
          CASE
            WHEN COALESCE(nf.los_nights, 0) > 0 AND COALESCE(r.total, 0) > 0
              THEN LEAST(
                COALESCE(r.total, 0),
                GREATEST(0, COALESCE(r.cleaning_fee, 0) + COALESCE(r.guest_fee, 0))
              ) / nf.los_nights
            ELSE 0
          END
        ),
        0
      )::numeric(18, 6) AS "feesAllocated"
    FROM night_facts nf
    LEFT JOIN reservations r ON r.id = nf.reservation_id
    WHERE ${Prisma.join(whereClauses, " AND ")}
    GROUP BY nf.date, nf.currency
    ORDER BY nf.date ASC
  `).catch((error: unknown) => {
    if (isMissingGuestFeeColumnError(error)) {
      throw toGuestFeeColumnMigrationError();
    }

    throw error;
  });

  const fx = new FxConverter();
  const output = new Map<string, DailyTotals>();

  for (const row of rows) {
    const dateKey = toDateOnly(row.date);
    const convertedRevenueIncl = await fx.convert(
      asNumber(row.revenueIncl),
      row.date,
      row.currency,
      params.displayCurrency
    );
    const convertedFees = await fx.convert(
      asNumber(row.feesAllocated),
      row.date,
      row.currency,
      params.displayCurrency
    );

    const current = output.get(dateKey) ?? emptyDailyTotals();
    current.nights += asNumber(row.nights);
    current.revenueIncl += convertedRevenueIncl;
    current.fees += convertedFees;
    output.set(dateKey, current);
  }

  return output;
}

async function groupReservationBookingsDaily(params: {
  tenantId: string;
  bookingDateFrom: Date;
  bookingDateTo: Date;
  listingIds: string[];
  channels: string[];
  statuses: string[];
  displayCurrency: string;
}): Promise<Map<string, DailyTotals>> {
  const bookingDateTextSql = Prisma.sql`COALESCE(
    NULLIF(r.raw_json ->> 'reservationDate', ''),
    NULLIF(r.raw_json ->> 'reservation_date', ''),
    NULLIF(r.raw_json ->> 'bookedOn', ''),
    NULLIF(r.raw_json ->> 'booked_on', ''),
    NULLIF(r.raw_json ->> 'bookingCreatedDate', ''),
    NULLIF(r.raw_json ->> 'booking_created_date', ''),
    NULLIF(r.raw_json ->> 'createdAt', ''),
    NULLIF(r.raw_json ->> 'created_at', '')
  )`;
  const bookingDateSql = Prisma.sql`
    DATE(
      COALESCE(
        CASE
          WHEN ${bookingDateTextSql} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN REPLACE(${bookingDateTextSql}, ' ', 'T')::timestamptz
          ELSE NULL
        END,
        r.created_at
      )
    )
  `;
  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`r.tenant_id = ${params.tenantId}`,
    Prisma.sql`${bookingDateSql} >= ${params.bookingDateFrom}::date`,
    Prisma.sql`${bookingDateSql} <= ${params.bookingDateTo}::date`
  ];

  if (params.listingIds.length > 0) {
    whereClauses.push(Prisma.sql`r.listing_id IN (${Prisma.join(params.listingIds)})`);
  }

  if (params.channels.length > 0) {
    const channelFilters = expandChannelFilterValues(params.channels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(r.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (params.statuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(r.status, '')) IN (${Prisma.join(params.statuses)})`);
  }

  const rows = await prisma.$queryRaw<ReservationBookingDailyRow[]>(Prisma.sql`
    SELECT
      ${bookingDateSql} AS "date",
      r.currency AS "currency",
      COALESCE(SUM(COALESCE(r.nights, 0)), 0)::int AS "nights",
      COALESCE(SUM(COALESCE(r.total, 0)), 0)::numeric(18, 6) AS "revenueIncl",
      COALESCE(
        SUM(
          LEAST(
            COALESCE(r.total, 0),
            GREATEST(0, COALESCE(r.cleaning_fee, 0) + COALESCE(r.guest_fee, 0))
          )
        ),
        0
      )::numeric(18, 6) AS "feesAllocated"
    FROM reservations r
    WHERE ${Prisma.join(whereClauses, " AND ")}
    GROUP BY 1, r.currency
    ORDER BY 1 ASC
  `).catch((error: unknown) => {
    if (isMissingGuestFeeColumnError(error)) {
      throw toGuestFeeColumnMigrationError();
    }

    throw error;
  });

  const fx = new FxConverter();
  const output = new Map<string, DailyTotals>();

  for (const row of rows) {
    const dateKey = toDateOnly(row.date);
    const convertedRevenueIncl = await fx.convert(
      asNumber(row.revenueIncl),
      row.date,
      row.currency,
      params.displayCurrency
    );
    const convertedFees = await fx.convert(
      asNumber(row.feesAllocated),
      row.date,
      row.currency,
      params.displayCurrency
    );

    const current = output.get(dateKey) ?? emptyDailyTotals();
    current.nights += asNumber(row.nights);
    current.revenueIncl += convertedRevenueIncl;
    current.fees += convertedFees;
    output.set(dateKey, current);
  }

  return output;
}

async function groupCalendarInventoryDaily(params: {
  tenantId: string;
  stayDateFrom: Date;
  stayDateTo: Date;
  listingIds: string[];
}): Promise<Map<string, number>> {
  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`cr.tenant_id = ${params.tenantId}`,
    Prisma.sql`cr.date >= ${params.stayDateFrom}::date`,
    Prisma.sql`cr.date <= ${params.stayDateTo}::date`
  ];

  if (params.listingIds.length > 0) {
    whereClauses.push(Prisma.sql`cr.listing_id IN (${Prisma.join(params.listingIds)})`);
  }

  const rows = await prisma.$queryRaw<CalendarInventoryDailyRow[]>(Prisma.sql`
    SELECT
      cr.date AS "date",
      COUNT(*)::int AS "inventoryNights"
    FROM calendar_rates cr
    WHERE ${Prisma.join(whereClauses, " AND ")}
    GROUP BY cr.date
    ORDER BY cr.date ASC
  `);

  const output = new Map<string, number>();
  for (const row of rows) {
    output.set(toDateOnly(row.date), asNumber(row.inventoryNights));
  }

  return output;
}

function withInventoryDailyFallback(params: {
  from: Date;
  to: Date;
  daily: Map<string, DailyTotals>;
  calendarInventoryDaily: Map<string, number>;
  fallbackInventoryNights: number;
}): Map<string, DailyTotals> {
  const output = new Map<string, DailyTotals>();
  for (let cursor = fromDateOnly(toDateOnly(params.from)); cursor <= params.to; cursor = addUtcDays(cursor, 1)) {
    const dateKey = toDateOnly(cursor);
    const current = params.daily.get(dateKey) ?? emptyDailyTotals();
    const calendarInventory = params.calendarInventoryDaily.get(dateKey) ?? 0;
    const fallbackInventory = Math.max(0, params.fallbackInventoryNights);
    const inventoryNights = Math.max(
      current.nights,
      calendarInventory > 0 ? calendarInventory : fallbackInventory
    );

    output.set(dateKey, {
      ...current,
      inventoryNights
    });
  }

  return output;
}

function assertValidRange(stayDateFrom: Date, stayDateTo: Date): void {
  if (stayDateFrom > stayDateTo) {
    throw new Error("stayDateFrom must be on or before stayDateTo");
  }
}

function buildSeriesResponse(params: {
  currentFrom: Date;
  currentTo: Date;
  lastYearFrom: Date;
  lastYearTo: Date;
  granularity: Granularity;
  includeFees: boolean;
  currentDaily: Map<string, DailyTotals>;
  lastYearDaily: Map<string, DailyTotals>;
}): Pick<ReportResponse, "buckets" | "current" | "lastYear"> {
  const currentBuckets = rangeToBucketLabels(params.currentFrom, params.currentTo, params.granularity);
  const lyBuckets = rangeToBucketLabels(params.lastYearFrom, params.lastYearTo, params.granularity);

  const currentByBucket = foldDailyToBuckets(params.currentDaily, params.granularity);
  const lyByBucket = foldDailyToBuckets(params.lastYearDaily, params.granularity);

  return {
    buckets: currentBuckets,
    current: seriesFromBucketLabels(currentBuckets, currentByBucket, params.includeFees),
    lastYear: alignedLySeries(currentBuckets, lyBuckets, lyByBucket, params.includeFees)
  };
}

export async function buildSalesReport(params: ReportBaseParams): Promise<ReportResponse> {
  const currentFrom = fromDateOnly(params.request.stayDateFrom);
  const currentTo = fromDateOnly(params.request.stayDateTo);
  assertValidRange(currentFrom, currentTo);

  const activeBeforeDate = params.request.activeBeforeDate ? fromDateOnly(params.request.activeBeforeDate) : null;
  const lastYearFrom = addUtcYearsClamped(currentFrom, -1);
  const lastYearTo = addUtcYearsClamped(currentTo, -1);
  const normalizedStatuses = normalizeFilterValues(params.request.statuses);
  const normalizedChannels = normalizeFilterValues(params.request.channels);
  const comparisonScope = await resolveComparisonListingScope({
    tenantId: params.tenantId,
    requestedListingIds: params.request.listingIds,
    activeBeforeDate
  });
  const scopedListingIds =
    activeBeforeDate !== null ? comparisonScope.comparisonListingIds : comparisonScope.scopedListingIds;
  const queryListingIds = listingIdsOrNoMatch(scopedListingIds);
  const fallbackInventoryNights = scopedListingIds.length;

  const [currentDailyRaw, lastYearDailyRaw, currentInventoryDaily, lastYearInventoryDaily] = await Promise.all([
    groupNightFactsDaily({
      tenantId: params.tenantId,
      stayDateFrom: currentFrom,
      stayDateTo: currentTo,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupNightFactsDaily({
      tenantId: params.tenantId,
      stayDateFrom: lastYearFrom,
      stayDateTo: lastYearTo,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupCalendarInventoryDaily({
      tenantId: params.tenantId,
      stayDateFrom: currentFrom,
      stayDateTo: currentTo,
      listingIds: queryListingIds
    }),
    groupCalendarInventoryDaily({
      tenantId: params.tenantId,
      stayDateFrom: lastYearFrom,
      stayDateTo: lastYearTo,
      listingIds: queryListingIds
    })
  ]);

  const currentDaily = withInventoryDailyFallback({
    from: currentFrom,
    to: currentTo,
    daily: currentDailyRaw,
    calendarInventoryDaily: currentInventoryDaily,
    fallbackInventoryNights
  });

  const lastYearDaily = withInventoryDailyFallback({
    from: lastYearFrom,
    to: lastYearTo,
    daily: lastYearDailyRaw,
    calendarInventoryDaily: lastYearInventoryDaily,
    fallbackInventoryNights
  });

  const series = buildSeriesResponse({
    currentFrom,
    currentTo,
    lastYearFrom,
    lastYearTo,
    granularity: params.request.granularity,
    includeFees: params.request.includeFees,
    currentDaily,
    lastYearDaily
  });

  return {
    ...series,
    meta: {
      displayCurrency: params.displayCurrency,
      snapshotDateUsed: null,
      snapshotDateLyUsed: null,
      comparisonScope: comparisonScope.comparisonScope
    }
  };
}

export async function buildPaceReport(params: ReportBaseParams): Promise<ReportResponse> {
  const currentFrom = fromDateOnly(params.request.stayDateFrom);
  const currentTo = fromDateOnly(params.request.stayDateTo);
  assertValidRange(currentFrom, currentTo);

  const activeBeforeDate = params.request.activeBeforeDate ? fromDateOnly(params.request.activeBeforeDate) : null;
  const compareMode = params.request.compareMode ?? "yoy_otb";
  const lastYearFrom = addUtcYearsClamped(currentFrom, -1);
  const lastYearTo = addUtcYearsClamped(currentTo, -1);
  const bookingCutoffDate = addUtcDays(fromDateOnly(toDateOnly(new Date())), -365);
  const normalizedStatuses = normalizeFilterValues(params.request.statuses);
  const normalizedChannels = normalizeFilterValues(params.request.channels);
  const comparisonScope = await resolveComparisonListingScope({
    tenantId: params.tenantId,
    requestedListingIds: params.request.listingIds,
    activeBeforeDate
  });
  const scopedListingIds = comparisonScope.comparisonListingIds;
  const queryListingIds = listingIdsOrNoMatch(scopedListingIds);

  const [currentByListingDaily, lastYearByListingDailyRaw] = await Promise.all([
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: currentFrom,
      stayDateTo: currentTo,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    compareMode === "ly_stayed"
      ? groupNightFactsDailyByListing({
          tenantId: params.tenantId,
          stayDateFrom: lastYearFrom,
          stayDateTo: lastYearTo,
          listingIds: queryListingIds,
          channels: normalizedChannels,
          statuses: normalizedStatuses,
          displayCurrency: params.displayCurrency
        })
      : groupNightFactsDailyByListing({
          tenantId: params.tenantId,
          stayDateFrom: lastYearFrom,
          stayDateTo: lastYearTo,
          listingIds: queryListingIds,
          channels: normalizedChannels,
          statuses: normalizedStatuses,
          displayCurrency: params.displayCurrency,
          bookingCreatedAtCutoff: bookingCutoffDate,
          excludeMissingBookingCreatedAt: true,
          includeCancelledAfterCutoff: true
        })
  ]);

  const gatedPaceDaily = applyPaceLifecycleGateByListing({
    listingIds: scopedListingIds,
    currentFrom,
    currentTo,
    currentByListingDaily,
    referenceByListingDaily: lastYearByListingDailyRaw,
    gateCurrent: false,
    lifecycleByListing: comparisonScope.lifecycleByListing
  });

  const currentDaily = aggregateListingDaily({
    listingIds: scopedListingIds,
    byListingDaily: currentByListingDaily,
    from: currentFrom,
    to: currentTo
  });
  const lastYearDaily = aggregateListingDaily({
    listingIds: scopedListingIds,
    byListingDaily: gatedPaceDaily.referenceByListingDaily,
    from: lastYearFrom,
    to: lastYearTo
  });

  const series = buildSeriesResponse({
    currentFrom,
    currentTo,
    lastYearFrom,
    lastYearTo,
    granularity: params.request.granularity,
    includeFees: params.request.includeFees,
    currentDaily,
    lastYearDaily
  });

  return {
    ...series,
    meta: {
      displayCurrency: params.displayCurrency,
      snapshotDateUsed: null,
      snapshotDateLyUsed: null,
      comparisonScope: comparisonScope.comparisonScope
    }
  };
}

export async function buildBookedReport(params: ReportBaseParams): Promise<ReportResponse> {
  const currentFrom = fromDateOnly(params.request.stayDateFrom);
  const currentTo = fromDateOnly(params.request.stayDateTo);
  assertValidRange(currentFrom, currentTo);

  const activeBeforeDate = params.request.activeBeforeDate ? fromDateOnly(params.request.activeBeforeDate) : null;
  const lastYearFrom = addUtcYearsClamped(currentFrom, -1);
  const lastYearTo = addUtcYearsClamped(currentTo, -1);
  const normalizedStatuses = normalizeFilterValues(params.request.statuses);
  const normalizedChannels = normalizeFilterValues(params.request.channels);
  const comparisonScope = await resolveComparisonListingScope({
    tenantId: params.tenantId,
    requestedListingIds: params.request.listingIds,
    activeBeforeDate
  });
  const scopedListingIds = comparisonScope.comparisonListingIds;
  const queryListingIds = listingIdsOrNoMatch(scopedListingIds);

  const [currentDaily, lastYearDaily] = await Promise.all([
    groupReservationBookingsDaily({
      tenantId: params.tenantId,
      bookingDateFrom: currentFrom,
      bookingDateTo: currentTo,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupReservationBookingsDaily({
      tenantId: params.tenantId,
      bookingDateFrom: lastYearFrom,
      bookingDateTo: lastYearTo,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    })
  ]);

  const series = buildSeriesResponse({
    currentFrom,
    currentTo,
    lastYearFrom,
    lastYearTo,
    granularity: params.request.granularity,
    includeFees: params.request.includeFees,
    currentDaily,
    lastYearDaily
  });

  return {
    ...series,
    meta: {
      displayCurrency: params.displayCurrency,
      snapshotDateUsed: null,
      snapshotDateLyUsed: null,
      comparisonScope: comparisonScope.comparisonScope
    }
  };
}

export async function buildBookWindowReport(params: BookWindowBaseParams): Promise<BookWindowReportResponse> {
  const requestedLookbackDays = params.request.lookbackDays ?? 30;
  const mode = params.request.mode ?? "booked";
  const includeFees = params.request.includeFees ?? true;
  const today = fromDateOnly(toDateOnly(new Date()));
  const customDateFrom = params.request.customDateFrom ? fromDateOnly(params.request.customDateFrom) : null;
  const customDateTo = params.request.customDateTo ? fromDateOnly(params.request.customDateTo) : null;
  const dateFrom = customDateFrom ?? addUtcDays(today, -(requestedLookbackDays - 1));
  const dateTo = customDateTo ?? today;
  const lookbackDays = Math.max(1, Math.round((dateTo.getTime() - dateFrom.getTime()) / 86_400_000) + 1);

  const normalizedStatuses = normalizeFilterValues(params.request.statuses);
  const normalizedChannels = normalizeFilterValues(params.request.channels);
  const scopedListingIds = await resolveScopedListingIds(params.tenantId, params.request.listingIds);
  const bookingDateTextSql = Prisma.sql`COALESCE(
    NULLIF(r.raw_json ->> 'reservationDate', ''),
    NULLIF(r.raw_json ->> 'reservation_date', ''),
    NULLIF(r.raw_json ->> 'bookedOn', ''),
    NULLIF(r.raw_json ->> 'booked_on', ''),
    NULLIF(r.raw_json ->> 'bookingCreatedDate', ''),
    NULLIF(r.raw_json ->> 'booking_created_date', ''),
    NULLIF(r.raw_json ->> 'createdAt', ''),
    NULLIF(r.raw_json ->> 'created_at', '')
  )`;
  const bookedAnchorDateSql = Prisma.sql`
    DATE(
      COALESCE(
        CASE
          WHEN ${bookingDateTextSql} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN REPLACE(${bookingDateTextSql}, ' ', 'T')::timestamptz
          ELSE NULL
        END,
        r.created_at
      )
    )
  `;
  const anchorDateSql = mode === "booked" ? bookedAnchorDateSql : Prisma.sql`r.arrival`;

  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`r.tenant_id = ${params.tenantId}`,
    Prisma.sql`${anchorDateSql} >= ${dateFrom}::date`,
    Prisma.sql`${anchorDateSql} <= ${dateTo}::date`
  ];

  if (scopedListingIds.length > 0) {
    whereClauses.push(Prisma.sql`r.listing_id IN (${Prisma.join(scopedListingIds)})`);
  }

  if (normalizedChannels.length > 0) {
    const channelFilters = expandChannelFilterValues(normalizedChannels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(r.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (normalizedStatuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(r.status, '')) IN (${Prisma.join(normalizedStatuses)})`);
  }

  const rows = await prisma.$queryRaw<BookWindowRawRow[]>(Prisma.sql`
    SELECT
      CASE
        WHEN scoped.lead_days <= 1 THEN 0
        WHEN scoped.lead_days <= 3 THEN 1
        WHEN scoped.lead_days <= 7 THEN 2
        WHEN scoped.lead_days <= 14 THEN 3
        WHEN scoped.lead_days <= 30 THEN 4
        WHEN scoped.lead_days <= 60 THEN 5
        WHEN scoped.lead_days <= 90 THEN 6
        WHEN scoped.lead_days <= 120 THEN 7
        ELSE 8
      END::int AS "bucketIndex",
      CASE
        WHEN scoped.lead_days <= 1 THEN '0-1'
        WHEN scoped.lead_days <= 3 THEN '2-3'
        WHEN scoped.lead_days <= 7 THEN '4-7'
        WHEN scoped.lead_days <= 14 THEN '8-14'
        WHEN scoped.lead_days <= 30 THEN '15-30'
        WHEN scoped.lead_days <= 60 THEN '31-60'
        WHEN scoped.lead_days <= 90 THEN '61-90'
        WHEN scoped.lead_days <= 120 THEN '91-120'
        ELSE '121+'
      END AS "bucketKey",
      scoped.fx_date AS "fxDate",
      scoped.currency AS "currency",
      COALESCE(SUM(COALESCE(scoped.nights, 0)), 0)::int AS "nights",
      COUNT(*)::int AS "reservations",
      COALESCE(
        SUM(
          CASE
            WHEN LOWER(COALESCE(scoped.status, '')) IN ('cancelled', 'canceled', 'no-show', 'no_show') THEN 1
            ELSE 0
          END
        ),
        0
      )::int AS "cancelledReservations",
      COALESCE(SUM(COALESCE(scoped.total, 0)), 0)::numeric(18, 6) AS "revenueIncl",
      COALESCE(
        SUM(
          LEAST(
            COALESCE(scoped.total, 0),
            GREATEST(0, COALESCE(scoped.cleaning_fee, 0) + COALESCE(scoped.guest_fee, 0))
          )
        ),
        0
      )::numeric(18, 6) AS "feesAllocated"
    FROM (
      SELECT
        r.*,
        ${anchorDateSql} AS fx_date,
        GREATEST(0, DATE(r.arrival) - ${bookedAnchorDateSql})::int AS lead_days
      FROM reservations r
      WHERE ${Prisma.join(whereClauses, " AND ")}
    ) scoped
    GROUP BY
      "bucketIndex",
      "bucketKey",
      scoped.fx_date,
      scoped.currency
    ORDER BY "bucketIndex" ASC, scoped.fx_date ASC
  `).catch((error: unknown) => {
    if (isMissingGuestFeeColumnError(error)) {
      throw toGuestFeeColumnMigrationError();
    }

    throw error;
  });

  const bucketMap = new Map<string, {
    nights: number;
    reservations: number;
    cancelledReservations: number;
    revenueIncl: number;
    feesAllocated: number;
  }>();

  for (const bucket of BOOK_WINDOW_BUCKETS) {
    bucketMap.set(bucket.key, {
      nights: 0,
      reservations: 0,
      cancelledReservations: 0,
      revenueIncl: 0,
      feesAllocated: 0
    });
  }

  const fx = new FxConverter();
  for (const row of rows) {
    const current = bucketMap.get(row.bucketKey);
    if (!current) continue;

    const convertedRevenue = await fx.convert(
      asNumber(row.revenueIncl),
      row.fxDate,
      row.currency,
      params.displayCurrency
    );
    const convertedFees = await fx.convert(
      asNumber(row.feesAllocated),
      row.fxDate,
      row.currency,
      params.displayCurrency
    );

    current.nights += asNumber(row.nights);
    current.reservations += asNumber(row.reservations);
    current.cancelledReservations += asNumber(row.cancelledReservations);
    current.revenueIncl += convertedRevenue;
    current.feesAllocated += convertedFees;
  }

  const totalNights = [...bucketMap.values()].reduce((sum, row) => sum + row.nights, 0);
  const totalReservations = [...bucketMap.values()].reduce((sum, row) => sum + row.reservations, 0);

  const buckets: BookWindowBucket[] = BOOK_WINDOW_BUCKETS.map((definition) => {
    const totals = bucketMap.get(definition.key) ?? {
      nights: 0,
      reservations: 0,
      cancelledReservations: 0,
      revenueIncl: 0,
      feesAllocated: 0
    };

    const resolvedRevenue = includeFees
      ? totals.revenueIncl
      : Math.max(0, totals.revenueIncl - totals.feesAllocated);
    const nightsPct = totalNights > 0 ? (totals.nights / totalNights) * 100 : 0;
    const adr = totals.nights > 0 ? resolvedRevenue / totals.nights : 0;
    const cancellationPct = totals.reservations > 0 ? (totals.cancelledReservations / totals.reservations) * 100 : 0;
    const avgLos = totals.reservations > 0 ? totals.nights / totals.reservations : 0;

    return {
      key: definition.key,
      label: definition.label,
      nights: roundTo2(totals.nights),
      nightsPct: roundTo2(nightsPct),
      adr: roundTo2(adr),
      cancellationPct: roundTo2(cancellationPct),
      avgLos: roundTo2(avgLos),
      reservations: roundTo2(totals.reservations),
      cancelledReservations: roundTo2(totals.cancelledReservations)
    };
  });

  return {
    mode,
    lookbackDays,
    dateFrom: toDateOnly(dateFrom),
    dateTo: toDateOnly(dateTo),
    buckets,
    meta: {
      displayCurrency: params.displayCurrency,
      totalNights: roundTo2(totalNights),
      totalReservations: roundTo2(totalReservations),
      includeFees
    }
  };
}

function bookingWindowTotals(params: {
  byDate: Map<string, BookingHeadlineTotals>;
  from: Date;
  to: Date;
  includeFees: boolean;
}): { reservations: number; nights: number; revenue: number } {
  let reservations = 0;
  let nights = 0;
  let revenue = 0;

  for (let cursor = fromDateOnly(toDateOnly(params.from)); cursor <= params.to; cursor = addUtcDays(cursor, 1)) {
    const key = toDateOnly(cursor);
    const row = params.byDate.get(key);
    if (!row) continue;

    reservations += row.reservations;
    nights += row.nights;
    revenue += params.includeFees ? row.revenueIncl : Math.max(0, row.revenueIncl - row.fees);
  }

  return {
    reservations: roundTo2(reservations),
    nights: roundTo2(nights),
    revenue: roundTo2(revenue)
  };
}

function earlierOfDates(a: Date, b: Date): Date {
  return a <= b ? a : b;
}

function laterOfDates(a: Date, b: Date): Date {
  return a >= b ? a : b;
}

function getDailyTotalsOrEmpty(map: Map<string, DailyTotals>, dateKey: string): DailyTotals {
  return map.get(dateKey) ?? cloneEmptyTotals();
}

function monthLabel(bucket: string): string {
  const [year, month] = bucket.split("-");
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  if (!Number.isFinite(parsedYear) || !Number.isFinite(parsedMonth)) return bucket;

  const date = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(date);
}

export async function buildHomeDashboard(params: HomeDashboardBaseParams): Promise<HomeDashboardResponse> {
  const includeFees = params.request.includeFees ?? true;
  const today = fromDateOnly(toDateOnly(new Date()));
  const yesterday = addUtcDays(today, -1);
  const thisWeekStart = startOfUtcWeek(today);
  const thisWeekEnd = addUtcDays(thisWeekStart, 6);
  const thisMonthStart = startOfUtcMonth(today);
  const thisMonthEnd = addUtcDays(addUtcMonths(thisMonthStart, 1), -1);
  const paceCutoff = addUtcDays(today, -365);

  const normalizedStatuses = normalizeFilterValues(params.request.statuses);
  const normalizedChannels = normalizeFilterValues(params.request.channels);
  const bookedCustomFrom = params.request.bookedCustomDateFrom
    ? fromDateOnly(params.request.bookedCustomDateFrom)
    : thisMonthStart;
  const bookedCustomTo = params.request.bookedCustomDateTo
    ? fromDateOnly(params.request.bookedCustomDateTo)
    : today;
  const stayedCustomFrom = params.request.stayedCustomDateFrom
    ? fromDateOnly(params.request.stayedCustomDateFrom)
    : thisMonthStart;
  const stayedCustomTo = params.request.stayedCustomDateTo
    ? fromDateOnly(params.request.stayedCustomDateTo)
    : thisMonthEnd;

  const bookedRangeFrom = [yesterday, thisWeekStart, thisMonthStart, bookedCustomFrom].reduce(
    (min, value) => (value < min ? value : min),
    today
  );
  const bookedRangeTo = [today, bookedCustomTo].reduce(
    (max, value) => (value > max ? value : max),
    today
  );
  const stayedRangeFrom = [yesterday, thisWeekStart, thisMonthStart, stayedCustomFrom, today].reduce(
    (min, value) => (value < min ? value : min),
    today
  );
  const stayedRangeTo = [today, thisWeekEnd, thisMonthEnd, stayedCustomTo].reduce(
    (max, value) => (value > max ? value : max),
    today
  );

  const focusMonthFrom = today;
  const focusMonthTo = addUtcDays(addUtcMonths(startOfUtcMonth(today), 6), -1);
  const focusMonthLyFrom = addUtcYearsClamped(focusMonthFrom, -1);
  const focusMonthLyTo = addUtcYearsClamped(focusMonthTo, -1);
  const focusWeekFrom = today;
  const focusWeekTo = addUtcDays(today, 12 * 7 - 1);
  const focusWeekLyFrom = addUtcYearsClamped(focusWeekFrom, -1);
  const focusWeekLyTo = addUtcYearsClamped(focusWeekTo, -1);
  const futureMonthStart = startOfUtcMonth(today);
  const futureMonthTo = addUtcDays(addUtcMonths(futureMonthStart, 12), -1);
  const futureLyMonthStart = addUtcYearsClamped(futureMonthStart, -1);
  const futureLyMonthTo = addUtcYearsClamped(futureMonthTo, -1);
  const activeBeforeDate = params.request.activeBeforeDate ? fromDateOnly(params.request.activeBeforeDate) : null;
  const filteredComparisonScope = await resolveComparisonListingScope({
    tenantId: params.tenantId,
    requestedListingIds: params.request.listingIds,
    activeBeforeDate
  });
  const portfolioComparisonScope = await resolveComparisonListingScope({
    tenantId: params.tenantId,
    requestedListingIds: [],
    activeBeforeDate: null
  });
  const scopedListingIds = filteredComparisonScope.comparisonListingIds;
  const queryScopedListingIds = listingIdsOrNoMatch(scopedListingIds);
  const focusFinderUseFilteredScope = params.request.focusFinderUseFilteredScope ?? false;
  const focusComparisonListingIds = focusFinderUseFilteredScope
    ? filteredComparisonScope.comparisonListingIds
    : portfolioComparisonScope.scopedListingIds;
  const focusDisplayListingIds = focusFinderUseFilteredScope
    ? filteredComparisonScope.scopedListingIds
    : portfolioComparisonScope.scopedListingIds;
  const focusQueryListingIds = listingIdsOrNoMatch(focusComparisonListingIds);
  const highDemandQueryListingIds = listingIdsOrNoMatch(focusDisplayListingIds);
  const focusChannels = focusFinderUseFilteredScope ? normalizedChannels : [];
  const focusStatuses = focusFinderUseFilteredScope ? normalizedStatuses : [];
  const listingMetadata = await loadListingMetadata(params.tenantId, scopedListingIds);
  const listingNameById = new Map(listingMetadata.map((listing) => [listing.id, listing.name]));

  const bookedLyRangeFrom = addUtcYearsClamped(bookedRangeFrom, -1);
  const bookedLyRangeTo = addUtcYearsClamped(bookedRangeTo, -1);
  const stayedLyRangeFrom = addUtcYearsClamped(stayedRangeFrom, -1);
  const stayedLyRangeTo = addUtcYearsClamped(stayedRangeTo, -1);

  const [bookingDaily, bookingLyDaily, stayDaily, stayLyDaily] = await Promise.all([
    groupBookingHeadlineDaily({
      tenantId: params.tenantId,
      bookingDateFrom: bookedRangeFrom,
      bookingDateTo: bookedRangeTo,
      listingIds: queryScopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupBookingHeadlineDaily({
      tenantId: params.tenantId,
      bookingDateFrom: bookedLyRangeFrom,
      bookingDateTo: bookedLyRangeTo,
      listingIds: queryScopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupStayHeadlineDaily({
      tenantId: params.tenantId,
      stayDateFrom: stayedRangeFrom,
      stayDateTo: stayedRangeTo,
      listingIds: queryScopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupStayHeadlineDaily({
      tenantId: params.tenantId,
      stayDateFrom: stayedLyRangeFrom,
      stayDateTo: stayedLyRangeTo,
      listingIds: queryScopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    })
  ]);

  const headlineBookedToday = {
    current: bookingWindowTotals({ byDate: bookingDaily, from: today, to: today, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: bookingLyDaily,
      from: addUtcYearsClamped(today, -1),
      to: addUtcYearsClamped(today, -1),
      includeFees
    })
  };
  const headlineBookedYesterday = {
    current: bookingWindowTotals({ byDate: bookingDaily, from: yesterday, to: yesterday, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: bookingLyDaily,
      from: addUtcYearsClamped(yesterday, -1),
      to: addUtcYearsClamped(yesterday, -1),
      includeFees
    })
  };
  const headlineBookedWeek = {
    current: bookingWindowTotals({ byDate: bookingDaily, from: thisWeekStart, to: today, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: bookingLyDaily,
      from: addUtcYearsClamped(thisWeekStart, -1),
      to: addUtcYearsClamped(today, -1),
      includeFees
    })
  };
  const headlineBookedMonth = {
    current: bookingWindowTotals({ byDate: bookingDaily, from: thisMonthStart, to: today, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: bookingLyDaily,
      from: addUtcYearsClamped(thisMonthStart, -1),
      to: addUtcYearsClamped(today, -1),
      includeFees
    })
  };
  const headlineBookedCustom = {
    current:
      bookedCustomFrom <= bookedCustomTo
        ? bookingWindowTotals({
            byDate: bookingDaily,
            from: bookedCustomFrom,
            to: bookedCustomTo,
            includeFees
          })
        : { revenue: 0, reservations: 0, nights: 0 },
    lastYear:
      bookedCustomFrom <= bookedCustomTo
        ? bookingWindowTotals({
            byDate: bookingLyDaily,
            from: addUtcYearsClamped(bookedCustomFrom, -1),
            to: addUtcYearsClamped(bookedCustomTo, -1),
            includeFees
          })
        : { revenue: 0, reservations: 0, nights: 0 }
  };

  const lyToday = addUtcYearsClamped(today, -1);
  const lyWeekStart = addUtcYearsClamped(thisWeekStart, -1);
  const lyWeekEnd = addUtcYearsClamped(thisWeekEnd, -1);
  const lyMonthStart = addUtcYearsClamped(thisMonthStart, -1);
  const lyMonthEnd = addUtcYearsClamped(thisMonthEnd, -1);
  const lyStayedCustomFrom = addUtcYearsClamped(stayedCustomFrom, -1);
  const lyStayedCustomTo = addUtcYearsClamped(stayedCustomTo, -1);
  const zeroHeadlineTotals = { revenue: 0, reservations: 0, nights: 0 };

  const headlineArrivalsToday = {
    current: bookingWindowTotals({ byDate: stayDaily, from: today, to: today, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: stayLyDaily,
      from: lyToday,
      to: lyToday,
      includeFees
    })
  };
  const headlineArrivalsYesterday = {
    current: zeroHeadlineTotals,
    lastYear: zeroHeadlineTotals
  };
  const headlineArrivalsWeek = {
    current: bookingWindowTotals({ byDate: stayDaily, from: today, to: thisWeekEnd, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: stayLyDaily,
      from: lyToday,
      to: lyWeekEnd,
      includeFees
    })
  };
  const headlineArrivalsMonth = {
    current: bookingWindowTotals({ byDate: stayDaily, from: today, to: thisMonthEnd, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: stayLyDaily,
      from: lyToday,
      to: lyMonthEnd,
      includeFees
    })
  };
  const headlineArrivalsCustom = {
    current:
      laterOfDates(today, stayedCustomFrom) <= stayedCustomTo
        ? bookingWindowTotals({
            byDate: stayDaily,
            from: laterOfDates(today, stayedCustomFrom),
            to: stayedCustomTo,
            includeFees
          })
        : zeroHeadlineTotals,
    lastYear:
      laterOfDates(lyToday, lyStayedCustomFrom) <= lyStayedCustomTo
        ? bookingWindowTotals({
            byDate: stayLyDaily,
            from: laterOfDates(lyToday, lyStayedCustomFrom),
            to: lyStayedCustomTo,
            includeFees
          })
        : zeroHeadlineTotals
  };

  const headlineStayedToday = {
    current: bookingWindowTotals({ byDate: stayDaily, from: today, to: today, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: stayLyDaily,
      from: lyToday,
      to: lyToday,
      includeFees
    })
  };
  const headlineStayedYesterday = {
    current: bookingWindowTotals({ byDate: stayDaily, from: yesterday, to: yesterday, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: stayLyDaily,
      from: addUtcYearsClamped(yesterday, -1),
      to: addUtcYearsClamped(yesterday, -1),
      includeFees
    })
  };
  const headlineStayedWeek = {
    current: bookingWindowTotals({ byDate: stayDaily, from: thisWeekStart, to: today, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: stayLyDaily,
      from: lyWeekStart,
      to: lyToday,
      includeFees
    })
  };
  const headlineStayedMonth = {
    current: bookingWindowTotals({ byDate: stayDaily, from: thisMonthStart, to: today, includeFees }),
    lastYear: bookingWindowTotals({
      byDate: stayLyDaily,
      from: lyMonthStart,
      to: lyToday,
      includeFees
    })
  };
  const headlineStayedCustom = {
    current:
      stayedCustomFrom <= earlierOfDates(today, stayedCustomTo)
        ? bookingWindowTotals({
            byDate: stayDaily,
            from: stayedCustomFrom,
            to: earlierOfDates(today, stayedCustomTo),
            includeFees
          })
        : zeroHeadlineTotals,
    lastYear:
      lyStayedCustomFrom <= earlierOfDates(lyToday, lyStayedCustomTo)
        ? bookingWindowTotals({
            byDate: stayLyDaily,
            from: lyStayedCustomFrom,
            to: earlierOfDates(lyToday, lyStayedCustomTo),
            includeFees
          })
        : zeroHeadlineTotals
  };

  const [
    focusMonthCurrentByListing,
    focusMonthLyPaceByListingRaw,
    focusMonthLyStayedByListing,
    focusMonthLiveRateByListingDate,
    focusWeekCurrentByListing,
    focusWeekLyPaceByListingRaw,
    focusWeekLyStayedByListing,
    highDemandStayDaily
  ] =
    await Promise.all([
      groupNightFactsDailyByListing({
        tenantId: params.tenantId,
        stayDateFrom: focusMonthFrom,
        stayDateTo: focusMonthTo,
        listingIds: focusQueryListingIds,
        channels: focusChannels,
        statuses: focusStatuses,
        displayCurrency: params.displayCurrency
      }),
      groupNightFactsDailyByListing({
        tenantId: params.tenantId,
        stayDateFrom: focusMonthLyFrom,
        stayDateTo: focusMonthLyTo,
        listingIds: focusQueryListingIds,
        channels: focusChannels,
        statuses: focusStatuses,
        displayCurrency: params.displayCurrency,
        bookingCreatedAtCutoff: paceCutoff,
        excludeMissingBookingCreatedAt: true,
        includeCancelledAfterCutoff: true
      }),
      groupNightFactsDailyByListing({
        tenantId: params.tenantId,
        stayDateFrom: focusMonthLyFrom,
        stayDateTo: focusMonthLyTo,
        listingIds: focusQueryListingIds,
        channels: focusChannels,
        statuses: focusStatuses,
        displayCurrency: params.displayCurrency
      }),
      groupLiveRateAverageByListingDate({
        tenantId: params.tenantId,
        from: addUtcDays(today, 1),
        to: focusMonthTo,
        listingIds: focusComparisonListingIds,
        displayCurrency: params.displayCurrency
      }),
      groupNightFactsDailyByListing({
        tenantId: params.tenantId,
        stayDateFrom: focusWeekFrom,
        stayDateTo: focusWeekTo,
        listingIds: focusQueryListingIds,
        channels: focusChannels,
        statuses: focusStatuses,
        displayCurrency: params.displayCurrency
      }),
      groupNightFactsDailyByListing({
        tenantId: params.tenantId,
        stayDateFrom: focusWeekLyFrom,
        stayDateTo: focusWeekLyTo,
        listingIds: focusQueryListingIds,
        channels: focusChannels,
        statuses: focusStatuses,
        displayCurrency: params.displayCurrency,
        bookingCreatedAtCutoff: paceCutoff,
        excludeMissingBookingCreatedAt: true,
        includeCancelledAfterCutoff: true
      }),
      groupNightFactsDailyByListing({
        tenantId: params.tenantId,
        stayDateFrom: focusWeekLyFrom,
        stayDateTo: focusWeekLyTo,
        listingIds: focusQueryListingIds,
        channels: focusChannels,
        statuses: focusStatuses,
        displayCurrency: params.displayCurrency
      }),
      groupStayHeadlineDaily({
        tenantId: params.tenantId,
        stayDateFrom: today,
        stayDateTo: addUtcDays(today, 180),
        listingIds: highDemandQueryListingIds,
        channels: focusChannels,
        statuses: focusStatuses,
        displayCurrency: params.displayCurrency
      })
    ]);

  const monthBuckets = rangeToBucketLabels(focusMonthFrom, focusMonthTo, "month");
  const monthLyBuckets = rangeToBucketLabels(focusMonthLyFrom, focusMonthLyTo, "month");
  const monthCurrentByBucketByListing = foldListingDailyToBuckets({
    listingIds: focusComparisonListingIds,
    byListingDaily: focusMonthCurrentByListing,
    granularity: "month"
  });
  const monthLyPaceByBucketByListing = foldListingDailyToBuckets({
    listingIds: focusComparisonListingIds,
    byListingDaily: focusMonthLyPaceByListingRaw,
    granularity: "month"
  });
  const monthLyStayedByBucketByListing = foldListingDailyToBuckets({
    listingIds: focusComparisonListingIds,
    byListingDaily: focusMonthLyStayedByListing,
    granularity: "month"
  });
  const monthLiveUnbookedByBucketByListing = foldListingDailyToBuckets({
    listingIds: focusComparisonListingIds,
    byListingDaily: buildLiveUnbookedDailyByListing({
      listingIds: focusComparisonListingIds,
      from: addUtcDays(today, 1),
      to: focusMonthTo,
      currentByListingDaily: focusMonthCurrentByListing,
      liveRateByListingDate: focusMonthLiveRateByListingDate
    }),
    granularity: "month"
  });
  const RADAR_ADR_DELTA_THRESHOLD = 12;

  const underperformingMonths = buildLikeForLikeBucketComparisons({
    listingIds: focusComparisonListingIds,
    currentBuckets: monthBuckets,
    referenceBuckets: monthLyBuckets,
    currentByListingBucket: monthCurrentByBucketByListing,
    referenceByListingBucket: monthLyPaceByBucketByListing,
    eligibilityByListingBucket: monthLyStayedByBucketByListing,
    includeFees,
    labelForBucket: monthLabel
  })
    .filter((item) => (item.revenueDeltaPct ?? 0) < 0)
    .sort((a, b) => (a.revenueDeltaPct ?? 0) - (b.revenueDeltaPct ?? 0))
    .slice(0, 6);
  const adrOpportunityMonths = buildAdrBucketComparisons({
    listingIds: focusComparisonListingIds,
    currentBuckets: monthBuckets,
    referenceBuckets: monthLyBuckets,
    currentByListingBucket: monthLiveUnbookedByBucketByListing,
    referenceByListingBucket: monthLyStayedByBucketByListing,
    includeFees,
    labelForBucket: monthLabel
  })
    .filter((item) => item.liveAdr > 0 && Math.abs(item.adrDeltaPct ?? 0) >= RADAR_ADR_DELTA_THRESHOLD)
    .sort((a, b) => Math.abs(b.adrDeltaPct ?? 0) - Math.abs(a.adrDeltaPct ?? 0))
    .slice(0, 6);

  const weekBuckets = rangeToBucketLabels(focusWeekFrom, focusWeekTo, "week");
  const weekLyBuckets = rangeToBucketLabels(focusWeekLyFrom, focusWeekLyTo, "week");
  const weekCurrentByBucketByListing = foldListingDailyToBuckets({
    listingIds: focusComparisonListingIds,
    byListingDaily: focusWeekCurrentByListing,
    granularity: "week"
  });
  const weekLyPaceByBucketByListing = foldListingDailyToBuckets({
    listingIds: focusComparisonListingIds,
    byListingDaily: focusWeekLyPaceByListingRaw,
    granularity: "week"
  });
  const weekLyStayedByBucketByListing = foldListingDailyToBuckets({
    listingIds: focusComparisonListingIds,
    byListingDaily: focusWeekLyStayedByListing,
    granularity: "week"
  });
  const underperformingWeeks = buildLikeForLikeBucketComparisons({
    listingIds: focusComparisonListingIds,
    currentBuckets: weekBuckets,
    referenceBuckets: weekLyBuckets,
    currentByListingBucket: weekCurrentByBucketByListing,
    referenceByListingBucket: weekLyPaceByBucketByListing,
    eligibilityByListingBucket: weekLyStayedByBucketByListing,
    includeFees,
    labelForBucket: (bucket) => `Week of ${bucket}`
  })
    .filter((item) => (item.revenueDeltaPct ?? 0) < 0)
    .sort((a, b) => (a.revenueDeltaPct ?? 0) - (b.revenueDeltaPct ?? 0))
    .slice(0, 8);

  const highDemandDates = [...highDemandStayDaily.entries()]
    .map(([date, totals]) => ({
      date,
      revenue: roundTo2(includeFees ? totals.revenueIncl : Math.max(0, totals.revenueIncl - totals.fees)),
      reservations: roundTo2(totals.reservations),
      nights: roundTo2(totals.nights)
    }))
    .sort((a, b) => {
      if (b.nights !== a.nights) return b.nights - a.nights;
      if (b.reservations !== a.reservations) return b.reservations - a.reservations;
      return b.revenue - a.revenue;
    })
    .slice(0, 10);

  const detectiveStart = today;
  const detective30To = addUtcDays(today, 29);
  const taskKeyByReason = {
    paceMonthRevenue20: "pace_month_revenue_20",
    occupancy7Under60: "occ_7_under_60",
    occupancy14Under50: "occ_14_under_50",
    occupancy30Under30: "occ_30_under_30",
    adrMonthDiff10: "adr_month_diff_10"
  } as const;

  const [detectiveCurrent, futureCurrentMonthly, futureLyPaceMonthly, futureLyStayedMonthly, suppressions] = await Promise.all([
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: detectiveStart,
      stayDateTo: detective30To,
      listingIds: queryScopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: futureMonthStart,
      stayDateTo: futureMonthTo,
      listingIds: queryScopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: futureLyMonthStart,
      stayDateTo: futureLyMonthTo,
      listingIds: queryScopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency,
      bookingCreatedAtCutoff: paceCutoff,
      excludeMissingBookingCreatedAt: true,
      includeCancelledAfterCutoff: true
    }),
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: futureLyMonthStart,
      stayDateTo: futureLyMonthTo,
      listingIds: queryScopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    prisma.attentionTaskSuppression.findMany({
      where: {
        tenantId: params.tenantId,
        listingId: { in: scopedListingIds },
        suppressedUntil: { gt: new Date() }
      },
      select: {
        listingId: true,
        taskKey: true
      }
    }).catch((error: unknown) => {
      if (isMissingAttentionSuppressionTableError(error)) {
        throw toAttentionSuppressionMigrationError();
      }
      throw error;
    })
  ]);

  const suppressedSet = new Set(suppressions.map((row) => `${row.listingId}:${row.taskKey}`));
  const current7Totals = sumListingTotalsForRange({
    listingIds: scopedListingIds,
    byListingDaily: detectiveCurrent,
    from: detectiveStart,
    to: addUtcDays(detectiveStart, 6)
  });
  const current14Totals = sumListingTotalsForRange({
    listingIds: scopedListingIds,
    byListingDaily: detectiveCurrent,
    from: detectiveStart,
    to: addUtcDays(detectiveStart, 13)
  });
  const current30Totals = sumListingTotalsForRange({
    listingIds: scopedListingIds,
    byListingDaily: detectiveCurrent,
    from: detectiveStart,
    to: detective30To
  });
  const gatedFutureMonthly = applyPaceLifecycleGateByListing({
    listingIds: scopedListingIds,
    currentFrom: futureMonthStart,
    currentTo: futureMonthTo,
    currentByListingDaily: futureCurrentMonthly,
    referenceByListingDaily: futureLyPaceMonthly,
    lifecycleByListing: filteredComparisonScope.lifecycleByListing
  });

  const futureMonthBuckets = rangeToBucketLabels(futureMonthStart, futureMonthTo, "month");
  const futureLyMonthBuckets = rangeToBucketLabels(futureLyMonthStart, futureLyMonthTo, "month");
  const futureCurrentByMonthByListing = foldListingDailyToBuckets({
    listingIds: scopedListingIds,
    byListingDaily: gatedFutureMonthly.currentByListingDaily,
    granularity: "month"
  });
  const futureLyByMonthByListing = foldListingDailyToBuckets({
    listingIds: scopedListingIds,
    byListingDaily: gatedFutureMonthly.referenceByListingDaily,
    granularity: "month"
  });
  const futureLyStayedByMonthByListing = foldListingDailyToBuckets({
    listingIds: scopedListingIds,
    byListingDaily: futureLyStayedMonthly,
    granularity: "month"
  });

  const propertyDetective = scopedListingIds
    .map((listingId) => {
      const current7 = current7Totals.get(listingId) ?? cloneEmptyTotals();
      const current14 = current14Totals.get(listingId) ?? cloneEmptyTotals();
      const current30 = current30Totals.get(listingId) ?? cloneEmptyTotals();

      const occ7 = resolveOccupancyPercent(current7);
      const occ14 = resolveOccupancyPercent(current14);
      const occ30 = resolveOccupancyPercent(current30);

      let worstRevenueMonth: { bucket: string; deltaPct: number } | null = null;
      let largestAdrDiffMonth: { bucket: string; deltaPct: number } | null = null;
      const currentByMonth = futureCurrentByMonthByListing.get(listingId) ?? new Map<string, DailyTotals>();
      const lyByMonth = futureLyByMonthByListing.get(listingId) ?? new Map<string, DailyTotals>();
      const lyStayedByMonth = futureLyStayedByMonthByListing.get(listingId) ?? new Map<string, DailyTotals>();

      for (let index = 0; index < futureMonthBuckets.length; index += 1) {
        const currentBucket = futureMonthBuckets[index];
        const lyBucket = futureLyMonthBuckets[index];
        if (!lyBucket) continue;
        const currentMonth = currentByMonth.get(currentBucket) ?? cloneEmptyTotals();
        const lyMonth = lyByMonth.get(lyBucket) ?? cloneEmptyTotals();
        const lyStayedMonth = lyStayedByMonth.get(lyBucket) ?? cloneEmptyTotals();
        const lyStayedRevenue = resolveRevenue(lyStayedMonth, includeFees);
        if (lyStayedMonth.nights <= 0 && lyStayedRevenue <= 0) {
          continue;
        }

        const currentMonthRevenue = resolveRevenue(currentMonth, includeFees);
        const lyMonthRevenue = resolveRevenue(lyMonth, includeFees);
        const revenueDelta = computeDeltaPct(currentMonthRevenue, lyMonthRevenue);
        if (revenueDelta !== null && (worstRevenueMonth === null || revenueDelta < worstRevenueMonth.deltaPct)) {
          worstRevenueMonth = { bucket: currentBucket, deltaPct: revenueDelta };
        }

        const currentMonthAdr = currentMonth.nights > 0 ? currentMonthRevenue / currentMonth.nights : 0;
        const lyMonthAdr = lyMonth.nights > 0 ? lyMonthRevenue / lyMonth.nights : 0;
        const adrDelta = computeDeltaPct(currentMonthAdr, lyMonthAdr);
        if (
          adrDelta !== null &&
          (largestAdrDiffMonth === null || Math.abs(adrDelta) > Math.abs(largestAdrDiffMonth.deltaPct))
        ) {
          largestAdrDiffMonth = { bucket: currentBucket, deltaPct: adrDelta };
        }
      }

      const reasons: Array<{ key: string; text: string }> = [];
      if (occ7 < 60) reasons.push({ key: taskKeyByReason.occupancy7Under60, text: "7D occupancy is low" });
      if (occ14 < 50) reasons.push({ key: taskKeyByReason.occupancy14Under50, text: "14D occupancy is low" });
      if (occ30 < 30) reasons.push({ key: taskKeyByReason.occupancy30Under30, text: "30D occupancy is low" });
      if (worstRevenueMonth && worstRevenueMonth.deltaPct <= -20) {
        reasons.push({
          key: taskKeyByReason.paceMonthRevenue20,
          text: `Revenue pacing is behind in ${monthLabel(worstRevenueMonth.bucket)}`
        });
      }
      if (largestAdrDiffMonth && largestAdrDiffMonth.deltaPct >= 10) {
        reasons.push({
          key: taskKeyByReason.adrMonthDiff10,
          text: `ADR is much higher than last year in ${monthLabel(largestAdrDiffMonth.bucket)}`
        });
      } else if (largestAdrDiffMonth && largestAdrDiffMonth.deltaPct <= -10) {
        reasons.push({
          key: taskKeyByReason.adrMonthDiff10,
          text: `ADR is much lower than last year in ${monthLabel(largestAdrDiffMonth.bucket)}`
        });
      }

      const unsuppressed = reasons.filter((reason) => !suppressedSet.has(`${listingId}:${reason.key}`));
      if (unsuppressed.length === 0) return null;

      const severity =
        occ30 < 20 ||
        (worstRevenueMonth !== null && worstRevenueMonth.deltaPct <= -30) ||
        unsuppressed.length >= 2
          ? "high"
          : "medium";

      return {
        listingId,
        listingName: listingNameById.get(listingId) ?? listingId,
        reasonKeys: unsuppressed.map((reason) => reason.key),
        reason: unsuppressed.map((reason) => reason.text).join("; "),
        severity
      } satisfies HomeDashboardResponse["propertyDetective"][number];
    })
    .filter((row): row is HomeDashboardResponse["propertyDetective"][number] => row !== null)
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
      return a.listingName.localeCompare(b.listingName);
    })
    .slice(0, 20);

  return {
    headline: {
      booked: {
        today: headlineBookedToday,
        yesterday: headlineBookedYesterday,
        thisWeek: headlineBookedWeek,
        thisMonth: headlineBookedMonth,
        custom: headlineBookedCustom
      },
      arrivals: {
        today: headlineArrivalsToday,
        yesterday: headlineArrivalsYesterday,
        thisWeek: headlineArrivalsWeek,
        thisMonth: headlineArrivalsMonth,
        custom: headlineArrivalsCustom
      },
      stayed: {
        today: headlineStayedToday,
        yesterday: headlineStayedYesterday,
        thisWeek: headlineStayedWeek,
        thisMonth: headlineStayedMonth,
        custom: headlineStayedCustom
      }
    },
    focusFinder: {
      underperformingMonths,
      underperformingWeeks,
      adrOpportunityMonths,
      highDemandDates
    },
    propertyDetective,
    meta: {
      displayCurrency: params.displayCurrency,
      includeFees,
      generatedAt: new Date().toISOString(),
      comparisonScope: filteredComparisonScope.comparisonScope
    }
  };
}

export async function buildReservationsReport(
  params: ReservationsReportBaseParams
): Promise<ReservationsReportResponse> {
  const bookingDateFrom = fromDateOnly(params.request.bookingDateFrom);
  const bookingDateTo = fromDateOnly(params.request.bookingDateTo);
  assertValidRange(bookingDateFrom, bookingDateTo);

  const includeFees = params.request.includeFees ?? true;
  const activeBeforeDate = params.request.activeBeforeDate ? fromDateOnly(params.request.activeBeforeDate) : null;
  const normalizedStatuses = normalizeFilterValues(params.request.statuses);
  const normalizedChannels = normalizeFilterValues(params.request.channels);
  const comparisonScope = await resolveComparisonListingScope({
    tenantId: params.tenantId,
    requestedListingIds: params.request.listingIds,
    activeBeforeDate
  });
  const scopedListingIds =
    activeBeforeDate !== null ? comparisonScope.comparisonListingIds : comparisonScope.scopedListingIds;
  const queryListingIds = listingIdsOrNoMatch(scopedListingIds);

  const bookingDateTextSql = Prisma.sql`COALESCE(
    NULLIF(r.raw_json ->> 'reservationDate', ''),
    NULLIF(r.raw_json ->> 'reservation_date', ''),
    NULLIF(r.raw_json ->> 'bookedOn', ''),
    NULLIF(r.raw_json ->> 'booked_on', ''),
    NULLIF(r.raw_json ->> 'bookingCreatedDate', ''),
    NULLIF(r.raw_json ->> 'booking_created_date', ''),
    NULLIF(r.raw_json ->> 'createdAt', ''),
    NULLIF(r.raw_json ->> 'created_at', '')
  )`;
  const bookingDateSql = Prisma.sql`
    DATE(
      COALESCE(
        CASE
          WHEN ${bookingDateTextSql} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN REPLACE(${bookingDateTextSql}, ' ', 'T')::timestamptz
          ELSE NULL
        END,
        r.created_at
      )
    )
  `;
  const rootGuestNameSql = Prisma.sql`
    NULLIF(
      BTRIM(
        CONCAT_WS(
          ' ',
          NULLIF(r.raw_json ->> 'firstName', ''),
          NULLIF(r.raw_json ->> 'lastName', '')
        )
      ),
      ''
    )
  `;
  const nestedGuestNameSql = Prisma.sql`
    NULLIF(
      BTRIM(
        CONCAT_WS(
          ' ',
          NULLIF(r.raw_json #>> '{guest,firstName}', ''),
          NULLIF(r.raw_json #>> '{guest,lastName}', '')
        )
      ),
      ''
    )
  `;
  const guestNameSql = Prisma.sql`COALESCE(
    NULLIF(r.raw_json ->> 'guestName', ''),
    NULLIF(r.raw_json ->> 'guest_name', ''),
    NULLIF(r.raw_json ->> 'customerName', ''),
    NULLIF(r.raw_json ->> 'customer_name', ''),
    NULLIF(r.raw_json ->> 'primaryGuestName', ''),
    NULLIF(r.raw_json ->> 'primary_guest_name', ''),
    NULLIF(r.raw_json #>> '{guest,name}', ''),
    NULLIF(r.raw_json #>> '{guest,fullName}', ''),
    NULLIF(r.raw_json #>> '{customer,name}', ''),
    NULLIF(r.raw_json #>> '{customer,fullName}', ''),
    NULLIF(r.raw_json #>> '{primaryGuest,name}', ''),
    ${nestedGuestNameSql},
    ${rootGuestNameSql}
  )`;
  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`r.tenant_id = ${params.tenantId}`,
    Prisma.sql`${bookingDateSql} >= ${bookingDateFrom}::date`,
    Prisma.sql`${bookingDateSql} <= ${bookingDateTo}::date`
  ];

  if (queryListingIds.length > 0) {
    whereClauses.push(Prisma.sql`r.listing_id IN (${Prisma.join(queryListingIds)})`);
  }

  if (normalizedChannels.length > 0) {
    const channelFilters = expandChannelFilterValues(normalizedChannels);
    whereClauses.push(Prisma.sql`LOWER(COALESCE(r.channel, '')) IN (${Prisma.join(channelFilters)})`);
  }

  if (normalizedStatuses.length > 0) {
    whereClauses.push(Prisma.sql`LOWER(COALESCE(r.status, '')) IN (${Prisma.join(normalizedStatuses)})`);
  }

  const rows = await prisma.$queryRaw<ReservationListRawRow[]>(Prisma.sql`
    SELECT
      r.id AS "id",
      r.listing_id AS "listingId",
      l.name AS "listingName",
      LOWER(COALESCE(r.status, 'unknown')) AS "status",
      ${guestNameSql} AS "guestName",
      ${bookingDateSql} AS "bookingDate",
      r.arrival AS "arrival",
      r.departure AS "departure",
      r.nights AS "nights",
      r.currency AS "currency",
      r.total AS "total",
      r.cleaning_fee AS "cleaningFee",
      r.guest_fee AS "guestFee",
      r.channel AS "channel"
    FROM reservations r
    INNER JOIN listings l
      ON l.id = r.listing_id
      AND l.tenant_id = r.tenant_id
    WHERE ${Prisma.join(whereClauses, " AND ")}
    ORDER BY ${bookingDateSql} DESC, r.arrival ASC, l.name ASC, r.id ASC
  `).catch((error: unknown) => {
    if (isMissingGuestFeeColumnError(error)) {
      throw toGuestFeeColumnMigrationError();
    }

    throw error;
  });

  if (rows.length === 0) {
    return {
      period: {
        bookingDateFrom: toDateOnly(bookingDateFrom),
        bookingDateTo: toDateOnly(bookingDateTo)
      },
      summary: {
        reservations: 0,
        nights: 0,
        revenue: 0,
        adr: 0
      },
      rows: [],
      meta: {
        displayCurrency: params.displayCurrency,
        includeFees,
        comparisonScope: comparisonScope.comparisonScope
      }
    };
  }

  const referenceListingIds = [...new Set(rows.map((row) => row.listingId))];
  let referenceWindowStart: Date | null = null;
  let referenceWindowEnd: Date | null = null;

  for (const row of rows) {
    const rowReferenceStart = addUtcDays(row.arrival, -364);
    const rowReferenceEnd = addUtcDays(row.departure, -365);

    if (referenceWindowStart === null || rowReferenceStart < referenceWindowStart) {
      referenceWindowStart = rowReferenceStart;
    }
    if (referenceWindowEnd === null || rowReferenceEnd > referenceWindowEnd) {
      referenceWindowEnd = rowReferenceEnd;
    }
  }

  const referenceDailyByListing =
    referenceWindowStart && referenceWindowEnd
      ? await groupNightFactsDailyByListing({
          tenantId: params.tenantId,
          stayDateFrom: referenceWindowStart,
          stayDateTo: referenceWindowEnd,
          listingIds: referenceListingIds,
          channels: normalizedChannels,
          statuses: normalizedStatuses,
          displayCurrency: params.displayCurrency
        })
      : new Map<string, Map<string, DailyTotals>>();

  const fx = new FxConverter();
  let totalRevenue = 0;
  let totalNights = 0;

  const reportRows: ReservationsReportRow[] = [];
  for (const row of rows) {
    const nights = Math.max(0, asNumber(row.nights));
    const totalValue = asNumber(row.total);
    const feeValue = Math.min(totalValue, Math.max(0, asNumber(row.cleaningFee) + asNumber(row.guestFee)));
    const convertedTotal = await fx.convert(totalValue, row.arrival, row.currency, params.displayCurrency);
    const convertedFees = await fx.convert(feeValue, row.arrival, row.currency, params.displayCurrency);
    const resolvedRevenue = includeFees ? convertedTotal : Math.max(0, convertedTotal - convertedFees);
    const adr = nights > 0 ? resolvedRevenue / nights : 0;

    const rowReferenceStart = addUtcDays(row.arrival, -364);
    const rowReferenceEnd = addUtcDays(row.departure, -365);
    const referenceDaily = referenceDailyByListing.get(row.listingId) ?? new Map<string, DailyTotals>();
    const referenceTotals =
      rowReferenceStart <= rowReferenceEnd
        ? sumDailyTotalsWithinRange(referenceDaily, rowReferenceStart, rowReferenceEnd)
        : cloneEmptyTotals();
    const referenceRevenue = resolveRevenue(referenceTotals, includeFees);
    const referenceAdr = referenceTotals.nights > 0 ? referenceRevenue / referenceTotals.nights : null;

    totalRevenue += resolvedRevenue;
    totalNights += nights;

    reportRows.push({
      id: row.id,
      guestName: row.guestName?.trim() ? row.guestName.trim() : null,
      listingId: row.listingId,
      listingName: row.listingName,
      status: row.status?.trim() ? row.status.trim().toLowerCase() : "unknown",
      bookingDate: toDateOnly(row.bookingDate),
      checkInDate: toDateOnly(row.arrival),
      nights: roundTo2(nights),
      totalPrice: roundTo2(resolvedRevenue),
      adr: roundTo2(adr),
      channel: row.channel?.trim() ? row.channel.trim() : null,
      lastYearSameWeekdayAdr: referenceAdr === null ? null : roundTo2(referenceAdr),
      adrDeltaPct: referenceAdr === null ? null : computeDeltaPct(adr, referenceAdr)
    });
  }

  return {
    period: {
      bookingDateFrom: toDateOnly(bookingDateFrom),
      bookingDateTo: toDateOnly(bookingDateTo)
    },
    summary: {
      reservations: reportRows.length,
      nights: roundTo2(totalNights),
      revenue: roundTo2(totalRevenue),
      adr: totalNights > 0 ? roundTo2(totalRevenue / totalNights) : 0
    },
    rows: reportRows,
    meta: {
      displayCurrency: params.displayCurrency,
      includeFees,
      comparisonScope: comparisonScope.comparisonScope
    }
  };
}

function scoreRevenuePaceHealth(revenueDeltaPct: number | null): "ahead" | "on_pace" | "behind" {
  if (revenueDeltaPct === null) return "on_pace";
  if (revenueDeltaPct >= 5) return "ahead";
  if (revenueDeltaPct <= -5) return "behind";
  return "on_pace";
}

export async function buildPropertyDeepDiveReport(
  params: PropertyDeepDiveBaseParams
): Promise<PropertyDeepDiveResponse> {
  const includeFees = params.request.includeFees ?? true;
  const granularity = params.request.granularity ?? "month";
  const compareMode = params.request.compareMode ?? "yoy_otb";
  const today = fromDateOnly(toDateOnly(new Date()));
  const activeBeforeDate = params.request.activeBeforeDate ? fromDateOnly(params.request.activeBeforeDate) : null;
  const selectedBase = params.request.selectedPeriodStart
    ? fromDateOnly(params.request.selectedPeriodStart)
    : today;
  const periodStart = startOfPeriod(selectedBase, granularity);
  const periodEnd = endOfPeriod(periodStart, granularity);
  const paceCutoff = addUtcDays(today, -365);
  const periodMode: PropertyDeepDiveResponse["period"]["mode"] =
    periodEnd < today ? "past" : periodStart > today ? "future" : "mixed";
  const lyStart = addUtcYearsClamped(periodStart, -1);
  const lyEnd = addUtcYearsClamped(periodEnd, -1);

  const normalizedStatuses = normalizeFilterValues(params.request.statuses);
  const normalizedChannels = normalizeFilterValues(params.request.channels);
  const comparisonScope = await resolveComparisonListingScope({
    tenantId: params.tenantId,
    requestedListingIds: params.request.listingIds,
    activeBeforeDate
  });
  const scopedListingIds = comparisonScope.comparisonListingIds;
  const queryListingIds = listingIdsOrNoMatch(scopedListingIds);
  const listingMetadata = await loadListingMetadata(params.tenantId, scopedListingIds);
  const listingNameById = new Map(listingMetadata.map((listing) => [listing.id, listing.name]));

  const [currentDaily, lyStayedDaily, lyPaceDaily, currentShortStayDaily, lyStayedShortStayDaily] = await Promise.all([
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: periodStart,
      stayDateTo: periodEnd,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: lyStart,
      stayDateTo: lyEnd,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: lyStart,
      stayDateTo: lyEnd,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency,
      bookingCreatedAtCutoff: paceCutoff,
      excludeMissingBookingCreatedAt: true,
      includeCancelledAfterCutoff: true
    }),
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: periodStart,
      stayDateTo: periodEnd,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency,
      maxLosNightsExclusive: 14
    }),
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: lyStart,
      stayDateTo: lyEnd,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency,
      maxLosNightsExclusive: 14
      })
  ]);
  const {
    currentByListingDaily,
    currentTotals,
    referenceTotals,
    paceStatusReferenceTotals,
    lyStayedTotals
  } = resolvePropertyDeepDiveComparisonData({
    scopedListingIds,
    currentDaily,
    lyStayedDaily,
    lyPaceDaily,
    lifecycleByListing: comparisonScope.lifecycleByListing,
    periodStart,
    periodEnd,
    lyStart,
    lyEnd,
    today,
    compareMode,
    periodMode
  });

  const liveRateFrom = periodStart > today ? periodStart : addUtcDays(today, 1);
  const liveRateTo = periodEnd;
  const liveRateByListing =
    periodMode === "past"
      ? new Map<string, number>()
      : await groupLiveRateAverageByListing({
          tenantId: params.tenantId,
          from: liveRateFrom,
          to: liveRateTo,
          listingIds: scopedListingIds,
          displayCurrency: params.displayCurrency
        });
  const liveRateByListingDate =
    periodMode === "past"
      ? new Map<string, Map<string, number>>()
      : await groupLiveRateAverageByListingDate({
          tenantId: params.tenantId,
          from: liveRateFrom,
          to: liveRateTo,
          listingIds: scopedListingIds,
          displayCurrency: params.displayCurrency
        });
  const currentShortStayTotals = sumListingTotalsForRange({
    listingIds: scopedListingIds,
    byListingDaily: currentShortStayDaily,
    from: periodStart,
    to: periodEnd
  });
  const lyStayedShortStayTotals = sumListingTotalsForRange({
    listingIds: scopedListingIds,
    byListingDaily: lyStayedShortStayDaily,
    from: lyStart,
    to: lyEnd
  });
  const daysUntilPeriodStart = Math.round((periodStart.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  const rows: PropertyDeepDiveRow[] = buildPropertyDeepDiveRows({
    scopedListingIds,
    listingMetadata,
    listingNameById,
    currentTotals,
    referenceTotals,
    paceStatusReferenceTotals,
    lyStayedTotals,
    liveRateByListing,
    liveRateByListingDate,
    currentByListingDaily,
    currentShortStayTotals,
    lyStayedShortStayTotals,
    includeFees,
    periodMode,
    periodStart,
    periodEnd,
    today,
    daysUntilPeriodStart
  });

  const periodLabel =
    granularity === "month"
      ? new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(periodStart)
      : `${toDateOnly(periodStart)} to ${toDateOnly(periodEnd)}`;

  return {
    granularity,
    compareMode,
    period: {
      start: toDateOnly(periodStart),
      end: toDateOnly(periodEnd),
      mode: periodMode,
      label: periodLabel
    },
    rows,
    meta: {
      displayCurrency: params.displayCurrency,
      includeFees,
      paceReferenceCutoffDate: toDateOnly(paceCutoff),
      comparisonScope: comparisonScope.comparisonScope
    }
  };
}

export async function buildPricingCalendarReport(
  params: PricingCalendarBaseParams
): Promise<PricingCalendarResponse> {
  const today = fromDateOnly(toDateOnly(new Date()));
  const monthStart = startOfUtcMonth(fromDateOnly(params.request.selectedMonthStart));
  const monthEnd = addUtcDays(addUtcMonths(monthStart, 1), -1);
  const lyStart = addUtcYearsClamped(monthStart, -1);
  const lyEnd = addUtcYearsClamped(monthEnd, -1);

  const activeBeforeDate = params.request.activeBeforeDate ? fromDateOnly(params.request.activeBeforeDate) : null;
  const normalizedStatuses = normalizeFilterValues(params.request.statuses);
  const normalizedChannels = normalizeFilterValues(params.request.channels);
  const comparisonScope = await resolveComparisonListingScope({
    tenantId: params.tenantId,
    requestedListingIds: params.request.listingIds,
    activeBeforeDate
  });
  const scopedListingIds = comparisonScope.comparisonListingIds;
  const queryListingIds = listingIdsOrNoMatch(scopedListingIds);
  const listingMetadata = await loadListingMetadata(params.tenantId, scopedListingIds);

  const monthDays: Date[] = [];
  for (let cursor = fromDateOnly(toDateOnly(monthStart)); cursor <= monthEnd; cursor = addUtcDays(cursor, 1)) {
    monthDays.push(cursor);
  }
  const dayKeys = monthDays.map((day) => toDateOnly(day));
  const pricingAnchorHistoryStartCandidate = addUtcDays(lyStart, -21);
  const recentHistoryStartCandidate = addUtcDays(today, -540);
  const pricingAnchorHistoryStart =
    pricingAnchorHistoryStartCandidate < recentHistoryStartCandidate
      ? pricingAnchorHistoryStartCandidate
      : recentHistoryStartCandidate;
  const pricingAnchorHistoryEnd = addUtcDays(today, -1);

  const pricingSettingsByListingId = await loadResolvedPricingSettings({
    tenantId: params.tenantId,
    listings: listingMetadata.map((listing) => ({
      listingId: listing.id,
      tags: listing.tags
    })),
    preferredGroupName: params.request.pricingGroupName ?? null
  });

  const [currentShortStayDaily, lyShortStayDaily, historicalAnchorObservationsByListingId, calendarCellsByListingDate, bookedNightRatesByListingDate, marketContexts] = await Promise.all([
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: monthStart,
      stayDateTo: monthEnd,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency,
      maxLosNightsExclusive: 14
    }),
    groupNightFactsDailyByListing({
      tenantId: params.tenantId,
      stayDateFrom: lyStart,
      stayDateTo: lyEnd,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency,
      maxLosNightsExclusive: 14
    }),
    loadPricingAnchorHistoryByListing({
      tenantId: params.tenantId,
      stayDateFrom: pricingAnchorHistoryStart,
      stayDateTo: pricingAnchorHistoryEnd,
      listingIds: queryListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    groupCalendarCellStatusByListingDate({
      tenantId: params.tenantId,
      from: monthStart,
      to: monthEnd,
      listingIds: scopedListingIds,
      displayCurrency: params.displayCurrency
    }),
    groupBookedNightRateByListingDate({
      tenantId: params.tenantId,
      from: monthStart,
      to: monthEnd,
      listingIds: scopedListingIds,
      channels: normalizedChannels,
      statuses: normalizedStatuses,
      displayCurrency: params.displayCurrency
    }),
    buildMarketPricingContexts({
      listings: listingMetadata.map((listing) => {
        const derivedCity = deriveCityFromListing(listing);
        return {
          id: listing.id,
          name: listing.name,
          country: listing.country,
          state: listing.state,
          city: listing.city ?? (derivedCity !== "Unknown" ? derivedCity : null),
          address: listing.address,
          publicAddress: listing.publicAddress,
          latitude: listing.latitude,
          longitude: listing.longitude,
          roomType: listing.roomType,
          bedroomsNumber: listing.bedroomsNumber,
          bathroomsNumber: listing.bathroomsNumber,
          bedsNumber: listing.bedsNumber,
          personCapacity: listing.personCapacity,
          guestsIncluded: listing.guestsIncluded,
          minNights: listing.minNights,
          cleaningFee: listing.cleaningFee,
          averageReviewRating: listing.averageReviewRating,
          pricingSettings: pricingSettingsByListingId.get(listing.id)?.settings ?? {
            ...DEFAULT_PRICING_SETTINGS
          }
        };
      }),
      dayKeys,
      forceRefresh: params.request.forceMarketRefresh,
      allowLiveFetch: params.request.forceMarketRefresh
    })
  ]);

  const daysInMonth = monthDays.length;
  const weekdayFormatter = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
  const monthLabel = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(monthStart);

  const pricingHistoryByListingId = buildPricingCalendarHistoryByListingId({
    listingMetadata,
    currentShortStayDaily,
    lyShortStayDaily,
    historicalAnchorObservationsByListingId,
    monthStart,
    monthEnd,
    lyStart,
    lyEnd,
    daysInMonth,
    sumListingTotalsForRange
  });
  const occupancyMaps = buildPricingCalendarOccupancyMaps({
    listingMetadata,
    pricingSettingsByListingId,
    calendarCellsByListingDate,
    bookedNightRatesByListingDate,
    monthDays
  });

  const days = monthDays.map((day) => ({
    date: toDateOnly(day),
    dayNumber: day.getUTCDate(),
    weekdayShort: weekdayFormatter.format(day)
  }));

  const rows = buildPricingCalendarRows({
    listingMetadata,
    pricingSettingsByListingId,
    pricingHistoryByListingId,
    marketContexts,
    calendarCellsByListingDate,
    bookedNightRatesByListingDate,
    monthDays,
    occupancyMaps,
    todayDateOnlyValue: toDateOnly(new Date()),
    lastYearMonthStartDateOnly: toDateOnly(lyStart),
    lastYearMonthEndDateOnly: toDateOnly(lyEnd),
    displayCurrency: params.displayCurrency
  });

  const rowsWithCachedMarketData = rows.filter((row) => row.marketDataStatus === "cached_market_data").length;
  const rowsUsingFallbackPricing = rows.filter((row) => row.marketDataStatus === "fallback_pricing").length;
  const rowsNeedingSetup = rows.filter((row) => row.marketDataStatus === "needs_setup").length;

  return {
    month: {
      start: toDateOnly(monthStart),
      end: toDateOnly(monthEnd),
      label: monthLabel
    },
    days,
    rows,
    meta: {
      displayCurrency: params.displayCurrency,
      comparisonScope: comparisonScope.comparisonScope,
      marketData: {
        mode: params.request.forceMarketRefresh ? "live_refresh" : "stored",
        totalRows: rows.length,
        rowsWithCachedMarketData,
        rowsUsingFallbackPricing,
        rowsNeedingSetup
      }
    }
  };
}
