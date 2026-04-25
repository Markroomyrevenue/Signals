"use client";

import Image from "next/image";
import Link from "next/link";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { buildClientOpenHref, buildDashboardViewHref, withBasePath } from "@/lib/base-path";
import {
  exportDashboardDeck,
  type PowerPointChecklistItem,
  type PowerPointKeyStat,
  type PowerPointSlide,
  urlToDataUrl
} from "@/lib/powerpoint";
import {
  downloadCsv,
  exportBusinessReviewPdf,
  type BusinessReviewSection,
  type BusinessReviewTable,
  urlToDataUrl as businessReviewUrlToDataUrl
} from "@/lib/business-review";
import type { PricingCalendarResponse } from "@/lib/reports/pricing-calendar-types";
import { readLastAutoSyncQueuedAt, SYNC_STALE_INTERVAL_MS, writeLastAutoSyncQueuedAt } from "@/lib/sync/client-sync";
import { isSyncScopeFresh, syncScopeForDashboardTab, SyncScope } from "@/lib/sync/stages";
import {
  buildCalendarDayOfWeekAdjustments,
  buildCachedCalendarReportReloadOptions,
  buildCalendarMonthAdjustments,
  buildCalendarPropertyDraft,
  calendarCellCopy,
  calendarCellSelectionKey,
  formatCalendarOverrideInput,
  isCalendarPropertyDraftDirty,
  normalizeCalendarSettingsForm,
  pricingCalendarCoverageMessage,
  type CalendarPropertyDraft,
  type PricingCalendarRow
} from "./revenue-dashboard/calendar-utils";
import { CalendarGridPanel } from "./revenue-dashboard/calendar-grid-panel";
import { CalendarSettingsPanel } from "./revenue-dashboard/calendar-settings-panel";
import WorkspaceLoadingScreen from "./workspace-loading-screen";

type TabId =
  | "overview"
  | "reservations"
  | "property_groups"
  | "pace"
  | "sales"
  | "booked"
  | "booking_behaviour"
  | "property_drilldown"
  | "calendar"
  | "signal_lab";
type Granularity = "day" | "week" | "month";
type BarMetric = "nights" | "revenue" | "occupancy";
type PaceCompareMode = "yoy_otb" | "ly_stayed";
type BookWindowMode = "booked" | "checked_in";
type BookWindowLookbackDays = 7 | 14 | 30 | 90 | 180 | 365;
type BookWindowRangeMode = "preset" | "custom_month";
type BookWindowLineMetric = "adr" | "cancellation_pct" | "avg_los";
type DeepDiveGranularity = "week" | "month";
type DeepDiveCompareMode = "yoy_otb" | "ly_stayed";
type HomeMetric = "revenue" | "reservations" | "nights";
type HomeWindow = "today" | "yesterday" | "this_week" | "this_month" | "custom";
type HomeWindowKey = "today" | "yesterday" | "thisWeek" | "thisMonth" | "custom";
type ReservationsRangePreset = "today" | "yesterday" | "last_7_days" | "this_month" | "custom";
type MetricFormatter = "number" | "percent" | "currency";
type MetricChartKind = "line" | "bar";
type BookedRangePreset = "last_day" | "last_7_days" | "last_30_days" | "last_90_days" | "last_year" | "custom";
type ActivePropertyScope = "whole_property" | "active_3_months" | "active_6_months" | "active_12_months" | "custom_date";
type BusinessReviewTab = "pace" | "sales" | "booked" | "booking_behaviour" | "property_drilldown";
type MetricId =
  | "occupied_nights"
  | "available_nights"
  | "occupancy_pct"
  | "stay_revenue"
  | "adr_stay"
  | "revpar"
  | "bookings_created_count"
  | "booked_revenue_by_booking_date"
  | "booked_revenue_by_booking_window"
  | "booked_nights_by_booking_window"
  | "booked_nights_by_los_bucket"
  | "cancellation_rate"
  | "adr_by_booking_window"
  | "avg_los_by_booking_window"
  | "pace_on_books_nights"
  | "pickup_between_snapshots"
  | "live_rate"
  | "rate_index_vs_booked_adr"
  | "channel_mix_bookings";
type MetricDomain = "stay" | "book" | "pace" | "rates" | "mix";
type MetricDateMode = "stay" | "booking" | "both";

type ListingOption = {
  id: string;
  name: string;
  tags: string[];
  firstBookedNight: string | null;
};

type FilterOptionsResponse = {
  channels: string[];
  statuses?: string[];
  listings: ListingOption[];
  currencies?: string[];
  paceSnapshotDates?: string[];
};

type ClientOption = {
  id: string;
  name: string;
  hostawayAccountId?: string | null;
};

type CurrentTenantResponse = {
  tenant: {
    id: string;
    name: string;
  };
  clients?: ClientOption[];
  user: {
    id: string;
    email: string;
  };
};

type ReportResponse = {
  buckets: string[];
  current: {
    nights: number[];
    revenue: number[];
    adr: number[];
    occupancy: number[];
    inventory: number[];
  };
  lastYear: {
    nights: number[];
    revenue: number[];
    adr: number[];
    occupancy: number[];
    inventory: number[];
  };
  meta: {
    displayCurrency: string;
    snapshotDateUsed: string | null;
    snapshotDateLyUsed: string | null;
    comparisonScope?: {
      totalListings: number;
      appliedListings: number;
      activeBeforeDate: string | null;
    };
  };
};

type BookWindowReportResponse = {
  mode: BookWindowMode;
  lookbackDays: number;
  dateFrom: string;
  dateTo: string;
  buckets: Array<{
    key: string;
    label: string;
    nights: number;
    nightsPct: number;
    adr: number;
    cancellationPct: number;
    avgLos: number;
    reservations: number;
    cancelledReservations: number;
  }>;
  meta: {
    displayCurrency: string;
    totalNights: number;
    totalReservations: number;
    includeFees: boolean;
  };
};

type HomeDashboardResponse = {
  headline: {
    booked: Record<
      HomeWindowKey,
      {
        current: { revenue: number; reservations: number; nights: number };
        lastYear: { revenue: number; reservations: number; nights: number };
      }
    >;
    arrivals: Record<
      HomeWindowKey,
      {
        current: { revenue: number; reservations: number; nights: number };
        lastYear: { revenue: number; reservations: number; nights: number };
      }
    >;
    stayed: Record<
      HomeWindowKey,
      {
        current: { revenue: number; reservations: number; nights: number };
        lastYear: { revenue: number; reservations: number; nights: number };
      }
    >;
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
    /** Days from today until the soonest impact this signal covers. */
    daysToImpact: number;
    /** 1-3 read-only suggestion strings derived from same-tenant history. */
    suggestions: string[];
  }>;
  meta: {
    displayCurrency: string;
    includeFees: boolean;
    generatedAt: string;
    comparisonScope: {
      totalListings: number;
      appliedListings: number;
      activeBeforeDate: string | null;
    };
  };
};

type ReservationsReportResponse = {
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
  rows: Array<{
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
  }>;
  meta: {
    displayCurrency: string;
    includeFees: boolean;
    comparisonScope: {
      totalListings: number;
      appliedListings: number;
      activeBeforeDate: string | null;
    };
  };
};

type PropertyDeepDiveResponse = {
  granularity: DeepDiveGranularity;
  compareMode: DeepDiveCompareMode;
  period: {
    start: string;
    end: string;
    mode: "past" | "future" | "mixed";
    label: string;
  };
  rows: Array<{
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
      anchorSource:
        | "listing_history"
        | "group_peer_set"
        | "area_peer_set"
        | "portfolio_peer_set"
        | "live_rate_fallback"
        | "insufficient_data";
      confidence: "high" | "medium" | "low";
      currentShortStayOccupancy: number | null;
      referenceShortStayOccupancy: number | null;
      note: string;
    };
  }>;
  meta: {
    displayCurrency: string;
    includeFees: boolean;
    paceReferenceCutoffDate: string;
    comparisonScope: {
      totalListings: number;
      appliedListings: number;
      activeBeforeDate: string | null;
    };
  };
};

type CalendarSettingsScope = "portfolio" | "group" | "property";
type CalendarSettingsSectionId =
  | "base_pricing"
  | "occupancy"
  | "demand"
  | "seasonality"
  | "day_of_week"
  | "safety_net"
  | "local_events"
  | "last_minute"
  | "stay_rules";

type SyncStatusResponse = {
  connection: {
    status: string;
    lastSyncAt: string | null;
  } | null;
  queueCounts: Record<string, number>;
  freshness?: {
    coreLastSyncAt: string | null;
    extendedLastSyncAt: string | null;
    activeScopes?: SyncScope[];
  };
  recentRuns: Array<{
    id: string;
    status: string;
    createdAt: string;
    finishedAt?: string | null;
    jobType?: string;
  }>;
};

type MetricDefinitionSummary = {
  id: MetricId;
  name: string;
  description: string;
  domain: MetricDomain;
  grains: Granularity[];
  formatter: MetricFormatter;
  chartKind: MetricChartKind;
};

type MetricsResponse = {
  xKey: "x";
  series: Array<{
    metricId: MetricId;
    name: string;
    formatter: MetricFormatter;
    domain: MetricDomain;
    chartKind: MetricChartKind;
    points: Array<{ x: string; value: number }>;
  }>;
  displayCurrency: string;
};

type MetricsMetadataResponse = {
  definitions: MetricDefinitionSummary[];
};

type DateRangesByTab = Record<
  "pace" | "sales" | "booked",
  {
    stayDateFrom: string;
    stayDateTo: string;
  }
>;

type TableRow = {
  bucketKey: string;
  bucketLabel: string;
  currentNights: number;
  lastYearNights: number;
  currentRevenue: number;
  lastYearRevenue: number;
  currentAdr: number;
  lastYearAdr: number;
  currentOccupancy: number;
  lastYearOccupancy: number;
  currentInventory: number;
  lastYearInventory: number;
};

type SavedView = {
  id: string;
  name: string;
  encoded: string;
  updatedAt: string;
};

type PersistedSnapshot = {
  preserveDates?: boolean;
  tab: TabId;
  includeFees: boolean;
  granularity: Granularity;
  barMetric: BarMetric;
  paceCompareMode: PaceCompareMode;
  activePropertyScope?: ActivePropertyScope;
  activeBeforeDateCustom?: string;
  selectedGroupTags?: string[];
  newPropertyWindowMonths?: 1 | 3 | 6 | 12;
  bookedRangePreset?: BookedRangePreset;
  bookWindowRangeMode?: BookWindowRangeMode;
  bookWindowMode: BookWindowMode;
  bookWindowLookbackDays: BookWindowLookbackDays;
  bookWindowCustomMonth?: string;
  bookWindowLineMetric: BookWindowLineMetric;
  deepDiveGranularity: DeepDiveGranularity;
  deepDiveCompareMode: DeepDiveCompareMode;
  deepDiveSelectedMonth: number;
  calendarSelectedMonthStart?: string;
  deepDiveWeekWindowOffset: number;
  deepDiveSelectedWeekIndex: number;
  homeBookedMetric: HomeMetric;
  homeBookedWindow: HomeWindow;
  homeStayedMetric: HomeMetric;
  homeStayedWindow: HomeWindow;
  homeBookedCustomFrom: string;
  homeBookedCustomTo: string;
  homeStayedCustomFrom: string;
  homeStayedCustomTo: string;
  reservationsRangePreset: ReservationsRangePreset;
  reservationsCustomFrom: string;
  reservationsCustomTo: string;
  displayCurrency: string;
  dateRanges: DateRangesByTab;
  selectedListingIds: string[];
  selectedChannels: string[];
  selectedStatuses: string[];
  filtersOpen: boolean;
  metricIds: MetricId[];
  metricDateMode: MetricDateMode;
  metricsGranularity: Granularity;
  metricsStayDateFrom: string;
  metricsStayDateTo: string;
  metricsBookingDateFrom: string;
  metricsBookingDateTo: string;
};

type CalendarSettingsSnapshot = {
  pricingGroupName: string;
};

const PERSISTENCE_KEY = "roomy-dashboard-last-view-v1";
const SAVED_VIEWS_KEY = "roomy-dashboard-saved-views-v1";
const RADAR_DISMISSALS_KEY = "roomy-dashboard-radar-dismissals-v1";
const CALENDAR_SETTINGS_KEY_PREFIX = "roomy-calendar-settings-v1:";
const POWERPOINT_CHECKLIST_KEY = "roomy-dashboard-ppt-checklist-v1";
const OTHER_CURRENCY_OPTION = "__other_currency__";
const NO_LISTING_MATCH_ID = "__roomy_no_listing__";
const CUSTOM_GROUP_TAG_PREFIX = "group:";
const CURATED_CURRENCIES = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF"] as const;
const CURATED_CURRENCY_SET = new Set<string>(CURATED_CURRENCIES);
const BOOK_WINDOW_LOOKBACK_DAY_OPTIONS: BookWindowLookbackDays[] = [7, 14, 30, 90, 180, 365];
const CHART_COLORS = ["#164733", "#b07a19", "#204f77"];
const DISPLAY_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC"
});
const DISPLAY_MONTH_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});

function sortCalendarSettingsValue(value: any): any {
  if (Array.isArray(value)) {
    return value.map((item) => sortCalendarSettingsValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortCalendarSettingsValue(nestedValue)])
    );
  }

  return value;
}

function calendarSettingsSignature(value: Record<string, any>): string {
  return JSON.stringify(sortCalendarSettingsValue(normalizeCalendarSettingsForm(value)));
}
const DISPLAY_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});
const DAY_MONTH_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC"
});
const MONTH_BUCKET_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC"
});
const RESERVATION_CHECK_IN_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "2-digit",
  timeZone: "UTC"
});
const DEFAULT_POWERPOINT_CHECKLIST: PowerPointChecklistItem[] = [
  { id: "brief", text: "Confirm the client brief still matches the filters used on these slides.", done: false },
  { id: "outliers", text: "Sense-check obvious outliers before sharing the deck with the client.", done: false },
  { id: "actions", text: "Add follow-up actions for any slide that shows a clear revenue gap or pricing opportunity.", done: false }
];

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateOnlyToDate(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00Z`);
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function addUtcMonthsClamped(date: Date, months: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      Math.min(date.getUTCDate(), new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months + 1, 0)).getUTCDate())
    )
  );
}

function isValidMonthInput(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function normalizeBookWindowLookbackDays(value: unknown): BookWindowLookbackDays {
  return BOOK_WINDOW_LOOKBACK_DAY_OPTIONS.includes(value as BookWindowLookbackDays) ? (value as BookWindowLookbackDays) : 30;
}

function monthValueToDateRange(monthValue: string): { from: string; to: string } | null {
  if (!isValidMonthInput(monthValue)) return null;

  const from = `${monthValue}-01`;
  const monthStart = dateOnlyToDate(from);
  const nextMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));

  return {
    from,
    to: toDateOnly(addUtcDays(nextMonthStart, -1))
  };
}

function startOfUtcWeek(date: Date): Date {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekdayOffset = (copy.getUTCDay() + 6) % 7;
  return addUtcDays(copy, -weekdayOffset);
}

function endOfUtcMonth(date: Date): Date {
  return addUtcDays(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)), -1);
}

function parseMonthBucketRange(bucket: string): { stayDateFrom: string; stayDateTo: string } {
  const parsed = dateOnlyToDate(`${bucket}-01`);
  if (Number.isNaN(parsed.getTime())) {
    const today = dateOnlyToDate(toDateOnly(new Date()));
    return {
      stayDateFrom: toDateOnly(today),
      stayDateTo: toDateOnly(endOfUtcMonth(today))
    };
  }

  return {
    stayDateFrom: toDateOnly(parsed),
    stayDateTo: toDateOnly(endOfUtcMonth(parsed))
  };
}

function parseWeekBucketRange(bucket: string): { stayDateFrom: string; stayDateTo: string } {
  const parsed = dateOnlyToDate(bucket);
  if (Number.isNaN(parsed.getTime())) {
    const today = dateOnlyToDate(toDateOnly(new Date()));
    const start = startOfUtcWeek(today);
    return {
      stayDateFrom: toDateOnly(start),
      stayDateTo: toDateOnly(addUtcDays(start, 6))
    };
  }

  const start = startOfUtcWeek(parsed);
  return {
    stayDateFrom: toDateOnly(start),
    stayDateTo: toDateOnly(addUtcDays(start, 6))
  };
}

function clampRangeStartToToday(range: { stayDateFrom: string; stayDateTo: string }): { stayDateFrom: string; stayDateTo: string } {
  const today = toDateOnly(new Date());
  return {
    stayDateFrom: range.stayDateFrom < today ? today : range.stayDateFrom,
    stayDateTo: range.stayDateTo
  };
}

function defaultDateRanges(): DateRangesByTab {
  const today = new Date();
  const currentMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const currentMonthEnd = addUtcDays(addUtcMonthsClamped(currentMonthStart, 6), -1);
  const todayDateOnly = new Date(`${toDateOnly(today)}T00:00:00Z`);

  return {
    pace: {
      stayDateFrom: toDateOnly(currentMonthStart),
      stayDateTo: toDateOnly(currentMonthEnd)
    },
    sales: {
      stayDateFrom: toDateOnly(addUtcMonthsClamped(todayDateOnly, -6)),
      stayDateTo: toDateOnly(todayDateOnly)
    },
    booked: {
      stayDateFrom: toDateOnly(addUtcDays(todayDateOnly, -89)),
      stayDateTo: toDateOnly(todayDateOnly)
    }
  };
}

function defaultHomeCustomDateRange(): { from: string; to: string } {
  const today = new Date();
  return {
    from: `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`,
    to: toDateOnly(today)
  };
}

function defaultReservationsCustomDateRange(): { from: string; to: string } {
  const today = toDateOnly(new Date());
  return {
    from: today,
    to: today
  };
}

function defaultMetricsRange(): {
  stayDateFrom: string;
  stayDateTo: string;
  bookingDateFrom: string;
  bookingDateTo: string;
} {
  const today = new Date();
  const to = toDateOnly(today);
  const from = toDateOnly(addUtcDays(today, -90));
  return {
    stayDateFrom: from,
    stayDateTo: to,
    bookingDateFrom: from,
    bookingDateTo: to
  };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 0
  }).format(Math.round(value));
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

function formatCurrencyCompact(value: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(1)}%`;
}

function formatSignedPercent(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function formatSignedPoints(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} pts`;
}

function formatSignedCurrencyDelta(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatCurrency(Math.abs(value), currency)}`;
}

function formatHomeMetricValue(value: number, metric: HomeMetric, currency: string): string {
  if (metric === "revenue") {
    return formatCurrency(value, currency);
  }
  return formatInteger(value);
}

function computePercentDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function hasData(report: ReportResponse | null): boolean {
  if (!report) return false;
  const values = [
    ...report.current.nights,
    ...report.current.revenue,
    ...report.current.adr,
    ...report.current.occupancy,
    ...report.lastYear.nights,
    ...report.lastYear.revenue,
    ...report.lastYear.adr,
    ...report.lastYear.occupancy
  ];

  return values.some((value) => Number.isFinite(value) && Math.abs(value) > 0);
}

function hasBookWindowData(report: BookWindowReportResponse | null): boolean {
  if (!report) return false;
  return report.buckets.some((bucket) => bucket.nights > 0 || bucket.reservations > 0);
}

function isAllSelected(selected: string[], allValues: string[]): boolean {
  if (allValues.length === 0) return true;
  if (selected.length !== allValues.length) return false;
  const selectedSet = new Set(selected);
  return allValues.every((value) => selectedSet.has(value));
}

function toggleInSelection(selection: string[], value: string): string[] {
  const set = new Set(selection);
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
  return [...set];
}

function formatDisplayDate(dateOnly: string | null): string {
  if (!dateOnly) return "n/a";
  const parsed = dateOnlyToDate(dateOnly);
  if (Number.isNaN(parsed.getTime())) return dateOnly;
  return DISPLAY_DATE_FORMATTER.format(parsed);
}

function formatDisplayMonth(monthValue: string | null): string {
  if (!monthValue) return "n/a";
  if (!isValidMonthInput(monthValue)) return monthValue;
  return DISPLAY_MONTH_FORMATTER.format(dateOnlyToDate(`${monthValue}-01`));
}

function formatReservationCheckInDate(dateOnly: string): string {
  const parsed = dateOnlyToDate(dateOnly);
  if (Number.isNaN(parsed.getTime())) return dateOnly;
  return RESERVATION_CHECK_IN_FORMATTER.format(parsed);
}

function formatDisplayTimestamp(value: string | null): string {
  if (!value) return "Awaiting sync";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return DISPLAY_TIMESTAMP_FORMATTER.format(parsed);
}

function formatOrdinalDayMonth(dateOnly: string): string {
  const parsed = dateOnlyToDate(dateOnly);
  if (Number.isNaN(parsed.getTime())) return dateOnly;

  const day = parsed.getUTCDate();
  const remainder = day % 10;
  const isTeen = day >= 11 && day <= 13;
  const suffix = isTeen ? "th" : remainder === 1 ? "st" : remainder === 2 ? "nd" : remainder === 3 ? "rd" : "th";
  const month = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(parsed);
  return `${day}${suffix} ${month}`;
}

function getIsoWeekInfo(date: Date): { week: number; isoYear: number } {
  const dateAtMidnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  dateAtMidnight.setUTCDate(dateAtMidnight.getUTCDate() + 4 - (dateAtMidnight.getUTCDay() || 7));
  const isoYear = dateAtMidnight.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((dateAtMidnight.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { week, isoYear };
}

function formatBucketLabel(bucketKey: string, granularity: Granularity): string {
  if (granularity === "day") {
    const day = dateOnlyToDate(bucketKey);
    if (Number.isNaN(day.getTime())) return bucketKey;
    return DAY_MONTH_FORMATTER.format(day);
  }

  if (granularity === "month") {
    const [year, month] = bucketKey.split("-");
    const parsedYear = Number(year);
    const parsedMonth = Number(month);
    if (!Number.isFinite(parsedYear) || !Number.isFinite(parsedMonth)) return bucketKey;
    const monthDate = new Date(Date.UTC(parsedYear, parsedMonth - 1, 1));
    if (Number.isNaN(monthDate.getTime())) return bucketKey;
    return MONTH_BUCKET_FORMATTER.format(monthDate);
  }

  const weekStart = dateOnlyToDate(bucketKey);
  if (Number.isNaN(weekStart.getTime())) return bucketKey;
  const { week, isoYear } = getIsoWeekInfo(weekStart);
  return `W${String(week).padStart(2, "0")} ${String(isoYear).slice(-2)} (${DAY_MONTH_FORMATTER.format(weekStart)})`;
}

function formatIsoWeekLabel(date: Date): string {
  const { week } = getIsoWeekInfo(date);
  return `W${String(week).padStart(2, "0")} (${DAY_MONTH_FORMATTER.format(date)})`;
}

function formatOpportunityWeekLabel(bucketKey: string): string {
  const parsed = dateOnlyToDate(bucketKey);
  if (Number.isNaN(parsed.getTime())) return bucketKey;
  const { week } = getIsoWeekInfo(parsed);
  return `Week Number ${week} (${formatOrdinalDayMonth(bucketKey)})`;
}

function normalizeCurrencyCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
}

function normalizeGroupName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatChannelLabel(value: string | null): string {
  if (!value) return "Unknown";
  const normalizedKey = value.trim().toLowerCase();
  const knownLabels: Record<string, string> = {
    airbnb: "Airbnb",
    bookingcom: "Booking.com",
    "booking.com": "Booking.com",
    vrbo: "Vrbo",
    expedia: "Expedia",
    direct: "Direct"
  };
  if (knownLabels[normalizedKey]) {
    return knownLabels[normalizedKey];
  }
  const normalized = value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Unknown";
  return normalized
    .split(" ")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatReservationStatusLabel(value: string | null): string {
  if (!value) return "Unknown";
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "Unknown";

  const knownLabels: Record<string, string> = {
    new: "New",
    modified: "Modified",
    inquiry: "Inquiry",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    confirmed: "Confirmed",
    pending: "Pending",
    declined: "Declined",
    expired: "Expired",
    "no-show": "No Show",
    no_show: "No Show",
    inquirypreapproved: "Inquiry Preapproved",
    inquirynotpossible: "Inquiry Not Possible"
  };

  if (knownLabels[normalized]) {
    return knownLabels[normalized];
  }

  return normalized
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function isCustomGroupTag(tag: string): boolean {
  return tag.trim().toLowerCase().startsWith(CUSTOM_GROUP_TAG_PREFIX);
}

function customGroupLabel(tag: string): string {
  return normalizeGroupName(tag.slice(CUSTOM_GROUP_TAG_PREFIX.length));
}

function customGroupKey(value: string): string {
  return normalizeGroupName(value).toLowerCase();
}

function groupTagMatches(tag: string, value: string): boolean {
  return isCustomGroupTag(tag) && customGroupKey(customGroupLabel(tag)) === customGroupKey(value);
}

function resolveListingIdsForFilters(params: {
  listings: ListingOption[];
  allListingIds: string[];
  activeBeforeDate: string | null;
  groupTags: string[];
}): string[] {
  const { listings, allListingIds, activeBeforeDate, groupTags } = params;

  if (!activeBeforeDate && groupTags.length === 0) {
    return allListingIds;
  }

  return listings
    .filter((listing) => {
      const matchesActiveWindow = !activeBeforeDate || (listing.firstBookedNight !== null && listing.firstBookedNight <= activeBeforeDate);
      const matchesGroup = groupTags.length === 0 || listing.tags.some((tag) => groupTags.some((value) => groupTagMatches(tag, value)));
      return matchesActiveWindow && matchesGroup;
    })
    .map((listing) => listing.id);
}

function readRadarDismissals(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(RADAR_DISMISSALS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => {
        const expiresAt = Date.parse(value);
        return Number.isFinite(expiresAt) && expiresAt > now;
      })
    );
  } catch {
    return {};
  }
}

function buildActiveBeforeDate(scope: ActivePropertyScope, customDate: string): string | null {
  if (scope === "whole_property") return null;

  const today = dateOnlyToDate(toDateOnly(new Date()));
  if (scope === "active_3_months") return toDateOnly(addUtcMonthsClamped(today, -3));
  if (scope === "active_6_months") return toDateOnly(addUtcMonthsClamped(today, -6));
  if (scope === "active_12_months") return toDateOnly(addUtcMonthsClamped(today, -12));
  return customDate || null;
}

function activeScopeLabel(scope: ActivePropertyScope, activeBeforeDate: string | null): string {
  if (scope === "whole_property" || !activeBeforeDate) return "All Properties";
  return `Properties live before ${formatDisplayDate(activeBeforeDate)}`;
}

function isValidCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

function percentDeltaStyle(value: number | null): CSSProperties {
  if (value === null) return { color: "var(--muted-text)" };
  if (value > 0) return { color: "var(--delta-positive)" };
  if (value < 0) return { color: "var(--delta-negative)" };
  return { color: "var(--text)" };
}

function pointsDeltaStyle(value: number): CSSProperties {
  if (value > 0) return { color: "var(--delta-positive)" };
  if (value < 0) return { color: "var(--delta-negative)" };
  return { color: "var(--muted-text)" };
}

function valueDeltaStyle(value: number | null): CSSProperties {
  if (value === null || !Number.isFinite(value)) return { color: "var(--muted-text)" };
  if (value > 0) return { color: "var(--delta-positive)" };
  if (value < 0) return { color: "var(--delta-negative)" };
  return { color: "var(--text)" };
}

function homeWindowLabel(value: HomeWindow): string {
  if (value === "today") return "Today";
  if (value === "yesterday") return "Yesterday";
  if (value === "this_week") return "This Week";
  if (value === "this_month") return "This Month";
  return "Custom";
}

function toHomeWindowKey(value: HomeWindow): HomeWindowKey {
  if (value === "this_week") return "thisWeek";
  if (value === "this_month") return "thisMonth";
  return value;
}

/**
 * Render-friendly label for a signal's days-to-impact horizon. Kept short so
 * it fits in a chip on a 380px viewport without wrapping.
 */
function signalHorizonLabel(daysToImpact: number): string {
  if (daysToImpact <= 0) return "This week";
  if (daysToImpact <= 14) return "Next 14 days";
  if (daysToImpact <= 30) return "Next 30 days";
  if (daysToImpact <= 60) return "In ~1 month";
  if (daysToImpact <= 90) return "In ~2 months";
  return `In ${Math.round(daysToImpact / 30)} months`;
}

function severityLabel(value: "high" | "medium"): string {
  return value === "high" ? "Immediate" : "Monitor";
}

function pricingAnchorLabel(
  value:
    | "listing_history"
    | "group_peer_set"
    | "area_peer_set"
    | "portfolio_peer_set"
    | "live_rate_fallback"
    | "insufficient_data"
): string {
  switch (value) {
    case "listing_history":
      return "Listing history";
    case "group_peer_set":
      return "Grouped peers";
    case "area_peer_set":
      return "Area average";
    case "portfolio_peer_set":
      return "Portfolio median";
    case "live_rate_fallback":
      return "Live rate";
    case "insufficient_data":
      return "Not enough data";
  }
}

function barMetricLabel(value: BarMetric): string {
  if (value === "nights") return "Roomnights";
  if (value === "revenue") return "Revenue";
  return "Occupancy";
}

function bookWindowModeLabel(value: BookWindowMode): string {
  return value === "booked" ? "Booked date" : "Checked-in date";
}

function bookWindowLineMetricLabel(value: BookWindowLineMetric): string {
  if (value === "adr") return "ADR";
  if (value === "cancellation_pct") return "Cancellation rate";
  return "Average length of stay";
}

function deepDiveCompareModeLabel(value: DeepDiveCompareMode): string {
  return value === "yoy_otb" ? "Same date last year" : "Last year finished";
}

function readableList(values: string[], maxVisible = 2, allLabel = "All"): string {
  if (values.length === 0) return allLabel;
  if (values.length <= maxVisible) return values.join(", ");
  return `${values.slice(0, maxVisible).join(", ")} +${formatInteger(values.length - maxVisible)} more`;
}

function naturalList(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function qualitativePercentTrend(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "mixed";
  if (value <= -15) return "well behind";
  if (value <= -5) return "slightly behind";
  if (value < 5) return "broadly flat";
  if (value < 15) return "slightly ahead";
  return "well ahead";
}

function qualitativePointsTrend(value: number): string {
  if (!Number.isFinite(value)) return "mixed";
  if (value <= -8) return "materially softer";
  if (value <= -2) return "slightly softer";
  if (value < 2) return "steady";
  if (value < 8) return "slightly stronger";
  return "materially stronger";
}

function cleanLabelList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatPricingBreakdownValue(
  item: { label: string; amount: number | null; unit: "currency" | "percent" | "number" | "multiplier" },
  currency: string
): string {
  if (item.amount === null) return "—";
  if (item.unit === "currency") {
    return item.label === "Pace" || item.label === "Floor" || item.label === "Fee adj" || item.label === "Pace adj"
      ? formatSignedCurrencyDelta(item.amount, currency)
      : formatCurrency(item.amount, currency);
  }
  if (item.unit === "percent") {
    return item.label.includes("Adj") ? formatSignedPercent(item.amount) : formatPercent(item.amount);
  }
  if (item.unit === "multiplier") {
    return `x${item.amount.toFixed(2)}`;
  }
  return Number.isInteger(item.amount) ? String(Math.round(item.amount)) : item.amount.toFixed(1);
}

function tabLabel(tab: TabId): string {
  switch (tab) {
    case "overview":
      return "Overview";
    case "reservations":
      return "Reservations";
    case "property_groups":
      return "Property Groups";
    case "pace":
      return "Pace";
    case "sales":
      return "Sales";
    case "booked":
      return "Booked";
    case "booking_behaviour":
      return "Booking Windows";
    case "property_drilldown":
      return "Property Drilldown";
    case "calendar":
      return "Calendar";
    case "signal_lab":
      return "Signal Lab";
  }
}

function tabDescription(tab: TabId): string {
  switch (tab) {
    case "overview":
      return "The fastest way to understand where revenue attention is needed next.";
    case "reservations":
      return "Booked reservations with guest detail and ADR compared to the same weekday pattern last year.";
    case "property_groups":
      return "Create custom groups, then open a group-specific dashboard for cities, clients, or any portfolio slice you want to track.";
    case "pace":
      return "Forward-looking on-the-books performance against last year's reference.";
    case "sales":
      return "Stayed performance to understand what actually landed.";
    case "booked":
      return "Booking-date performance so you can see demand creation clearly.";
    case "booking_behaviour":
      return "How guests book, cancel, and convert across booking windows.";
    case "property_drilldown":
      return "Property-by-property pacing, ADR, occupancy, and live rate pressure.";
    case "calendar":
      return "Live Hostaway month view with booked, unavailable, and recommended available nights.";
    case "signal_lab":
      return "Advanced metrics workspace for expert exploration without cluttering the main product.";
  }
}

function requiredSyncTimestamp(status: SyncStatusResponse | null, scope: SyncScope): string | null {
  if (!status) return null;
  if (scope === "core") {
    return status.freshness?.coreLastSyncAt ?? status.connection?.lastSyncAt ?? null;
  }

  return status.freshness?.extendedLastSyncAt ?? null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), init);
  const body = (await response.json().catch(() => ({}))) as { error?: unknown } & T;
  if (!response.ok) {
    throw new Error(formatApiError(body.error) ?? "Request failed");
  }
  return body;
}

function formatApiError(error: unknown): string | null {
  if (typeof error === "string" && error.trim()) return error;
  if (!error || typeof error !== "object") return null;

  const objectError = error as {
    formErrors?: unknown;
    fieldErrors?: Record<string, unknown>;
    message?: unknown;
  };

  if (typeof objectError.message === "string" && objectError.message.trim()) {
    return objectError.message;
  }

  const formErrors = Array.isArray(objectError.formErrors)
    ? objectError.formErrors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  const fieldErrors = objectError.fieldErrors && typeof objectError.fieldErrors === "object"
    ? Object.entries(objectError.fieldErrors)
        .flatMap(([field, value]) =>
          Array.isArray(value)
            ? value
                .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
                .map((item) => `${field}: ${item}`)
            : []
        )
    : [];

  const combined = [...formErrors, ...fieldErrors].filter(Boolean);
  if (combined.length > 0) return combined.join(" ");

  try {
    return JSON.stringify(error);
  } catch {
    return null;
  }
}

function encodeSnapshot(snapshot: Partial<PersistedSnapshot>): string {
  if (typeof window === "undefined") return "";
  return window.btoa(JSON.stringify(snapshot));
}

function decodeSnapshot(value: string | null): PersistedSnapshot | null {
  if (!value || typeof window === "undefined") return null;
  try {
    return JSON.parse(window.atob(value)) as PersistedSnapshot;
  } catch {
    return null;
  }
}

function buildMetricsChartData(report: MetricsResponse | null): Array<Record<string, string | number>> {
  if (!report) return [];
  const keys = new Set<string>();
  for (const series of report.series) {
    for (const point of series.points) {
      keys.add(point.x);
    }
  }
  return [...keys]
    .sort()
    .map((bucket) => {
      const row: Record<string, string | number> = {
        bucket,
        label: bucket.length === 10 ? formatBucketLabel(bucket, "week") : bucket
      };
      for (const series of report.series) {
        row[series.metricId] = series.points.find((point) => point.x === bucket)?.value ?? 0;
      }
      return row;
    });
}

function inferBookedRangePreset(range: DateRangesByTab["booked"] | undefined): BookedRangePreset {
  if (!range) return "last_30_days";

  const today = toDateOnly(new Date());
  if (range.stayDateTo !== today) return "custom";

  const diffDays = Math.round((dateOnlyToDate(range.stayDateTo).getTime() - dateOnlyToDate(range.stayDateFrom).getTime()) / 86400000) + 1;
  if (diffDays === 1) return "last_day";
  if (diffDays === 7) return "last_7_days";
  if (diffDays === 30) return "last_30_days";
  if (diffDays === 90) return "last_90_days";
  if (diffDays === 365) return "last_year";
  return "custom";
}

function getHomeWindowMetricValue(
  snapshot: { current: { revenue: number; reservations: number; nights: number }; lastYear: { revenue: number; reservations: number; nights: number } } | null,
  metric: HomeMetric
): { current: number; lastYear: number; deltaPct: number | null } {
  const current = snapshot?.current[metric] ?? 0;
  const lastYear = snapshot?.lastYear[metric] ?? 0;
  return {
    current,
    lastYear,
    deltaPct: computePercentDelta(current, lastYear)
  };
}

function comparisonScopeLabel(scope?: {
  totalListings: number;
  appliedListings: number;
  activeBeforeDate: string | null;
} | null): string | null {
  if (!scope) return null;
  if (scope.totalListings === 0) return null;
  if (!scope.activeBeforeDate) {
    return `Showing all properties (${scope.appliedListings} of ${scope.totalListings}).`;
  }
  return `${scope.appliedListings} of ${scope.totalListings} properties were live before ${formatDisplayDate(scope.activeBeforeDate)}.`;
}

function buildMetricsAxisAssignments(report: MetricsResponse | null): Record<string, "left" | "right"> {
  if (!report || report.series.length === 0) return {};

  const seriesStats = report.series.map((series) => ({
    metricId: series.metricId,
    formatter: series.formatter,
    maxAbs: Math.max(...series.points.map((point) => Math.abs(point.value)), 0)
  }));

  const assignment: Record<string, "left" | "right"> = {};
  const percentSeries = seriesStats.filter((series) => series.formatter === "percent");
  const nonPercentSeries = seriesStats.filter((series) => series.formatter !== "percent").sort((a, b) => b.maxAbs - a.maxAbs);

  if (percentSeries.length > 0 && nonPercentSeries.length > 0) {
    for (const series of percentSeries) assignment[series.metricId] = "right";
  }

  let leftMax = 0;
  let rightMax = percentSeries.length > 0 && nonPercentSeries.length > 0 ? Math.max(...percentSeries.map((series) => series.maxAbs), 0) : 0;

  for (const series of nonPercentSeries) {
    if (leftMax === 0) {
      assignment[series.metricId] = "left";
      leftMax = Math.max(leftMax, series.maxAbs);
      continue;
    }

    const leftRatio = series.maxAbs > 0 ? Math.max(leftMax, series.maxAbs) / Math.max(1, Math.min(leftMax || 1, series.maxAbs)) : 1;
    const rightRatio = rightMax > 0 && series.maxAbs > 0 ? Math.max(rightMax, series.maxAbs) / Math.max(1, Math.min(rightMax, series.maxAbs)) : Number.POSITIVE_INFINITY;
    const shouldUseRight = (leftRatio >= 7 && rightRatio > leftRatio) || (rightMax > 0 && rightRatio < leftRatio);

    assignment[series.metricId] = shouldUseRight ? "right" : "left";
    if (shouldUseRight) {
      rightMax = Math.max(rightMax, series.maxAbs);
    } else {
      leftMax = Math.max(leftMax, series.maxAbs);
    }
  }

  if (nonPercentSeries.length === 0) {
    for (const series of percentSeries) assignment[series.metricId] = "left";
  } else if (rightMax === 0 && percentSeries.length === 0 && nonPercentSeries.length > 1) {
    const smallest = nonPercentSeries[nonPercentSeries.length - 1];
    const largest = nonPercentSeries[0];
    if (largest.maxAbs > 0 && smallest.maxAbs > 0 && largest.maxAbs / smallest.maxAbs >= 7) {
      assignment[smallest.metricId] = "right";
    }
  }

  return assignment;
}

function axisFormatterForSeries(
  series: MetricsResponse["series"],
  axisAssignments: Record<string, "left" | "right">,
  axis: "left" | "right",
  currency: string
): (value: number) => string {
  const axisSeries = series.filter((item) => axisAssignments[item.metricId] === axis);
  const axisFormatter = axisSeries[0]?.formatter;

  return (value: number) => {
    if (axisFormatter === "currency") return formatCurrencyCompact(Number(value), currency);
    if (axisFormatter === "percent") return `${Number(value).toFixed(0)}%`;
    return formatInteger(Number(value));
  };
}

function metricFormatterValue(value: number, formatter: MetricFormatter, currency: string): string {
  if (formatter === "currency") return formatCurrency(value, currency);
  if (formatter === "percent") return `${value.toFixed(1)}%`;
  return formatInteger(value);
}

function MetricBadge({ tone, children }: { tone: "green" | "gold" | "red" | "blue"; children: React.ReactNode }) {
  const tones: Record<typeof tone, CSSProperties> = {
    green: { background: "rgba(31,122,77,0.12)", color: "var(--delta-positive)" },
    gold: { background: "rgba(176,122,25,0.14)", color: "var(--mustard-dark)" },
    red: { background: "rgba(187,75,82,0.12)", color: "var(--delta-negative)" },
    blue: { background: "rgba(95,111,103,0.12)", color: "var(--green-mid)" }
  };

  return (
    <span className="inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]" style={tones[tone]}>
      {children}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  delta,
  tone = "green"
}: {
  label: string;
  value: string;
  detail?: string;
  delta?: string;
  tone?: "green" | "gold" | "blue";
}) {
  const borderColor =
    tone === "gold" ? "rgba(176,122,25,0.18)" : tone === "blue" ? "rgba(95,111,103,0.18)" : "rgba(22,71,51,0.16)";

  return (
    <div className="glass-panel rounded-[20px] border px-3.5 py-3" style={{ borderColor }}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--muted-text)" }}>
        {label}
      </p>
      <p className="mt-1.5 text-xl font-semibold text-balance sm:text-[1.45rem]">{value}</p>
      {detail ? (
        <p className="mt-1.5 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
          {detail}
        </p>
      ) : null}
      {delta ? (
        <p className="mt-2 text-[13px] font-semibold" style={{ color: tone === "gold" ? "var(--mustard-dark)" : "var(--green-dark)" }}>
          {delta}
        </p>
      ) : null}
    </div>
  );
}

function SectionCard({
  id,
  title,
  kicker,
  description,
  actions,
  children
}: {
  id?: string;
  title: string;
  kicker?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="glass-panel rounded-[24px] border px-3.5 py-3.5 sm:px-4 sm:py-4" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-col gap-2.5 md:flex-row md:items-start md:justify-between">
        <div className="max-w-3xl">
          {kicker ? (
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em]" style={{ color: "var(--muted-text)" }}>
              {kicker}
            </p>
          ) : null}
          <h2 className="font-display mt-1 text-[1.35rem] sm:text-[1.45rem]">{title}</h2>
          {description ? (
            <p className="mt-1.5 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div
      className="flex min-h-[240px] flex-col items-center justify-center rounded-[22px] border border-dashed px-6 text-center"
      style={{ borderColor: "var(--border-strong)" }}
    >
      <p className="font-display text-[1.5rem]">{title}</p>
      <p className="mt-2 max-w-xl text-sm leading-5" style={{ color: "var(--muted-text)" }}>
        {description}
      </p>
    </div>
  );
}

export default function RevenueDashboard({
  userEmail,
  userRole = "viewer",
  defaultCurrency,
  initialTenantId,
  initialTenantName,
  allowLiveMarketRefresh
}: {
  userEmail: string;
  userRole?: "admin" | "viewer";
  defaultCurrency: string;
  initialTenantId: string;
  initialTenantName: string;
  allowLiveMarketRefresh: boolean;
}) {
  const isAdminRole = userRole === "admin";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialRanges = useMemo(defaultDateRanges, []);
  const initialHomeCustomRange = useMemo(defaultHomeCustomDateRange, []);
  const initialReservationsCustomRange = useMemo(defaultReservationsCustomDateRange, []);
  const initialMetricsRange = useMemo(defaultMetricsRange, []);
  const initialActiveBeforeDateCustom = useMemo(() => {
    const today = dateOnlyToDate(toDateOnly(new Date()));
    return toDateOnly(addUtcMonthsClamped(today, -12));
  }, []);
  const normalizedDefaultCurrency = normalizeCurrencyCode(defaultCurrency);
  const defaultCurrencyInCurated = CURATED_CURRENCY_SET.has(normalizedDefaultCurrency);
  const currentYear = new Date().getUTCFullYear();
  const todayDateOnly = useMemo(() => toDateOnly(new Date()), []);
  const defaultBookWindowCustomMonth = todayDateOnly.slice(0, 7);
  const defaultCalendarMonthStart = `${todayDateOnly.slice(0, 7)}-01`;
  const viewParam = searchParams?.get("view") ?? null;
  const calendarWorkspaceRequested = searchParams?.get("calendarWorkspace") === "1";

  const [tab, setTab] = useState<TabId>("overview");
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [barMetric, setBarMetric] = useState<BarMetric>("revenue");
  const [paceCompareMode, setPaceCompareMode] = useState<PaceCompareMode>("yoy_otb");
  const [includeFees, setIncludeFees] = useState(true);
  const [activePropertyScope, setActivePropertyScope] = useState<ActivePropertyScope>("whole_property");
  const [activeBeforeDateCustom, setActiveBeforeDateCustom] = useState<string>(initialActiveBeforeDateCustom);
  const [bookedRangePreset, setBookedRangePreset] = useState<BookedRangePreset>("last_90_days");
  const [bookWindowMode, setBookWindowMode] = useState<BookWindowMode>("booked");
  const [bookWindowRangeMode, setBookWindowRangeMode] = useState<BookWindowRangeMode>("preset");
  const [bookWindowLookbackDays, setBookWindowLookbackDays] = useState<BookWindowLookbackDays>(30);
  const [bookWindowCustomMonth, setBookWindowCustomMonth] = useState<string>(defaultBookWindowCustomMonth);
  const [bookWindowLineMetric, setBookWindowLineMetric] = useState<BookWindowLineMetric>("adr");
  const [deepDiveGranularity, setDeepDiveGranularity] = useState<DeepDiveGranularity>("month");
  const [deepDiveCompareMode, setDeepDiveCompareMode] = useState<DeepDiveCompareMode>("yoy_otb");
  const [deepDiveFocusListingId, setDeepDiveFocusListingId] = useState<string | null>(null);
  const [homeBookedMetric, setHomeBookedMetric] = useState<HomeMetric>("revenue");
  const [homeBookedWindow, setHomeBookedWindow] = useState<HomeWindow>("this_month");
  const [homeStayedMetric, setHomeStayedMetric] = useState<HomeMetric>("revenue");
  const [homeStayedWindow, setHomeStayedWindow] = useState<HomeWindow>("this_month");
  const [homeBookedCustomFrom, setHomeBookedCustomFrom] = useState<string>(() => defaultHomeCustomDateRange().from);
  const [homeBookedCustomTo, setHomeBookedCustomTo] = useState<string>(() => defaultHomeCustomDateRange().to);
  const [homeStayedCustomFrom, setHomeStayedCustomFrom] = useState<string>(() => defaultHomeCustomDateRange().from);
  const [homeStayedCustomTo, setHomeStayedCustomTo] = useState<string>(() => defaultHomeCustomDateRange().to);
  const [reservationsRangePreset, setReservationsRangePreset] = useState<ReservationsRangePreset>("today");
  const [reservationsCustomFrom, setReservationsCustomFrom] = useState<string>(() => defaultReservationsCustomDateRange().from);
  const [reservationsCustomTo, setReservationsCustomTo] = useState<string>(() => defaultReservationsCustomDateRange().to);
  const [deepDiveSelectedMonth, setDeepDiveSelectedMonth] = useState<number>(() => new Date().getUTCMonth() + 1);
  const [deepDiveWeekWindowOffset, setDeepDiveWeekWindowOffset] = useState(0);
  const [deepDiveSelectedWeekIndex, setDeepDiveSelectedWeekIndex] = useState(2);
  const [calendarSelectedMonthStart, setCalendarSelectedMonthStart] = useState<string>(
    () => defaultCalendarMonthStart
  );
  const [selectedCurrencyOption, setSelectedCurrencyOption] = useState<string>(
    defaultCurrencyInCurated ? normalizedDefaultCurrency : OTHER_CURRENCY_OPTION
  );
  const [customCurrencyCode, setCustomCurrencyCode] = useState<string>(defaultCurrencyInCurated ? "" : normalizedDefaultCurrency);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [listingSearch, setListingSearch] = useState("");
  const [dateRanges, setDateRanges] = useState<DateRangesByTab>(initialRanges);
  const [selectedListingIds, setSelectedListingIds] = useState<string[]>([]);
  const [selectedGroupTags, setSelectedGroupTags] = useState<string[]>([]);
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [groupBuilderOpen, setGroupBuilderOpen] = useState(false);
  const [groupDraftName, setGroupDraftName] = useState("");
  const [groupEditorSearch, setGroupEditorSearch] = useState("");
  const [groupEditorListingIds, setGroupEditorListingIds] = useState<string[]>([]);
  const [savingGroup, setSavingGroup] = useState(false);
  const [filtersInitialized, setFiltersInitialized] = useState(false);
  const [restoredSelections, setRestoredSelections] = useState<{
    listingIds?: string[];
    groupTags?: string[];
    channels?: string[];
    statuses?: string[];
  } | null>(null);

  const [currentClientId, setCurrentClientId] = useState(initialTenantId);
  const [currentClientName, setCurrentClientName] = useState(initialTenantName);
  const [clientOptions, setClientOptions] = useState<ClientOption[]>([{ id: initialTenantId, name: initialTenantName }]);
  const [switchingClientId, setSwitchingClientId] = useState<string | null>(null);
  const [pendingClientName, setPendingClientName] = useState<string | null>(null);

  const [options, setOptions] = useState<FilterOptionsResponse | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [bookWindowReport, setBookWindowReport] = useState<BookWindowReportResponse | null>(null);
  const [homeDashboardReport, setHomeDashboardReport] = useState<HomeDashboardResponse | null>(null);
  const [reservationsReport, setReservationsReport] = useState<ReservationsReportResponse | null>(null);
  const [deepDiveReport, setDeepDiveReport] = useState<PropertyDeepDiveResponse | null>(null);
  const [pricingCalendarReport, setPricingCalendarReport] = useState<PricingCalendarResponse | null>(null);
  const calendarVisibleStartIndex = useMemo(() => {
    if (!pricingCalendarReport) return 0;

    const firstForwardIndex = pricingCalendarReport.days.findIndex((day) => day.date >= todayDateOnly);
    if (firstForwardIndex === -1) return pricingCalendarReport.days.length;
    return firstForwardIndex;
  }, [pricingCalendarReport, todayDateOnly]);
  const calendarVisibleDays = useMemo(
    () => pricingCalendarReport?.days.slice(calendarVisibleStartIndex) ?? [],
    [calendarVisibleStartIndex, pricingCalendarReport]
  );
  const calendarVisibleRows = useMemo(
    () =>
      pricingCalendarReport?.rows.map((row) => ({
        ...row,
        cells: row.cells.slice(calendarVisibleStartIndex)
      })) ?? [],
    [calendarVisibleStartIndex, pricingCalendarReport]
  );
  const [calendarSettingsHydrated, setCalendarSettingsHydrated] = useState(false);
  const [calendarPricingGroupName, setCalendarPricingGroupName] = useState("");
  const [calendarWorkspacePanel, setCalendarWorkspacePanel] = useState<"calendar" | "settings">("calendar");
  const [calendarSettingsScope, setCalendarSettingsScope] = useState<CalendarSettingsScope | null>(null);
  const [calendarSettingsSection, setCalendarSettingsSection] = useState<CalendarSettingsSectionId>("base_pricing");
  const [calendarSettingsGroupRef, setCalendarSettingsGroupRef] = useState("");
  const [calendarSettingsPropertyId, setCalendarSettingsPropertyId] = useState("");
  const [calendarSettingsForm, setCalendarSettingsForm] = useState<Record<string, any>>({});
  const [calendarSettingsResolvedForm, setCalendarSettingsResolvedForm] = useState<Record<string, any>>({});
  const [calendarSettingsLoadedOverride, setCalendarSettingsLoadedOverride] = useState<Record<string, any>>({});
  const [loadingPricingSettings, setLoadingPricingSettings] = useState(false);
  const [savingPricingSettings, setSavingPricingSettings] = useState(false);
  const [savingCalendarPropertyIds, setSavingCalendarPropertyIds] = useState<string[]>([]);
  const [refreshingCalendarListingIds, setRefreshingCalendarListingIds] = useState<string[]>([]);
  const [calendarPropertyDrafts, setCalendarPropertyDrafts] = useState<Record<string, CalendarPropertyDraft>>({});
  const [metricDefinitions, setMetricDefinitions] = useState<MetricDefinitionSummary[]>([]);
  const [metricsReport, setMetricsReport] = useState<MetricsResponse | null>(null);
  const [metricIds, setMetricIds] = useState<MetricId[]>(["occupancy_pct", "stay_revenue"]);
  const [metricDateMode, setMetricDateMode] = useState<MetricDateMode>("stay");
  const [metricsGranularity, setMetricsGranularity] = useState<Granularity>("month");
  const [metricsStayDateFrom, setMetricsStayDateFrom] = useState(initialMetricsRange.stayDateFrom);
  const [metricsStayDateTo, setMetricsStayDateTo] = useState(initialMetricsRange.stayDateTo);
  const [metricsBookingDateFrom, setMetricsBookingDateFrom] = useState(initialMetricsRange.bookingDateFrom);
  const [metricsBookingDateTo, setMetricsBookingDateTo] = useState(initialMetricsRange.bookingDateTo);
  const calendarWorkspaceMode = calendarWorkspaceRequested && tab === "calendar";

  const [resolvingAttentionListingId, setResolvingAttentionListingId] = useState<string | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [viewStateReady, setViewStateReady] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [radarDismissals, setRadarDismissals] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [saveViewDialogOpen, setSaveViewDialogOpen] = useState(false);
  const [saveViewNameDraft, setSaveViewNameDraft] = useState("");
  const [showAllSignals, setShowAllSignals] = useState(false);
  const [selectedCalendarCellKey, setSelectedCalendarCellKey] = useState<string | null>(null);
  const [showSlowLoadingScreen, setShowSlowLoadingScreen] = useState(false);
  const [queueingManualSync, setQueueingManualSync] = useState(false);
  const [refreshingMarketData, setRefreshingMarketData] = useState(false);
  const [businessReviewSections, setBusinessReviewSections] = useState<BusinessReviewSection[]>([]);
  const [businessReviewManagerOpen, setBusinessReviewManagerOpen] = useState(false);
  const [addingCurrentViewToBusinessReview, setAddingCurrentViewToBusinessReview] = useState(false);
  const [exportingBusinessReview, setExportingBusinessReview] = useState(false);
  const [exportingCurrentReportPdf, setExportingCurrentReportPdf] = useState(false);
  const [exportingCurrentCsv, setExportingCurrentCsv] = useState(false);
  const [deepDiveExportMonths, setDeepDiveExportMonths] = useState<string[]>([]);
  const [powerPointSlides, setPowerPointSlides] = useState<PowerPointSlide[]>([]);
  const [powerPointChecklist, setPowerPointChecklist] = useState<PowerPointChecklistItem[]>(DEFAULT_POWERPOINT_CHECKLIST);
  const [powerPointPanelOpen, setPowerPointPanelOpen] = useState(false);
  const [addingCurrentViewToPowerPoint, setAddingCurrentViewToPowerPoint] = useState(false);
  const [exportingPowerPoint, setExportingPowerPoint] = useState(false);
  const [powerPointChecklistHydrated, setPowerPointChecklistHydrated] = useState(false);
  const backgroundSyncInFlightRef = useRef(false);
  const lastNavigationKeyRef = useRef<string | null>(null);
  const calendarReportClientCacheRef = useRef<Map<string, PricingCalendarResponse>>(new Map());
  const savingCalendarPropertyIdsRef = useRef<Set<string>>(new Set());
  const queuedCalendarPropertySaveIdsRef = useRef<Set<string>>(new Set());
  const loadCalendarReportRef = useRef<
    ((params?: { forceMarketRefresh?: boolean; ignoreClientCache?: boolean; suppressLoadingState?: boolean }) => Promise<PricingCalendarResponse>) | null
  >(null);
  const exportCaptureRef = useRef<HTMLDivElement | null>(null);
  const reportChartCaptureRef = useRef<HTMLDivElement | null>(null);
  const bookWindowChartCaptureRef = useRef<HTMLDivElement | null>(null);
  const deepDiveCaptureRef = useRef<HTMLDivElement | null>(null);
  const calendarScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const calendarTableRef = useRef<HTMLTableElement | null>(null);
  const calendarBottomScrollRef = useRef<HTMLDivElement | null>(null);
  const calendarBottomScrollContentRef = useRef<HTMLDivElement | null>(null);
  const calendarScrollSyncingRef = useRef(false);
  const [calendarHasHorizontalOverflow, setCalendarHasHorizontalOverflow] = useState(false);

  const deferredListingSearch = useDeferredValue(listingSearch);
  const activeRange = tab === "pace" || tab === "sales" || tab === "booked" ? dateRanges[tab] : null;
  const reservationsDateRange = useMemo(() => {
    const today = dateOnlyToDate(toDateOnly(new Date()));

    if (reservationsRangePreset === "today") {
      const dateOnly = toDateOnly(today);
      return { from: dateOnly, to: dateOnly };
    }
    if (reservationsRangePreset === "yesterday") {
      const yesterday = toDateOnly(addUtcDays(today, -1));
      return { from: yesterday, to: yesterday };
    }
    if (reservationsRangePreset === "last_7_days") {
      return {
        from: toDateOnly(addUtcDays(today, -6)),
        to: toDateOnly(today)
      };
    }
    if (reservationsRangePreset === "this_month") {
      return {
        from: `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`,
        to: toDateOnly(today)
      };
    }

    return {
      from: reservationsCustomFrom,
      to: reservationsCustomTo
    };
  }, [reservationsCustomFrom, reservationsCustomTo, reservationsRangePreset]);
  const bookWindowCustomDateRange = useMemo(
    () => (bookWindowRangeMode === "custom_month" ? monthValueToDateRange(bookWindowCustomMonth) : null),
    [bookWindowCustomMonth, bookWindowRangeMode]
  );
  const bookWindowSelectionLabel = useMemo(() => {
    if (bookWindowRangeMode === "custom_month" && bookWindowCustomDateRange) {
      return `${formatDisplayMonth(bookWindowCustomMonth)} (${formatDisplayDate(bookWindowCustomDateRange.from)} to ${formatDisplayDate(bookWindowCustomDateRange.to)})`;
    }

    return `Last ${bookWindowLookbackDays} days`;
  }, [bookWindowCustomDateRange, bookWindowCustomMonth, bookWindowLookbackDays, bookWindowRangeMode]);
  const displayCurrency = selectedCurrencyOption === OTHER_CURRENCY_OPTION ? customCurrencyCode : selectedCurrencyOption;
  const displayCurrencyValid = isValidCurrencyCode(displayCurrency);
  const availableCurrencies = useMemo(() => {
    const merged: string[] = [];
    const seen = new Set<string>();

    for (const code of CURATED_CURRENCIES) {
      merged.push(code);
      seen.add(code);
    }

    for (const code of options?.currencies ?? []) {
      const normalized = normalizeCurrencyCode(code);
      if (!isValidCurrencyCode(normalized) || seen.has(normalized)) continue;
      merged.push(normalized);
      seen.add(normalized);
    }

    return merged;
  }, [options?.currencies]);
  const weekWindowStart = useMemo(() => {
    const currentWeekStart = (() => {
      const now = new Date();
      const start = dateOnlyToDate(toDateOnly(now));
      const weekdayOffset = (start.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - weekdayOffset);
      return start;
    })();
    return addUtcDays(currentWeekStart, deepDiveWeekWindowOffset * 7);
  }, [deepDiveWeekWindowOffset]);
  const deepDiveWeekOptions = useMemo(
    () => Array.from({ length: 5 }, (_, index) => addUtcDays(weekWindowStart, index * 7)),
    [weekWindowStart]
  );
  const deepDiveSelectedWeekStart = deepDiveWeekOptions[Math.min(Math.max(deepDiveSelectedWeekIndex, 0), 4)];
  const deepDiveSelectedPeriodStart = useMemo(() => {
    if (deepDiveGranularity === "month") {
      return toDateOnly(new Date(Date.UTC(currentYear, deepDiveSelectedMonth - 1, 1)));
    }
    return deepDiveSelectedWeekStart ? toDateOnly(deepDiveSelectedWeekStart) : toDateOnly(new Date());
  }, [currentYear, deepDiveGranularity, deepDiveSelectedMonth, deepDiveSelectedWeekStart]);
  const pricingCalendarSelectedMonthStart = calendarSelectedMonthStart;
  const calendarMonthOptions = useMemo(() => {
    const currentMonthStart = dateOnlyToDate(`${todayDateOnly.slice(0, 7)}-01`);
    return Array.from({ length: 18 }, (_, index) => {
      const monthDate = addUtcMonthsClamped(currentMonthStart, index);
      const monthStart = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1));
      return {
        value: toDateOnly(monthStart),
        short: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(monthStart),
        year: monthStart.getUTCFullYear()
      };
    });
  }, [todayDateOnly]);
  const selectedCalendarMonthIndex = calendarMonthOptions.findIndex((month) => month.value === pricingCalendarSelectedMonthStart);
  const selectedCalendarMonthOption = selectedCalendarMonthIndex >= 0 ? calendarMonthOptions[selectedCalendarMonthIndex] : calendarMonthOptions[0] ?? null;

  const allListings = useMemo(() => options?.listings ?? [], [options?.listings]);
  const allChannels = useMemo(() => options?.channels ?? [], [options?.channels]);
  const allStatuses = useMemo(() => options?.statuses ?? [], [options?.statuses]);
  const allListingIds = useMemo(() => allListings.map((listing) => listing.id), [allListings]);
  const allCustomGroups = useMemo(() => {
    const groups = new Map<string, { label: string; listingIds: string[] }>();

    for (const listing of allListings) {
      for (const tag of listing.tags ?? []) {
        if (!isCustomGroupTag(tag)) continue;

        const label = customGroupLabel(tag);
        if (!label) continue;

        const key = customGroupKey(label);
        const current = groups.get(key) ?? { label, listingIds: [] };
        current.listingIds.push(listing.id);
        groups.set(key, current);
      }
    }

    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [allListings]);
  const filteredGroupEditorListings = useMemo(() => {
    const normalizedQuery = groupEditorSearch.trim().toLowerCase();
    if (!normalizedQuery) return allListings;
    return allListings.filter((listing) => listing.name.toLowerCase().includes(normalizedQuery) || listing.id.toLowerCase().includes(normalizedQuery));
  }, [allListings, groupEditorSearch]);
  const activeBeforeDate = useMemo(
    () => buildActiveBeforeDate(activePropertyScope, activeBeforeDateCustom),
    [activeBeforeDateCustom, activePropertyScope]
  );
  const effectiveSelectedGroupTags = useMemo(() => {
    if (selectedGroupTags.length === 0) return [];
    const availableKeys = new Set(allCustomGroups.map((group) => customGroupKey(group.label)));
    return selectedGroupTags.filter((tag) => availableKeys.has(customGroupKey(tag)));
  }, [allCustomGroups, selectedGroupTags]);
  const currentCalendarPricingGroup = useMemo(
    () => allCustomGroups.find((group) => customGroupKey(group.label) === customGroupKey(calendarPricingGroupName)) ?? null,
    [allCustomGroups, calendarPricingGroupName]
  );
  const calendarMarketDataMeta = pricingCalendarReport?.meta.marketData ?? null;
  const calendarCoverageMessage = useMemo(
    () => pricingCalendarCoverageMessage(pricingCalendarReport),
    [pricingCalendarReport]
  );
  const selectedCalendarCellDetail = useMemo(() => {
    if (!selectedCalendarCellKey) return null;

    for (const row of calendarVisibleRows) {
      const cell = row.cells.find((candidate) => calendarCellSelectionKey(row.listingId, candidate.date) === selectedCalendarCellKey);
      if (cell) {
        return { row, cell };
      }
    }

    return null;
  }, [calendarVisibleRows, selectedCalendarCellKey]);
  const effectiveCalendarSettingsGroupRef = useMemo(
    () => calendarSettingsGroupRef || currentCalendarPricingGroup?.label || "",
    [calendarSettingsGroupRef, currentCalendarPricingGroup?.label]
  );
  const effectiveCalendarSettingsPropertyId = useMemo(
    () => calendarSettingsPropertyId || calendarVisibleRows[0]?.listingId || "",
    [calendarSettingsPropertyId, calendarVisibleRows]
  );
  const calendarSettingsScopeOptions = [
    { id: "portfolio" as const, label: "Whole Portfolio" },
    { id: "group" as const, label: "Group" },
    { id: "property" as const, label: "Individual Property" }
  ];
  const calendarSettingsMenu = [
    { id: "base_pricing" as const, label: "Base Price & Minimum Price" },
    { id: "occupancy" as const, label: "Occupancy" },
    { id: "demand" as const, label: "Demand" },
    { id: "seasonality" as const, label: "Seasonality" },
    { id: "day_of_week" as const, label: "Day Of Week" },
    { id: "safety_net" as const, label: "Safety Net" },
    { id: "local_events" as const, label: "Local Events" },
    { id: "last_minute" as const, label: "Last Minute" },
    { id: "stay_rules" as const, label: "Stay Rules" }
  ];
  const calendarSettingsScopeReady =
    calendarSettingsScope === "portfolio" ||
    (calendarSettingsScope === "group" && Boolean(effectiveCalendarSettingsGroupRef)) ||
    (calendarSettingsScope === "property" && Boolean(effectiveCalendarSettingsPropertyId));
  const calendarSeasonalityAdjustments = buildCalendarMonthAdjustments(calendarSettingsForm.seasonalityMonthlyAdjustments);
  const calendarDayOfWeekAdjustments = buildCalendarDayOfWeekAdjustments(calendarSettingsForm.dayOfWeekAdjustments);
  const calendarDemandSensitivityLevel = Math.max(
    1,
    Math.min(5, Math.round(Number(calendarSettingsForm.demandSensitivityLevel ?? 3)))
  ) as 1 | 2 | 3 | 4 | 5;
  const calendarSettingsDirty = useMemo(
    () => calendarSettingsSignature(calendarSettingsForm) !== calendarSettingsSignature(calendarSettingsLoadedOverride),
    [calendarSettingsForm, calendarSettingsLoadedOverride]
  );
  const calendarSettingsHasOverrides = useMemo(
    () => Object.keys(calendarSettingsLoadedOverride).length > 0,
    [calendarSettingsLoadedOverride]
  );
  const hasDirtyCalendarPropertyDrafts = useMemo(() => {
    if (!pricingCalendarReport) return false;

    return pricingCalendarReport.rows.some((row) => {
      const draft = calendarPropertyDrafts[row.listingId];
      return draft ? isCalendarPropertyDraftDirty(row, draft) : false;
    });
  }, [calendarPropertyDrafts, pricingCalendarReport]);
  const listingFilterBaseIds = useMemo(
    () =>
      resolveListingIdsForFilters({
        listings: allListings,
        allListingIds,
        activeBeforeDate,
        groupTags: effectiveSelectedGroupTags
      }),
    [activeBeforeDate, allListingIds, allListings, effectiveSelectedGroupTags]
  );
  const listingFilterBaseIdSet = useMemo(() => new Set(listingFilterBaseIds), [listingFilterBaseIds]);
  const filteredListings = useMemo(() => {
    const normalizedQuery = deferredListingSearch.trim().toLowerCase();
    const sourceListings = allListings.filter((listing) => listingFilterBaseIdSet.has(listing.id));
    if (!normalizedQuery) return sourceListings;
    return sourceListings.filter((listing) => {
      const name = listing.name.toLowerCase();
      const id = listing.id.toLowerCase();
      return name.includes(normalizedQuery) || id.includes(normalizedQuery);
    });
  }, [allListings, deferredListingSearch, listingFilterBaseIdSet]);

  const requestListingIds = useMemo(() => {
    if (!options) return [];
    const listingSelection = selectedListingIds;
    const intersected = listingSelection.filter((listingId) => listingFilterBaseIdSet.has(listingId));

    if (listingSelection.length === 0 || intersected.length === 0) {
      return [NO_LISTING_MATCH_ID];
    }
    if (intersected.length === allListingIds.length && activeBeforeDate === null && effectiveSelectedGroupTags.length === 0) return [];
    return intersected;
  }, [activeBeforeDate, allListingIds, effectiveSelectedGroupTags.length, listingFilterBaseIdSet, options, selectedListingIds]);
  const requestChannels = useMemo(() => {
    if (!options) return [];
    if (selectedChannels.length === 0) return [];
    if (isAllSelected(selectedChannels, allChannels)) return [];
    return selectedChannels;
  }, [allChannels, options, selectedChannels]);
  const requestStatuses = useMemo(() => {
    if (!options) return [];
    if (selectedStatuses.length === 0) return [];
    if (isAllSelected(selectedStatuses, allStatuses)) return [];
    return selectedStatuses;
  }, [allStatuses, options, selectedStatuses]);

  const homeBookedWindowKey = toHomeWindowKey(homeBookedWindow);
  const homeStayedWindowKey = toHomeWindowKey(homeStayedWindow);
  const homeBookedSnapshot = homeDashboardReport?.headline.booked[homeBookedWindowKey] ?? null;
  const homeArrivalsSnapshot = homeDashboardReport?.headline.arrivals[homeStayedWindowKey] ?? null;
  const homeStayedSnapshot = homeDashboardReport?.headline.stayed[homeStayedWindowKey] ?? null;
  const homeMetric = homeBookedMetric;
  const homeWindow = homeBookedWindow;
  const comparisonScope =
    tab === "overview" || tab === "property_groups"
      ? homeDashboardReport?.meta.comparisonScope ?? null
      : tab === "reservations"
        ? reservationsReport?.meta.comparisonScope ?? null
      : tab === "property_drilldown"
        ? deepDiveReport?.meta.comparisonScope ?? null
        : tab === "calendar"
          ? pricingCalendarReport?.meta.comparisonScope ?? null
        : tab === "pace" || tab === "sales"
          ? report?.meta.comparisonScope ?? null
        : null;
  const activePropertyGroupView = tab === "property_groups" && effectiveSelectedGroupTags.length === 1 ? effectiveSelectedGroupTags[0] : null;
  const canRenderHomeDashboard = tab === "overview" || tab === "property_groups";
  const showGroupFilterColumn = tab !== "property_groups";
  const reportRangeLabel = useMemo(() => {
    if (!activeRange) return null;
    return `${formatDisplayDate(activeRange.stayDateFrom)} to ${formatDisplayDate(activeRange.stayDateTo)}`;
  }, [activeRange]);
  const negativeRadarMonths = useMemo(
    () =>
      (homeDashboardReport?.focusFinder.underperformingMonths ?? []).filter(
        (row) => (row.revenueDeltaPct ?? 0) < 0 && !radarDismissals[`month:${row.bucket}`]
      ),
    [homeDashboardReport?.focusFinder.underperformingMonths, radarDismissals]
  );
  const negativeRadarWeeks = useMemo(
    () =>
      (homeDashboardReport?.focusFinder.underperformingWeeks ?? []).filter(
        (row) => (row.revenueDeltaPct ?? 0) < 0 && !radarDismissals[`week:${row.bucket}`]
      ),
    [homeDashboardReport?.focusFinder.underperformingWeeks, radarDismissals]
  );
  const adrRadarMonths = useMemo(
    () =>
      (homeDashboardReport?.focusFinder.adrOpportunityMonths ?? []).filter(
        (row) => Math.abs(row.adrDeltaPct ?? 0) >= 12 && !radarDismissals[`adr:${row.bucket}`]
      ),
    [homeDashboardReport?.focusFinder.adrOpportunityMonths, radarDismissals]
  );
  const highDemandRadarDates = useMemo(
    () =>
      (homeDashboardReport?.focusFinder.highDemandDates ?? []).filter(
        (row) => !radarDismissals[`demand:${row.date}`]
      ),
    [homeDashboardReport?.focusFinder.highDemandDates, radarDismissals]
  );
  const syncQueueActivity = (syncStatus?.queueCounts.waiting ?? 0) + (syncStatus?.queueCounts.active ?? 0);
  const coreSyncTimestamp = requiredSyncTimestamp(syncStatus, "core");
  const extendedSyncTimestamp = requiredSyncTimestamp(syncStatus, "extended");
  const lastSyncDisplay = syncStatus?.connection?.lastSyncAt ? formatDisplayTimestamp(syncStatus.connection.lastSyncAt) : "Awaiting sync";
  const syncRefreshDisabled = queueingManualSync || !currentClientId || syncQueueActivity > 0;
  const completedPowerPointChecklistCount = powerPointChecklist.filter((item) => item.done).length;
  const metricsAxisAssignments = useMemo(() => buildMetricsAxisAssignments(metricsReport), [metricsReport]);
  const metricsLeftAxisFormatter = useMemo(
    () => axisFormatterForSeries(metricsReport?.series ?? [], metricsAxisAssignments, "left", metricsReport?.displayCurrency ?? displayCurrency),
    [displayCurrency, metricsAxisAssignments, metricsReport?.displayCurrency, metricsReport?.series]
  );
  const metricsRightAxisFormatter = useMemo(
    () => axisFormatterForSeries(metricsReport?.series ?? [], metricsAxisAssignments, "right", metricsReport?.displayCurrency ?? displayCurrency),
    [displayCurrency, metricsAxisAssignments, metricsReport?.displayCurrency, metricsReport?.series]
  );

  const chartData = useMemo(() => {
    if (!report) return [];
    return report.buckets.map((bucketKey, index) => {
      const currentBar =
        barMetric === "nights"
          ? report.current.nights[index]
          : barMetric === "revenue"
            ? report.current.revenue[index]
            : report.current.occupancy[index];
      const lastYearBar =
        barMetric === "nights"
          ? report.lastYear.nights[index]
          : barMetric === "revenue"
            ? report.lastYear.revenue[index]
            : report.lastYear.occupancy[index];

      return {
        bucketKey,
        bucketLabel: formatBucketLabel(bucketKey, granularity),
        currentBar: currentBar ?? 0,
        lastYearBar: lastYearBar ?? 0,
        currentADR: report.current.adr[index] ?? 0,
        lastYearADR: report.lastYear.adr[index] ?? 0,
        currentOccupancy: report.current.occupancy[index] ?? 0,
        lastYearOccupancy: report.lastYear.occupancy[index] ?? 0
      };
    });
  }, [barMetric, granularity, report]);

  const tableRows = useMemo<TableRow[]>(() => {
    if (!report) return [];
    return report.buckets.map((bucketKey, index) => ({
      bucketKey,
      bucketLabel: formatBucketLabel(bucketKey, granularity),
      currentNights: report.current.nights[index] ?? 0,
      lastYearNights: report.lastYear.nights[index] ?? 0,
      currentRevenue: report.current.revenue[index] ?? 0,
      lastYearRevenue: report.lastYear.revenue[index] ?? 0,
      currentAdr: report.current.adr[index] ?? 0,
      lastYearAdr: report.lastYear.adr[index] ?? 0,
      currentOccupancy: report.current.occupancy[index] ?? 0,
      lastYearOccupancy: report.lastYear.occupancy[index] ?? 0,
      currentInventory: report.current.inventory[index] ?? 0,
      lastYearInventory: report.lastYear.inventory[index] ?? 0
    }));
  }, [granularity, report]);

  const legacyTotals = useMemo(() => {
    if (tableRows.length === 0 || !report) return null;
    const totalCurrentNights = tableRows.reduce((sum, row) => sum + row.currentNights, 0);
    const totalLyNights = tableRows.reduce((sum, row) => sum + row.lastYearNights, 0);
    const totalCurrentRevenue = tableRows.reduce((sum, row) => sum + row.currentRevenue, 0);
    const totalLyRevenue = tableRows.reduce((sum, row) => sum + row.lastYearRevenue, 0);
    const totalCurrentInventory = tableRows.reduce((sum, row) => sum + row.currentInventory, 0);
    const totalLyInventory = tableRows.reduce((sum, row) => sum + row.lastYearInventory, 0);
    const totalCurrentAdr = totalCurrentNights > 0 ? totalCurrentRevenue / totalCurrentNights : 0;
    const totalLyAdr = totalLyNights > 0 ? totalLyRevenue / totalLyNights : 0;
    const totalCurrentOccupancy = totalCurrentInventory > 0 ? (totalCurrentNights / totalCurrentInventory) * 100 : 0;
    const totalLyOccupancy = totalLyInventory > 0 ? (totalLyNights / totalLyInventory) * 100 : 0;
    return {
      totalCurrentNights,
      totalLyNights,
      totalCurrentRevenue,
      totalLyRevenue,
      totalCurrentAdr,
      totalLyAdr,
      totalCurrentOccupancy,
      totalLyOccupancy
    };
  }, [report, tableRows]);

  const bookWindowChartData = useMemo(() => {
    if (!bookWindowReport) return [];
    return bookWindowReport.buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      nightsPct: bucket.nightsPct,
      lineValue:
        bookWindowLineMetric === "adr"
          ? bucket.adr
          : bookWindowLineMetric === "cancellation_pct"
            ? bucket.cancellationPct
            : bucket.avgLos
    }));
  }, [bookWindowLineMetric, bookWindowReport]);
  const topBookWindow = useMemo(() => {
    if (!bookWindowReport) return null;

    return bookWindowReport.buckets.reduce<BookWindowReportResponse["buckets"][number] | null>((best, bucket) => {
      if (!best) return bucket;
      if (bucket.nightsPct !== best.nightsPct) return bucket.nightsPct > best.nightsPct ? bucket : best;
      if (bucket.nights !== best.nights) return bucket.nights > best.nights ? bucket : best;
      if (bucket.reservations !== best.reservations) return bucket.reservations > best.reservations ? bucket : best;
      return bucket;
    }, null);
  }, [bookWindowReport]);

  const deepDiveSummary = useMemo(() => {
    if (!deepDiveReport) return null;
    return deepDiveReport.rows.reduce(
      (summary, row) => {
        summary[row.health] += 1;
        return summary;
      },
      { ahead: 0, on_pace: 0, behind: 0 }
    );
  }, [deepDiveReport]);

  const metricsChartData = useMemo(() => buildMetricsChartData(metricsReport), [metricsReport]);
  const metricDefinitionMap = useMemo(
    () => new Map(metricDefinitions.map((definition) => [definition.id, definition])),
    [metricDefinitions]
  );

  // The URL sync intentionally tracks the underlying state fields rather than the derived helper identities.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if ((tab === "booked" || tab === "booking_behaviour") && barMetric === "occupancy") {
      setBarMetric("nights");
    }
  }, [barMetric, tab]);

  useEffect(() => {
    if (tab !== "booked" && granularity === "day") {
      setGranularity("month");
    }
  }, [granularity, tab]);

  useEffect(() => {
    if (tab !== "property_drilldown" || !deepDiveFocusListingId) return;
    const rowElement = document.getElementById(`deep-dive-row-${deepDiveFocusListingId}`);
    if (!rowElement) return;
    rowElement.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [deepDiveFocusListingId, deepDiveReport?.rows.length, tab]);

  useEffect(() => {
    if (deepDiveGranularity !== "month") {
      setDeepDiveExportMonths([]);
      return;
    }

    const currentMonthStart = toDateOnly(new Date(Date.UTC(currentYear, deepDiveSelectedMonth - 1, 1)));
    const validMonthStarts = new Set(
      Array.from({ length: 12 }, (_, index) => toDateOnly(new Date(Date.UTC(currentYear, index, 1))))
    );
    setDeepDiveExportMonths((current) => {
      const filtered = current.filter((value) => validMonthStarts.has(value));
      if (filtered.length > 0 && filtered.length === current.length) return current;
      if (filtered.length > 0) return filtered;
      return [currentMonthStart];
    });
  }, [currentYear, deepDiveGranularity, deepDiveSelectedMonth]);

  useEffect(() => {
    const snapshotFromUrl = decodeSnapshot(viewParam);
    const snapshotFromStorage = (() => {
      if (typeof window === "undefined") return null;
      try {
        const raw = window.localStorage.getItem(PERSISTENCE_KEY);
        return raw ? (JSON.parse(raw) as PersistedSnapshot) : null;
      } catch {
        return null;
      }
    })();
    const snapshot = snapshotFromUrl ?? snapshotFromStorage;
    const storedViews = (() => {
      if (typeof window === "undefined") return [];
      try {
        const raw = window.localStorage.getItem(SAVED_VIEWS_KEY);
        return raw ? (JSON.parse(raw) as SavedView[]) : [];
      } catch {
        return [];
      }
    })();

    if (snapshot) {
      const shouldPreserveDates = snapshot.preserveDates === true;
      const restoredActivePropertyScope =
        snapshot.activePropertyScope ??
        (snapshot.newPropertyWindowMonths === 3
          ? "active_3_months"
          : snapshot.newPropertyWindowMonths === 6
            ? "active_6_months"
            : snapshot.newPropertyWindowMonths === 12
              ? "active_12_months"
              : "whole_property");
      setTab(snapshot.tab === "signal_lab" ? "overview" : snapshot.tab ?? "overview");
      setIncludeFees(snapshot.includeFees ?? true);
      setGranularity(snapshot.granularity && snapshot.granularity !== "day" ? snapshot.granularity : "month");
      setBarMetric(snapshot.barMetric ?? "revenue");
      setPaceCompareMode(snapshot.paceCompareMode ?? "yoy_otb");
      setActivePropertyScope(restoredActivePropertyScope);
      setActiveBeforeDateCustom(snapshot.activeBeforeDateCustom ?? initialActiveBeforeDateCustom);
      setBookedRangePreset(shouldPreserveDates ? snapshot.bookedRangePreset ?? inferBookedRangePreset(snapshot.dateRanges?.booked) : "last_90_days");
      setBookWindowRangeMode(snapshot.bookWindowRangeMode ?? "preset");
      setBookWindowMode(snapshot.bookWindowMode ?? "booked");
      setBookWindowLookbackDays(normalizeBookWindowLookbackDays(snapshot.bookWindowLookbackDays));
      setBookWindowCustomMonth(
        snapshot.bookWindowCustomMonth && isValidMonthInput(snapshot.bookWindowCustomMonth)
          ? snapshot.bookWindowCustomMonth
          : defaultBookWindowCustomMonth
      );
      setBookWindowLineMetric(snapshot.bookWindowLineMetric ?? "adr");
      setDeepDiveGranularity(snapshot.deepDiveGranularity ?? "month");
      setDeepDiveCompareMode(snapshot.deepDiveCompareMode ?? "yoy_otb");
      setDeepDiveSelectedMonth(snapshot.deepDiveSelectedMonth ?? new Date().getUTCMonth() + 1);
      setCalendarSelectedMonthStart(snapshot.calendarSelectedMonthStart ?? `${todayDateOnly.slice(0, 7)}-01`);
      setDeepDiveWeekWindowOffset(snapshot.deepDiveWeekWindowOffset ?? 0);
      setDeepDiveSelectedWeekIndex(snapshot.deepDiveSelectedWeekIndex ?? 2);
      const restoredHomeMetric = snapshot.homeBookedMetric ?? snapshot.homeStayedMetric ?? "revenue";
      const restoredHomeWindow = snapshot.homeBookedWindow ?? snapshot.homeStayedWindow ?? "this_month";
      const restoredHomeCustomFrom = shouldPreserveDates
        ? snapshot.homeBookedCustomFrom ?? snapshot.homeStayedCustomFrom ?? initialHomeCustomRange.from
        : initialHomeCustomRange.from;
      const restoredHomeCustomTo = shouldPreserveDates
        ? snapshot.homeBookedCustomTo ?? snapshot.homeStayedCustomTo ?? initialHomeCustomRange.to
        : initialHomeCustomRange.to;
      const restoredReservationsCustomFrom = shouldPreserveDates
        ? snapshot.reservationsCustomFrom ?? initialReservationsCustomRange.from
        : initialReservationsCustomRange.from;
      const restoredReservationsCustomTo = shouldPreserveDates
        ? snapshot.reservationsCustomTo ?? initialReservationsCustomRange.to
        : initialReservationsCustomRange.to;
      setHomeBookedMetric(restoredHomeMetric);
      setHomeStayedMetric(restoredHomeMetric);
      setHomeBookedWindow(restoredHomeWindow);
      setHomeStayedWindow(restoredHomeWindow);
      setHomeBookedCustomFrom(restoredHomeCustomFrom);
      setHomeBookedCustomTo(restoredHomeCustomTo);
      setHomeStayedCustomFrom(restoredHomeCustomFrom);
      setHomeStayedCustomTo(restoredHomeCustomTo);
      setReservationsRangePreset(shouldPreserveDates ? snapshot.reservationsRangePreset ?? "today" : "today");
      setReservationsCustomFrom(restoredReservationsCustomFrom);
      setReservationsCustomTo(restoredReservationsCustomTo);
      setDateRanges(shouldPreserveDates ? snapshot.dateRanges ?? initialRanges : initialRanges);
      setFiltersOpen(snapshot.filtersOpen ?? false);
      setMetricIds(snapshot.metricIds?.length ? snapshot.metricIds : ["occupancy_pct", "stay_revenue"]);
      setMetricDateMode(snapshot.metricDateMode ?? "stay");
      setMetricsGranularity(snapshot.metricsGranularity ?? "month");
      setMetricsStayDateFrom(snapshot.metricsStayDateFrom ?? initialMetricsRange.stayDateFrom);
      setMetricsStayDateTo(snapshot.metricsStayDateTo ?? initialMetricsRange.stayDateTo);
      setMetricsBookingDateFrom(snapshot.metricsBookingDateFrom ?? initialMetricsRange.bookingDateFrom);
      setMetricsBookingDateTo(snapshot.metricsBookingDateTo ?? initialMetricsRange.bookingDateTo);

      const normalizedDisplayCurrency = normalizeCurrencyCode(snapshot.displayCurrency ?? normalizedDefaultCurrency);
      if (CURATED_CURRENCY_SET.has(normalizedDisplayCurrency)) {
        setSelectedCurrencyOption(normalizedDisplayCurrency);
        setCustomCurrencyCode(normalizedDisplayCurrency);
      } else if (normalizedDisplayCurrency) {
        setSelectedCurrencyOption(OTHER_CURRENCY_OPTION);
        setCustomCurrencyCode(normalizedDisplayCurrency);
      }

      setRestoredSelections({
        listingIds: snapshot.selectedListingIds,
        groupTags: snapshot.selectedGroupTags,
        channels: snapshot.selectedChannels,
        statuses: snapshot.selectedStatuses
      });
    }

    setSavedViews(storedViews);
    setRadarDismissals(readRadarDismissals());
    setViewStateReady(true);
  }, [
    defaultBookWindowCustomMonth,
    initialActiveBeforeDateCustom,
    initialHomeCustomRange.from,
    initialHomeCustomRange.to,
    initialReservationsCustomRange.from,
    initialReservationsCustomRange.to,
    initialMetricsRange.bookingDateFrom,
    initialMetricsRange.bookingDateTo,
    initialMetricsRange.stayDateFrom,
    initialMetricsRange.stayDateTo,
    initialRanges,
    normalizedDefaultCurrency,
    todayDateOnly,
    viewParam
  ]);

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [calendarWorkspaceMode, pathname, tab]);

  useEffect(() => {
    setShowAllSignals(false);
  }, [homeDashboardReport?.propertyDetective.length]);

  useEffect(() => {
    if (!calendarWorkspaceMode) return;
    if (selectedCalendarCellKey && !selectedCalendarCellDetail) {
      setSelectedCalendarCellKey(null);
    }
  }, [calendarWorkspaceMode, selectedCalendarCellDetail, selectedCalendarCellKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RADAR_DISMISSALS_KEY, JSON.stringify(radarDismissals));
  }, [radarDismissals]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(POWERPOINT_CHECKLIST_KEY);
      if (!raw) {
        setPowerPointChecklist(DEFAULT_POWERPOINT_CHECKLIST);
        return;
      }

      const parsed = JSON.parse(raw) as Array<Partial<PowerPointChecklistItem>>;
      const normalized = parsed
        .map((item, index) => ({
          id: item.id && item.id.trim().length > 0 ? item.id : `ppt-check-${index + 1}`,
          text: typeof item.text === "string" ? item.text.trim() : "",
          done: Boolean(item.done)
        }))
        .filter((item) => item.text.length > 0);

      setPowerPointChecklist(normalized.length > 0 ? normalized : DEFAULT_POWERPOINT_CHECKLIST);
    } catch {
      setPowerPointChecklist(DEFAULT_POWERPOINT_CHECKLIST);
    } finally {
      setPowerPointChecklistHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!powerPointChecklistHydrated || typeof window === "undefined") return;
    window.localStorage.setItem(POWERPOINT_CHECKLIST_KEY, JSON.stringify(powerPointChecklist));
  }, [powerPointChecklist, powerPointChecklistHydrated]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentClientId) return;

    try {
      const raw = window.localStorage.getItem(`${CALENDAR_SETTINGS_KEY_PREFIX}${currentClientId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CalendarSettingsSnapshot>;
        setCalendarPricingGroupName(normalizeGroupName(parsed.pricingGroupName ?? ""));
      }
    } catch {
      // Ignore malformed local settings and continue with defaults.
    } finally {
      setCalendarSettingsHydrated(true);
    }
  }, [currentClientId]);

  useEffect(() => {
    if (!calendarSettingsHydrated || typeof window === "undefined" || !currentClientId) return;

    const snapshot: CalendarSettingsSnapshot = {
      pricingGroupName: calendarPricingGroupName
    };

    window.localStorage.setItem(`${CALENDAR_SETTINGS_KEY_PREFIX}${currentClientId}`, JSON.stringify(snapshot));
  }, [calendarPricingGroupName, calendarSettingsHydrated, currentClientId]);

  useEffect(() => {
    if (!calendarPricingGroupName) return;
    if (allCustomGroups.some((group) => customGroupKey(group.label) === customGroupKey(calendarPricingGroupName))) return;
    setCalendarPricingGroupName("");
  }, [allCustomGroups, calendarPricingGroupName]);

  useEffect(() => {
    if (calendarPricingGroupName || effectiveSelectedGroupTags.length !== 1) return;
    setCalendarPricingGroupName(effectiveSelectedGroupTags[0] ?? "");
  }, [calendarPricingGroupName, effectiveSelectedGroupTags]);

  useEffect(() => {
    let active = true;

    async function loadBootstrap() {
      setLoadingOptions(true);
      try {
        const [filterOptions, syncData] = await Promise.all([
          fetchJson<FilterOptionsResponse>("/api/filters/options"),
          fetchJson<SyncStatusResponse>("/api/sync/status")
        ]);

        if (!active) return;

        setOptions({
          channels: filterOptions.channels ?? [],
          statuses: filterOptions.statuses ?? [],
          listings: filterOptions.listings ?? [],
          currencies: filterOptions.currencies ?? [],
          paceSnapshotDates: filterOptions.paceSnapshotDates ?? []
        });
        setSyncStatus(syncData);
        setLoadingOptions(false);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard");
        setLoadingOptions(false);
      }
    }

    void loadBootstrap();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadClientContext() {
      try {
        const tenantContext = await fetchJson<CurrentTenantResponse>("/api/tenants/current");
        if (!active) return;

        setCurrentClientId(tenantContext.tenant.id);
        setCurrentClientName(tenantContext.tenant.name);
        setClientOptions(tenantContext.clients ?? [{ id: tenantContext.tenant.id, name: tenantContext.tenant.name }]);
      } catch {
        if (!active) return;
      }
    }

    void loadClientContext();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (metricDefinitions.length > 0) return;

    let active = true;

    async function loadMetricsMetadata() {
      try {
        const metricsMetadata = await fetchJson<MetricsMetadataResponse>("/api/metrics");
        if (!active) return;
        setMetricDefinitions(metricsMetadata.definitions ?? []);
      } catch {
        if (!active) return;
      }
    }

    void loadMetricsMetadata();
    return () => {
      active = false;
    };
  }, [metricDefinitions.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (loadingOptions || switchingClientId !== null) {
      setShowSlowLoadingScreen(false);
      return;
    }
    if (!loadingReport) {
      setShowSlowLoadingScreen(false);
      return;
    }

    const timer = window.setTimeout(() => setShowSlowLoadingScreen(true), 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadingOptions, loadingReport, switchingClientId]);

  useEffect(() => {
    if (!options || filtersInitialized) return;

    const restoredListingIds = restoredSelections?.listingIds?.filter((id) => allListingIds.includes(id));
    const restoredGroupTags = restoredSelections?.groupTags?.filter((value) =>
      allCustomGroups.some((group) => customGroupKey(group.label) === customGroupKey(value))
    );
    const restoredChannels = restoredSelections?.channels?.filter((value) => allChannels.includes(value));
    const restoredStatuses = restoredSelections?.statuses?.filter((value) => allStatuses.includes(value));

    setSelectedListingIds(restoredListingIds && restoredListingIds.length > 0 ? restoredListingIds : allListingIds);
    setSelectedGroupTags(restoredGroupTags && restoredGroupTags.length > 0 ? restoredGroupTags : []);
    setSelectedChannels(restoredChannels && restoredChannels.length > 0 ? restoredChannels : allChannels);
    setSelectedStatuses(restoredStatuses && restoredStatuses.length > 0 ? restoredStatuses : allStatuses);
    setFiltersInitialized(true);
  }, [allChannels, allCustomGroups, allListingIds, allStatuses, filtersInitialized, options, restoredSelections]);

  useEffect(() => {
    if (!filtersInitialized) return;
    if (activePropertyScope === "whole_property" && effectiveSelectedGroupTags.length === 0) return;
    setSelectedListingIds(listingFilterBaseIds);
  }, [activePropertyScope, effectiveSelectedGroupTags.length, filtersInitialized, listingFilterBaseIds]);

  useEffect(() => {
    if (typeof window === "undefined" || loadingOptions || !viewStateReady || !currentClientId) return;

    const navigationKey = `${pathname}:${tab}`;
    const previousNavigationKey = lastNavigationKeyRef.current;
    lastNavigationKeyRef.current = navigationKey;

    if (previousNavigationKey === null || previousNavigationKey === navigationKey) return;
    if (document.visibilityState !== "visible") return;
    if (backgroundSyncInFlightRef.current) return;

    const queueActivity = syncQueueActivity;
    if (queueActivity > 0) return;

    const lastQueuedAt = readLastAutoSyncQueuedAt(currentClientId);
    const lastSyncedAt = Date.parse(coreSyncTimestamp ?? "");
    const freshestKnownSyncAt = Math.max(lastQueuedAt, Number.isFinite(lastSyncedAt) ? lastSyncedAt : 0);

    if (freshestKnownSyncAt > 0 && Date.now() - freshestKnownSyncAt < SYNC_STALE_INTERVAL_MS) {
      return;
    }

    let cancelled = false;
    backgroundSyncInFlightRef.current = true;

    async function queueAutoSync() {
      try {
        const queuedAt = Date.now();
        await fetchJson("/api/sync/run", { method: "POST" });
        writeLastAutoSyncQueuedAt(currentClientId, queuedAt);
        const latestSync = await fetchJson<SyncStatusResponse>("/api/sync/status");
        if (!cancelled) {
          setSyncStatus(latestSync);
        }
      } catch (syncError) {
        console.error("Auto sync queue failed", syncError);
      } finally {
        backgroundSyncInFlightRef.current = false;
      }
    }

    void queueAutoSync();

    return () => {
      cancelled = true;
    };
  }, [coreSyncTimestamp, currentClientId, loadingOptions, pathname, syncQueueActivity, tab, viewStateReady]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentClientId || syncQueueActivity === 0) return;

    let cancelled = false;

    async function refreshSyncStatus() {
      try {
        const latestSync = await fetchJson<SyncStatusResponse>("/api/sync/status");
        if (!cancelled) {
          setSyncStatus(latestSync);
        }
      } catch {
        if (!cancelled) {
          // Keep the current view stable; we only need this poller to update the badge and queue state.
        }
      }
    }

    void refreshSyncStatus();
    const timer = window.setInterval(() => {
      void refreshSyncStatus();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentClientId, syncQueueActivity]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!viewStateReady || !filtersInitialized) return;

    const snapshot = buildPersistedSnapshot();
    const shareableSnapshot = buildShareableSnapshot();
    const shouldOmitView = Object.keys(shareableSnapshot).length === 1 && shareableSnapshot.tab === "overview";

    if (typeof window !== "undefined") {
      window.localStorage.setItem(PERSISTENCE_KEY, JSON.stringify(snapshot));
      const nextUrl = new URL(window.location.href);
      const currentViewParam = nextUrl.searchParams.get("view");
      const encoded = shouldOmitView ? null : encodeSnapshot(shareableSnapshot);
      if ((currentViewParam ?? null) === encoded) {
        return;
      }
      if (encoded) {
        nextUrl.searchParams.set("view", encoded);
      } else {
        nextUrl.searchParams.delete("view");
      }
      window.history.replaceState(window.history.state, "", `${nextUrl.pathname}?${nextUrl.searchParams.toString()}${nextUrl.hash}`);
      return;
    }
  }, [
    barMetric,
    bookWindowCustomMonth,
    bookWindowLineMetric,
    bookWindowLookbackDays,
    bookWindowMode,
    bookWindowRangeMode,
    bookedRangePreset,
    dateRanges,
    calendarSelectedMonthStart,
    deepDiveCompareMode,
    deepDiveGranularity,
    deepDiveSelectedMonth,
    deepDiveSelectedWeekIndex,
    deepDiveWeekWindowOffset,
    displayCurrency,
    filtersInitialized,
    filtersOpen,
    granularity,
    activeBeforeDateCustom,
    activePropertyScope,
    homeBookedCustomFrom,
    homeBookedCustomTo,
    homeBookedMetric,
    homeBookedWindow,
    homeStayedCustomFrom,
    homeStayedCustomTo,
    homeStayedMetric,
    homeStayedWindow,
    reservationsCustomFrom,
    reservationsCustomTo,
    reservationsRangePreset,
    includeFees,
    effectiveSelectedGroupTags,
    metricDateMode,
    metricIds,
    metricsBookingDateFrom,
    metricsBookingDateTo,
    metricsGranularity,
    metricsStayDateFrom,
    metricsStayDateTo,
    normalizedDefaultCurrency,
    paceCompareMode,
    selectedChannels,
    selectedListingIds,
    selectedStatuses,
    tab,
    viewStateReady
  ]);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    if (!options || !filtersInitialized || !displayCurrencyValid) return;
    if (!(tab === "pace" || tab === "sales" || tab === "booked")) return;

    let active = true;

    async function loadReport() {
      setLoadingReport(true);
      setError(null);

      try {
        const endpoint = tab === "pace" ? "/api/reports/pace" : tab === "sales" ? "/api/reports/sales" : "/api/reports/booked";
        const body = await fetchJson<ReportResponse>(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stayDateFrom: activeRange?.stayDateFrom,
            stayDateTo: activeRange?.stayDateTo,
            granularity,
            listingIds: requestListingIds,
            channels: requestChannels,
            statuses: requestStatuses,
            includeFees,
            ...(activeBeforeDate ? { activeBeforeDate } : {}),
            barMetric,
            compareMode: paceCompareMode,
            displayCurrency
          })
        });

        if (!active) return;
        setReport(body);
        setLoadingReport(false);
      } catch (reportError) {
        if (!active) return;
        setError(reportError instanceof Error ? reportError.message : "Failed to load report");
        setLoadingReport(false);
      }
    }

    void loadReport();
    return () => {
      active = false;
    };
  }, [
    activeRange?.stayDateFrom,
    activeRange?.stayDateTo,
    barMetric,
    displayCurrency,
    displayCurrencyValid,
    filtersInitialized,
    granularity,
    includeFees,
    activeBeforeDate,
    options,
    paceCompareMode,
    requestChannels,
    requestListingIds,
    requestStatuses,
    tab
  ]);

  useEffect(() => {
    if (!options || !filtersInitialized || !displayCurrencyValid || tab !== "booking_behaviour") return;

    let active = true;

    async function loadBookWindow() {
      setLoadingReport(true);
      setError(null);
      try {
        const body = await fetchJson<BookWindowReportResponse>("/api/reports/book-window", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: bookWindowMode,
            lookbackDays: bookWindowLookbackDays,
            ...(bookWindowRangeMode === "custom_month" && bookWindowCustomDateRange
              ? {
                  customDateFrom: bookWindowCustomDateRange.from,
                  customDateTo: bookWindowCustomDateRange.to
                }
              : {}),
            listingIds: requestListingIds,
            channels: requestChannels,
            statuses: requestStatuses,
            includeFees,
            displayCurrency
          })
        });

        if (!active) return;
        setBookWindowReport(body);
        setLoadingReport(false);
      } catch (reportError) {
        if (!active) return;
        setError(reportError instanceof Error ? reportError.message : "Failed to load booking windows");
        setLoadingReport(false);
      }
    }

    void loadBookWindow();
    return () => {
      active = false;
    };
  }, [
    bookWindowCustomDateRange,
    bookWindowLookbackDays,
    bookWindowMode,
    bookWindowRangeMode,
    displayCurrency,
    displayCurrencyValid,
    filtersInitialized,
    includeFees,
    options,
    requestChannels,
    requestListingIds,
    requestStatuses,
    tab
  ]);

  useEffect(() => {
    if (!options || !filtersInitialized || !displayCurrencyValid || !(tab === "overview" || tab === "property_groups")) return;
    if (tab === "property_groups" && !activePropertyGroupView) {
      setHomeDashboardReport(null);
      return;
    }

    let active = true;

    async function loadOverview() {
      setLoadingReport(true);
      setError(null);
      try {
        const [dashboard, syncData] = await Promise.all([
          fetchJson<HomeDashboardResponse>("/api/reports/home-dashboard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              listingIds: requestListingIds,
              channels: requestChannels,
              statuses: requestStatuses,
              includeFees,
              ...(activeBeforeDate ? { activeBeforeDate } : {}),
              bookedCustomDateFrom: homeBookedCustomFrom,
              bookedCustomDateTo: homeBookedCustomTo,
              stayedCustomDateFrom: homeStayedCustomFrom,
              stayedCustomDateTo: homeStayedCustomTo,
              focusFinderUseFilteredScope: false,
              displayCurrency
            })
          }),
          fetchJson<SyncStatusResponse>("/api/sync/status")
        ]);

        if (!active) return;
        setHomeDashboardReport(dashboard);
        setSyncStatus(syncData);
        setLoadingReport(false);
      } catch (reportError) {
        if (!active) return;
        setError(reportError instanceof Error ? reportError.message : "Failed to load overview");
        setLoadingReport(false);
      }
    }

    void loadOverview();
    return () => {
      active = false;
    };
  }, [
    displayCurrency,
    displayCurrencyValid,
    filtersInitialized,
    homeBookedCustomFrom,
    homeBookedCustomTo,
    homeStayedCustomFrom,
    homeStayedCustomTo,
    includeFees,
    activeBeforeDate,
    options,
    requestChannels,
    requestListingIds,
    requestStatuses,
    activePropertyGroupView,
    tab
  ]);

  useEffect(() => {
    if (!options || !filtersInitialized || !displayCurrencyValid || tab !== "reservations") return;

    let active = true;

    async function loadReservations() {
      setLoadingReport(true);
      setError(null);
      try {
        const body = await fetchJson<ReservationsReportResponse>("/api/reports/reservations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingDateFrom: reservationsDateRange.from,
            bookingDateTo: reservationsDateRange.to,
            listingIds: requestListingIds,
            channels: requestChannels,
            statuses: requestStatuses,
            includeFees,
            ...(activeBeforeDate ? { activeBeforeDate } : {}),
            displayCurrency
          })
        });

        if (!active) return;
        setReservationsReport(body);
        setLoadingReport(false);
      } catch (reportError) {
        if (!active) return;
        setError(reportError instanceof Error ? reportError.message : "Failed to load reservations");
        setLoadingReport(false);
      }
    }

    void loadReservations();
    return () => {
      active = false;
    };
  }, [
    activeBeforeDate,
    displayCurrency,
    displayCurrencyValid,
    filtersInitialized,
    includeFees,
    options,
    requestChannels,
    requestListingIds,
    requestStatuses,
    reservationsDateRange.from,
    reservationsDateRange.to,
    tab
  ]);

  useEffect(() => {
    if (!options || !filtersInitialized || !displayCurrencyValid || tab !== "property_drilldown") return;

    let active = true;

    async function loadDeepDive() {
      setLoadingReport(true);
      setError(null);
      try {
        const deepDiveBody = await fetchJson<PropertyDeepDiveResponse>("/api/reports/property-deep-dive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            granularity: deepDiveGranularity,
            compareMode: deepDiveCompareMode,
            selectedPeriodStart: deepDiveSelectedPeriodStart,
            listingIds: requestListingIds,
            channels: requestChannels,
            statuses: requestStatuses,
            includeFees,
            ...(activeBeforeDate ? { activeBeforeDate } : {}),
            displayCurrency
          })
        });

        if (!active) return;
        setDeepDiveReport(deepDiveBody);
        setLoadingReport(false);
      } catch (reportError) {
        if (!active) return;
        setError(reportError instanceof Error ? reportError.message : "Failed to load drilldown");
        setLoadingReport(false);
      }
    }

    void loadDeepDive();
    return () => {
      active = false;
    };
  }, [
    deepDiveCompareMode,
    deepDiveGranularity,
    deepDiveSelectedPeriodStart,
    displayCurrency,
    displayCurrencyValid,
    filtersInitialized,
    includeFees,
    activeBeforeDate,
    options,
    requestChannels,
    requestListingIds,
    requestStatuses,
    tab
  ]);

  useEffect(() => {
    if (!options || !filtersInitialized || !displayCurrencyValid || !calendarWorkspaceMode) return;
    if (calendarWorkspacePanel === "settings" && pricingCalendarReport) return;

    let active = true;
    const timeoutId = window.setTimeout(() => {
      setError(null);
      void loadCalendar();
    }, 120);

    async function loadCalendar() {
      try {
        const body = await loadCalendarReportRef.current?.();
        if (!body) return;
        if (!active) return;
        setPricingCalendarReport(body);
      } catch (reportError) {
        if (!active) return;
        setError(reportError instanceof Error ? reportError.message : "Failed to load calendar");
        setLoadingReport(false);
      }
    }

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    activeBeforeDate,
    calendarWorkspacePanel,
    displayCurrency,
    displayCurrencyValid,
    filtersInitialized,
    options,
    calendarPricingGroupName,
    pricingCalendarSelectedMonthStart,
    pricingCalendarReport,
    requestChannels,
    requestListingIds,
    requestStatuses,
    calendarWorkspaceMode
  ]);

  useEffect(() => {
    if (!options || !filtersInitialized || !displayCurrencyValid || tab !== "signal_lab" || metricIds.length === 0) return;

    let active = true;

    async function loadMetrics() {
      setLoadingReport(true);
      setError(null);
      try {
        const body = await fetchJson<MetricsResponse>("/api/metrics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            metricIds,
            filters: {
              dateMode: metricDateMode,
              stayDateFrom: metricsStayDateFrom,
              stayDateTo: metricsStayDateTo,
              bookingDateFrom: metricsBookingDateFrom,
              bookingDateTo: metricsBookingDateTo,
              granularity: metricsGranularity,
              listingIds: requestListingIds,
              channels: requestChannels,
              statuses: requestStatuses
            },
            displayCurrency
          })
        });

        if (!active) return;
        setMetricsReport(body);
        setLoadingReport(false);
      } catch (reportError) {
        if (!active) return;
        setError(reportError instanceof Error ? reportError.message : "Failed to load advanced metrics");
        setLoadingReport(false);
      }
    }

    void loadMetrics();
    return () => {
      active = false;
    };
  }, [
    displayCurrency,
    displayCurrencyValid,
    filtersInitialized,
    metricDateMode,
    metricIds,
    metricsBookingDateFrom,
    metricsBookingDateTo,
    metricsGranularity,
    metricsStayDateFrom,
    metricsStayDateTo,
    options,
    requestChannels,
    requestListingIds,
    requestStatuses,
    tab
  ]);

  const buildPersistedSnapshot = useCallback(
    (overrides: Partial<PersistedSnapshot> = {}): PersistedSnapshot => ({
      preserveDates: true,
      tab,
      includeFees,
      granularity,
      barMetric,
      paceCompareMode,
      activePropertyScope,
      activeBeforeDateCustom,
      bookedRangePreset,
      bookWindowRangeMode,
      bookWindowMode,
      bookWindowLookbackDays,
      bookWindowCustomMonth,
      bookWindowLineMetric,
      deepDiveGranularity,
      deepDiveCompareMode,
      deepDiveSelectedMonth,
      calendarSelectedMonthStart,
      deepDiveWeekWindowOffset,
      deepDiveSelectedWeekIndex,
      homeBookedMetric,
      homeBookedWindow,
      homeStayedMetric,
      homeStayedWindow,
      homeBookedCustomFrom,
      homeBookedCustomTo,
      homeStayedCustomFrom,
      homeStayedCustomTo,
      reservationsRangePreset,
      reservationsCustomFrom,
      reservationsCustomTo,
      displayCurrency: normalizeCurrencyCode(displayCurrency) || normalizedDefaultCurrency,
      dateRanges,
      selectedListingIds,
      selectedGroupTags: effectiveSelectedGroupTags,
      selectedChannels,
      selectedStatuses,
      filtersOpen,
      metricIds,
      metricDateMode,
      metricsGranularity,
      metricsStayDateFrom,
      metricsStayDateTo,
      metricsBookingDateFrom,
      metricsBookingDateTo,
      ...overrides
    }),
    [
      activeBeforeDateCustom,
      activePropertyScope,
      barMetric,
      bookWindowCustomMonth,
      bookWindowLineMetric,
      bookWindowLookbackDays,
      bookWindowMode,
      bookWindowRangeMode,
      bookedRangePreset,
      calendarSelectedMonthStart,
      dateRanges,
      deepDiveCompareMode,
      deepDiveGranularity,
      deepDiveSelectedMonth,
      deepDiveSelectedWeekIndex,
      deepDiveWeekWindowOffset,
      displayCurrency,
      effectiveSelectedGroupTags,
      filtersOpen,
      granularity,
      homeBookedCustomFrom,
      homeBookedCustomTo,
      homeBookedMetric,
      homeBookedWindow,
      homeStayedCustomFrom,
      homeStayedCustomTo,
      homeStayedMetric,
      homeStayedWindow,
      includeFees,
      metricDateMode,
      metricIds,
      metricsBookingDateFrom,
      metricsBookingDateTo,
      metricsGranularity,
      metricsStayDateFrom,
      metricsStayDateTo,
      normalizedDefaultCurrency,
      paceCompareMode,
      reservationsCustomFrom,
      reservationsCustomTo,
      reservationsRangePreset,
      selectedChannels,
      selectedListingIds,
      selectedStatuses,
      tab
    ]
  );

  function openCalendarWorkspace(overrides: Partial<PersistedSnapshot> = {}) {
    if (typeof window === "undefined") return;

    const snapshot = buildShareableSnapshot({
      tab: "calendar",
      filtersOpen: false,
      ...overrides
    });
    const href = buildDashboardViewHref("calendar", encodeSnapshot(snapshot));
    const workspaceUrl = new URL(href, window.location.origin);
    workspaceUrl.searchParams.set("calendarWorkspace", "1");

    const opened = window.open(workspaceUrl.toString(), "_blank", "noopener,noreferrer");
    if (!opened) {
      setError("Your browser blocked the new tab. Allow pop-ups for this site to open Calendar in a separate workspace.");
      return;
    }

    setBanner("Calendar workspace opened in a new tab.");
  }

  function openDashboardTab(nextTab: TabId) {
    setMobileSidebarOpen(false);
    if (nextTab === tab) return;

    if (nextTab === "calendar" && !calendarWorkspaceMode) {
      openCalendarWorkspace();
      return;
    }

    const requiredScope = syncScopeForDashboardTab(nextTab);
    if (
      !isSyncScopeFresh({
        scope: requiredScope,
        coreLastSyncAt: coreSyncTimestamp,
        extendedLastSyncAt: extendedSyncTimestamp
      })
    ) {
      if (typeof window !== "undefined") {
        window.location.replace(
          buildClientOpenHref(currentClientName, {
            tab: nextTab,
            scope: requiredScope
          })
        );
      }
      return;
    }

    setTab(nextTab);
  }

  function openSignalDrivenPaceView(params: {
    granularity: Extract<Granularity, "week" | "month">;
    stayDateFrom: string;
    stayDateTo: string;
    compareMode: PaceCompareMode;
    activeScope?: ActivePropertyScope;
  }) {
    const nextDateRanges = {
      ...dateRanges,
      pace: {
        stayDateFrom: params.stayDateFrom,
        stayDateTo: params.stayDateTo
      }
    };
    const nextActiveScope = params.activeScope ?? "active_12_months";
    const nextSnapshot = buildPersistedSnapshot({
      tab: "pace",
      granularity: params.granularity,
      paceCompareMode: params.compareMode,
      activePropertyScope: nextActiveScope,
      dateRanges: nextDateRanges
    });
    const requiredScope = syncScopeForDashboardTab("pace");

    if (
      !isSyncScopeFresh({
        scope: requiredScope,
        coreLastSyncAt: coreSyncTimestamp,
        extendedLastSyncAt: extendedSyncTimestamp
      })
    ) {
      if (typeof window !== "undefined") {
        window.location.replace(
          buildClientOpenHref(currentClientName, {
            tab: "pace",
            scope: requiredScope,
            view: encodeSnapshot(nextSnapshot)
          })
        );
      }
      return;
    }

    setGranularity(params.granularity);
    setPaceCompareMode(params.compareMode);
    setActivePropertyScope(nextActiveScope);
    setDateRanges(nextDateRanges);
    setTab("pace");
  }

  async function handleSwitchClient(tenantId: string) {
    if (!tenantId || tenantId === currentClientId) return;
    const nextClient = clientOptions.find((client) => client.id === tenantId);
    setMobileSidebarOpen(false);
    setSwitchingClientId(tenantId);
    setPendingClientName(nextClient?.name ?? "client");
    setError(null);

    try {
      await fetchJson("/api/tenants/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId })
      });
      if (typeof window !== "undefined") {
        window.location.replace(
          buildClientOpenHref(nextClient?.name ?? "client", {
            tab: "overview",
            scope: "core"
          })
        );
      }
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : "Failed to switch client");
      setSwitchingClientId(null);
      setPendingClientName(null);
    }
  }

  async function handleRefreshSync() {
    if (!currentClientId || syncRefreshDisabled) return;

    setQueueingManualSync(true);
    setError(null);
    setBanner(null);

    try {
      const queuedAt = Date.now();
      await fetchJson("/api/sync/run", { method: "POST" });
      writeLastAutoSyncQueuedAt(currentClientId, queuedAt);
      const latestSync = await fetchJson<SyncStatusResponse>("/api/sync/status");
      setSyncStatus(latestSync);
      setBanner("Refresh sync queued. The current tab stays in place while the latest data catches up.");
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Failed to queue refresh sync");
    } finally {
      setQueueingManualSync(false);
    }
  }

  async function handleRefreshMarketData() {
    if (!allowLiveMarketRefresh || !options || !filtersInitialized || !displayCurrencyValid || !calendarWorkspaceMode || refreshingMarketData) return;

    setRefreshingMarketData(true);
    setError(null);
    setBanner(null);

    try {
      calendarReportClientCacheRef.current.clear();
      const body = await loadCalendarReport({ forceMarketRefresh: true, ignoreClientCache: true });
      setPricingCalendarReport(body);
      setBanner("Market snapshot refreshed and stored for future calendar loads.");
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : "Failed to refresh market data");
    } finally {
      setRefreshingMarketData(false);
    }
  }

  async function resolveAttentionTask(listingId: string, reasonKeys: string[], action: "complete" | "ignore") {
    if (!listingId || reasonKeys.length === 0) return;
    setResolvingAttentionListingId(listingId);
    setError(null);

    try {
      await fetchJson("/api/reports/attention-tasks/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId, reasonKeys, action })
      });

      setHomeDashboardReport((current) => {
        if (!current) return current;
        return {
          ...current,
          propertyDetective: current.propertyDetective.filter((row) => row.listingId !== listingId)
        };
      });
      setBanner(action === "complete" ? "Signal marked as reviewed for 7 days." : "Signal muted for 7 days.");
    } catch (attentionError) {
      setError(attentionError instanceof Error ? attentionError.message : "Failed to update signal");
    } finally {
      setResolvingAttentionListingId(null);
    }
  }

  async function handleLogout() {
    setMobileSidebarOpen(false);
    await fetch(withBasePath("/api/auth/logout"), { method: "POST" });
    startTransition(() => {
      router.replace("/login");
      router.refresh();
    });
  }

  function handleCurrencySelectionChange(value: string) {
    setSelectedCurrencyOption(value);
    if (value === OTHER_CURRENCY_OPTION) {
      if (!customCurrencyCode) {
        setCustomCurrencyCode(displayCurrency);
      }
      return;
    }
    setCustomCurrencyCode(value);
  }

  function updateHomeMetric(value: HomeMetric) {
    setHomeBookedMetric(value);
    setHomeStayedMetric(value);
  }

  function updateHomeWindow(value: HomeWindow) {
    setHomeBookedWindow(value);
    setHomeStayedWindow(value);
  }

  function updateHomeCustomFrom(value: string) {
    setHomeBookedCustomFrom(value);
    setHomeStayedCustomFrom(value);
  }

  function updateHomeCustomTo(value: string) {
    setHomeBookedCustomTo(value);
    setHomeStayedCustomTo(value);
  }

  function applyReservationsPreset(value: ReservationsRangePreset) {
    setReservationsRangePreset(value);

    if (value === "custom") {
      return;
    }

    const today = toDateOnly(new Date());
    if (value === "today") {
      setReservationsCustomFrom(today);
      setReservationsCustomTo(today);
      return;
    }

    if (value === "yesterday") {
      const yesterday = toDateOnly(addUtcDays(dateOnlyToDate(today), -1));
      setReservationsCustomFrom(yesterday);
      setReservationsCustomTo(yesterday);
      return;
    }

    if (value === "last_7_days") {
      setReservationsCustomFrom(toDateOnly(addUtcDays(dateOnlyToDate(today), -6)));
      setReservationsCustomTo(today);
      return;
    }

    const thisMonthStart = `${dateOnlyToDate(today).getUTCFullYear()}-${String(dateOnlyToDate(today).getUTCMonth() + 1).padStart(2, "0")}-01`;
    setReservationsCustomFrom(thisMonthStart);
    setReservationsCustomTo(today);
  }

  function applyBookedPreset(preset: BookedRangePreset) {
    const today = new Date(`${toDateOnly(new Date())}T00:00:00Z`);
    let from = dateRanges.booked.stayDateFrom;
    let to = dateRanges.booked.stayDateTo;

    if (preset === "last_day") {
      from = toDateOnly(today);
      to = toDateOnly(today);
    } else if (preset === "last_7_days") {
      from = toDateOnly(addUtcDays(today, -6));
      to = toDateOnly(today);
    } else if (preset === "last_30_days") {
      from = toDateOnly(addUtcDays(today, -29));
      to = toDateOnly(today);
    } else if (preset === "last_90_days") {
      from = toDateOnly(addUtcDays(today, -89));
      to = toDateOnly(today);
    } else if (preset === "last_year") {
      from = toDateOnly(addUtcDays(today, -364));
      to = toDateOnly(today);
    }

    setBookedRangePreset(preset);
    if (preset !== "custom") {
      setDateRanges((current) => ({
        ...current,
        booked: {
          stayDateFrom: from,
          stayDateTo: to
        }
      }));
    }
  }

  function jumpToFullSignalList() {
    if (typeof document === "undefined") return;
    document.getElementById("signal-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openSaveCurrentViewDialog() {
    setSaveViewNameDraft(`${tabLabel(tab)} view`);
    setSaveViewDialogOpen(true);
  }

  const buildShareableSnapshot = useCallback(
    (overrides: Partial<PersistedSnapshot> = {}): Partial<PersistedSnapshot> => {
      const snapshot = buildPersistedSnapshot(overrides);
      const shareable: Partial<PersistedSnapshot> = { tab: snapshot.tab };

      if (!snapshot.includeFees) shareable.includeFees = snapshot.includeFees;
      if (snapshot.granularity !== "month") shareable.granularity = snapshot.granularity;
      if (snapshot.barMetric !== "revenue") shareable.barMetric = snapshot.barMetric;
      if (snapshot.paceCompareMode !== "yoy_otb") shareable.paceCompareMode = snapshot.paceCompareMode;
      if (snapshot.activePropertyScope && snapshot.activePropertyScope !== "whole_property") {
        shareable.activePropertyScope = snapshot.activePropertyScope;
      }
      if (snapshot.activePropertyScope === "custom_date" && snapshot.activeBeforeDateCustom !== initialActiveBeforeDateCustom) {
        shareable.activeBeforeDateCustom = snapshot.activeBeforeDateCustom;
      }
      if (snapshot.bookedRangePreset && snapshot.bookedRangePreset !== "last_90_days") shareable.bookedRangePreset = snapshot.bookedRangePreset;
      if (snapshot.bookWindowMode !== "booked") shareable.bookWindowMode = snapshot.bookWindowMode;
      if (snapshot.bookWindowRangeMode === "custom_month") {
        shareable.bookWindowRangeMode = snapshot.bookWindowRangeMode;
        shareable.bookWindowCustomMonth = snapshot.bookWindowCustomMonth;
      } else if (snapshot.bookWindowLookbackDays !== 30) {
        shareable.bookWindowLookbackDays = snapshot.bookWindowLookbackDays;
      }
      if (snapshot.bookWindowLineMetric !== "adr") shareable.bookWindowLineMetric = snapshot.bookWindowLineMetric;
      if (snapshot.deepDiveGranularity !== "month") shareable.deepDiveGranularity = snapshot.deepDiveGranularity;
      if (snapshot.deepDiveCompareMode !== "yoy_otb") shareable.deepDiveCompareMode = snapshot.deepDiveCompareMode;
      if (snapshot.deepDiveSelectedMonth !== new Date().getUTCMonth() + 1) shareable.deepDiveSelectedMonth = snapshot.deepDiveSelectedMonth;
      if (snapshot.calendarSelectedMonthStart !== defaultCalendarMonthStart) shareable.calendarSelectedMonthStart = snapshot.calendarSelectedMonthStart;
      if (snapshot.deepDiveWeekWindowOffset !== 0) shareable.deepDiveWeekWindowOffset = snapshot.deepDiveWeekWindowOffset;
      if (snapshot.deepDiveSelectedWeekIndex !== 2) shareable.deepDiveSelectedWeekIndex = snapshot.deepDiveSelectedWeekIndex;
      if (snapshot.homeBookedMetric !== "revenue") {
        shareable.homeBookedMetric = snapshot.homeBookedMetric;
        shareable.homeStayedMetric = snapshot.homeStayedMetric;
      }
      if (snapshot.homeBookedWindow !== "this_month") {
        shareable.homeBookedWindow = snapshot.homeBookedWindow;
        shareable.homeStayedWindow = snapshot.homeStayedWindow;
      }
      if (snapshot.homeBookedWindow === "custom") {
        shareable.homeBookedCustomFrom = snapshot.homeBookedCustomFrom;
        shareable.homeBookedCustomTo = snapshot.homeBookedCustomTo;
        shareable.homeStayedCustomFrom = snapshot.homeStayedCustomFrom;
        shareable.homeStayedCustomTo = snapshot.homeStayedCustomTo;
      }
      if (snapshot.reservationsRangePreset !== "today") shareable.reservationsRangePreset = snapshot.reservationsRangePreset;
      if (snapshot.reservationsRangePreset === "custom") {
        shareable.reservationsCustomFrom = snapshot.reservationsCustomFrom;
        shareable.reservationsCustomTo = snapshot.reservationsCustomTo;
      }
      if ((snapshot.displayCurrency ?? normalizedDefaultCurrency) !== normalizedDefaultCurrency) {
        shareable.displayCurrency = snapshot.displayCurrency;
      }
      if (JSON.stringify(snapshot.dateRanges) !== JSON.stringify(initialRanges)) shareable.dateRanges = snapshot.dateRanges;
      if (snapshot.selectedGroupTags && snapshot.selectedGroupTags.length > 0) shareable.selectedGroupTags = snapshot.selectedGroupTags;
      if (!isAllSelected(snapshot.selectedListingIds, listingFilterBaseIds)) shareable.selectedListingIds = snapshot.selectedListingIds;
      if (!isAllSelected(snapshot.selectedChannels, allChannels)) shareable.selectedChannels = snapshot.selectedChannels;
      if (!isAllSelected(snapshot.selectedStatuses, allStatuses)) shareable.selectedStatuses = snapshot.selectedStatuses;

      return shareable;
    },
    [
      allChannels,
      allStatuses,
      buildPersistedSnapshot,
      defaultCalendarMonthStart,
      initialActiveBeforeDateCustom,
      initialRanges,
      listingFilterBaseIds,
      normalizedDefaultCurrency
    ]
  );

  function buildShareUrl(overrides: Partial<PersistedSnapshot> = {}): string | null {
    if (typeof window === "undefined") return null;

    const shareableSnapshot = buildShareableSnapshot(overrides);
    const nextUrl = new URL(window.location.href);
    const shouldOmitView = Object.keys(shareableSnapshot).length === 1 && shareableSnapshot.tab === "overview";

    if (shouldOmitView) {
      nextUrl.searchParams.delete("view");
    } else {
      nextUrl.searchParams.set("view", encodeSnapshot(shareableSnapshot));
    }

    return nextUrl.toString();
  }

  function confirmSaveCurrentView() {
    const name = saveViewNameDraft.trim();
    if (!name) return;

    const snapshot = buildPersistedSnapshot();

    const nextSavedViews = [
      {
        id: `${Date.now()}`,
        name,
        encoded: encodeSnapshot(snapshot),
        updatedAt: new Date().toISOString()
      },
      ...savedViews.filter((view) => view.name.toLowerCase() !== name.toLowerCase())
    ].slice(0, 10);

    setSavedViews(nextSavedViews);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(nextSavedViews));
    }
    setBanner(`Saved view "${name}".`);
    setSaveViewDialogOpen(false);
  }

  async function copyShareLink() {
    const shareUrl = buildShareUrl();
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setBanner("Share link copied.");
  }

  function applySavedView(encoded: string) {
    if (typeof window === "undefined") return;
    window.location.assign(buildDashboardViewHref(tab, encoded));
  }

  function isBusinessReviewTab(targetTab: TabId): targetTab is BusinessReviewTab {
    return (
      targetTab === "pace" ||
      targetTab === "sales" ||
      targetTab === "booked" ||
      targetTab === "booking_behaviour" ||
      targetTab === "property_drilldown"
    );
  }

  function businessReviewReportLabel(targetTab: BusinessReviewTab): string {
    switch (targetTab) {
      case "pace":
        return "Pace Report";
      case "sales":
        return "Sales Report";
      case "booked":
        return "Booked Report";
      case "booking_behaviour":
        return "Booking Window Report";
      case "property_drilldown":
        return "Property Drilldown";
    }
  }

  function buildBusinessReviewTitle(targetTab: BusinessReviewTab): string {
    const reportLabel = businessReviewReportLabel(targetTab);
    const includedChannels = requestChannels.length === 0 ? allChannels : cleanLabelList(selectedChannels.map((channel) => formatChannelLabel(channel)));
    const allChannelLabels = cleanLabelList(allChannels.map((channel) => formatChannelLabel(channel)));
    const excludedChannels = allChannelLabels.filter((channel) => !includedChannels.includes(channel));

    if (activePropertyGroupView) {
      return `${currentClientName} x ${reportLabel}: "${activePropertyGroupView}"`;
    }

    if (effectiveSelectedGroupTags.length === 1) {
      return `${currentClientName} x ${reportLabel}: "${effectiveSelectedGroupTags[0]}"`;
    }

    if (excludedChannels.length === 1 && excludedChannels[0] === "Direct") {
      return `${currentClientName} x ${reportLabel} without Direct bookings`;
    }

    if (requestListingIds.length > 0 && !requestListingIds.includes(NO_LISTING_MATCH_ID) && requestListingIds.length < allListingIds.length) {
      return `${currentClientName} x ${reportLabel} Selected Properties`;
    }

    return `${currentClientName} x ${reportLabel} Whole Portfolio`;
  }

  function buildBusinessReviewTables(targetTab: BusinessReviewTab): BusinessReviewTable[] {
    if ((targetTab === "pace" || targetTab === "sales" || targetTab === "booked") && report && tableRows.length > 0) {
      return [
        {
          title: "Detailed view",
          headers: [
            "Bucket",
            `Roomnights ${currentSeriesLabel.toLowerCase()}`,
            `Roomnights ${lastYearSeriesLabel.toLowerCase()}`,
            `Revenue ${currentSeriesLabel.toLowerCase()}`,
            `Revenue ${lastYearSeriesLabel.toLowerCase()}`,
            targetTab === "sales" ? "ADR" : `ADR ${currentSeriesLabel.toLowerCase()}`,
            targetTab === "sales" ? "ADR previous year" : `ADR ${lastYearSeriesLabel.toLowerCase()}`
          ],
          rows: tableRows.map((row) => [
            row.bucketLabel,
            formatInteger(row.currentNights),
            formatInteger(row.lastYearNights),
            formatCurrency(row.currentRevenue, report.meta.displayCurrency),
            formatCurrency(row.lastYearRevenue, report.meta.displayCurrency),
            formatCurrency(row.currentAdr, report.meta.displayCurrency),
            formatCurrency(row.lastYearAdr, report.meta.displayCurrency)
          ])
        }
      ];
    }

    if (targetTab === "booking_behaviour" && bookWindowReport) {
      return [
        {
          title: "Detailed view",
          headers: ["Book Window", "Nights", "Nights %", "Reservations", "Cancelled", "Cancellation %", "ADR", "Avg LOS"],
          rows: bookWindowReport.buckets.map((bucket) => [
            bucket.label,
            formatInteger(bucket.nights),
            `${bucket.nightsPct.toFixed(1)}%`,
            formatInteger(bucket.reservations),
            formatInteger(bucket.cancelledReservations),
            `${bucket.cancellationPct.toFixed(1)}%`,
            formatCurrency(bucket.adr, bookWindowReport.meta.displayCurrency),
            bucket.avgLos.toFixed(2)
          ])
        }
      ];
    }

    if (targetTab === "property_drilldown" && deepDiveReport) {
      return [
        {
          title: `Detailed view${deepDiveReport.period?.label ? ` · ${deepDiveReport.period.label}` : ""}`,
          headers: ["Property", "Pace Status", "Revenue", "Revenue vs LY", "ADR", "ADR vs LY", "Occupancy", "Occupancy vs LY", "Live Rate"],
          rows: deepDiveReport.rows.map((row) => [
            row.listingName,
            row.health === "behind" ? "Behind" : row.health === "ahead" ? "Ahead" : "On pace",
            formatCurrency(row.current.revenue, deepDiveReport.meta.displayCurrency),
            formatSignedPercent(row.delta.revenuePct),
            formatCurrency(row.current.adr, deepDiveReport.meta.displayCurrency),
            formatSignedPercent(row.delta.adrPct),
            formatPercent(row.current.occupancy),
            formatSignedPoints(row.delta.occupancyPts),
            row.liveRate !== null ? formatCurrency(row.liveRate, deepDiveReport.meta.displayCurrency) : "—"
          ])
        }
      ];
    }

    return [];
  }

  function buildCurrentCsvPayload(targetTab: BusinessReviewTab): { filename: string; headers: string[]; rows: Array<Array<string | number | null>> } | null {
    const title = buildBusinessReviewTitle(targetTab);

    if ((targetTab === "pace" || targetTab === "sales" || targetTab === "booked") && report && tableRows.length > 0) {
      return {
        filename: title,
        headers: [
          "Bucket",
          `Roomnights ${currentSeriesLabel.toLowerCase()}`,
          `Roomnights ${lastYearSeriesLabel.toLowerCase()}`,
          `Revenue ${currentSeriesLabel.toLowerCase()}`,
          `Revenue ${lastYearSeriesLabel.toLowerCase()}`,
          targetTab === "sales" ? "ADR" : `ADR ${currentSeriesLabel.toLowerCase()}`,
          targetTab === "sales" ? "ADR previous year" : `ADR ${lastYearSeriesLabel.toLowerCase()}`
        ],
        rows: tableRows.map((row) => [
          row.bucketLabel,
          row.currentNights,
          row.lastYearNights,
          row.currentRevenue,
          row.lastYearRevenue,
          row.currentAdr,
          row.lastYearAdr
        ])
      };
    }

    if (targetTab === "booking_behaviour" && bookWindowReport) {
      return {
        filename: title,
        headers: ["Book Window", "Nights", "Nights %", "Reservations", "Cancelled", "Cancellation %", "ADR", "Avg LOS"],
        rows: bookWindowReport.buckets.map((bucket) => [
          bucket.label,
          bucket.nights,
          bucket.nightsPct,
          bucket.reservations,
          bucket.cancelledReservations,
          bucket.cancellationPct,
          bucket.adr,
          bucket.avgLos
        ])
      };
    }

    if (targetTab === "property_drilldown" && deepDiveReport) {
      return {
        filename: title,
        headers: ["Property", "Pace Status", "Revenue", "Revenue vs LY %", "ADR", "ADR vs LY %", "Occupancy %", "Occupancy vs LY pts", "Live Rate"],
        rows: deepDiveReport.rows.map((row) => [
          row.listingName,
          row.health === "behind" ? "Behind" : row.health === "ahead" ? "Ahead" : "On pace",
          row.current.revenue,
          row.delta.revenuePct,
          row.current.adr,
          row.delta.adrPct,
          row.current.occupancy,
          row.delta.occupancyPts,
          row.liveRate
        ])
      };
    }

    return null;
  }

  function currentBusinessReviewCaptureNode(targetTab: BusinessReviewTab): HTMLElement | null {
    if (targetTab === "booking_behaviour") {
      return bookWindowChartCaptureRef.current;
    }
    if (targetTab === "property_drilldown") {
      return deepDiveCaptureRef.current;
    }
    return reportChartCaptureRef.current;
  }

  async function captureBusinessReviewSection(targetTab: BusinessReviewTab): Promise<BusinessReviewSection> {
    const tables = buildBusinessReviewTables(targetTab);
    if (tables.length === 0) {
      throw new Error(`No ${businessReviewReportLabel(targetTab).toLowerCase()} data is ready to export.`);
    }

    const captureNode = currentBusinessReviewCaptureNode(targetTab);
    let chartImageDataUrl: string | null = null;

    if (captureNode) {
      const { toPng } = await import("html-to-image");
      chartImageDataUrl = await toPng(captureNode, {
        cacheBust: true,
        backgroundColor: "#fbf8f1",
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2)
      });
    }

    return {
      id: `${targetTab}-${Date.now()}`,
      title: buildBusinessReviewTitle(targetTab),
      subtitle: `${buildPowerPointFilterContextNarrative()} · ${formatDisplayTimestamp(new Date().toISOString())}`,
      filters: buildPowerPointFilterSummary(),
      chartImageDataUrl,
      tables
    };
  }

  async function addCurrentViewToBusinessReview() {
    if (!isBusinessReviewTab(tab) || addingCurrentViewToBusinessReview) return;

    setAddingCurrentViewToBusinessReview(true);
    setError(null);
    setBanner(null);

    try {
      const section = await captureBusinessReviewSection(tab);
      setBusinessReviewSections((current) => [...current, section]);
      setBanner(`Added ${businessReviewReportLabel(tab)} to the business review.`);
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "Failed to add this report to the business review");
    } finally {
      setAddingCurrentViewToBusinessReview(false);
    }
  }

  function removeBusinessReviewSection(id: string) {
    setBusinessReviewSections((current) => current.filter((section) => section.id !== id));
  }

  async function handleExportBusinessReview() {
    if (exportingBusinessReview) return;

    setExportingBusinessReview(true);
    setError(null);
    setBanner(null);

    try {
      const sections = businessReviewSections;
      if (sections.length === 0) {
        throw new Error("Add at least one report before downloading the business review.");
      }

      let brandImageDataUrl: string | null = null;
      if (typeof window !== "undefined") {
        try {
          brandImageDataUrl = await businessReviewUrlToDataUrl(new URL(withBasePath("/logo.jpg"), window.location.origin).toString());
        } catch {
          brandImageDataUrl = null;
        }
      }

      await exportBusinessReviewPdf({
        clientName: currentClientName,
        sections,
        generatedAtLabel: formatDisplayTimestamp(new Date().toISOString()),
        brandImageDataUrl,
        filename: `${currentClientName} business review`
      });

      setBanner(`Downloaded business review with ${formatInteger(sections.length)} report section${sections.length === 1 ? "" : "s"}.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Failed to export business review");
    } finally {
      setExportingBusinessReview(false);
    }
  }

  async function handleDownloadCurrentReportPdf() {
    if (!isBusinessReviewTab(tab) || exportingCurrentReportPdf) return;

    setExportingCurrentReportPdf(true);
    setError(null);
    setBanner(null);

    try {
      const section = await captureBusinessReviewSection(tab);
      let brandImageDataUrl: string | null = null;
      if (typeof window !== "undefined") {
        try {
          brandImageDataUrl = await businessReviewUrlToDataUrl(new URL(withBasePath("/logo.jpg"), window.location.origin).toString());
        } catch {
          brandImageDataUrl = null;
        }
      }

      await exportBusinessReviewPdf({
        clientName: currentClientName,
        sections: [section],
        generatedAtLabel: formatDisplayTimestamp(new Date().toISOString()),
        brandImageDataUrl,
        filename: buildBusinessReviewTitle(tab)
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Failed to export PDF");
    } finally {
      setExportingCurrentReportPdf(false);
    }
  }

  function handleDownloadCurrentCsv() {
    if (!isBusinessReviewTab(tab) || exportingCurrentCsv) return;

    setExportingCurrentCsv(true);
    setError(null);
    setBanner(null);

    try {
      const payload = buildCurrentCsvPayload(tab);
      if (!payload) {
        throw new Error("No detailed view is ready to export as CSV.");
      }

      downloadCsv(payload);
    } catch (csvError) {
      setError(csvError instanceof Error ? csvError.message : "Failed to export CSV");
    } finally {
      setExportingCurrentCsv(false);
    }
  }

  async function fetchDeepDiveReportsForExport(selectedMonthStarts: string[]) {
    const uniqueMonths = [...new Set(selectedMonthStarts)];
    if (uniqueMonths.length === 0) {
      return [];
    }

    return Promise.all(
      uniqueMonths.map((selectedPeriodStart) =>
        fetchJson<PropertyDeepDiveResponse>("/api/reports/property-deep-dive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            granularity: "month",
            compareMode: deepDiveCompareMode,
            selectedPeriodStart,
            listingIds: requestListingIds,
            channels: requestChannels,
            statuses: requestStatuses,
            includeFees,
            ...(activeBeforeDate ? { activeBeforeDate } : {}),
            displayCurrency
          })
        })
      )
    );
  }

  async function handleDownloadDeepDiveExport(format: "csv" | "pdf") {
    if (deepDiveGranularity !== "month" || tab !== "property_drilldown") {
      if (format === "csv") {
        handleDownloadCurrentCsv();
      } else {
        await handleDownloadCurrentReportPdf();
      }
      return;
    }

    const selectedMonths = deepDiveExportMonths.length > 0 ? deepDiveExportMonths : [deepDiveSelectedPeriodStart];
    if (format === "pdf") {
      setExportingCurrentReportPdf(true);
    } else {
      setExportingCurrentCsv(true);
    }
    setError(null);
    setBanner(null);

    try {
      const reports = await fetchDeepDiveReportsForExport(selectedMonths);
      if (reports.length === 0) {
        throw new Error("Select at least one month to export.");
      }

      if (format === "csv") {
        downloadCsv({
          filename: `${buildBusinessReviewTitle("property_drilldown")} multi-month`,
          headers: ["Period", "Property", "Pace Status", "Revenue", "Revenue vs LY %", "ADR", "ADR vs LY %", "Occupancy %", "Occupancy vs LY pts", "Live Rate"],
          rows: reports.flatMap((reportItem) =>
            reportItem.rows.map((row) => [
              reportItem.period.label,
              row.listingName,
              row.health === "behind" ? "Behind" : row.health === "ahead" ? "Ahead" : "On pace",
              row.current.revenue,
              row.delta.revenuePct,
              row.current.adr,
              row.delta.adrPct,
              row.current.occupancy,
              row.delta.occupancyPts,
              row.liveRate
            ])
          )
        });
        return;
      }

      let brandImageDataUrl: string | null = null;
      if (typeof window !== "undefined") {
        try {
          brandImageDataUrl = await businessReviewUrlToDataUrl(new URL(withBasePath("/logo.jpg"), window.location.origin).toString());
        } catch {
          brandImageDataUrl = null;
        }
      }

      await exportBusinessReviewPdf({
        clientName: currentClientName,
        sections: reports.map((reportItem) => ({
          id: `deep-dive-${reportItem.period.start}`,
          title: `${buildBusinessReviewTitle("property_drilldown")} · ${reportItem.period.label}`,
          subtitle: `${buildPowerPointFilterContextNarrative()} · ${formatDisplayTimestamp(new Date().toISOString())}`,
          filters: buildPowerPointFilterSummary(),
          chartImageDataUrl: null,
          tables: [
            {
              title: "Detailed view",
              headers: ["Property", "Pace Status", "Revenue", "Revenue vs LY", "ADR", "ADR vs LY", "Occupancy", "Occupancy vs LY", "Live Rate"],
              rows: reportItem.rows.map((row) => [
                row.listingName,
                row.health === "behind" ? "Behind" : row.health === "ahead" ? "Ahead" : "On pace",
                formatCurrency(row.current.revenue, reportItem.meta.displayCurrency),
                formatSignedPercent(row.delta.revenuePct),
                formatCurrency(row.current.adr, reportItem.meta.displayCurrency),
                formatSignedPercent(row.delta.adrPct),
                formatPercent(row.current.occupancy),
                formatSignedPoints(row.delta.occupancyPts),
                row.liveRate !== null ? formatCurrency(row.liveRate, reportItem.meta.displayCurrency) : "—"
              ])
            }
          ]
        })),
        generatedAtLabel: formatDisplayTimestamp(new Date().toISOString()),
        brandImageDataUrl,
        filename: `${buildBusinessReviewTitle("property_drilldown")} multi-month`
      });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : `Failed to export ${format.toUpperCase()}`);
    } finally {
      if (format === "pdf") {
        setExportingCurrentReportPdf(false);
      } else {
        setExportingCurrentCsv(false);
      }
    }
  }

  function togglePowerPointChecklistItem(id: string) {
    setPowerPointChecklist((current) =>
      current.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
    );
  }

  function updatePowerPointChecklistText(id: string, text: string) {
    setPowerPointChecklist((current) =>
      current.map((item) => (item.id === id ? { ...item, text } : item))
    );
  }

  function addPowerPointChecklistItem() {
    const nextItem: PowerPointChecklistItem = {
      id: `ppt-check-${Date.now()}`,
      text: "Add a review point for this client deck.",
      done: false
    };
    setPowerPointChecklist((current) => [...current, nextItem]);
    setPowerPointPanelOpen(true);
  }

  function removePowerPointChecklistItem(id: string) {
    setPowerPointChecklist((current) => current.filter((item) => item.id !== id));
  }

  function removePowerPointSlide(id: string) {
    setPowerPointSlides((current) => current.filter((slide) => slide.id !== id));
  }

  function clearPowerPointDeck() {
    setPowerPointSlides([]);
  }

  function effectiveListingSelectionForSummary() {
    const effectiveIds =
      requestListingIds.length === 0
        ? allListingIds
        : requestListingIds.includes(NO_LISTING_MATCH_ID)
          ? []
          : requestListingIds;

    const effectiveIdSet = new Set(effectiveIds);
    return allListings.filter((listing) => effectiveIdSet.has(listing.id));
  }

  function selectionSummary(params: {
    values: string[];
    totalCount: number;
    singular: string;
    plural: string;
    allLabel?: string;
  }): string {
    const { values, totalCount, singular, plural, allLabel } = params;
    if (totalCount === 0) return `No ${plural}`;
    if (values.length === 0 || values.length === totalCount) {
      return allLabel ?? `All ${plural} (${formatInteger(totalCount)})`;
    }
    return `${formatInteger(values.length)} ${values.length === 1 ? singular : plural} (${readableList(values, 2)})`;
  }

  function buildPowerPointFilterSummary(): string[] {
    const effectiveListings = effectiveListingSelectionForSummary();
    const listingNames = effectiveListings.map((listing) => listing.name);
    const lines = [
      `Client: ${currentClientName}`,
      `Listings: ${selectionSummary({
        values: listingNames,
        totalCount: allListingIds.length,
        singular: "property",
        plural: "properties"
      })}`,
      `Property groups: ${
        effectiveSelectedGroupTags.length === 0
          ? `All groups (${formatInteger(allCustomGroups.length)})`
          : readableList(effectiveSelectedGroupTags, 2)
      }`,
      `Channels: ${selectionSummary({
        values: requestChannels.length === 0 ? allChannels : selectedChannels,
        totalCount: allChannels.length,
        singular: "channel",
        plural: "channels"
      })}`,
      `Statuses: ${selectionSummary({
        values: requestStatuses.length === 0 ? allStatuses : selectedStatuses,
        totalCount: allStatuses.length,
        singular: "status",
        plural: "statuses"
      })}`,
      `Scope: ${activeScopeLabel(activePropertyScope, activeBeforeDate)}`,
      `Currency: ${displayCurrency}`
    ];

    if (tab === "overview" || tab === "property_groups") {
      lines.push(`Headline lens: ${homeWindowLabel(homeWindow)} ${homeMetric}`);
      if (homeWindow === "custom") {
        lines.push(`Custom window: ${formatDisplayDate(homeBookedCustomFrom)} to ${formatDisplayDate(homeBookedCustomTo)}`);
      }
      if (tab === "property_groups") {
        lines.push(`Selected group: ${activePropertyGroupView ?? "No single group selected"}`);
      }
      lines.push(`Revenue mode: ${includeFees ? "Include fees" : "Exclude fees"}`);
      return lines;
    }

    if (tab === "reservations") {
      lines.push(`Booking window: ${formatDisplayDate(reservationsDateRange.from)} to ${formatDisplayDate(reservationsDateRange.to)}`);
      lines.push(`Revenue mode: ${includeFees ? "Include fees" : "Exclude fees"}`);
      return lines;
    }

    if (tab === "booking_behaviour") {
      lines.push(`Measured by: ${bookWindowModeLabel(bookWindowMode)}`);
      lines.push(`Anchor window: ${bookWindowSelectionLabel}`);
      lines.push(`Line metric: ${bookWindowLineMetricLabel(bookWindowLineMetric)}`);
      lines.push(`Revenue mode: ${includeFees ? "Include fees" : "Exclude fees"}`);
      return lines;
    }

    if (tab === "property_drilldown") {
      lines.push(`Period: ${deepDiveReport?.period.label ?? formatDisplayDate(deepDiveSelectedPeriodStart)}`);
      lines.push(`Granularity: ${deepDiveGranularity === "month" ? "Monthly" : "Weekly"}`);
      lines.push(`Reference: ${deepDiveCompareModeLabel(deepDiveCompareMode)}`);
      lines.push(`Revenue mode: ${includeFees ? "Include fees" : "Exclude fees"}`);
      return lines;
    }

    if (tab === "calendar") {
      lines.push(`Month: ${pricingCalendarReport?.month.label ?? formatDisplayDate(pricingCalendarSelectedMonthStart)}`);
      lines.push(`Pricing group: ${calendarPricingGroupName || "All selected properties"}`);
      return lines;
    }

    if (tab === "signal_lab") {
      lines.push(`Metrics: ${readableList(metricIds.map((metricId) => metricDefinitionMap.get(metricId)?.name ?? metricId), 2)}`);
      lines.push(`Date mode: ${metricDateMode}`);
      lines.push(`Granularity: ${metricsGranularity}`);
      lines.push(`Stay range: ${formatDisplayDate(metricsStayDateFrom)} to ${formatDisplayDate(metricsStayDateTo)}`);
      if (metricDateMode !== "stay") {
        lines.push(`Booking range: ${formatDisplayDate(metricsBookingDateFrom)} to ${formatDisplayDate(metricsBookingDateTo)}`);
      }
      return lines;
    }

    if (activeRange) {
      lines.push(`Date range: ${formatDisplayDate(activeRange.stayDateFrom)} to ${formatDisplayDate(activeRange.stayDateTo)}`);
    }
    lines.push(`Granularity: ${granularity === "day" ? "Daily" : granularity === "week" ? "Weekly" : "Monthly"}`);
    lines.push(`Bars: ${barMetricLabel(barMetric)}`);
    lines.push(`Comparator: ${lastYearSeriesLabel}`);
    lines.push(`Revenue mode: ${includeFees ? "Include fees" : "Exclude fees"}`);
    if (tab === "pace") {
      lines.push(`Pace reference: ${paceCompareMode === "yoy_otb" ? "Same date last year" : "Stayed bookings last year"}`);
    }
    return lines;
  }

  function buildPowerPointLegend(): string[] {
    if (tab === "overview" || tab === "property_groups") {
      return [
        "Booked shows demand created in the selected booking window.",
        "Arrivals shows upcoming stays that are still on the books.",
        "Stayed shows revenue or nights already realised in the selected stay window.",
        "Signal badges mark properties that need immediate review or light monitoring."
      ];
    }

    if (tab === "reservations") {
      return [
        "Reservations counts bookings created in the selected booking window.",
        "Roomnights are the total nights attached to those bookings.",
        "ADR is total revenue divided by booked nights.",
        "Status and channel columns explain where the bookings came from and how they are currently classified."
      ];
    }

    if (tab === "booking_behaviour") {
      return [
        "Bars show the share of nights sitting in each booking window.",
        `The line tracks ${bookWindowLineMetricLabel(bookWindowLineMetric).toLowerCase()} for each window.`,
        `${bookWindowModeLabel(bookWindowMode)} decides whether windows are grouped by booking date or check-in date.`
      ];
    }

    if (tab === "property_drilldown") {
      return [
        "Behind, On pace, and Ahead describe how each property is performing against the selected reference.",
        "Live vs current ADR shows where today’s rate sits against actual achieved rate.",
        "Pricing confidence reflects how strong the evidence is behind each rate recommendation."
      ];
    }

    if (tab === "calendar") {
      return [
        "Booked nights are already reserved and show the booked rate.",
        "Available nights are sellable and include live and recommended rates where available.",
        "Unavailable nights are blocked from sale.",
        "Demand colours move from low to high pressure so you can spot where pricing has room to move."
      ];
    }

    if (tab === "signal_lab") {
      return [
        "Each series is one selected metric plotted over the chosen time range.",
        "Left and right axes separate metrics that sit on very different scales.",
        "Bars and lines follow the chart style assigned to each metric definition."
      ];
    }

    return [
      `Bars compare ${barMetricLabel(barMetric).toLowerCase()} between ${currentSeriesLabel.toLowerCase()} and ${lastYearSeriesLabel.toLowerCase()}.`,
      barMetric === "occupancy"
        ? "Occupancy is shown as a percentage of available inventory."
        : `Lines compare ADR between ${currentSeriesLabel.toLowerCase()} and ${lastYearSeriesLabel.toLowerCase()}.`,
      "Totals are limited to the filters and property scope shown on the slide."
    ];
  }

  function buildPowerPointKeyStats(): PowerPointKeyStat[] {
    if (tab === "overview" || tab === "property_groups") {
      return [
        {
          label: "Booked",
          value: formatHomeMetricValue(getHomeWindowMetricValue(homeBookedSnapshot, homeMetric).current, homeMetric, homeDashboardReport?.meta.displayCurrency ?? displayCurrency)
        },
        {
          label: "Arrivals",
          value: formatHomeMetricValue(getHomeWindowMetricValue(homeArrivalsSnapshot, homeMetric).current, homeMetric, homeDashboardReport?.meta.displayCurrency ?? displayCurrency)
        },
        {
          label: "Stayed",
          value: formatHomeMetricValue(getHomeWindowMetricValue(homeStayedSnapshot, homeMetric).current, homeMetric, homeDashboardReport?.meta.displayCurrency ?? displayCurrency)
        },
        {
          label: "Signals",
          value: formatInteger(homeDashboardReport?.propertyDetective.length ?? 0)
        }
      ];
    }

    if (tab === "reservations" && reservationsReport) {
      return [
        { label: "Reservations", value: formatInteger(reservationsReport.summary.reservations) },
        { label: "Roomnights", value: formatInteger(reservationsReport.summary.nights) },
        { label: "Revenue", value: formatCurrency(reservationsReport.summary.revenue, reservationsReport.meta.displayCurrency) },
        { label: "ADR", value: formatCurrency(reservationsReport.summary.adr, reservationsReport.meta.displayCurrency) }
      ];
    }

    if ((tab === "pace" || tab === "sales" || tab === "booked") && legacyTotals && report) {
      return [
        { label: "Roomnights", value: formatInteger(legacyTotals.totalCurrentNights) },
        { label: "Revenue", value: formatCurrency(legacyTotals.totalCurrentRevenue, report.meta.displayCurrency) },
        { label: "ADR", value: formatCurrency(legacyTotals.totalCurrentAdr, report.meta.displayCurrency) },
        { label: "Occupancy", value: formatPercent(legacyTotals.totalCurrentOccupancy) }
      ];
    }

    if (tab === "booking_behaviour" && bookWindowReport) {
      return [
        { label: "Top window", value: topBookWindow?.label ?? "n/a" },
        { label: "Total nights", value: formatInteger(bookWindowReport.meta.totalNights) },
        { label: "Reservations", value: formatInteger(bookWindowReport.meta.totalReservations) },
        { label: "Top share", value: topBookWindow ? formatPercent(topBookWindow.nightsPct) : "—" }
      ];
    }

    if (tab === "property_drilldown" && deepDiveSummary) {
      return [
        { label: "Behind", value: formatInteger(deepDiveSummary.behind) },
        { label: "On pace", value: formatInteger(deepDiveSummary.on_pace) },
        { label: "Ahead", value: formatInteger(deepDiveSummary.ahead) },
        { label: "Reference", value: deepDiveGranularity === "month" ? "Monthly" : "Weekly" }
      ];
    }

    if (tab === "calendar") {
      const visibleCells = calendarVisibleRows.flatMap((row) => row.cells);
      const availableCells = visibleCells.filter((cell) => cell.state === "available");
      const bookedCells = visibleCells.filter((cell) => cell.state === "booked");
      const actionableCells = availableCells.filter((cell) => cell.liveRate !== null && cell.recommendedRate !== null);
      const averageRateDeltaPct =
        actionableCells.length > 0
          ? actionableCells.reduce((sum, cell) => {
              const liveRate = cell.liveRate ?? 0;
              const recommendedRate = cell.recommendedRate ?? 0;
              if (liveRate <= 0) return sum;
              return sum + ((recommendedRate - liveRate) / liveRate) * 100;
            }, 0) / actionableCells.length
          : null;

      return [
        { label: "Listings", value: formatInteger(calendarVisibleRows.length) },
        { label: "Available", value: formatInteger(availableCells.length) },
        { label: "Booked", value: formatInteger(bookedCells.length) },
        { label: "Avg rate move", value: averageRateDeltaPct === null ? "—" : formatSignedPercent(averageRateDeltaPct) }
      ];
    }

    if (tab === "signal_lab" && metricsReport) {
      return metricsReport.series.slice(0, 4).map((series) => ({
        label: series.name,
        value: metricFormatterValue(series.points.at(-1)?.value ?? 0, series.formatter, metricsReport.displayCurrency)
      }));
    }

    return [{ label: "View", value: tabLabel(tab) }];
  }

  function buildPowerPointFilterContextNarrative(): string {
    const parts: string[] = [];

    if (activePropertyGroupView) {
      parts.push(`for property group ${activePropertyGroupView}`);
    } else if (effectiveSelectedGroupTags.length > 1) {
      parts.push(`for the selected groups ${naturalList(cleanLabelList(effectiveSelectedGroupTags.slice(0, 3)))}`);
    } else {
      parts.push("for the whole portfolio");
    }

    const includedChannels = requestChannels.length === 0 ? allChannels : cleanLabelList(selectedChannels.map((channel) => formatChannelLabel(channel)));
    const allChannelLabels = cleanLabelList(allChannels.map((channel) => formatChannelLabel(channel)));
    const excludedChannels = allChannelLabels.filter((channel) => !includedChannels.includes(channel));

    if (allChannelLabels.length > 0) {
      if (excludedChannels.length === 0 || includedChannels.length === 0) {
        parts.push("across all booking channels");
      } else if (excludedChannels.length === 1 && excludedChannels[0] === "Direct") {
        parts.push("excluding Direct bookings");
      } else if (excludedChannels.length <= 2) {
        parts.push(`excluding ${naturalList(excludedChannels)} bookings`);
      } else {
        parts.push(`focused on ${naturalList(includedChannels.slice(0, 3))}`);
      }
    }

    const selectedStatusLabels = requestStatuses.length === 0
      ? []
      : cleanLabelList(selectedStatuses.map((status) => formatReservationStatusLabel(status)));
    if (selectedStatusLabels.length > 0) {
      parts.push(`using ${naturalList(selectedStatusLabels.slice(0, 3))} statuses`);
    }

    if (activePropertyScope !== "whole_property") {
      parts.push(activeScopeLabel(activePropertyScope, activeBeforeDate).toLowerCase());
    }

    return parts.join(", ");
  }

  function buildPowerPointSummary(): string {
    const filterContext = buildPowerPointFilterContextNarrative();

    if ((tab === "overview" || tab === "property_groups") && homeDashboardReport) {
      const booked = getHomeWindowMetricValue(homeBookedSnapshot, homeMetric);
      const arrivals = getHomeWindowMetricValue(homeArrivalsSnapshot, homeMetric);
      const stayed = getHomeWindowMetricValue(homeStayedSnapshot, homeMetric);
      const candidates = [
        { label: "Booked", current: booked.current, deltaPct: booked.deltaPct },
        { label: "Arrivals", current: arrivals.current, deltaPct: arrivals.deltaPct },
        { label: "Stayed", current: stayed.current, deltaPct: stayed.deltaPct }
      ];
      const strongest = candidates.reduce((best, item) => (item.current > best.current ? item : best), candidates[0]);
      const weakestDelta = candidates.reduce(
        (best, item) => ((item.deltaPct ?? Number.POSITIVE_INFINITY) < (best.deltaPct ?? Number.POSITIVE_INFINITY) ? item : best),
        candidates[0]
      );
      const weakMonths = negativeRadarMonths.slice(0, 2).map((row) => row.label);
      const pressuredDates = highDemandRadarDates.slice(0, 2).map((row) => formatOrdinalDayMonth(row.date));

      return `This overview is ${filterContext}. ${strongest.label} is the strongest headline line right now, while ${weakestDelta.label} looks ${qualitativePercentTrend(
        weakestDelta.deltaPct
      )} against last year. ${
        weakMonths.length > 0
          ? `The most immediate softer months are ${naturalList(weakMonths)}, so those are the first places to review pricing and availability.`
          : "There is no obvious near-term month showing a meaningful pace drop in the current filter set."
      } ${
        pressuredDates.length > 0
          ? `Near-term demand is already building around ${naturalList(pressuredDates)}, which usually means those dates deserve rate protection before other parts of the calendar.`
          : ""
      } ${
        homeDashboardReport.propertyDetective.length > 0
          ? "The signal queue underneath points to the properties most likely to be driving the variance."
          : "There are no urgent property signals in this slice right now."
      }`;
    }

    if (tab === "property_groups") {
      return `This grouping view is ${filterContext}. It is mainly here to explain which slice of the portfolio the later report slides belong to, so the audience knows whether they are looking at a single group or the wider business.`;
    }

    if (tab === "reservations" && reservationsReport) {
      const topChannelEntry = Object.entries(
        reservationsReport.rows.reduce<Record<string, number>>((counts, row) => {
          const key = formatChannelLabel(row.channel);
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {})
      ).sort((a, b) => b[1] - a[1])[0];
      const topListings = Object.entries(
        reservationsReport.rows.reduce<Record<string, number>>((counts, row) => {
          counts[row.listingName] = (counts[row.listingName] ?? 0) + 1;
          return counts;
        }, {})
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([listingName]) => listingName);

      return `This reservations cut is ${filterContext}, using bookings created between ${formatDisplayDate(reservationsDateRange.from)} and ${formatDisplayDate(
        reservationsDateRange.to
      )}. Booking activity is concentrated in ${topListings.length > 0 ? naturalList(topListings) : "a small number of properties"}, which suggests the current momentum is not evenly spread across the filtered portfolio. ${
        topChannelEntry ? `${topChannelEntry[0]} is the main booking source in this slice, so the pattern is being shaped most heavily by that channel.` : ""
      } The table is most useful for spotting where the recent demand is landing and whether it is broad-based or property-specific.`;
    }

    if ((tab === "pace" || tab === "sales" || tab === "booked") && legacyTotals && report) {
      const rowsWithDelta = tableRows.map((row) => ({
        ...row,
        revenueDeltaPct: computePercentDelta(row.currentRevenue, row.lastYearRevenue),
        adrDeltaPct: computePercentDelta(row.currentAdr, row.lastYearAdr),
        occupancyDeltaPts: row.currentOccupancy - row.lastYearOccupancy
      }));
      const imminentRows = rowsWithDelta.slice(0, Math.min(granularity === "day" ? 5 : 3, rowsWithDelta.length));
      const imminentSoft = imminentRows.filter((row) => (row.revenueDeltaPct ?? 0) < -3).map((row) => row.bucketLabel);
      const imminentStrong = imminentRows.filter((row) => (row.revenueDeltaPct ?? 0) > 3).map((row) => row.bucketLabel);
      const weakestRow = [...rowsWithDelta]
        .filter((row) => row.revenueDeltaPct !== null)
        .sort((a, b) => (a.revenueDeltaPct ?? 0) - (b.revenueDeltaPct ?? 0))[0];
      const strongestRow = [...rowsWithDelta]
        .filter((row) => row.revenueDeltaPct !== null)
        .sort((a, b) => (b.revenueDeltaPct ?? 0) - (a.revenueDeltaPct ?? 0))[0];
      const averageImminentAdrTrend =
        imminentRows.length > 0
          ? imminentRows.reduce((sum, row) => sum + (row.adrDeltaPct ?? 0), 0) / imminentRows.length
          : null;
      const averageImminentOccupancyTrend =
        imminentRows.length > 0
          ? imminentRows.reduce((sum, row) => sum + row.occupancyDeltaPts, 0) / imminentRows.length
          : 0;
      const performanceLabel =
        tab === "pace" ? "forward pace" : tab === "sales" ? "stayed performance" : "booking momentum";

      return `This ${tabLabel(tab).toLowerCase()} view is ${filterContext} and compares ${performanceLabel} with ${lastYearSeriesLabel.toLowerCase()}. ${
        imminentSoft.length > 0
          ? `The most imminent pressure sits in ${naturalList(imminentSoft.slice(0, 2))}, where the trend is tracking behind the reference.`
          : imminentStrong.length > 0
            ? `${naturalList(imminentStrong.slice(0, 2))} is leading the near-term trend, so the next part of the period is holding up well.`
            : "The near-term buckets are broadly moving in line with the reference."
      } ${
        averageImminentOccupancyTrend <= -2
          ? "The weakness looks more occupancy-led than rate-led, so demand capture matters more than pure pricing."
          : averageImminentAdrTrend !== null && averageImminentAdrTrend <= -5
            ? "The softer buckets look more rate-led, which suggests price position is doing more of the damage than availability."
            : "The gap looks reasonably balanced between rate and occupancy rather than being driven by only one factor."
      } ${
        weakestRow && strongestRow
          ? `${weakestRow.bucketLabel} is the clearest soft spot, while ${strongestRow.bucketLabel} is the strongest bucket in the selected range.`
          : "The chart is best read as a spread of stronger and weaker buckets across the selected period."
      }`;
    }

    if (tab === "booking_behaviour" && bookWindowReport) {
      const sortedBuckets = [...bookWindowReport.buckets].sort((a, b) => b.nightsPct - a.nightsPct);
      const topBuckets = sortedBuckets.slice(0, 2);
      const shorterLeadBucket = sortedBuckets.find((bucket) => bucket.key === "0_7" || bucket.key === "8_14" || bucket.key === "15_30");
      const longerLeadBucket = sortedBuckets.find((bucket) => bucket.key === "91_180" || bucket.key === "181_365" || bucket.key === "366_plus");

      return `This booking-window view is ${filterContext}. Demand is most concentrated in ${topBuckets.length > 0 ? naturalList(topBuckets.map((bucket) => bucket.label)) : "a small number of windows"}, which shows where guests are most likely to commit. ${
        shorterLeadBucket && longerLeadBucket
          ? shorterLeadBucket.nightsPct > longerLeadBucket.nightsPct
            ? "The shape of the curve leans later, so more guests are booking closer to arrival than far in advance."
            : "The curve still leans earlier, so a larger share of demand is committing well ahead of arrival."
          : "Use the relative bar heights to see whether this slice books early or late."
      } ${
        topBookWindow
          ? `${topBookWindow.label} is the main booking window to watch because it carries the most nights in the current filtered slice.`
          : ""
      }`;
    }

    if (tab === "property_drilldown" && deepDiveReport && deepDiveSummary) {
      const behindRows = deepDiveReport.rows
        .filter((row) => row.health === "behind")
        .sort((a, b) => (a.delta.revenuePct ?? 0) - (b.delta.revenuePct ?? 0))
        .slice(0, 2)
        .map((row) => row.listingName);
      const aheadRows = deepDiveReport.rows
        .filter((row) => row.health === "ahead")
        .sort((a, b) => (b.delta.revenuePct ?? 0) - (a.delta.revenuePct ?? 0))
        .slice(0, 2)
        .map((row) => row.listingName);
      const mostBehind = deepDiveReport.rows
        .filter((row) => row.delta.revenuePct !== null)
        .sort((a, b) => (a.delta.revenuePct ?? 0) - (b.delta.revenuePct ?? 0))[0];

      return `This property drilldown is ${filterContext} and ranks each property against ${deepDiveCompareModeLabel(deepDiveCompareMode).toLowerCase()} for the selected ${
        deepDiveGranularity === "month" ? "month" : "week"
      }. ${
        behindRows.length > 0
          ? `The main underperformers are ${naturalList(behindRows)}, so that is where intervention is most urgent.`
          : "No properties are clearly behind the benchmark in the current slice."
      } ${
        aheadRows.length > 0 ? `${naturalList(aheadRows)} is currently setting the pace on the positive side.` : ""
      } ${
        mostBehind
          ? `${mostBehind.listingName} looks ${qualitativePercentTrend(mostBehind.delta.revenuePct)} on revenue, so it is the clearest candidate for rate, restriction, or availability review.`
          : "The table is best used to separate true property issues from portfolio-wide noise."
      }`;
    }

    if (tab === "calendar") {
      const visibleCells = calendarVisibleRows.flatMap((row) => row.cells);
      const availableCells = visibleCells.filter((cell) => cell.state === "available");
      const bookedCells = visibleCells.filter((cell) => cell.state === "booked");
      const highDemandAvailableCells = availableCells.filter((cell) => cell.demandBand >= 4);
      const actionableCells = availableCells.filter((cell) => cell.liveRate !== null && cell.recommendedRate !== null && (cell.liveRate ?? 0) > 0);
      const imminentHighDemandDates = cleanLabelList(
        highDemandAvailableCells
          .slice(0, 3)
          .map((cell) => formatOrdinalDayMonth(cell.date))
      );
      const averageRateDeltaPct =
        actionableCells.length > 0
          ? actionableCells.reduce((sum, cell) => sum + (((cell.recommendedRate ?? 0) - (cell.liveRate ?? 0)) / (cell.liveRate ?? 1)) * 100, 0) / actionableCells.length
          : null;

      return `This pricing calendar is ${filterContext} for ${pricingCalendarReport?.month.label ?? "the selected month"}. ${
        imminentHighDemandDates.length > 0
          ? `The most imminent high-pressure dates are ${naturalList(imminentHighDemandDates)}, so those nights are the clearest candidates for rate protection.`
          : "The near-term calendar does not show an obvious cluster of high-pressure available dates right now."
      } ${
        averageRateDeltaPct !== null
          ? averageRateDeltaPct > 3
            ? "Across nights where the system has enough evidence, the suggested pricing direction is generally above the current live rate."
            : averageRateDeltaPct < -3
              ? "Across nights with guidance, the model is generally pointing below the current live rate, which suggests the current stance may be a little rich."
              : "Across nights with guidance, the current live rate and the recommended rate are broadly aligned."
          : "The calendar is most useful here for reading demand shape and identifying where guidance is available."
      } Booked and available nights are mixed across the view, so the pattern is best read as a sequence of sellable opportunities rather than one single market state.`;
    }

    if (tab === "signal_lab" && metricsReport && metricsReport.series.length > 0) {
      const leadSeries = metricsReport.series[0];
      const firstValue = leadSeries.points[0]?.value ?? 0;
      const latestValue = leadSeries.points.at(-1)?.value ?? 0;
      const deltaPct = computePercentDelta(latestValue, firstValue);

      return `This custom metrics view is ${filterContext}. ${leadSeries.name} is the lead series and looks ${qualitativePercentTrend(
        deltaPct
      )} versus the start of the selected range. It works best as a trend slide, showing whether the chosen metric is improving, weakening, or staying broadly steady under the active filters.`;
    }

    return `This slide captures the ${tabLabel(tab).toLowerCase()} view ${filterContext}. It is intended to explain the trend in the selected slice rather than restate the page layout.`;
  }

  async function captureCurrentViewForPowerPoint(): Promise<PowerPointSlide> {
    const node = exportCaptureRef.current;
    if (!node) {
      throw new Error("The current view is not ready to capture yet.");
    }

    const { toPng } = await import("html-to-image");
    const imageDataUrl = await toPng(node, {
      cacheBust: true,
      backgroundColor: "#fbf8f1",
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      filter: (candidate) => !(candidate instanceof HTMLElement && candidate.dataset.pptExclude === "true")
    });

    return {
      id: `${tab}-${Date.now()}`,
      title: tab === "property_groups" && activePropertyGroupView ? `${tabLabel(tab)}: ${activePropertyGroupView}` : tabLabel(tab),
      subtitle: `${currentClientName} · ${formatDisplayTimestamp(new Date().toISOString())}`,
      summary: buildPowerPointSummary(),
      filters: buildPowerPointFilterSummary(),
      legend: buildPowerPointLegend(),
      keyStats: buildPowerPointKeyStats(),
      imageDataUrl
    };
  }

  async function addCurrentViewToPowerPoint() {
    if (addingCurrentViewToPowerPoint) return;

    setAddingCurrentViewToPowerPoint(true);
    setError(null);
    setBanner(null);

    try {
      const slide = await captureCurrentViewForPowerPoint();
      setPowerPointSlides((current) => [...current, slide]);
      setPowerPointPanelOpen(true);
      setBanner(`Added ${slide.title} to the PowerPoint deck.`);
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "Failed to add the current view to PowerPoint");
    } finally {
      setAddingCurrentViewToPowerPoint(false);
    }
  }

  async function handleExportPowerPoint() {
    if (exportingPowerPoint) return;

    setExportingPowerPoint(true);
    setError(null);
    setBanner(null);

    try {
      const slides = powerPointSlides.length > 0 ? powerPointSlides : [await captureCurrentViewForPowerPoint()];
      let brandImageDataUrl: string | null = null;
      if (typeof window !== "undefined") {
        try {
          brandImageDataUrl = await urlToDataUrl(new URL(withBasePath("/logo.jpg"), window.location.origin).toString());
        } catch {
          brandImageDataUrl = null;
        }
      }

      await exportDashboardDeck({
        clientName: currentClientName,
        generatedAtLabel: formatDisplayTimestamp(new Date().toISOString()),
        checklist: powerPointChecklist.filter((item) => item.text.trim().length > 0),
        slides,
        brandImageDataUrl,
        libraryUrl: typeof window !== "undefined" ? new URL(withBasePath("/vendor/pptxgen.min.js"), window.location.origin).toString() : ""
      });

      setPowerPointPanelOpen(true);
      setBanner(`Exported PowerPoint with ${formatInteger(slides.length)} report slide${slides.length === 1 ? "" : "s"}.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Failed to export PowerPoint");
    } finally {
      setExportingPowerPoint(false);
    }
  }

  async function refreshFilterOptions() {
    const filterOptions = await fetchJson<FilterOptionsResponse>("/api/filters/options");
    setOptions({
      channels: filterOptions.channels ?? [],
      statuses: filterOptions.statuses ?? [],
      listings: filterOptions.listings ?? [],
      currencies: filterOptions.currencies ?? [],
      paceSnapshotDates: filterOptions.paceSnapshotDates ?? []
    });
  }

  async function handleGroupMutation(action: "assign" | "remove" | "delete", name: string, listingIds: string[] = []) {
    const normalizedName = normalizeGroupName(name);
    if (!normalizedName) {
      setError("Enter a property group name.");
      return;
    }

    if (action !== "delete" && listingIds.length === 0) {
      setError("Select at least one property to update.");
      return;
    }

    setSavingGroup(true);
    setError(null);
    setBanner(null);

    try {
      await fetchJson("/api/listings/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          name: normalizedName,
          listingIds
        })
      });

      await refreshFilterOptions();

      if (action === "assign") {
        setSelectedGroupTags([normalizedName]);
        setSelectedListingIds(listingIds);
        setGroupBuilderOpen(false);
        setGroupDraftName("");
        setGroupEditorListingIds([]);
        setBanner(`Saved property group "${normalizedName}".`);
      } else if (action === "remove") {
        setBanner(`Removed "${normalizedName}" from the selected properties.`);
      } else {
        const nextGroupTags = effectiveSelectedGroupTags.filter((value) => customGroupKey(value) !== customGroupKey(normalizedName));
        setSelectedGroupTags(nextGroupTags);
        setSelectedListingIds(
          resolveListingIdsForFilters({
            listings: allListings,
            allListingIds,
            activeBeforeDate,
            groupTags: nextGroupTags
          })
        );
        setGroupBuilderOpen(false);
        setBanner(`Deleted property group "${normalizedName}".`);
      }
    } catch (groupError) {
      setError(groupError instanceof Error ? groupError.message : "Failed to update property group");
    } finally {
      setSavingGroup(false);
    }
  }

  function openGroupBuilder() {
    setGroupBuilderOpen(true);
    setGroupDraftName("");
    setGroupEditorSearch("");
    setGroupEditorListingIds(selectedListingIds.length > 0 ? selectedListingIds : allListingIds);
  }

  function applyCalendarPricingGroup(name: string) {
    const normalizedName = normalizeGroupName(name);
    setCalendarPricingGroupName(normalizedName);
    setBanner(normalizedName ? `Calendar is now focused on pricing group "${normalizedName}".` : "Calendar pricing group cleared.");
  }

  function buildCalendarReportPayload(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      selectedMonthStart: pricingCalendarSelectedMonthStart,
      ...(calendarPricingGroupName ? { pricingGroupName: calendarPricingGroupName } : {}),
      listingIds: requestListingIds,
      channels: requestChannels,
      statuses: requestStatuses,
      ...(activeBeforeDate ? { activeBeforeDate } : {}),
      displayCurrency,
      ...overrides
    };
  }

  function calendarReportCacheKey(payload: Record<string, unknown>): string {
    return JSON.stringify(payload);
  }

  async function loadCalendarReport(params: {
    forceMarketRefresh?: boolean;
    ignoreClientCache?: boolean;
    suppressLoadingState?: boolean;
  } = {}): Promise<PricingCalendarResponse> {
    const payload = buildCalendarReportPayload({
      ...(params.forceMarketRefresh ? { forceMarketRefresh: true } : {})
    });
    const cacheKey = calendarReportCacheKey(payload);

    if (!params.forceMarketRefresh && !params.ignoreClientCache) {
      const cachedReport = calendarReportClientCacheRef.current.get(cacheKey);
      if (cachedReport) {
        setPricingCalendarReport(cachedReport);
        setLoadingReport(false);
        return cachedReport;
      }
    }

    if (!params.suppressLoadingState) {
      setLoadingReport(true);
    }

    const body = await fetchJson<PricingCalendarResponse>("/api/reports/pricing-calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    calendarReportClientCacheRef.current.set(cacheKey, body);
    setPricingCalendarReport(body);
    setLoadingReport(false);
    return body;
  }
  loadCalendarReportRef.current = loadCalendarReport;

  function updateCalendarSettingsField(key: string, value: any) {
    setCalendarSettingsForm((current) => ({
      ...current,
      [key]: value
    }));
  }

  function confirmDiscardCalendarSettingsChanges(
    message = "You have unsaved pricing setting changes. Discard them and continue?"
  ): boolean {
    if (!calendarSettingsDirty || typeof window === "undefined") return true;
    return window.confirm(message);
  }

  function openCalendarSettingsPanel(
    scope: CalendarSettingsScope | null,
    section: CalendarSettingsSectionId = "base_pricing",
    options: { propertyId?: string; groupRef?: string } = {}
  ) {
    const scopeChanged = scope !== calendarSettingsScope;
    const sectionChanged = section !== calendarSettingsSection;
    const propertyChanged = options.propertyId !== undefined && options.propertyId !== calendarSettingsPropertyId;
    const groupChanged = options.groupRef !== undefined && options.groupRef !== calendarSettingsGroupRef;

    if ((scopeChanged || sectionChanged || propertyChanged || groupChanged) && !confirmDiscardCalendarSettingsChanges()) {
      return;
    }

    setCalendarWorkspacePanel("settings");
    setCalendarSettingsScope(scope);
    setCalendarSettingsSection(section);
    if (options.groupRef !== undefined) {
      setCalendarSettingsGroupRef(options.groupRef);
    }
    if (options.propertyId !== undefined) {
      setCalendarSettingsPropertyId(options.propertyId);
    }
  }

  function handleSelectCalendarSettingsScope(scope: CalendarSettingsScope) {
    if (scope === calendarSettingsScope) return;
    if (!confirmDiscardCalendarSettingsChanges()) return;
    setCalendarSettingsScope(scope);
    setCalendarSettingsSection("base_pricing");
  }

  function handleSelectCalendarSettingsSection(section: CalendarSettingsSectionId) {
    if (section === calendarSettingsSection) return;
    if (!confirmDiscardCalendarSettingsChanges()) return;
    setCalendarSettingsSection(section);
  }

  function handleSelectCalendarSettingsGroupRef(groupRef: string) {
    if (groupRef === calendarSettingsGroupRef) return;
    if (!confirmDiscardCalendarSettingsChanges()) return;
    setCalendarSettingsGroupRef(groupRef);
  }

  function handleSelectCalendarSettingsPropertyId(propertyId: string) {
    if (propertyId === calendarSettingsPropertyId) return;
    if (!confirmDiscardCalendarSettingsChanges()) return;
    setCalendarSettingsPropertyId(propertyId);
  }

  function handleDiscardCalendarSettingsChanges() {
    if (!calendarSettingsDirty) return;

    setCalendarSettingsForm(normalizeCalendarSettingsForm(calendarSettingsLoadedOverride));
    setError(null);
    setBanner("Discarded unsaved pricing setting changes.");
  }

  function activeCalendarSensitivityMode(prefix: "seasonality" | "dayOfWeek"): "less_sensitive" | "recommended" | "more_sensitive" | "custom" {
    if (calendarSettingsForm[`${prefix}ManualAdjustmentEnabled`] === true) {
      return "custom";
    }
    const mode = calendarSettingsForm[`${prefix}SensitivityMode`];
    return mode === "less_sensitive" || mode === "more_sensitive" ? mode : "recommended";
  }

  function applyCalendarSensitivityMode(
    prefix: "seasonality" | "dayOfWeek",
    mode: "less_sensitive" | "recommended" | "more_sensitive" | "custom"
  ) {
    setCalendarSettingsForm((current) => {
      const next = { ...current };
      next[`${prefix}SensitivityMode`] = mode === "custom" ? "recommended" : mode;
      next[`${prefix}ManualAdjustmentEnabled`] = mode === "custom";
      if (mode === "custom" && typeof next[`${prefix}ManualAdjustmentPct`] !== "number") {
        next[`${prefix}ManualAdjustmentPct`] = 0;
      }
      return next;
    });
  }

  function setCalendarDemandSensitivityLevel(level: 1 | 2 | 3 | 4 | 5) {
    const normalizedLevel = Math.max(1, Math.min(5, Math.round(level))) as 1 | 2 | 3 | 4 | 5;
    updateCalendarSettingsField("demandSensitivityLevel", normalizedLevel);
    updateCalendarSettingsField(
      "demandSensitivityMode",
      normalizedLevel <= 2 ? "less_sensitive" : normalizedLevel >= 4 ? "more_sensitive" : "recommended"
    );
  }

  function updateCalendarSettingsListItem(listKey: string, index: number, key: string, value: any) {
    setCalendarSettingsForm((current) => {
      const currentList = Array.isArray(current[listKey]) ? [...current[listKey]] : [];
      currentList[index] = {
        ...(currentList[index] ?? {}),
        [key]: value
      };
      return {
        ...current,
        [listKey]: currentList
      };
    });
  }

  function addCalendarSettingsListItem(listKey: "localEvents" | "lastMinuteAdjustments" | "gapNightAdjustments") {
    setCalendarSettingsForm((current) => {
      const currentList = Array.isArray(current[listKey]) ? [...current[listKey]] : [];
      if (listKey === "localEvents") {
        currentList.push({
          id: `event-${Date.now()}`,
          name: "New event",
          startDate: pricingCalendarSelectedMonthStart,
          endDate: pricingCalendarSelectedMonthStart,
          adjustmentPct: 15,
          dateSelectionMode: "range",
          selectedDates: []
        });
      } else if (listKey === "lastMinuteAdjustments") {
        currentList.push({
          id: `lead-${Date.now()}`,
          minDaysBefore: 0,
          maxDaysBefore: 7,
          adjustmentPct: -5
        });
      } else {
        currentList.push({
          gapNights: currentList.length + 1,
          adjustmentPct: 0
        });
      }
      return {
        ...current,
        [listKey]: currentList
      };
    });
  }

  function removeCalendarSettingsListItem(listKey: string, index: number) {
    setCalendarSettingsForm((current) => {
      const currentList = Array.isArray(current[listKey]) ? [...current[listKey]] : [];
      currentList.splice(index, 1);
      return {
        ...current,
        [listKey]: currentList
      };
    });
  }

  function updateCalendarPropertyDraft(
    listingId: string,
    key: "qualityTier" | "basePriceOverride" | "minimumPriceOverride",
    value: string
  ) {
    setCalendarPropertyDrafts((current) => ({
      ...current,
      [listingId]: {
        qualityTier: current[listingId]?.qualityTier ?? "mid_scale",
        basePriceOverride: current[listingId]?.basePriceOverride ?? "",
        minimumPriceOverride: current[listingId]?.minimumPriceOverride ?? "",
        [key]: value
      }
    }));
  }

  async function refreshCalendarRecommendations(params: {
    listingId?: string | null;
    suppressLoadingState?: boolean;
  } = {}): Promise<PricingCalendarResponse> {
    const listingId = params.listingId ?? null;

    if (listingId) {
      setRefreshingCalendarListingIds((current) => (current.includes(listingId) ? current : [...current, listingId]));
    }

    try {
      calendarReportClientCacheRef.current.clear();
      return await loadCalendarReport(buildCachedCalendarReportReloadOptions(params.suppressLoadingState ?? true));
    } finally {
      if (listingId) {
        setRefreshingCalendarListingIds((current) => current.filter((value) => value !== listingId));
      }
    }
  }

  function parseCalendarOverrideInput(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("Enter a valid positive price.");
    }
    return roundTo2(parsed);
  }

  async function saveCalendarPropertySettings(
    listingId: string,
    patch: Record<string, any>,
    options: { successMessage?: string } = {}
  ) {
    if (savingCalendarPropertyIdsRef.current.has(listingId)) {
      queuedCalendarPropertySaveIdsRef.current.add(listingId);
      return;
    }

    savingCalendarPropertyIdsRef.current.add(listingId);
    setSavingCalendarPropertyIds((current) => (current.includes(listingId) ? current : [...current, listingId]));
    setError(null);

    try {
      const nextSettings = { ...patch };
      const clearKeys: string[] = [];

      if (nextSettings.basePriceOverride === null) {
        delete nextSettings.basePriceOverride;
        clearKeys.push("basePriceOverride");
      }
      if (nextSettings.minimumPriceOverride === null) {
        delete nextSettings.minimumPriceOverride;
        clearKeys.push("minimumPriceOverride");
      }

      await fetchJson("/api/pricing-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "property",
          scopeRef: listingId,
          settings: nextSettings,
          mergeExisting: true,
          clearKeys
        })
      });

      await refreshCalendarRecommendations({ listingId, suppressLoadingState: true });
      if (options.successMessage) {
        setBanner(options.successMessage);
      }
    } catch (propertySettingsError) {
      setError(propertySettingsError instanceof Error ? propertySettingsError.message : "Failed to save property pricing settings");
    } finally {
      savingCalendarPropertyIdsRef.current.delete(listingId);
      setSavingCalendarPropertyIds((current) => current.filter((value) => value !== listingId));
      if (queuedCalendarPropertySaveIdsRef.current.has(listingId)) {
        queuedCalendarPropertySaveIdsRef.current.delete(listingId);
        void handleSaveCalendarPropertyOverrides(listingId);
      }
    }
  }

  async function handleSaveCalendarPropertyOverrides(listingId: string) {
    const draft = calendarPropertyDrafts[listingId];
    if (!draft) return;

    try {
      const row = pricingCalendarReport?.rows.find((candidate) => candidate.listingId === listingId) ?? null;
      const basePriceOverride = parseCalendarOverrideInput(draft.basePriceOverride);
      const minimumPriceOverride = parseCalendarOverrideInput(draft.minimumPriceOverride);
      const nextSettings: Record<string, any> = {};
      const currentBaseInput = row ? formatCalendarOverrideInput(row.pricingAnchors.currentBasePrice) : "";
      const currentMinimumInput = row ? formatCalendarOverrideInput(row.pricingAnchors.currentMinimumPrice) : "";
      const baseValueChanged = !row || draft.basePriceOverride.trim() !== currentBaseInput;
      const minimumValueChanged = !row || draft.minimumPriceOverride.trim() !== currentMinimumInput;

      if (!row || draft.qualityTier !== row.settings.qualityTier) {
        nextSettings.qualityTier = draft.qualityTier;
      }
      if (baseValueChanged) {
        nextSettings.basePriceOverride = basePriceOverride;
      }
      if (minimumValueChanged) {
        nextSettings.minimumPriceOverride = minimumPriceOverride;
      }
      if (Object.keys(nextSettings).length === 0) return;

      await saveCalendarPropertySettings(listingId, nextSettings);
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : "Failed to read the property pricing inputs");
    }
  }

  function handleRefreshCalendarListing(listingId: string) {
    setError(null);
    void refreshCalendarRecommendations({ listingId, suppressLoadingState: true }).catch((refreshError) => {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh calendar recommendations");
    });
  }

  function handleSetCalendarPropertyQualityTier(
    listingId: string,
    qualityTier: PricingCalendarRow["settings"]["qualityTier"]
  ) {
    setCalendarPropertyDrafts((current) => ({
      ...current,
      [listingId]: {
        qualityTier,
        basePriceOverride: current[listingId]?.basePriceOverride ?? "",
        minimumPriceOverride: current[listingId]?.minimumPriceOverride ?? ""
      }
    }));
  }

  function handleResetCalendarPropertyDraft(row: PricingCalendarRow) {
    setCalendarPropertyDrafts((current) => ({
      ...current,
      [row.listingId]: buildCalendarPropertyDraft(row)
    }));
  }

  async function handleResetCalendarSettingsScope() {
    if (!calendarSettingsScope) {
      setError("Choose a scope before resetting settings.");
      return;
    }

    if (!calendarSettingsHasOverrides) {
      handleDiscardCalendarSettingsChanges();
      return;
    }

    const scopeRef =
      calendarSettingsScope === "portfolio"
        ? undefined
        : calendarSettingsScope === "group"
          ? customGroupKey(effectiveCalendarSettingsGroupRef)
          : effectiveCalendarSettingsPropertyId;

    if ((calendarSettingsScope === "group" || calendarSettingsScope === "property") && !scopeRef) {
      setError("Choose a group or property before resetting settings.");
      return;
    }

    setSavingPricingSettings(true);
    setError(null);
    setBanner(null);

    try {
      if (
        typeof window !== "undefined" &&
        !window.confirm("Reset the saved pricing settings for this scope? This clears the saved override and refreshes recommendations.")
      ) {
        return;
      }

      await fetchJson("/api/pricing-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: calendarSettingsScope,
          ...(scopeRef ? { scopeRef } : {}),
          settings: {}
        })
      });

      setCalendarSettingsForm({});
      setCalendarSettingsResolvedForm({});
      setCalendarSettingsLoadedOverride({});
      await refreshCalendarRecommendations({ suppressLoadingState: false });
      setBanner("Calendar pricing settings reset for this scope.");
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : "Failed to reset pricing settings");
    } finally {
      setSavingPricingSettings(false);
    }
  }

  async function handleSaveCalendarSettings() {
    if (savingPricingSettings) return;
    if (!calendarSettingsScope) {
      setError("Choose a scope before saving settings.");
      return;
    }

    const scopeRef =
      calendarSettingsScope === "portfolio"
        ? undefined
        : calendarSettingsScope === "group"
          ? customGroupKey(effectiveCalendarSettingsGroupRef)
          : effectiveCalendarSettingsPropertyId;

    if ((calendarSettingsScope === "group" || calendarSettingsScope === "property") && !scopeRef) {
      setError("Choose a group or property before saving settings.");
      return;
    }

    setSavingPricingSettings(true);
    setError(null);
    setBanner(null);

    try {
      const normalizedSettings = normalizeCalendarSettingsForm(calendarSettingsForm);

      await fetchJson("/api/pricing-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: calendarSettingsScope,
          ...(scopeRef ? { scopeRef } : {}),
          settings: normalizedSettings
        })
      });

      setCalendarSettingsForm(normalizedSettings);
      setCalendarSettingsLoadedOverride(normalizedSettings);
      await refreshCalendarRecommendations({ suppressLoadingState: false });
      setBanner("Calendar pricing settings saved and recommendations refreshed.");
    } catch (settingsError) {
      setError(settingsError instanceof Error ? settingsError.message : "Failed to save pricing settings");
    } finally {
      setSavingPricingSettings(false);
    }
  }

  function dismissRadarItem(key: string, action: "complete" | "ignore") {
    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + (action === "ignore" ? 7 : 30));
    setRadarDismissals((current) => ({
      ...current,
      [key]: expiresAt.toISOString()
    }));
    setBanner(action === "ignore" ? "Muted radar item for 7 days." : "Marked radar item as reviewed.");
  }

  function applyActivePropertyScope(scope: ActivePropertyScope) {
    const nextActiveBeforeDate = buildActiveBeforeDate(scope, activeBeforeDateCustom);
    setActivePropertyScope(scope);
    setSelectedListingIds(
      resolveListingIdsForFilters({
        listings: allListings,
        allListingIds,
        activeBeforeDate: nextActiveBeforeDate,
        groupTags: effectiveSelectedGroupTags
      })
    );
  }

  function applyGroupFilterSelection(nextGroupTags: string[]) {
    setSelectedGroupTags(nextGroupTags);
    setSelectedListingIds(
      resolveListingIdsForFilters({
        listings: allListings,
        allListingIds,
        activeBeforeDate,
        groupTags: nextGroupTags
      })
    );
  }

  function setMetricIdAtIndex(index: number, value: MetricId) {
    setMetricIds((current) => {
      const next = [...current];
      next[index] = value;
      return [...new Set(next)].slice(0, 3);
    });
  }

  const navGroups: Array<{ label: string; items: TabId[] }> = isAdminRole
    ? [
        { label: "Overview", items: ["overview", "reservations", "property_groups"] },
        { label: "Performance", items: ["pace", "sales", "booked", "booking_behaviour", "property_drilldown", "calendar"] }
      ]
    : [
        // Reporting-only viewers (staff) do not see the Calendar / dynamic-pricing tab.
        { label: "Overview", items: ["overview", "reservations", "property_groups"] },
        { label: "Performance", items: ["pace", "sales", "booked", "booking_behaviour", "property_drilldown"] }
      ];

  // Belt-and-braces: if a viewer lands on ?tab=calendar (old link, manual URL, etc.),
  // bounce them back to Overview so they never see the pricing workspace.
  useEffect(() => {
    if (!isAdminRole && tab === "calendar") {
      setTab("overview");
    }
  }, [isAdminRole, tab]);
  const homeMetricOptions: Array<{ id: HomeMetric; label: string }> = [
    { id: "revenue", label: "Revenue" },
    { id: "reservations", label: "Reservations" },
    { id: "nights", label: "Nights" }
  ];
  const homeWindowOptions: Array<{ id: HomeWindow; label: string }> = [
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
    { id: "this_week", label: "This Week" },
    { id: "this_month", label: "This Month" },
    { id: "custom", label: "Custom" }
  ];
  const activePropertyScopeOptions: Array<{ id: ActivePropertyScope; label: string }> = [
    { id: "whole_property", label: "All Properties" },
    { id: "active_3_months", label: "Live 3M Ago" },
    { id: "active_6_months", label: "Live 6M Ago" },
    { id: "active_12_months", label: "Live 12M Ago" },
    { id: "custom_date", label: "Custom Start Date" }
  ];
  const deepDiveMonthOptions = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(currentYear, index, 1));
    const short = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(date);
    return { month: index + 1, short };
  });
  const supportsHistoryLens =
    tab === "overview" ||
    tab === "reservations" ||
    tab === "property_groups" ||
    tab === "pace" ||
    tab === "sales" ||
    tab === "booked" ||
    tab === "property_drilldown" ||
    tab === "calendar";
  const currentSeriesLabel = tab === "sales" ? "Selected period" : "Current";
  const lastYearSeriesLabel =
    tab === "pace"
      ? paceCompareMode === "yoy_otb"
        ? "Same date last year (comparator)"
        : "Stayed bookings last year (comparator)"
      : tab === "booked"
        ? "Same booking period last year"
        : tab === "sales"
          ? "Previous Year"
          : "Same period last year";
  const currentAdrSeriesLabel = tab === "sales" ? "ADR" : "ADR Current";
  const lastYearAdrSeriesLabel = tab === "sales" ? "ADR Previous Year" : `ADR ${lastYearSeriesLabel}`;
  const blockingLoaderTitle =
    switchingClientId !== null
      ? `Opening ${pendingClientName ?? "client"}`
      : `Refreshing ${tabLabel(tab)}`;
  const blockingLoaderDescription =
    switchingClientId !== null
      ? "Switching tenant context and checking whether this client needs a fresh sync."
      : `Pulling the latest ${tabLabel(tab).toLowerCase()} view for this lens.`;

  useEffect(() => {
    const validMonthValues = new Set(calendarMonthOptions.map((month) => month.value));
    if (validMonthValues.has(calendarSelectedMonthStart)) return;
    setCalendarSelectedMonthStart(calendarMonthOptions[0]?.value ?? `${todayDateOnly.slice(0, 7)}-01`);
  }, [calendarMonthOptions, calendarSelectedMonthStart, todayDateOnly]);

  useEffect(() => {
    if (calendarSettingsScope !== "group") return;
    if (effectiveCalendarSettingsGroupRef) {
      setCalendarSettingsGroupRef((current) => current || effectiveCalendarSettingsGroupRef);
    }
  }, [calendarSettingsScope, effectiveCalendarSettingsGroupRef]);

  useEffect(() => {
    if (calendarSettingsScope !== "property") return;
    if (effectiveCalendarSettingsPropertyId) {
      setCalendarSettingsPropertyId((current) => current || effectiveCalendarSettingsPropertyId);
    }
  }, [calendarSettingsScope, effectiveCalendarSettingsPropertyId]);

  useEffect(() => {
    if (!calendarWorkspaceMode || calendarWorkspacePanel !== "settings") return;
    if (!calendarSettingsScope) {
      setCalendarSettingsForm({});
      setCalendarSettingsResolvedForm({});
      setCalendarSettingsLoadedOverride({});
      setLoadingPricingSettings(false);
      return;
    }
    const selectedSettingsScope = calendarSettingsScope;

    const scopeRef =
      selectedSettingsScope === "portfolio"
        ? ""
        : selectedSettingsScope === "group"
          ? customGroupKey(effectiveCalendarSettingsGroupRef)
          : effectiveCalendarSettingsPropertyId;

    if ((selectedSettingsScope === "group" || selectedSettingsScope === "property") && !scopeRef) {
      setCalendarSettingsForm({});
      setCalendarSettingsResolvedForm({});
      setCalendarSettingsLoadedOverride({});
      return;
    }

    let active = true;
    setLoadingPricingSettings(true);

    async function loadPricingSettings() {
      try {
        const params = new URLSearchParams({ scope: selectedSettingsScope });
        if (scopeRef) {
          params.set("scopeRef", scopeRef);
        }
        const response = await fetchJson<{ override: Record<string, any>; resolved: Record<string, any> }>(`/api/pricing-settings?${params.toString()}`);
        if (!active) return;
        setCalendarSettingsLoadedOverride(response.override ?? {});
        setCalendarSettingsResolvedForm(normalizeCalendarSettingsForm(response.resolved ?? {}));
        setCalendarSettingsForm(normalizeCalendarSettingsForm(response.override ?? {}));
      } catch (settingsError) {
        if (!active) return;
        setError(settingsError instanceof Error ? settingsError.message : "Failed to load pricing settings");
      } finally {
        if (active) {
          setLoadingPricingSettings(false);
        }
      }
    }

    void loadPricingSettings();
    return () => {
      active = false;
    };
  }, [
    calendarSettingsScope,
    calendarWorkspaceMode,
    calendarWorkspacePanel,
    effectiveCalendarSettingsGroupRef,
    effectiveCalendarSettingsPropertyId
  ]);

  useEffect(() => {
    if (!pricingCalendarReport) {
      setCalendarPropertyDrafts({});
      return;
    }

    setCalendarPropertyDrafts((current) => {
      const next = { ...current };

      for (const row of pricingCalendarReport.rows) {
        const syncedDraft = buildCalendarPropertyDraft(row);
        const existingDraft = current[row.listingId];
        next[row.listingId] = existingDraft && isCalendarPropertyDraftDirty(row, existingDraft) ? existingDraft : syncedDraft;
      }

      return next;
    });
  }, [pricingCalendarReport]);

  useEffect(() => {
    if (businessReviewSections.length === 0) {
      setBusinessReviewManagerOpen(false);
    }
  }, [businessReviewSections.length]);

  useEffect(() => {
    if (!calendarWorkspaceMode) {
      setCalendarHasHorizontalOverflow(false);
      return;
    }

    const viewport = calendarScrollViewportRef.current;
    const table = calendarTableRef.current;
    const bottomScroll = calendarBottomScrollRef.current;
    const bottomContent = calendarBottomScrollContentRef.current;
    if (!viewport || !table || !bottomScroll || !bottomContent) return;

    const syncScrollPositions = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (calendarScrollSyncingRef.current) return;
      calendarScrollSyncingRef.current = true;
      target.scrollLeft = source.scrollLeft;
      window.requestAnimationFrame(() => {
        calendarScrollSyncingRef.current = false;
      });
    };

    const handleViewportScroll = () => syncScrollPositions(viewport, bottomScroll);
    const handleBottomScroll = () => syncScrollPositions(bottomScroll, viewport);

    const updateMeasurements = () => {
      const scrollWidth = table.scrollWidth;
      bottomContent.style.width = `${scrollWidth}px`;
      setCalendarHasHorizontalOverflow(scrollWidth > viewport.clientWidth + 4);
      if (Math.abs(bottomScroll.scrollLeft - viewport.scrollLeft) > 1) {
        bottomScroll.scrollLeft = viewport.scrollLeft;
      }
    };

    viewport.addEventListener("scroll", handleViewportScroll, { passive: true });
    bottomScroll.addEventListener("scroll", handleBottomScroll, { passive: true });

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            updateMeasurements();
          })
        : null;

    resizeObserver?.observe(viewport);
    resizeObserver?.observe(table);
    window.addEventListener("resize", updateMeasurements);
    window.requestAnimationFrame(updateMeasurements);

    return () => {
      viewport.removeEventListener("scroll", handleViewportScroll);
      bottomScroll.removeEventListener("scroll", handleBottomScroll);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateMeasurements);
    };
  }, [calendarVisibleDays.length, calendarVisibleRows.length, calendarWorkspaceMode]);

  const propertyGroupsSection = (
    <SectionCard
      title="Property Groups"
      kicker="Custom Views"
      description="Group properties by city, by management client, or any portfolio slice you want to review in one clean dashboard."
    >
      {allCustomGroups.length === 0 && !groupBuilderOpen ? (
        <div className="rounded-[22px] border bg-white/76 p-5" style={{ borderColor: "var(--border)" }}>
          <p className="text-sm leading-6" style={{ color: "var(--muted-text)" }}>
            Build reusable views for the parts of the portfolio you actually operate on day to day. For example:
            city groups, owner groups, managed-vs-rental-arbitrage, or any custom commercial split.
          </p>
          <button
            type="button"
            className="mt-4 rounded-full px-4 py-2 text-sm font-semibold text-white"
            style={{ background: "var(--green-dark)" }}
            onClick={openGroupBuilder}
          >
            Create Group
          </button>
        </div>
      ) : null}

      {allCustomGroups.length > 0 ? (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <div className="rounded-[22px] border bg-white/76 p-4" style={{ borderColor: "var(--border)" }}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
              Select Group You&apos;d Like To View
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className="min-w-[260px] flex-1 rounded-2xl border bg-white px-3 py-2.5 text-sm outline-none"
                style={{ borderColor: "var(--border)" }}
                value={activePropertyGroupView ?? ""}
                onChange={(event) => applyGroupFilterSelection(event.target.value ? [event.target.value] : [])}
              >
                <option value="">Select a group</option>
                {allCustomGroups.map((group) => (
                  <option key={`group-select-${group.label}`} value={group.label}>
                    {group.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-full border px-3.5 py-2 text-sm font-semibold"
                style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                onClick={openGroupBuilder}
              >
                Create New Group
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {allCustomGroups.map((group) => {
                const active = activePropertyGroupView !== null && customGroupKey(activePropertyGroupView) === customGroupKey(group.label);
                return (
                  <button
                    key={`group-pill-${group.label}`}
                    type="button"
                    className="rounded-full px-3 py-1.5 text-sm"
                    style={
                      active
                        ? { background: "rgba(22,71,51,0.12)", color: "var(--green-dark)" }
                        : { background: "white", border: "1px solid var(--border)" }
                    }
                    onClick={() => applyGroupFilterSelection([group.label])}
                  >
                    {group.label} · {formatInteger(group.listingIds.length)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-[22px] border bg-white/76 p-4" style={{ borderColor: "var(--border)" }}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
              Group Actions
            </p>
            <div className="mt-3 space-y-2.5">
              {allCustomGroups.map((group) => (
                <div key={`group-action-${group.label}`} className="rounded-2xl border bg-white px-3 py-3" style={{ borderColor: "var(--border)" }}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold">{group.label}</p>
                      <p className="mt-1 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                        {formatInteger(group.listingIds.length)} properties
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                      style={{ borderColor: "rgba(187,75,82,0.2)", color: "var(--delta-negative)" }}
                      disabled={savingGroup}
                      onClick={() => void handleGroupMutation("delete", group.label)}
                    >
                      Delete group
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {groupBuilderOpen ? (
        <div className="mt-3 rounded-[22px] border bg-white/76 p-4" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[220px] flex-1 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
              Group name
              <input
                type="text"
                className="mt-1.5 w-full rounded-2xl border bg-white px-3 py-2.5 text-sm font-normal outline-none"
                style={{ borderColor: "var(--border)" }}
                value={groupDraftName}
                onChange={(event) => setGroupDraftName(event.target.value)}
                placeholder="Glasgow City Centre"
              />
            </label>
            <button
              type="button"
              className="rounded-full px-3.5 py-1.5 text-sm font-semibold text-white"
              style={{ background: "var(--green-dark)" }}
              disabled={savingGroup}
              onClick={() => void handleGroupMutation("assign", groupDraftName, groupEditorListingIds)}
            >
              {savingGroup ? "Saving..." : `Save ${formatInteger(groupEditorListingIds.length)} properties`}
            </button>
            <button
              type="button"
              className="rounded-full border px-3.5 py-1.5 text-sm font-semibold"
              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
              onClick={() => setGroupBuilderOpen(false)}
            >
              Cancel
            </button>
          </div>
          <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
            Select the properties that belong in this group, then save it as a reusable dashboard view.
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <input
              type="search"
              className="w-full rounded-2xl border bg-white px-3 py-2.5 text-sm outline-none"
              style={{ borderColor: "var(--border)" }}
              value={groupEditorSearch}
              onChange={(event) => setGroupEditorSearch(event.target.value)}
              placeholder="Search properties"
            />
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                className="rounded-full border px-2 py-1"
                style={{ borderColor: "var(--border)" }}
                onClick={() => setGroupEditorListingIds(allListingIds)}
              >
                All
              </button>
              <button
                type="button"
                className="rounded-full border px-2 py-1"
                style={{ borderColor: "var(--border)" }}
                onClick={() => setGroupEditorListingIds([])}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="mt-2.5 max-h-72 space-y-1 overflow-auto rounded-2xl border bg-white p-2" style={{ borderColor: "var(--border)" }}>
            {filteredGroupEditorListings.map((listing) => (
              <label key={`group-editor-${listing.id}`} className="flex items-center gap-3 rounded-2xl px-2 py-2 text-sm hover:bg-emerald-50/70">
                <input
                  type="checkbox"
                  checked={groupEditorListingIds.includes(listing.id)}
                  onChange={() => setGroupEditorListingIds((current) => toggleInSelection(current, listing.id))}
                />
                <span className="truncate">{listing.name}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {allCustomGroups.length > 0 && !activePropertyGroupView ? (
        <div className="mt-3">
          <EmptyState title="Select a group to view its dashboard" description="Choose one existing group above, or create a new one if you want a new portfolio slice." />
        </div>
      ) : null}
    </SectionCard>
  );

  const reservationsSection = (
    <SectionCard
      title="Reservations"
      kicker="Booked Reservations"
      description="Bookings created in the selected booking window. ADR compares each stay to the same weekday-aligned stay window last year."
    >
      {loadingReport ? (
        <p className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(176,122,25,0.18)", background: "rgba(176,122,25,0.07)", color: "var(--mustard-dark)" }}>
          Refreshing reservations. The current table stays visible while the latest booking window loads.
        </p>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,0.85fr)]">
        <div className="rounded-[22px] border bg-white/72 p-4" style={{ borderColor: "var(--border)" }}>
          <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
            Booking Window
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {([
              { id: "today", label: "Today" },
              { id: "yesterday", label: "Yesterday" },
              { id: "last_7_days", label: "Last 7 Days" },
              { id: "this_month", label: "This Month" },
              { id: "custom", label: "Custom" }
            ] as const).map((option) => (
              <button
                key={option.id}
                type="button"
                className="rounded-full px-3 py-2 text-sm"
                style={
                  reservationsRangePreset === option.id
                    ? { background: "rgba(176,122,25,0.14)", color: "var(--mustard-dark)" }
                    : { background: "white", border: "1px solid var(--border)" }
                }
                onClick={() => applyReservationsPreset(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {reservationsRangePreset === "custom" ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                From
                <input
                  type="date"
                  className="mt-1.5 w-full rounded-2xl border bg-white px-3 py-2.5 text-sm"
                  style={{ borderColor: "var(--border)" }}
                  value={reservationsCustomFrom}
                  onChange={(event) => {
                    setReservationsRangePreset("custom");
                    setReservationsCustomFrom(event.target.value);
                  }}
                />
              </label>
              <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                To
                <input
                  type="date"
                  className="mt-1.5 w-full rounded-2xl border bg-white px-3 py-2.5 text-sm"
                  style={{ borderColor: "var(--border)" }}
                  value={reservationsCustomTo}
                  onChange={(event) => {
                    setReservationsRangePreset("custom");
                    setReservationsCustomTo(event.target.value);
                  }}
                />
              </label>
            </div>
          ) : null}
        </div>

        <div className="rounded-[22px] border bg-white/72 p-4" style={{ borderColor: "var(--border)" }}>
          <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
            Revenue Mode
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-full px-3 py-2 text-sm"
              style={includeFees ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
              onClick={() => setIncludeFees(true)}
            >
              Include fees
            </button>
            <button
              type="button"
              className="rounded-full px-3 py-2 text-sm"
              style={!includeFees ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
              onClick={() => setIncludeFees(false)}
            >
              Exclude fees
            </button>
          </div>
          <p className="mt-3 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
            Showing bookings made between {formatDisplayDate(reservationsDateRange.from)} and {formatDisplayDate(reservationsDateRange.to)}.
          </p>
          {comparisonScopeLabel(reservationsReport?.meta.comparisonScope ?? comparisonScope) ? (
            <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
              {comparisonScopeLabel(reservationsReport?.meta.comparisonScope ?? comparisonScope)}
            </p>
          ) : null}
        </div>
      </div>

      {reservationsReport ? (
        <>
          <div className="mt-5 grid gap-4 xl:grid-cols-4">
            <SummaryCard
              label="Reservations"
              value={formatInteger(reservationsReport.summary.reservations)}
              detail="Total booked reservations in the selected booking window."
            />
            <SummaryCard
              label="Roomnights"
              value={formatInteger(reservationsReport.summary.nights)}
              detail="Total nights attached to those reservations."
              tone="blue"
            />
            <SummaryCard
              label="Total Revenue"
              value={formatCurrency(reservationsReport.summary.revenue, reservationsReport.meta.displayCurrency)}
              detail={includeFees ? "Reservation totals including fees." : "Reservation totals excluding fees."}
              tone="gold"
            />
            <SummaryCard
              label="Average ADR"
              value={formatCurrency(reservationsReport.summary.adr, reservationsReport.meta.displayCurrency)}
              detail="Weighted average ADR across the reservations below."
            />
          </div>

          {reservationsReport.rows.length > 0 ? (
            <div className="mt-5 overflow-x-auto rounded-[24px] border bg-white/82 p-4" style={{ borderColor: "var(--border)" }}>
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {["Guest Name", "Listing", "Status", "Check in Date", "Number of Nights", "Total Price", "ADR", "Channel"].map((label) => (
                      <th key={label} className="border-b px-3 py-2 text-left font-semibold" style={{ borderColor: "var(--border)" }}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reservationsReport.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="border-b px-3 py-3 align-top" style={{ borderColor: "var(--border)" }}>
                        <span className="font-medium">{row.guestName ?? "Guest unavailable"}</span>
                      </td>
                      <td className="border-b px-3 py-3 align-top" style={{ borderColor: "var(--border)" }}>
                        <span className="font-medium">{row.listingName}</span>
                      </td>
                      <td className="border-b px-3 py-3 align-top" style={{ borderColor: "var(--border)" }}>
                        <span
                          className="inline-flex rounded-full px-2.5 py-1 text-[12px] font-semibold"
                          style={{
                            background:
                              row.status === "cancelled" || row.status === "canceled"
                                ? "rgba(187,75,82,0.11)"
                                : row.status === "inquiry"
                                  ? "rgba(176,122,25,0.12)"
                                  : "rgba(22,71,51,0.1)",
                            color:
                              row.status === "cancelled" || row.status === "canceled"
                                ? "var(--delta-negative)"
                                : row.status === "inquiry"
                                  ? "var(--mustard-dark)"
                                  : "var(--green-dark)"
                          }}
                        >
                          {formatReservationStatusLabel(row.status)}
                        </span>
                      </td>
                      <td className="border-b px-3 py-3 align-top" style={{ borderColor: "var(--border)" }}>
                        {formatReservationCheckInDate(row.checkInDate)}
                      </td>
                      <td className="border-b px-3 py-3 align-top" style={{ borderColor: "var(--border)" }}>
                        {formatInteger(row.nights)}
                      </td>
                      <td className="border-b px-3 py-3 align-top" style={{ borderColor: "var(--border)" }}>
                        {formatCurrency(row.totalPrice, reservationsReport.meta.displayCurrency)}
                      </td>
                      <td className="border-b px-3 py-3 align-top" style={{ borderColor: "var(--border)" }}>
                        <p className="font-medium">{formatCurrency(row.adr, reservationsReport.meta.displayCurrency)}</p>
                        <p className="mt-1 text-[12px] leading-5" style={percentDeltaStyle(row.adrDeltaPct)}>
                          {row.lastYearSameWeekdayAdr !== null
                            ? `${formatSignedPercent(row.adrDeltaPct)} vs LY weekdays (${formatCurrency(row.lastYearSameWeekdayAdr, reservationsReport.meta.displayCurrency)})`
                            : "No LY weekday match"}
                        </p>
                      </td>
                      <td className="border-b px-3 py-3 align-top" style={{ borderColor: "var(--border)" }}>
                        {formatChannelLabel(row.channel)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-5">
              <EmptyState title="No reservations in this booking window" description="Try widening the booking dates or adjusting your filters." />
            </div>
          )}
        </>
      ) : null}
    </SectionCard>
  );

  if (!viewStateReady || loadingOptions) {
    return <WorkspaceLoadingScreen title="Signals" description="Loading your revenue workspace" />;
  }

  if (calendarWorkspaceMode) {
    return (
      <main className="app-shell relative flex min-h-screen flex-col overflow-hidden">
        {switchingClientId !== null || showSlowLoadingScreen ? (
          <WorkspaceLoadingScreen fixed title={blockingLoaderTitle} description={blockingLoaderDescription} />
        ) : null}

        <header className="border-b bg-white/90 px-3 py-3 backdrop-blur-md sm:px-4" style={{ borderColor: "var(--border)" }}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--muted-text)" }}>
                  Calendar Workspace
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-[1.7rem] leading-none">Calendar</h1>
                  <span className="rounded-full border bg-white/78 px-3 py-1 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                    {currentClientName}
                  </span>
                  <span className="rounded-full border bg-white/78 px-3 py-1 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                    {selectedCalendarMonthOption ? `${selectedCalendarMonthOption.short} ${selectedCalendarMonthOption.year}` : pricingCalendarReport?.month.label}
                  </span>
                  <span className="rounded-full border bg-white/78 px-3 py-1 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                    {displayCurrency}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border bg-white/78 px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                  Last sync: {lastSyncDisplay}
                </span>
                {calendarMarketDataMeta ? (
                  <span
                    className="rounded-full border px-3 py-1.5 text-xs font-semibold"
                    style={
                      calendarMarketDataMeta.rowsNeedingSetup > 0
                        ? {
                            borderColor: "rgba(187,75,82,0.18)",
                            background: "rgba(187,75,82,0.08)",
                            color: "var(--delta-negative)"
                          }
                        : calendarMarketDataMeta.rowsUsingFallbackPricing > 0
                          ? {
                              borderColor: "rgba(176,122,25,0.18)",
                              background: "rgba(176,122,25,0.08)",
                              color: "var(--mustard-dark)"
                            }
                          : {
                              borderColor: "rgba(22,71,51,0.14)",
                              background: "rgba(31,122,77,0.08)",
                              color: "var(--green-dark)"
                            }
                    }
                  >
                    {calendarMarketDataMeta.rowsNeedingSetup > 0
                      ? `${calendarMarketDataMeta.rowsNeedingSetup} need setup`
                      : calendarMarketDataMeta.rowsUsingFallbackPricing > 0
                        ? `${calendarMarketDataMeta.rowsUsingFallbackPricing} using backup pricing`
                        : "Market ready"}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="rounded-[18px] border bg-white/78 p-2.5" style={{ borderColor: "var(--border)" }}>
              <div className="flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-full border bg-white p-1" style={{ borderColor: "var(--border)" }}>
                    {[
                      { id: "calendar" as const, label: "Calendar" },
                      { id: "settings" as const, label: "Settings" }
                    ].map((panel) => (
                      <button
                        key={`calendar-panel-${panel.id}`}
                        type="button"
                        className="rounded-full px-3 py-1.5 text-xs font-semibold"
                        style={
                          calendarWorkspacePanel === panel.id
                            ? { background: "var(--green-dark)", color: "#ffffff" }
                            : { color: "var(--navy-dark)" }
                        }
                        onClick={() => {
                          if (panel.id === "settings") {
                            openCalendarSettingsPanel(calendarSettingsScope, calendarSettingsSection);
                            return;
                          }
                          setCalendarWorkspacePanel(panel.id);
                        }}
                      >
                        {panel.label}
                      </button>
                    ))}
                  </div>

                  <div className="inline-flex items-center gap-1 rounded-full border bg-white px-1 py-1" style={{ borderColor: "var(--border)" }}>
                    <button
                      type="button"
                      className="rounded-full px-2.5 py-1.5 text-sm font-semibold disabled:opacity-40"
                      style={{ color: "var(--navy-dark)" }}
                      disabled={selectedCalendarMonthIndex <= 0}
                      onClick={() => {
                        const previousMonth = calendarMonthOptions[selectedCalendarMonthIndex - 1];
                        if (previousMonth) setCalendarSelectedMonthStart(previousMonth.value);
                      }}
                    >
                      ←
                    </button>
                    <select
                      className="min-w-[148px] bg-transparent px-2 py-1.5 text-sm font-semibold outline-none"
                      value={pricingCalendarSelectedMonthStart}
                      onChange={(event) => setCalendarSelectedMonthStart(event.target.value)}
                    >
                      {calendarMonthOptions.map((month) => (
                        <option key={`calendar-month-option-${month.value}`} value={month.value}>
                          {month.short} {month.year}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="rounded-full px-2.5 py-1.5 text-sm font-semibold disabled:opacity-40"
                      style={{ color: "var(--navy-dark)" }}
                      disabled={selectedCalendarMonthIndex < 0 || selectedCalendarMonthIndex >= calendarMonthOptions.length - 1}
                      onClick={() => {
                        const nextMonth = calendarMonthOptions[selectedCalendarMonthIndex + 1];
                        if (nextMonth) setCalendarSelectedMonthStart(nextMonth.value);
                      }}
                    >
                      →
                    </button>
                  </div>

                  <select
                    className="rounded-full border bg-white px-3 py-2 text-xs font-semibold outline-none"
                    style={{ borderColor: "var(--border)" }}
                    value={currentCalendarPricingGroup?.label ?? ""}
                    onChange={(event) => applyCalendarPricingGroup(event.target.value)}
                  >
                    <option value="">All properties</option>
                    {allCustomGroups.map((group) => (
                      <option key={`calendar-workspace-group-${group.label}`} value={group.label}>
                        {group.label} · {group.listingIds.length}
                      </option>
                    ))}
                  </select>

                  <span className="rounded-full border bg-white px-3 py-2 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                    {currentCalendarPricingGroup ? `${currentCalendarPricingGroup.listingIds.length} in group` : `${pricingCalendarReport?.rows.length ?? 0} listings`}
                  </span>
                  {hasDirtyCalendarPropertyDrafts ? (
                    <span
                      className="rounded-full border px-3 py-2 text-xs font-semibold"
                      style={{
                        borderColor: "rgba(176,122,25,0.18)",
                        background: "rgba(176,122,25,0.08)",
                        color: "var(--mustard-dark)"
                      }}
                    >
                      Unsaved property pricing
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-full border bg-white px-3 py-2 text-xs font-semibold"
                    style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                    disabled={syncRefreshDisabled}
                    onClick={() => void handleRefreshSync()}
                  >
                    {queueingManualSync || syncQueueActivity > 0 ? "Syncing..." : "Refresh Sync"}
                  </button>
                  <button
                    type="button"
                    className="hidden rounded-full border bg-white px-3 py-2 text-xs font-semibold xl:inline-flex"
                    style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                    onClick={() => openCalendarWorkspace()}
                  >
                    Duplicate Tab ↗
                  </button>
                  <button
                    type="button"
                    className="rounded-full border bg-white px-3 py-2 text-xs font-semibold"
                    style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                    onClick={() => {
                      if (typeof window === "undefined") return;
                      if (window.opener) {
                        window.close();
                        return;
                      }
                      const overviewUrl = buildShareUrl({ tab: "overview" }) ?? withBasePath("/dashboard");
                      window.location.assign(overviewUrl);
                    }}
                  >
                    Close Workspace
                  </button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {(["booked", "available", "unavailable"] as const).map((state) => {
                  const palette = calendarCellCopy(state);
                  return (
                    <span
                      key={`workspace-legend-${state}`}
                      className="rounded-full border px-2.5 py-1 text-[11px] font-semibold"
                      style={{ background: palette.background, borderColor: palette.border, color: palette.accent }}
                    >
                      {palette.label}
                    </span>
                  );
                })}
                  <span
                    className="inline-flex items-center gap-2 rounded-full border bg-white px-2.5 py-1 text-[11px] font-semibold"
                    style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}
                  >
                  <span
                    className="h-2.5 w-16 rounded-full"
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(246,216,120,0.8) 0%, rgba(204,218,132,0.86) 44%, rgba(54,143,84,0.86) 100%)"
                    }}
                  />
                  Deeper green means stronger demand
                </span>
                <span
                  className="inline-flex items-center gap-2 rounded-full border bg-white px-2.5 py-1 text-[11px] font-semibold"
                  style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}
                >
                    <span className="rounded-full border px-1.5 py-0.5 text-[10px]" style={{ borderColor: "var(--border)" }}>
                      +8%
                    </span>
                  Change vs Base Price
                </span>
              </div>
            </div>
          </div>
        </header>

        <section className="flex-1 overflow-hidden px-1 py-1">
          {banner ? (
            <p className="mb-1 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "rgba(22,71,51,0.16)", background: "rgba(31,122,77,0.08)" }}>
              {banner}
            </p>
          ) : null}
          {error ? (
            <p className="mb-1 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }}>
              {error}
            </p>
          ) : null}
          {loadingReport ? (
            <p className="mb-1 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "rgba(176,122,25,0.18)", background: "rgba(176,122,25,0.07)", color: "var(--mustard-dark)" }}>
              {refreshingMarketData
                ? "Refreshing the stored market snapshot for future calendar loads."
                : "Refreshing calendar data. This workspace stays visible while the latest month reloads."}
            </p>
          ) : null}
          {calendarCoverageMessage ? (
            <p
              className="mb-1 rounded-xl border px-3 py-2 text-sm"
              style={
                calendarCoverageMessage.tone === "critical"
                  ? {
                      borderColor: "rgba(187,75,82,0.2)",
                      background: "rgba(187,75,82,0.08)",
                      color: "var(--delta-negative)"
                    }
                  : calendarCoverageMessage.tone === "warning"
                    ? {
                        borderColor: "rgba(176,122,25,0.18)",
                        background: "rgba(176,122,25,0.07)",
                        color: "var(--mustard-dark)"
                      }
                    : {
                        borderColor: "rgba(22,71,51,0.16)",
                        background: "rgba(31,122,77,0.08)",
                        color: "var(--green-dark)"
                      }
              }
            >
              {calendarCoverageMessage.message}
            </p>
          ) : null}

          {calendarWorkspacePanel === "settings" ? (
            <CalendarSettingsPanel
              calendarSettingsScope={calendarSettingsScope}
              calendarSettingsSection={calendarSettingsSection}
              calendarSettingsScopeOptions={calendarSettingsScopeOptions}
              calendarSettingsMenu={calendarSettingsMenu}
              effectiveCalendarSettingsGroupRef={effectiveCalendarSettingsGroupRef}
              effectiveCalendarSettingsPropertyId={effectiveCalendarSettingsPropertyId}
              allCustomGroups={allCustomGroups}
              calendarRows={pricingCalendarReport?.rows ?? []}
              calendarSettingsScopeReady={calendarSettingsScopeReady}
              calendarSettingsDirty={calendarSettingsDirty}
              calendarSettingsHasOverrides={calendarSettingsHasOverrides}
              calendarSettingsForm={calendarSettingsForm}
              calendarSettingsResolvedForm={calendarSettingsResolvedForm}
              calendarSeasonalityAdjustments={calendarSeasonalityAdjustments}
              calendarDayOfWeekAdjustments={calendarDayOfWeekAdjustments}
              calendarDemandSensitivityLevel={calendarDemandSensitivityLevel}
              pricingCalendarSelectedMonthStart={pricingCalendarSelectedMonthStart}
              savingPricingSettings={savingPricingSettings}
              loadingPricingSettings={loadingPricingSettings}
              setCalendarSettingsScope={handleSelectCalendarSettingsScope}
              setCalendarSettingsSection={handleSelectCalendarSettingsSection}
              setCalendarSettingsGroupRef={handleSelectCalendarSettingsGroupRef}
              setCalendarSettingsPropertyId={handleSelectCalendarSettingsPropertyId}
              updateCalendarSettingsField={updateCalendarSettingsField}
              activeCalendarSensitivityMode={activeCalendarSensitivityMode}
              applyCalendarSensitivityMode={applyCalendarSensitivityMode}
              setCalendarDemandSensitivityLevel={setCalendarDemandSensitivityLevel}
              addCalendarSettingsListItem={addCalendarSettingsListItem}
              removeCalendarSettingsListItem={removeCalendarSettingsListItem}
              updateCalendarSettingsListItem={updateCalendarSettingsListItem}
              handleDiscardCalendarSettingsChanges={handleDiscardCalendarSettingsChanges}
              handleSaveCalendarSettings={handleSaveCalendarSettings}
              handleResetCalendarSettingsScope={handleResetCalendarSettingsScope}
            />
          ) : pricingCalendarReport && calendarVisibleRows.length > 0 && calendarVisibleDays.length > 0 ? (
            <CalendarGridPanel
              pricingCalendarReport={pricingCalendarReport}
              calendarVisibleRows={calendarVisibleRows}
              calendarVisibleDays={calendarVisibleDays}
              selectedCalendarCellDetail={selectedCalendarCellDetail}
              calendarPropertyDrafts={calendarPropertyDrafts}
              savingCalendarPropertyIds={savingCalendarPropertyIds}
              refreshingCalendarListingIds={refreshingCalendarListingIds}
              selectedCalendarCellKey={selectedCalendarCellKey}
              calendarHasHorizontalOverflow={calendarHasHorizontalOverflow}
              calendarScrollViewportRef={calendarScrollViewportRef}
              calendarTableRef={calendarTableRef}
              calendarBottomScrollRef={calendarBottomScrollRef}
              calendarBottomScrollContentRef={calendarBottomScrollContentRef}
              setSelectedCalendarCellKey={setSelectedCalendarCellKey}
              openCalendarSettingsPanel={openCalendarSettingsPanel}
              handleSetCalendarPropertyQualityTier={handleSetCalendarPropertyQualityTier}
              updateCalendarPropertyDraft={updateCalendarPropertyDraft}
              handleSaveCalendarPropertyOverrides={handleSaveCalendarPropertyOverrides}
              handleResetCalendarPropertyDraft={handleResetCalendarPropertyDraft}
              handleRefreshCalendarListing={handleRefreshCalendarListing}
              formatCurrency={formatCurrency}
              formatDisplayDate={formatDisplayDate}
            />
          ) : (
            <div className="h-full rounded-[18px] border bg-white/72 p-2" style={{ borderColor: "var(--border)" }}>
              <EmptyState title="No forward dates to show" description="Pick the current or a future month, then run a fresh sync if the calendar is still empty." />
            </div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell relative min-h-screen overflow-x-hidden">
      {switchingClientId !== null || showSlowLoadingScreen ? (
        <WorkspaceLoadingScreen
          fixed
          title={blockingLoaderTitle}
          description={blockingLoaderDescription}
        />
      ) : null}
      <div className="relative flex min-h-screen flex-col md:flex-row">
        <div
          className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b px-4 py-3 md:hidden"
          style={{ background: "rgba(247,245,239,0.94)", borderColor: "var(--border)", backdropFilter: "blur(12px)" }}
        >
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
              {currentClientName}
            </p>
            <p className="font-display text-[1.4rem] leading-none">{tabLabel(tab)}</p>
          </div>
          <button
            type="button"
            className="rounded-full border px-3 py-2 text-sm font-semibold"
            style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
            aria-expanded={mobileSidebarOpen}
            aria-controls="dashboard-sidebar"
            onClick={() => setMobileSidebarOpen((current) => !current)}
          >
            {mobileSidebarOpen ? "Close" : "Menu"}
          </button>
        </div>
        {mobileSidebarOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-slate-950/35 md:hidden"
            aria-label="Close menu"
            onClick={() => setMobileSidebarOpen(false)}
          />
        ) : null}
        <aside
          id="dashboard-sidebar"
          className={`fixed inset-y-0 left-0 z-50 w-[86vw] max-w-[320px] overflow-y-auto border-r px-5 py-5 transition-transform duration-200 md:static md:min-h-screen md:w-[308px] md:max-w-none md:border-b-0 md:px-6 md:py-7 ${
            mobileSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
          }`}
          style={{ background: "var(--sidebar-bg)", borderColor: "rgba(255,255,255,0.08)", color: "var(--sidebar-text)" }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
                <Image src={withBasePath("/logo.jpg")} alt="Roomy" width={48} height={48} className="rounded-xl object-cover" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-white/60">Roomy Revenue</p>
                <p className="font-display text-[1.9rem] leading-none">Signals</p>
              </div>
            </div>
            <button
              type="button"
              className="rounded-full border border-white/12 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/80 md:hidden"
              onClick={() => setMobileSidebarOpen(false)}
            >
              Close
            </button>
          </div>

          <div className="mt-6 rounded-[24px] border border-white/10 bg-white/8 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">Current Client</p>
            <select
              className="mt-3 w-full rounded-2xl border border-white/10 bg-white/10 px-3 py-3 text-sm outline-none"
              value={currentClientId}
              disabled={switchingClientId !== null}
              onChange={(event) => void handleSwitchClient(event.target.value)}
            >
              {clientOptions.map((client) => (
                <option key={client.id} value={client.id} style={{ color: "#142a22" }}>
                  {client.name}
                </option>
              ))}
            </select>
            <Link
              href="/dashboard/select-client/new"
              className="mt-3 inline-flex rounded-full border border-white/12 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/80"
            >
              Add client
            </Link>
          </div>

          <nav className="mt-8 space-y-6">
            {navGroups.map((group) => (
              <div key={group.label}>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/40">{group.label}</p>
                <div className="space-y-2">
                  {group.items.map((item) => {
                    const active = tab === item;
                    return (
                      <button
                        key={item}
                        type="button"
                        className="w-full rounded-2xl px-4 py-3 text-left text-sm font-medium transition"
                        style={
                          active
                            ? { background: "rgba(255,255,255,0.14)", color: "#ffffff", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)" }
                            : { background: "transparent", color: "rgba(255,255,255,0.76)" }
                        }
                        onClick={() => openDashboardTab(item)}
                      >
                        <span className="block">{item === "calendar" ? `${tabLabel(item)} ↗` : tabLabel(item)}</span>
                        {active ? <span className="mt-1 block text-xs font-normal text-white/50">{tabDescription(item)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="mt-8 rounded-[24px] border border-white/10 bg-white/8 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55">Account</p>
            <p className="mt-3 text-sm text-white/80">{userEmail}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href="/dashboard/settings"
                className="rounded-full border border-white/12 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/80"
              >
                Settings
              </Link>
              <button
                type="button"
                className="rounded-full border border-white/12 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/80"
                onClick={() => void handleLogout()}
              >
                Sign out
              </button>
            </div>
          </div>
        </aside>

        <section className="flex-1 px-4 py-5 sm:px-6 md:px-8 md:py-8">
          <div className="mx-auto max-w-[1440px] space-y-6">
            {banner ? (
              <p className="rounded-2xl border px-3.5 py-2.5 text-sm" style={{ borderColor: "rgba(22,71,51,0.16)", background: "rgba(31,122,77,0.08)" }}>
                {banner}
              </p>
            ) : null}
            {error ? (
              <p className="rounded-2xl border px-3.5 py-2.5 text-sm" style={{ borderColor: "rgba(187,75,82,0.2)", background: "rgba(187,75,82,0.08)", color: "var(--delta-negative)" }}>
                {error}
              </p>
            ) : null}
            {saveViewDialogOpen ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4">
                <div className="w-full max-w-md rounded-[28px] border bg-white p-5 shadow-2xl" style={{ borderColor: "var(--border-strong)" }}>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                    Save View
                  </p>
                  <h2 className="font-display mt-2 text-[1.8rem]">Name this view</h2>
                  <p className="mt-2 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                    Saved views keep this dashboard lens ready to reopen without copying a long URL around.
                  </p>
                  <label className="mt-4 block text-sm font-medium">
                    <span style={{ color: "var(--muted-text)" }}>View name</span>
                    <input
                      autoFocus
                      type="text"
                      className="mt-2 w-full rounded-[20px] border bg-white px-4 py-3 outline-none transition focus-visible:border-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-100"
                      style={{ borderColor: "var(--border)" }}
                      value={saveViewNameDraft}
                      onChange={(event) => setSaveViewNameDraft(event.target.value)}
                      placeholder="Weekly overview"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          confirmSaveCurrentView();
                        }
                      }}
                    />
                  </label>
                  <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-full border px-4 py-2 text-sm font-semibold"
                      style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                      onClick={() => setSaveViewDialogOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="rounded-full px-4 py-2 text-sm font-semibold text-white"
                      style={{ background: "var(--green-dark)" }}
                      onClick={confirmSaveCurrentView}
                    >
                      Save view
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <div ref={exportCaptureRef} className="space-y-6">
              {businessReviewManagerOpen && businessReviewSections.length > 0 ? (
                <div className="fixed right-6 top-24 z-50 w-[360px] rounded-[24px] border bg-white/98 p-4 shadow-2xl" style={{ borderColor: "var(--border-strong)" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Business Review
                      </p>
                      <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
                        {formatInteger(businessReviewSections.length)} report section{businessReviewSections.length === 1 ? "" : "s"} currently queued.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rounded-full border px-2.5 py-1 text-xs font-semibold"
                      style={{ borderColor: "var(--border)", color: "var(--navy-dark)" }}
                      onClick={() => setBusinessReviewManagerOpen(false)}
                    >
                      Close
                    </button>
                  </div>
                  <div className="mt-3 max-h-[320px] space-y-2 overflow-auto pr-1">
                    {businessReviewSections.map((section) => (
                      <div key={section.id} className="rounded-[18px] border bg-slate-50/70 px-3 py-3" style={{ borderColor: "var(--border)" }}>
                        <p className="text-sm font-semibold leading-5">{section.title}</p>
                        <p className="mt-1 text-[12px] leading-5" style={{ color: "var(--muted-text)" }}>
                          {section.subtitle}
                        </p>
                        <div className="mt-2 flex justify-end">
                          <button
                            type="button"
                            className="rounded-full border px-3 py-1.5 text-xs font-semibold"
                            style={{ borderColor: "rgba(187,75,82,0.24)", color: "var(--delta-negative)" }}
                            onClick={() => removeBusinessReviewSection(section.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {tab === "property_groups" ? (
                propertyGroupsSection
              ) : (
                <section className="glass-panel rounded-[22px] border px-4 py-3" style={{ borderColor: "var(--border)" }}>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                    <div className="min-w-0 flex-1 pr-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--muted-text)" }}>
                        Portfolio Lens
                      </p>
                      <p className="text-sm font-semibold">{currentClientName}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span
                        className="inline-flex h-9 items-center rounded-full border bg-white/72 px-3 text-xs font-semibold"
                        style={{ borderColor: "var(--border)" }}
                      >
                        Last sync: {lastSyncDisplay}
                      </span>
                      <button
                        type="button"
                        className="inline-flex h-9 items-center rounded-full border bg-white/72 px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                        style={{ borderColor: "var(--border)", color: "var(--green-dark)" }}
                        disabled={syncRefreshDisabled}
                        onClick={() => void handleRefreshSync()}
                      >
                        {queueingManualSync || syncQueueActivity > 0 ? "Syncing..." : "Refresh Sync"}
                      </button>
                      <div
                        className="flex min-h-9 min-w-[188px] items-center gap-2 rounded-full border bg-white/70 px-3 py-1.5"
                        style={{ borderColor: "var(--border)" }}
                      >
                        <label htmlFor="displayCurrencySelect" className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Currency
                        </label>
                        <select
                          id="displayCurrencySelect"
                          className="min-w-0 flex-1 bg-transparent text-right text-sm outline-none"
                          value={selectedCurrencyOption}
                          onChange={(event) => handleCurrencySelectionChange(event.target.value)}
                        >
                          {availableCurrencies.map((currencyCode) => (
                            <option key={currencyCode} value={currencyCode}>
                              {currencyCode}
                            </option>
                          ))}
                          <option value={OTHER_CURRENCY_OPTION}>Other...</option>
                        </select>
                        {selectedCurrencyOption === OTHER_CURRENCY_OPTION ? (
                          <input
                            className="w-16 rounded-full border px-2 py-1 text-center text-xs uppercase"
                            style={{ borderColor: displayCurrencyValid ? "var(--border)" : "rgba(187,75,82,0.4)" }}
                            value={customCurrencyCode}
                            maxLength={3}
                            onChange={(event) => setCustomCurrencyCode(normalizeCurrencyCode(event.target.value))}
                            placeholder="USD"
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[18px] border bg-white/68 p-2.5" style={{ borderColor: "var(--border)" }}>
                    <div className="flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
                      <div className="flex flex-wrap items-center gap-2">
                        {supportsHistoryLens ? (
                          <div className="flex items-center gap-1.5 rounded-full border bg-white px-2 py-1.5" style={{ borderColor: "var(--border)" }}>
                            <span className="pl-1 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                              Show
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {activePropertyScopeOptions.map((option) => (
                                <button
                                  key={option.id}
                                  type="button"
                                  className="rounded-full px-2.5 py-1 text-xs font-semibold"
                                  style={
                                    activePropertyScope === option.id
                                      ? { background: "rgba(176,122,25,0.16)", color: "var(--mustard-dark)" }
                                      : { background: "white", border: "1px solid var(--border)", color: "var(--green-dark)" }
                                  }
                                  onClick={() => applyActivePropertyScope(option.id)}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {supportsHistoryLens && activePropertyScope === "custom_date" ? (
                          <label className="flex items-center gap-2 rounded-full border bg-white px-3 py-1.5 text-sm" style={{ borderColor: "var(--border)" }}>
                            <span className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                              Properties live before
                            </span>
                            <input
                              type="date"
                              className="bg-transparent text-sm outline-none"
                              value={activeBeforeDateCustom}
                              onChange={(event) => setActiveBeforeDateCustom(event.target.value)}
                            />
                          </label>
                        ) : null}
                      </div>

                      <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
                        {savedViews.length > 0 ? (
                          <div className="col-span-2 flex min-h-9 min-w-0 items-center gap-2 rounded-full border bg-white px-3 py-1.5 sm:min-w-[184px]" style={{ borderColor: "var(--border)" }}>
                            <label htmlFor="savedViewSelect" className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                              Saved
                            </label>
                            <select
                              id="savedViewSelect"
                              className="min-w-0 flex-1 bg-transparent text-right text-sm outline-none"
                              defaultValue=""
                              onChange={(event) => {
                                const encoded = event.target.value;
                                if (!encoded) return;
                                applySavedView(encoded);
                                event.target.value = "";
                              }}
                            >
                              <option value="">Saved views</option>
                              {savedViews.map((view) => (
                                <option key={view.id} value={view.encoded}>
                                  {view.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className="rounded-full border bg-white px-3.5 py-2 text-sm font-semibold"
                          style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                          onClick={openSaveCurrentViewDialog}
                        >
                          Save view
                        </button>
                        <button
                          type="button"
                          className="rounded-full border bg-white px-3.5 py-2 text-sm font-semibold"
                          style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                          onClick={() => void copyShareLink()}
                        >
                          Copy link
                        </button>
                        <button
                          type="button"
                          className="col-span-2 rounded-full border bg-white px-3.5 py-2 text-sm font-semibold sm:col-span-1"
                          style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                          onClick={() => setFiltersOpen((current) => !current)}
                        >
                          {filtersOpen ? "Hide filters" : "Show filters"}
                        </button>
                      </div>
                    </div>

                    {filtersOpen ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <span className="rounded-full border bg-white px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                          Listings: {formatInteger(selectedListingIds.length)}
                        </span>
                        {showGroupFilterColumn ? (
                          <span className="rounded-full border bg-white px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                            Groups: {effectiveSelectedGroupTags.length === 0 ? "All" : formatInteger(effectiveSelectedGroupTags.length)}
                          </span>
                        ) : null}
                        <span className="rounded-full border bg-white px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                          Channels: {formatInteger(selectedChannels.length)}
                        </span>
                        <span className="rounded-full border bg-white px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                          Statuses: {formatInteger(selectedStatuses.length)}
                        </span>
                        <span className="rounded-full border bg-white px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--border)" }}>
                          Show: {activeScopeLabel(activePropertyScope, activeBeforeDate)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>

                {filtersOpen ? (
                  <div className={`mt-4 grid gap-3 ${showGroupFilterColumn ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
                    <div className="rounded-[22px] border bg-white/70 p-3.5" style={{ borderColor: "var(--border)" }}>
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-display text-[1.3rem]">Listings</h3>
                        <div className="flex gap-2 text-xs">
                          <button type="button" className="rounded-full border px-2 py-1" style={{ borderColor: "var(--border)" }} onClick={() => setSelectedListingIds(listingFilterBaseIds)}>
                            All
                          </button>
                          <button type="button" className="rounded-full border px-2 py-1" style={{ borderColor: "var(--border)" }} onClick={() => setSelectedListingIds([])}>
                            Clear
                          </button>
                        </div>
                      </div>
                      <input
                        type="search"
                        className="mt-2.5 w-full rounded-2xl border bg-white px-3 py-2.5 text-sm outline-none"
                        style={{ borderColor: "var(--border)" }}
                        value={listingSearch}
                        onChange={(event) => setListingSearch(event.target.value)}
                        placeholder="Search property name or listing id"
                      />
                      <div className="mt-2.5 max-h-64 space-y-1 overflow-auto rounded-2xl border bg-white p-2" style={{ borderColor: "var(--border)" }}>
                        {filteredListings.map((listing) => (
                          <label key={listing.id} className="flex items-center gap-3 rounded-2xl px-2 py-2 text-sm hover:bg-emerald-50/70">
                            <input
                              type="checkbox"
                              checked={selectedListingIds.includes(listing.id)}
                              onChange={() => setSelectedListingIds((current) => toggleInSelection(current, listing.id))}
                            />
                            <span className="truncate">{listing.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {showGroupFilterColumn ? (
                      <div className="rounded-[22px] border bg-white/70 p-3.5" style={{ borderColor: "var(--border)" }}>
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="font-display text-[1.3rem]">Property Groups</h3>
                          <div className="flex gap-2 text-xs">
                            <button
                              type="button"
                              className="rounded-full border px-2 py-1"
                              style={{ borderColor: "var(--border)" }}
                              onClick={() => applyGroupFilterSelection(allCustomGroups.map((group) => group.label))}
                            >
                              All
                            </button>
                            <button
                              type="button"
                              className="rounded-full border px-2 py-1"
                              style={{ borderColor: "var(--border)" }}
                              onClick={() => applyGroupFilterSelection([])}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <div className="mt-2.5 max-h-64 space-y-1 overflow-auto rounded-2xl border bg-white p-2" style={{ borderColor: "var(--border)" }}>
                          {allCustomGroups.length === 0 ? (
                            <p className="px-2 py-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                              No custom property groups yet. Create them from the Property Groups tab.
                            </p>
                          ) : (
                            allCustomGroups.map((group) => (
                              <label key={group.label} className="flex items-center gap-3 rounded-2xl px-2 py-2 text-sm hover:bg-emerald-50/70">
                                <input
                                  type="checkbox"
                                  checked={effectiveSelectedGroupTags.some((value) => customGroupKey(value) === customGroupKey(group.label))}
                                  onChange={() => applyGroupFilterSelection(toggleInSelection(effectiveSelectedGroupTags, group.label))}
                                />
                                <span className="truncate">{group.label}</span>
                                <span className="ml-auto text-[11px]" style={{ color: "var(--muted-text)" }}>
                                  {group.listingIds.length}
                                </span>
                              </label>
                            ))
                          )}
                        </div>
                      </div>
                    ) : null}

                    <div className="rounded-[22px] border bg-white/70 p-3.5" style={{ borderColor: "var(--border)" }}>
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-display text-[1.3rem]">Channels</h3>
                        <div className="flex gap-2 text-xs">
                          <button type="button" className="rounded-full border px-2 py-1" style={{ borderColor: "var(--border)" }} onClick={() => setSelectedChannels(allChannels)}>
                            All
                          </button>
                          <button type="button" className="rounded-full border px-2 py-1" style={{ borderColor: "var(--border)" }} onClick={() => setSelectedChannels([])}>
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="mt-2.5 max-h-64 space-y-1 overflow-auto rounded-2xl border bg-white p-2" style={{ borderColor: "var(--border)" }}>
                        {allChannels.map((channel) => (
                          <label key={channel} className="flex items-center gap-3 rounded-2xl px-2 py-2 text-sm hover:bg-emerald-50/70">
                            <input
                              type="checkbox"
                              checked={selectedChannels.includes(channel)}
                              onChange={() => setSelectedChannels((current) => toggleInSelection(current, channel))}
                            />
                            <span className="truncate">{channel}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-[22px] border bg-white/70 p-3.5" style={{ borderColor: "var(--border)" }}>
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-display text-[1.3rem]">Statuses</h3>
                        <div className="flex gap-2 text-xs">
                          <button type="button" className="rounded-full border px-2 py-1" style={{ borderColor: "var(--border)" }} onClick={() => setSelectedStatuses(allStatuses)}>
                            All
                          </button>
                          <button type="button" className="rounded-full border px-2 py-1" style={{ borderColor: "var(--border)" }} onClick={() => setSelectedStatuses([])}>
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="mt-2.5 max-h-64 space-y-1 overflow-auto rounded-2xl border bg-white p-2" style={{ borderColor: "var(--border)" }}>
                        {allStatuses.map((status) => (
                          <label key={status} className="flex items-center gap-3 rounded-2xl px-2 py-2 text-sm hover:bg-emerald-50/70">
                            <input
                              type="checkbox"
                              checked={selectedStatuses.includes(status)}
                              onChange={() => setSelectedStatuses((current) => toggleInSelection(current, status))}
                            />
                            <span className="truncate">{status}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}

                {selectedCurrencyOption === OTHER_CURRENCY_OPTION && !displayCurrencyValid ? (
                  <p className="mt-3 text-sm" style={{ color: "var(--delta-negative)" }}>
                    Enter a valid 3-letter currency code to keep the reports in sync.
                  </p>
                ) : null}
                </section>
              )}

              {tab === "reservations" ? (
              reservationsSection
            ) : canRenderHomeDashboard ? (
              homeDashboardReport ? (
                <>
                  <SectionCard
                    title="Headline Windows"
                    kicker="At A Glance"
                    description="One shared lens keeps booked, arrivals, and stayed aligned. Inline deltas always show the change vs last year."
                  >
                    <div className="space-y-3">
                      <div className="rounded-[20px] border bg-white/72 px-3.5 py-3" style={{ borderColor: "var(--border)" }}>
                        <div className="flex flex-wrap gap-1.5">
                          {homeMetricOptions.map((option) => (
                            <button
                              key={`headline-metric-${option.id}`}
                              type="button"
                              className="rounded-full px-3 py-1.5 text-sm"
                              style={
                                homeMetric === option.id
                                  ? { background: "var(--green-dark)", color: "#ffffff" }
                                  : { background: "white", border: "1px solid var(--border)" }
                              }
                              onClick={() => updateHomeMetric(option.id)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {homeWindowOptions.map((option) => (
                            <button
                              key={`headline-window-${option.id}`}
                              type="button"
                              className="rounded-full px-3 py-1.5 text-sm"
                              style={
                                homeWindow === option.id
                                  ? { background: "rgba(176,122,25,0.14)", color: "var(--mustard-dark)" }
                                  : { background: "white", border: "1px solid var(--border)" }
                              }
                              onClick={() => updateHomeWindow(option.id)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        {homeWindow === "custom" ? (
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                              From
                              <input
                                type="date"
                                className="mt-1.5 w-full rounded-2xl border bg-white px-3 py-2.5 text-sm"
                                style={{ borderColor: "var(--border)" }}
                                value={homeBookedCustomFrom}
                                onChange={(event) => updateHomeCustomFrom(event.target.value)}
                              />
                            </label>
                            <label className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                              To
                              <input
                                type="date"
                                className="mt-1.5 w-full rounded-2xl border bg-white px-3 py-2.5 text-sm"
                                style={{ borderColor: "var(--border)" }}
                                value={homeBookedCustomTo}
                                onChange={(event) => updateHomeCustomTo(event.target.value)}
                              />
                            </label>
                          </div>
                        ) : null}
                      </div>

                      <div className="grid gap-3 xl:grid-cols-3">
                        {[
                          {
                            id: "booked",
                            label: "Booked",
                            description: "Booking-date demand creation and commercial momentum.",
                            snapshot: homeBookedSnapshot,
                            onOpen: () => openDashboardTab("booked")
                          },
                          {
                            id: "arrivals",
                            label: "Arrivals",
                            description: "What is still due to arrive inside the selected stay window.",
                            snapshot: homeArrivalsSnapshot,
                            onOpen: () => openDashboardTab("pace")
                          },
                          {
                            id: "stayed",
                            label: "Stayed",
                            description: "What has already stayed inside the selected stay window.",
                            snapshot: homeStayedSnapshot,
                            onOpen: () => openDashboardTab("sales")
                          }
                        ].map((card) => {
                          const values = getHomeWindowMetricValue(card.snapshot, homeMetric);
                          return (
                            <div key={card.id} className="rounded-[22px] border bg-white/78 p-3.5" style={{ borderColor: "var(--border)" }}>
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                  <MetricBadge tone={card.id === "booked" ? "green" : card.id === "arrivals" ? "gold" : "blue"}>{card.label}</MetricBadge>
                                  <p className="mt-1.5 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                    {card.description}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                  style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                  onClick={card.onOpen}
                                >
                                  Open report
                                </button>
                              </div>
                              <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                                {homeWindowLabel(homeWindow)}
                              </p>
                              <div className="mt-2 flex flex-wrap items-end gap-3">
                                <p className="text-[2rem] font-semibold">
                                  {formatHomeMetricValue(values.current, homeMetric, homeDashboardReport.meta.displayCurrency)}
                                </p>
                                <span className="pb-1 text-sm font-semibold" style={percentDeltaStyle(values.deltaPct)}>
                                  {formatSignedPercent(values.deltaPct)} vs last year
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </SectionCard>

                  {tab === "overview" ? (
                    <SectionCard
                      title="Opportunity Radar"
                      kicker="Portfolio View"
                      description="Like-for-like pace, ADR movement, and high-demand dates worth protecting across the same properties last year."
                    >
                      <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-4">
                        <div className="rounded-[24px] border bg-white/76 p-4" style={{ borderColor: "var(--border)", order: negativeRadarMonths.length > 0 ? 1 : 11 }}>
                          <MetricBadge tone="gold">Months</MetricBadge>
                          <h3 className="font-display mt-2 text-[1.25rem]">Negative Pace Months</h3>
                          <div className="mt-3 space-y-2.5">
                            {negativeRadarMonths.length === 0 ? (
                              <p className="rounded-2xl border border-dashed bg-white px-3 py-3 text-[13px] leading-5" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
                                No negative like-for-like pace months are standing out right now.
                              </p>
                            ) : (
                              negativeRadarMonths.slice(0, 3).map((row) => (
                                <div key={row.bucket} className="rounded-2xl bg-amber-50/70 px-3 py-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="font-semibold">{row.label}</span>
                                    <span className="text-sm font-semibold" style={percentDeltaStyle(row.revenueDeltaPct)}>
                                      {formatSignedPercent(row.revenueDeltaPct)} vs last year
                                    </span>
                                  </div>
                                  <p className="mt-1 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                    {formatCurrency(row.currentRevenue, homeDashboardReport.meta.displayCurrency)} on books vs{" "}
                                    {formatCurrency(row.lastYearRevenue, homeDashboardReport.meta.displayCurrency)} at the same point last year
                                  </p>
                                  <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                    Review pricing, restrictions, and availability before this month drifts further behind.
                                  </p>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                      onClick={() =>
                                        openSignalDrivenPaceView({
                                          granularity: "month",
                                          ...clampRangeStartToToday(parseMonthBucketRange(row.bucket)),
                                          compareMode: "yoy_otb",
                                          activeScope: "active_12_months"
                                        })
                                      }
                                    >
                                      Open pace
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-full px-3 py-1.5 text-sm font-semibold text-white"
                                      style={{ background: "var(--green-dark)" }}
                                      onClick={() => dismissRadarItem(`month:${row.bucket}`, "complete")}
                                    >
                                      Mark reviewed
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                      onClick={() => dismissRadarItem(`month:${row.bucket}`, "ignore")}
                                    >
                                      Mute for 7 days
                                    </button>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        <div className="rounded-[24px] border bg-white/76 p-4" style={{ borderColor: "var(--border)", order: negativeRadarWeeks.length > 0 ? 2 : 12 }}>
                          <MetricBadge tone="blue">Weeks</MetricBadge>
                          <h3 className="font-display mt-2 text-[1.25rem]">Negative Pace Weeks</h3>
                          <div className="mt-3 space-y-2.5">
                            {negativeRadarWeeks.length === 0 ? (
                              <p className="rounded-2xl border border-dashed bg-white px-3 py-3 text-[13px] leading-5" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
                                No negative like-for-like pace weeks are standing out right now.
                              </p>
                            ) : (
                              negativeRadarWeeks.slice(0, 4).map((row) => (
                                <div key={row.bucket} className="rounded-2xl px-3 py-3" style={{ background: "rgba(247, 242, 230, 0.88)" }}>
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="font-semibold">{formatOpportunityWeekLabel(row.bucket)}</span>
                                    <span className="text-sm font-semibold" style={percentDeltaStyle(row.revenueDeltaPct)}>
                                      {formatSignedPercent(row.revenueDeltaPct)} vs last year
                                    </span>
                                  </div>
                                  <p className="mt-1 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                    {formatCurrency(row.currentRevenue, homeDashboardReport.meta.displayCurrency)} on books vs{" "}
                                    {formatCurrency(row.lastYearRevenue, homeDashboardReport.meta.displayCurrency)} at the same point last year
                                  </p>
                                  <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                    Review short-term rates and restrictions while this week is still recoverable.
                                  </p>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                      onClick={() =>
                                        openSignalDrivenPaceView({
                                          granularity: "week",
                                          ...clampRangeStartToToday(parseWeekBucketRange(row.bucket)),
                                          compareMode: "yoy_otb",
                                          activeScope: "active_12_months"
                                        })
                                      }
                                    >
                                      Open pace
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-full px-3 py-1.5 text-sm font-semibold text-white"
                                      style={{ background: "var(--green-dark)" }}
                                      onClick={() => dismissRadarItem(`week:${row.bucket}`, "complete")}
                                    >
                                      Mark reviewed
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                      onClick={() => dismissRadarItem(`week:${row.bucket}`, "ignore")}
                                    >
                                      Mute for 7 days
                                    </button>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        <div className="rounded-[24px] border bg-white/76 p-4" style={{ borderColor: "var(--border)", order: adrRadarMonths.length > 0 ? 3 : 13 }}>
                          <MetricBadge tone="green">ADR Watch</MetricBadge>
                          <h3 className="font-display mt-2 text-[1.25rem]">ADR Driver Months</h3>
                          <div className="mt-3 space-y-2.5">
                            {adrRadarMonths.length === 0 ? (
                              <p className="rounded-2xl border border-dashed bg-white px-3 py-3 text-[13px] leading-5" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
                                No major ADR-driven months are standing out right now.
                              </p>
                            ) : (
                              adrRadarMonths.slice(0, 3).map((row) => {
                                const adrDelta = row.adrDeltaPct === null ? null : row.liveAdr - row.lastYearAdr;
                                return (
                                  <div key={`adr-${row.bucket}`} className="rounded-2xl bg-emerald-50/75 px-3 py-3">
                                    <div className="flex items-center justify-between gap-3">
                                      <span className="font-semibold">{row.label}</span>
                                      <span className="text-sm font-semibold" style={valueDeltaStyle(adrDelta)}>
                                        {formatSignedCurrencyDelta(adrDelta, homeDashboardReport.meta.displayCurrency)} ADR vs stayed last year
                                      </span>
                                    </div>
                                    <p className="mt-1 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                      {formatCurrency(row.liveAdr, homeDashboardReport.meta.displayCurrency)} live unbooked ADR vs{" "}
                                      {formatCurrency(row.lastYearAdr, homeDashboardReport.meta.displayCurrency)} stayed ADR last year
                                    </p>
                                    <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                      Live forward ADR is doing more of the work here than normal, so sense-check rate position before acting on pace alone.
                                    </p>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      <button
                                        type="button"
                                        className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                        style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                        onClick={() =>
                                          openSignalDrivenPaceView({
                                            granularity: "month",
                                            ...clampRangeStartToToday(parseMonthBucketRange(row.bucket)),
                                            compareMode: "ly_stayed",
                                            activeScope: "active_12_months"
                                          })
                                        }
                                      >
                                        Open pace
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded-full px-3 py-1.5 text-sm font-semibold text-white"
                                        style={{ background: "var(--green-dark)" }}
                                        onClick={() => dismissRadarItem(`adr:${row.bucket}`, "complete")}
                                      >
                                        Mark reviewed
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                        style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                        onClick={() => dismissRadarItem(`adr:${row.bucket}`, "ignore")}
                                      >
                                        Mute for 7 days
                                      </button>
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>

                        <div className="rounded-[24px] border bg-white/76 p-4" style={{ borderColor: "var(--border)", order: highDemandRadarDates.length > 0 ? 4 : 14 }}>
                          <MetricBadge tone="gold">Demand</MetricBadge>
                          <h3 className="font-display mt-2 text-[1.25rem]">High Demand Dates</h3>
                          <div className="mt-3 space-y-2.5">
                            {highDemandRadarDates.length === 0 ? (
                              <p className="rounded-2xl border border-dashed bg-white px-3 py-3 text-[13px] leading-5" style={{ borderColor: "var(--border)", color: "var(--muted-text)" }}>
                                No standout demand dates are surfacing right now.
                              </p>
                            ) : (
                              highDemandRadarDates.slice(0, 4).map((row) => (
                                <div key={`demand-${row.date}`} className="rounded-2xl bg-white px-3 py-3">
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="font-semibold">{formatOrdinalDayMonth(row.date)}</span>
                                    <span className="text-sm font-semibold" style={{ color: "var(--mustard-dark)" }}>
                                      {formatInteger(row.reservations)} reservations
                                    </span>
                                  </div>
                                  <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                    Demand is already compressing around this date, so protect rate, restrictions, and availability while it is still hot.
                                  </p>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                      onClick={() =>
                                        openSignalDrivenPaceView({
                                          granularity: "week",
                                          ...clampRangeStartToToday(parseWeekBucketRange(row.date)),
                                          compareMode: "yoy_otb",
                                          activeScope: "whole_property"
                                        })
                                      }
                                    >
                                      Open pace
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-full px-3 py-1.5 text-sm font-semibold text-white"
                                      style={{ background: "var(--green-dark)" }}
                                      onClick={() => dismissRadarItem(`demand:${row.date}`, "complete")}
                                    >
                                      Mark reviewed
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                      style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                      onClick={() => dismissRadarItem(`demand:${row.date}`, "ignore")}
                                    >
                                      Mute for 7 days
                                    </button>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </SectionCard>
                  ) : null}

                  <SectionCard
                    title="Priority Signals"
                    kicker="Top 3"
                    description="Start here. These are the three signals most worth acting on right now."
                    actions={
                      <button
                        type="button"
                        className="rounded-full border px-3.5 py-1.5 text-sm font-semibold"
                        style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                        onClick={jumpToFullSignalList}
                      >
                        Jump to full list
                      </button>
                    }
                  >
                    {homeDashboardReport.propertyDetective.length === 0 ? (
                      <EmptyState title="No priority signals right now" description="Your current filters are not surfacing any properties that need immediate follow-up." />
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {homeDashboardReport.propertyDetective.slice(0, 3).map((row) => (
                          <div key={`priority-${row.listingId}`} className="flex h-full min-w-0 flex-col rounded-[22px] border bg-white/78 p-3.5" style={{ borderColor: "var(--border)" }}>
                            <div className="flex min-w-0 flex-col gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <MetricBadge tone={row.severity === "high" ? "red" : "gold"}>{severityLabel(row.severity)}</MetricBadge>
                                <span className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide" style={{ background: "rgba(60,108,84,0.12)", color: "var(--green-dark)" }}>
                                  {signalHorizonLabel(row.daysToImpact)}
                                </span>
                              </div>
                              <h3 className="font-display text-[1.25rem] leading-tight break-words">{row.listingName}</h3>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {row.reason
                                .split(";")
                                .map((item) => item.trim())
                                .filter(Boolean)
                                .map((item) => (
                                  <span key={`${row.listingId}-${item}`} className="rounded-full px-2.5 py-1 text-[12px]" style={{ background: "rgba(176,122,25,0.11)", color: "var(--text)" }}>
                                    {item}
                                  </span>
                                ))}
                            </div>
                            {row.suggestions.length > 0 ? (
                              <ul className="mt-3 space-y-1.5 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                {row.suggestions.map((suggestion, index) => (
                                  <li key={`priority-suggestion-${row.listingId}-${index}`} className="flex gap-2">
                                    <span aria-hidden className="mt-1 inline-block h-1.5 w-1.5 flex-none rounded-full" style={{ background: "var(--green-dark)" }} />
                                    <span className="min-w-0 break-words">{suggestion}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            <div className="mt-auto flex flex-wrap gap-2 pt-3">
                              <button
                                type="button"
                                className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                onClick={() => {
                                  setDeepDiveFocusListingId(row.listingId);
                                  openDashboardTab("property_drilldown");
                                }}
                              >
                                Open drilldown
                              </button>
                              <button
                                type="button"
                                className="rounded-full px-3 py-1.5 text-sm font-semibold text-white"
                                style={{ background: "var(--green-dark)" }}
                                disabled={resolvingAttentionListingId === row.listingId}
                                onClick={() => void resolveAttentionTask(row.listingId, row.reasonKeys, "complete")}
                              >
                                Mark reviewed
                              </button>
                              <button
                                type="button"
                                className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                disabled={resolvingAttentionListingId === row.listingId}
                                onClick={() => void resolveAttentionTask(row.listingId, row.reasonKeys, "ignore")}
                              >
                                Mute for 7 days
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </SectionCard>

                  <SectionCard
                    id="signal-queue"
                    title="Signal Queue"
                    kicker="Action Priority"
                    description="Everything beyond the top three signals, ordered for quick triage without opening another page."
                    actions={
                      homeDashboardReport.propertyDetective.length > 9 ? (
                        <button
                          type="button"
                          className="rounded-full border px-3.5 py-1.5 text-sm font-semibold"
                          style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                          onClick={() => setShowAllSignals((current) => !current)}
                        >
                          {showAllSignals ? "Show fewer" : "Show all"}
                        </button>
                      ) : null
                    }
                  >
                    {homeDashboardReport.propertyDetective.length === 0 ? (
                      <EmptyState title="No active attention queue" description="Your current filters are not surfacing any properties that need immediate follow-up." />
                    ) : homeDashboardReport.propertyDetective.length <= 3 ? (
                      <EmptyState title="Top signals already cover the queue" description="All current signals are shown in the priority cards above, so there is nothing extra to triage below." />
                    ) : (
                      <div className="space-y-3">
                        {homeDashboardReport.propertyDetective.slice(3, showAllSignals ? undefined : 9).map((row) => (
                          <div key={row.listingId} className="min-w-0 rounded-[20px] border bg-white/75 px-3.5 py-3" style={{ borderColor: "var(--border)" }}>
                            <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <MetricBadge tone={row.severity === "high" ? "red" : "gold"}>{severityLabel(row.severity)}</MetricBadge>
                                  <span className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide" style={{ background: "rgba(60,108,84,0.12)", color: "var(--green-dark)" }}>
                                    {signalHorizonLabel(row.daysToImpact)}
                                  </span>
                                  <h3 className="min-w-0 break-words text-base font-semibold">{row.listingName}</h3>
                                </div>
                                <p className="mt-2 text-[13px] leading-5" style={{ color: "var(--text)" }}>
                                  {row.reason
                                    .split(";")
                                    .map((item) => item.trim())
                                    .filter(Boolean)
                                    .slice(0, 2)
                                    .join(" · ")}
                                </p>
                                {row.suggestions.length > 0 ? (
                                  <ul className="mt-2 space-y-1.5 text-[13px] leading-5" style={{ color: "var(--muted-text)" }}>
                                    {row.suggestions.map((suggestion, index) => (
                                      <li key={`queue-suggestion-${row.listingId}-${index}`} className="flex gap-2">
                                        <span aria-hidden className="mt-1 inline-block h-1.5 w-1.5 flex-none rounded-full" style={{ background: "var(--green-dark)" }} />
                                        <span className="min-w-0 break-words">{suggestion}</span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                              </div>
                              <div className="flex flex-wrap gap-2 lg:flex-none lg:flex-col lg:items-end">
                                <button
                                  type="button"
                                  className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                  style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                  onClick={() => {
                                    setDeepDiveFocusListingId(row.listingId);
                                    openDashboardTab("property_drilldown");
                                  }}
                                >
                                  Open drilldown
                                </button>
                                <button
                                  type="button"
                                  className="rounded-full px-3 py-1.5 text-sm font-semibold text-white"
                                  style={{ background: "var(--green-dark)" }}
                                  disabled={resolvingAttentionListingId === row.listingId}
                                  onClick={() => void resolveAttentionTask(row.listingId, row.reasonKeys, "complete")}
                                >
                                  Reviewed
                                </button>
                                <button
                                  type="button"
                                  className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                                  style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                                  disabled={resolvingAttentionListingId === row.listingId}
                                  onClick={() => void resolveAttentionTask(row.listingId, row.reasonKeys, "ignore")}
                                >
                                  Mute 7d
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </SectionCard>
                </>
              ) : tab === "property_groups" ? null : (
                <SectionCard title="Overview" kicker="No Data" description="Overview data is not available for the current filter set.">
                  <EmptyState title="Nothing to show yet" description="Try widening the dates, resetting filters, or running a fresh sync." />
                </SectionCard>
              )
            ) : tab === "property_drilldown" ? (
              <>
                <SectionCard
                  title="Property Drilldown"
                  kicker="Property-by-Property"
                  description="A single place to see property performance, while Pace Status always stays anchored to revenue vs the same point last year."
                >
                  {loadingReport ? (
                    <p className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(176,122,25,0.18)", background: "rgba(176,122,25,0.07)", color: "var(--mustard-dark)" }}>
                      Refreshing drilldown data. The current table stays visible while the latest comparison reloads.
                    </p>
                  ) : null}
                  <div className="grid gap-4 xl:grid-cols-4">
                    <SummaryCard
                      label="Comparison"
                      value={deepDiveCompareMode === "yoy_otb" ? "Same date last year" : "Last year finished"}
                      detail={comparisonScopeLabel(deepDiveReport?.meta.comparisonScope ?? null) ?? "Controls the revenue table reference. Pace Status always uses revenue vs the same point last year."}
                    />
                    <SummaryCard label="Grain" value={deepDiveGranularity === "month" ? "Monthly" : "Weekly"} detail="Choose the planning cadence that matches your review rhythm." tone="blue" />
                    <SummaryCard label="Behind" value={deepDiveSummary ? formatInteger(deepDiveSummary.behind) : "0"} detail="Properties that need immediate review." tone="gold" />
                    <SummaryCard label="Ahead" value={deepDiveSummary ? formatInteger(deepDiveSummary.ahead) : "0"} detail="Properties currently pacing stronger than the reference." />
                  </div>
                  <div className="mt-5 grid gap-4 xl:grid-cols-3">
                    <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Period Buckets
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(["week", "month"] as const).map((value) => (
                          <button
                            key={value}
                            type="button"
                            className="rounded-full px-3 py-2 text-sm"
                            style={deepDiveGranularity === value ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                            onClick={() => setDeepDiveGranularity(value)}
                          >
                            {value === "week" ? "Week" : "Month"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Forward Compare
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {([
                          { id: "yoy_otb", label: "Same date last year" },
                          { id: "ly_stayed", label: "Last year finished" }
                        ] as const).map((value) => (
                          <button
                            key={value.id}
                            type="button"
                            className="rounded-full px-3 py-2 text-sm"
                            style={deepDiveCompareMode === value.id ? { background: "var(--navy-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                            onClick={() => setDeepDiveCompareMode(value.id)}
                          >
                            {value.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Revenue Mode
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={includeFees ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                          onClick={() => setIncludeFees(true)}
                        >
                          Include fees
                        </button>
                        <button
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={!includeFees ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                          onClick={() => setIncludeFees(false)}
                        >
                          Exclude fees
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Select Period
                    </p>
                    {deepDiveGranularity === "month" ? (
                      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6 xl:grid-cols-12">
                        {deepDiveMonthOptions.map((month) => (
                          <button
                            key={month.month}
                            type="button"
                            className="rounded-2xl px-3 py-2 text-sm"
                            style={deepDiveSelectedMonth === month.month ? { background: "var(--mustard-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                            onClick={() => setDeepDiveSelectedMonth(month.month)}
                          >
                            {month.short}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 flex items-center gap-2">
                        <button type="button" className="rounded-full border px-3 py-2" style={{ borderColor: "var(--border)" }} onClick={() => setDeepDiveWeekWindowOffset((current) => current - 5)}>
                          Previous
                        </button>
                        <div className="grid flex-1 gap-2 sm:grid-cols-5">
                          {deepDiveWeekOptions.map((weekStart, index) => (
                            <button
                              key={toDateOnly(weekStart)}
                              type="button"
                              className="rounded-2xl px-3 py-2 text-sm"
                              style={deepDiveSelectedWeekIndex === index ? { background: "var(--mustard-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                              onClick={() => setDeepDiveSelectedWeekIndex(index)}
                            >
                              {formatIsoWeekLabel(weekStart)}
                            </button>
                          ))}
                        </div>
                        <button type="button" className="rounded-full border px-3 py-2" style={{ borderColor: "var(--border)" }} onClick={() => setDeepDiveWeekWindowOffset((current) => current + 5)}>
                          Next
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="mt-5 rounded-[24px] border bg-white/76 p-4" style={{ borderColor: "var(--border)" }}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Business Review
                        </p>
                        <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
                          {businessReviewSections.length > 0
                            ? `${formatInteger(businessReviewSections.length)} report section${businessReviewSections.length === 1 ? "" : "s"} queued`
                            : "Queue this drilldown into the PDF business review or export the detailed table directly."}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {businessReviewSections.length === 0 ? (
                          <button
                            type="button"
                            className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                            style={{ background: "var(--green-dark)" }}
                            disabled={addingCurrentViewToBusinessReview}
                            onClick={() => void addCurrentViewToBusinessReview()}
                          >
                            {addingCurrentViewToBusinessReview ? "Creating..." : "Create Business Review"}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="rounded-full border px-3.5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                              disabled={addingCurrentViewToBusinessReview}
                              onClick={() => void addCurrentViewToBusinessReview()}
                            >
                              {addingCurrentViewToBusinessReview ? "Adding..." : "Add to Business Review"}
                            </button>
                            <button
                              type="button"
                              className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                              style={{ background: "var(--navy-dark)" }}
                              disabled={exportingBusinessReview}
                              onClick={() => void handleExportBusinessReview()}
                            >
                              {exportingBusinessReview ? "Downloading..." : "Download Business Review"}
                            </button>
                            <button
                              type="button"
                              className="rounded-full border px-3.5 py-2 text-sm font-semibold"
                              style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                              onClick={() => setBusinessReviewManagerOpen(true)}
                            >
                              What&apos;s On So Far ({formatInteger(businessReviewSections.length)})
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                        style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                        disabled={exportingCurrentReportPdf}
                        onClick={() => void handleDownloadDeepDiveExport("pdf")}
                      >
                        {exportingCurrentReportPdf ? "Downloading PDF..." : "Download PDF"}
                      </button>
                      <button
                        type="button"
                        className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                        style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                        disabled={exportingCurrentCsv}
                        onClick={() => void handleDownloadDeepDiveExport("csv")}
                      >
                        {exportingCurrentCsv ? "Downloading CSV..." : "Download CSV"}
                      </button>
                    </div>

                    {deepDiveGranularity === "month" ? (
                      <div className="mt-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Months To Export
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {deepDiveMonthOptions.map((month) => {
                            const monthStart = toDateOnly(new Date(Date.UTC(currentYear, month.month - 1, 1)));
                            const active = deepDiveExportMonths.includes(monthStart);
                            return (
                              <button
                                key={`deep-dive-export-${monthStart}`}
                                type="button"
                                className="rounded-full px-3 py-1.5 text-sm"
                                style={active ? { background: "var(--mustard-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                                onClick={() =>
                                  setDeepDiveExportMonths((current) =>
                                    current.includes(monthStart) ? current.filter((value) => value !== monthStart) : [...current, monthStart].sort()
                                  )
                                }
                              >
                                {month.short}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {deepDiveReport && deepDiveReport.rows.length > 0 ? (
                    <div ref={deepDiveCaptureRef} className="mt-5 overflow-x-auto rounded-[24px] border bg-white/85 p-2" style={{ borderColor: "var(--border)" }}>
                      <table className="min-w-full border-collapse text-sm">
                        <thead>
                          <tr>
                            {["Property", "Pace Status", "Revenue", "ADR", "Occupancy", "Live Rate", "Calendar ADR vs last year"].map((label) => (
                              <th key={label} className="border-b px-3 py-3 text-left font-semibold" style={{ borderColor: "var(--border)" }}>
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {deepDiveReport.rows.map((row) => {
                            const highlighted = row.listingId === deepDiveFocusListingId;
                            const statusTone = row.health === "behind" ? "red" : row.health === "ahead" ? "green" : "blue";
                            const adrDelta = row.delta.adrPct === null ? null : row.current.adr - row.reference.adr;
                            const liveAdrDelta =
                              row.liveVsReferenceAdrPct === null || row.liveRate === null ? null : row.liveRate - row.reference.adr;
                            return (
                              <tr key={row.listingId} id={`deep-dive-row-${row.listingId}`} style={highlighted ? { background: "#fff7db" } : undefined}>
                                <td className="border-b px-3 py-3 font-medium" style={{ borderColor: "var(--border)" }}>
                                  {row.listingName}
                                </td>
                                <td className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
                                  <MetricBadge tone={statusTone}>
                                    {row.health === "behind" ? "Behind" : row.health === "ahead" ? "Ahead" : "On pace"}
                                  </MetricBadge>
                                </td>
                                <td className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
                                  <div>{formatCurrency(row.current.revenue, deepDiveReport.meta.displayCurrency)}</div>
                                  <div className="text-xs" style={percentDeltaStyle(row.delta.revenuePct)}>
                                    {formatSignedPercent(row.delta.revenuePct)} vs last year
                                  </div>
                                </td>
                                <td className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
                                  <div>{formatCurrency(row.current.adr, deepDiveReport.meta.displayCurrency)}</div>
                                  <div className="text-xs" style={valueDeltaStyle(adrDelta)}>
                                    {formatSignedCurrencyDelta(adrDelta, deepDiveReport.meta.displayCurrency)} vs last year
                                  </div>
                                </td>
                                <td className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
                                  <div>{formatPercent(row.current.occupancy)}</div>
                                  <div className="text-xs" style={pointsDeltaStyle(row.delta.occupancyPts)}>
                                    {formatSignedPoints(row.delta.occupancyPts)} vs last year
                                  </div>
                                </td>
                                <td className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
                                  {row.liveRate !== null ? formatCurrency(row.liveRate, deepDiveReport.meta.displayCurrency) : "—"}
                                </td>
                                <td className="border-b px-3 py-3" style={{ borderColor: "var(--border)", ...valueDeltaStyle(liveAdrDelta) }}>
                                  {formatSignedCurrencyDelta(liveAdrDelta, deepDiveReport.meta.displayCurrency)} vs last year
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="mt-5">
                      <EmptyState title="No properties matched this drilldown" description="Try widening the date lens or resetting filters to bring properties back into the comparison table." />
                    </div>
                  )}
                </SectionCard>
              </>
            ) : tab === "calendar" ? (
              <SectionCard
                title="Calendar Workspace"
                kicker="Opened Separately"
                description="Calendar now opens in a dedicated workspace tab so it can use almost the full window width and fit much more of the month on screen."
                actions={
                  <button
                    type="button"
                    className="rounded-full px-3.5 py-2 text-sm font-semibold text-white"
                    style={{ background: "var(--green-dark)" }}
                    onClick={() => openCalendarWorkspace()}
                  >
                    Open Calendar Workspace ↗
                  </button>
                }
              >
                <div className="rounded-[24px] border bg-white/82 p-5" style={{ borderColor: "var(--border)" }}>
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Why It Changed
                      </p>
                      <p className="mt-3 text-sm leading-6" style={{ color: "var(--text)" }}>
                        The dedicated workspace removes the usual dashboard width cap, margins, and sidebar squeeze so listings can stay down the left and dates can stretch across the top with a much denser month grid.
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {[
                          "Dedicated browser tab",
                          "Full-width layout",
                          "Compact month grid",
                          "Listings pinned left",
                          "Dates pinned top"
                        ].map((item) => (
                          <span
                            key={`calendar-workspace-pill-${item}`}
                            className="rounded-full border bg-white px-3 py-1.5 text-xs font-semibold"
                            style={{ borderColor: "var(--border)" }}
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-[20px] border bg-white/88 p-4" style={{ borderColor: "var(--border)" }}>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Current Workspace Lens
                      </p>
                      <div className="mt-3 space-y-2 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <span style={{ color: "var(--muted-text)" }}>Month</span>
                          <span className="font-semibold">{pricingCalendarReport?.month.label ?? formatDisplayDate(pricingCalendarSelectedMonthStart)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span style={{ color: "var(--muted-text)" }}>Pricing group</span>
                          <span className="font-semibold">{currentCalendarPricingGroup?.label ?? "All properties"}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span style={{ color: "var(--muted-text)" }}>Listings</span>
                          <span className="font-semibold">{pricingCalendarReport ? formatInteger(pricingCalendarReport.rows.length) : "0"}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span style={{ color: "var(--muted-text)" }}>Currency</span>
                          <span className="font-semibold">{displayCurrency}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </SectionCard>
            ) : tab === "booking_behaviour" ? (
              <SectionCard
                title="Booking Windows"
                kicker="Demand Mechanics"
                description="Use this view to separate what is changing in booking timing, cancellation pressure, and average stay length."
              >
                {loadingReport ? (
                  <p className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(176,122,25,0.18)", background: "rgba(176,122,25,0.07)", color: "var(--mustard-dark)" }}>
                    Refreshing booking window data. The current chart stays in place while the update completes.
                  </p>
                ) : null}
                <div className="grid gap-4 xl:grid-cols-4">
                  <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Period Anchor
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(["booked", "checked_in"] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={bookWindowMode === value ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                          onClick={() => setBookWindowMode(value)}
                        >
                          {value === "booked" ? "Booked" : "Checked-in"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Anchor Window
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {BOOK_WINDOW_LOOKBACK_DAY_OPTIONS.map((days) => (
                        <button
                          key={days}
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={
                            bookWindowRangeMode === "preset" && bookWindowLookbackDays === days
                              ? { background: "var(--mustard-dark)", color: "#ffffff" }
                              : { background: "white", border: "1px solid var(--border)" }
                          }
                          onClick={() => {
                            setBookWindowRangeMode("preset");
                            setBookWindowLookbackDays(days);
                          }}
                        >
                          {days}d
                        </button>
                      ))}
                      <button
                        type="button"
                        className="rounded-full px-3 py-2 text-sm"
                        style={
                          bookWindowRangeMode === "custom_month"
                            ? { background: "var(--mustard-dark)", color: "#ffffff" }
                            : { background: "white", border: "1px solid var(--border)" }
                        }
                        onClick={() => setBookWindowRangeMode("custom_month")}
                      >
                        Custom month
                      </button>
                    </div>
                    {bookWindowRangeMode === "custom_month" ? (
                      <div className="mt-3 space-y-2">
                        <input
                          type="month"
                          className="w-full rounded-2xl border bg-white px-3 py-2.5 text-sm"
                          style={{ borderColor: "var(--border)" }}
                          value={bookWindowCustomMonth}
                          onChange={(event) => {
                            setBookWindowRangeMode("custom_month");
                            setBookWindowCustomMonth(event.target.value);
                          }}
                        />
                        {bookWindowCustomDateRange ? (
                          <p className="text-xs" style={{ color: "var(--muted-text)" }}>
                            Showing {formatDisplayMonth(bookWindowCustomMonth)} anchored from {formatDisplayDate(bookWindowCustomDateRange.from)} to{" "}
                            {formatDisplayDate(bookWindowCustomDateRange.to)}.
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-3 text-xs" style={{ color: "var(--muted-text)" }}>
                        {bookWindowSelectionLabel}
                      </p>
                    )}
                  </div>
                  <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Overlay
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {([
                        { id: "adr", label: "ADR" },
                        { id: "cancellation_pct", label: "Cancellation %" },
                        { id: "avg_los", label: "Avg LOS" }
                      ] as const).map((value) => (
                        <button
                          key={value.id}
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={bookWindowLineMetric === value.id ? { background: "var(--navy-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                          onClick={() => setBookWindowLineMetric(value.id)}
                        >
                          {value.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Revenue Mode
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-full px-3 py-2 text-sm"
                        style={includeFees ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                        onClick={() => setIncludeFees(true)}
                      >
                        Include fees
                      </button>
                      <button
                        type="button"
                        className="rounded-full px-3 py-2 text-sm"
                        style={!includeFees ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                        onClick={() => setIncludeFees(false)}
                      >
                        Exclude fees
                      </button>
                    </div>
                  </div>
                </div>

                {bookWindowReport && hasBookWindowData(bookWindowReport) ? (
                  <>
                    <div className="mt-5 grid gap-4 xl:grid-cols-3">
                      <SummaryCard label="Total Nights" value={formatInteger(bookWindowReport.meta.totalNights)} detail="All nights that landed inside the selected booking window." />
                      <SummaryCard label="Reservations" value={formatInteger(bookWindowReport.meta.totalReservations)} detail="Bookings contributing to the booking window distribution." tone="blue" />
                      <SummaryCard
                        label="Top Window"
                        value={topBookWindow?.label ?? "—"}
                        detail={topBookWindow ? `${topBookWindow.nightsPct.toFixed(1)}% of all nights.` : "No booking window data available."}
                        tone="gold"
                      />
                    </div>

                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Business Review
                        </p>
                        <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
                          {businessReviewSections.length > 0
                            ? `${formatInteger(businessReviewSections.length)} report section${businessReviewSections.length === 1 ? "" : "s"} queued`
                            : "Queue this booking-window chart into the PDF business review."}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {businessReviewSections.length === 0 ? (
                          <button
                            type="button"
                            className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                            style={{ background: "var(--green-dark)" }}
                            disabled={addingCurrentViewToBusinessReview}
                            onClick={() => void addCurrentViewToBusinessReview()}
                          >
                            {addingCurrentViewToBusinessReview ? "Creating..." : "Create Business Review"}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="rounded-full border px-3.5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                              disabled={addingCurrentViewToBusinessReview}
                              onClick={() => void addCurrentViewToBusinessReview()}
                            >
                              {addingCurrentViewToBusinessReview ? "Adding..." : "Add to Business Review"}
                            </button>
                            <button
                              type="button"
                              className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                              style={{ background: "var(--navy-dark)" }}
                              disabled={exportingBusinessReview}
                              onClick={() => void handleExportBusinessReview()}
                            >
                              {exportingBusinessReview ? "Downloading..." : "Download Business Review"}
                            </button>
                            <button
                              type="button"
                              className="rounded-full border px-3.5 py-2 text-sm font-semibold"
                              style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                              onClick={() => setBusinessReviewManagerOpen(true)}
                            >
                              What&apos;s On So Far ({formatInteger(businessReviewSections.length)})
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div ref={bookWindowChartCaptureRef} className="mt-5 h-[420px] rounded-[28px] border bg-white/80 p-4" style={{ borderColor: "var(--border)" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={bookWindowChartData} margin={{ top: 12, right: 28, left: 12, bottom: 12 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                          <YAxis
                            yAxisId="left"
                            width={70}
                            tick={{ fontSize: 12 }}
                            tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                          />
                          <YAxis
                            yAxisId="right"
                            orientation="right"
                            width={96}
                            tick={{ fontSize: 12 }}
                            tickFormatter={(value) => {
                              const numeric = Number(value);
                              if (bookWindowLineMetric === "adr") {
                                return formatCurrencyCompact(numeric, bookWindowReport.meta.displayCurrency);
                              }
                              if (bookWindowLineMetric === "cancellation_pct") {
                                return `${numeric.toFixed(0)}%`;
                              }
                              return numeric.toFixed(1);
                            }}
                          />
                          <Tooltip
                            formatter={(value: number | string, name: string | number) => {
                              const numeric = typeof value === "number" ? value : Number(value);
                              const seriesName = String(name);
                              if (!Number.isFinite(numeric)) return ["—", seriesName];
                              if (seriesName === "% of Nights") return [`${numeric.toFixed(1)}%`, seriesName];
                              if (seriesName === "ADR") return [formatCurrency(numeric, bookWindowReport.meta.displayCurrency), seriesName];
                              if (seriesName === "Cancellation %") return [`${numeric.toFixed(1)}%`, seriesName];
                              return [numeric.toFixed(1), seriesName];
                            }}
                          />
                          <Legend />
                          <Bar yAxisId="left" name="% of Nights" dataKey="nightsPct" fill="var(--green-dark)" radius={[10, 10, 0, 0]}>
                            <LabelList
                              dataKey="nightsPct"
                              position="insideBottom"
                              offset={8}
                              fill="rgba(255,255,255,0.92)"
                              fontSize={11}
                              formatter={(value: number | string) => {
                                const numeric = typeof value === "number" ? value : Number(value);
                                return Number.isFinite(numeric) && numeric > 0 ? `${numeric.toFixed(1)}%` : "";
                              }}
                            />
                          </Bar>
                          <Line yAxisId="right" name={bookWindowLineMetric === "adr" ? "ADR" : bookWindowLineMetric === "cancellation_pct" ? "Cancellation %" : "Avg LOS"} dataKey="lineValue" stroke="var(--mustard-dark)" strokeWidth={2.5} dot={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>

                    <details className="mt-5 rounded-[24px] border bg-white/80 p-4" style={{ borderColor: "var(--border)" }}>
                      <summary className="cursor-pointer text-sm font-semibold">Open booking window detail table</summary>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                          style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                          disabled={exportingCurrentReportPdf}
                          onClick={() => void handleDownloadCurrentReportPdf()}
                        >
                          {exportingCurrentReportPdf ? "Downloading PDF..." : "Download PDF"}
                        </button>
                        <button
                          type="button"
                          className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                          style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                          disabled={exportingCurrentCsv}
                          onClick={handleDownloadCurrentCsv}
                        >
                          {exportingCurrentCsv ? "Downloading CSV..." : "Download CSV"}
                        </button>
                      </div>
                      <div className="mt-4 overflow-x-auto">
                        <table className="min-w-full border-collapse text-sm">
                          <thead>
                            <tr>
                              {["Book Window", "Nights", "Nights %", "Reservations", "Cancelled", "Cancellation %", "ADR", "Avg LOS"].map((label) => (
                                <th key={label} className="border-b px-3 py-2 text-left font-semibold" style={{ borderColor: "var(--border)" }}>
                                  {label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {bookWindowReport.buckets.map((bucket) => (
                              <tr key={bucket.key}>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{bucket.label}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatInteger(bucket.nights)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{bucket.nightsPct.toFixed(1)}%</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatInteger(bucket.reservations)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatInteger(bucket.cancelledReservations)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{bucket.cancellationPct.toFixed(1)}%</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatCurrency(bucket.adr, bookWindowReport.meta.displayCurrency)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{bucket.avgLos.toFixed(2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </>
                ) : (
                  <div className="mt-5">
                    <EmptyState title="No booking window data" description="Try a longer lookback window or widen the current filters." />
                  </div>
                )}
              </SectionCard>
            ) : tab === "signal_lab" ? (
              <SectionCard
                title="Signal Lab"
                kicker="Expert Workspace"
                description="This is the advanced layer. Mix up to three metrics and inspect the relationships without adding complexity to the core product."
              >
                {loadingReport ? (
                  <p className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(176,122,25,0.18)", background: "rgba(176,122,25,0.07)", color: "var(--mustard-dark)" }}>
                    Refreshing Signal Lab. The current chart stays visible while the new metric mix reloads.
                  </p>
                ) : null}
                <div className="grid gap-4 xl:grid-cols-4">
                  {Array.from({ length: 3 }, (_, index) => (
                    <div key={index} className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Metric {index + 1}
                      </p>
                      <select
                        className="mt-3 w-full rounded-2xl border bg-white px-3 py-2.5 text-sm outline-none"
                        style={{ borderColor: "var(--border)" }}
                        value={metricIds[index] ?? metricIds[0]}
                        onChange={(event) => setMetricIdAtIndex(index, event.target.value as MetricId)}
                      >
                        {metricDefinitions.map((definition) => (
                          <option key={definition.id} value={definition.id}>
                            {definition.name}
                          </option>
                        ))}
                      </select>
                      {metricIds[index] ? (
                        <p className="mt-3 text-sm leading-6" style={{ color: "var(--muted-text)" }}>
                          {metricDefinitionMap.get(metricIds[index])?.description}
                        </p>
                      ) : null}
                    </div>
                  ))}
                  <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Workspace Lens
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(["stay", "booking", "both"] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={metricDateMode === value ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                          onClick={() => setMetricDateMode(value)}
                        >
                          {value === "both" ? "Combined" : value === "stay" ? "Stay date" : "Booking date"}
                        </button>
                      ))}
                    </div>
                    <div className="mt-4">
                      <label className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                        Granularity
                        <select
                          className="mt-2 w-full rounded-2xl border bg-white px-3 py-2.5 text-sm outline-none"
                          style={{ borderColor: "var(--border)" }}
                          value={metricsGranularity}
                          onChange={(event) => setMetricsGranularity(event.target.value as Granularity)}
                        >
                          <option value="day">Day</option>
                          <option value="week">Week</option>
                          <option value="month">Month</option>
                        </select>
                      </label>
                    </div>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 xl:grid-cols-2">
                  <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Stay Range
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <input
                        type="date"
                        className="rounded-2xl border bg-white px-3 py-2.5 text-sm"
                        style={{ borderColor: "var(--border)" }}
                        value={metricsStayDateFrom}
                        onChange={(event) => setMetricsStayDateFrom(event.target.value)}
                      />
                      <input
                        type="date"
                        className="rounded-2xl border bg-white px-3 py-2.5 text-sm"
                        style={{ borderColor: "var(--border)" }}
                        value={metricsStayDateTo}
                        onChange={(event) => setMetricsStayDateTo(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Booking Range
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <input
                        type="date"
                        className="rounded-2xl border bg-white px-3 py-2.5 text-sm"
                        style={{ borderColor: "var(--border)" }}
                        value={metricsBookingDateFrom}
                        onChange={(event) => setMetricsBookingDateFrom(event.target.value)}
                      />
                      <input
                        type="date"
                        className="rounded-2xl border bg-white px-3 py-2.5 text-sm"
                        style={{ borderColor: "var(--border)" }}
                        value={metricsBookingDateTo}
                        onChange={(event) => setMetricsBookingDateTo(event.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {metricsReport && metricsReport.series.length > 0 ? (
                  <>
                    <div className="mt-5 grid gap-4 xl:grid-cols-3">
                      {metricsReport.series.map((series) => {
                        const latestValue = series.points.at(-1)?.value ?? 0;
                        return (
                          <SummaryCard
                            key={series.metricId}
                            label={series.name}
                            value={metricFormatterValue(latestValue, series.formatter, metricsReport.displayCurrency)}
                            detail={metricDefinitionMap.get(series.metricId)?.description ?? ""}
                            tone={series.domain === "rates" ? "gold" : series.domain === "mix" ? "blue" : "green"}
                          />
                        );
                      })}
                    </div>

                    <div className="mt-5 h-[420px] rounded-[28px] border bg-white/80 p-4" style={{ borderColor: "var(--border)" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={metricsChartData} margin={{ top: 12, right: 28, left: 12, bottom: 12 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                          <YAxis yAxisId="left" width={90} tick={{ fontSize: 12 }} tickFormatter={metricsLeftAxisFormatter} />
                          <YAxis yAxisId="right" orientation="right" width={90} tick={{ fontSize: 12 }} tickFormatter={metricsRightAxisFormatter} />
                          <Tooltip />
                          <Legend />
                          {metricsReport.series.map((series, index) => {
                            const yAxisId = metricsAxisAssignments[series.metricId] ?? "left";
                            if (series.chartKind === "bar") {
                              return (
                                <Bar
                                  key={series.metricId}
                                  yAxisId={yAxisId}
                                  name={series.name}
                                  dataKey={series.metricId}
                                  fill={CHART_COLORS[index % CHART_COLORS.length]}
                                  radius={[8, 8, 0, 0]}
                                />
                              );
                            }
                            return (
                              <Line
                                key={series.metricId}
                                yAxisId={yAxisId}
                                type="monotone"
                                name={series.name}
                                dataKey={series.metricId}
                                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                                strokeWidth={2.5}
                                dot={false}
                              />
                            );
                          })}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                ) : (
                  <div className="mt-5">
                    <EmptyState title="No advanced metrics yet" description="Pick one or more metrics and widen the date ranges if you want to explore a broader pattern." />
                  </div>
                )}
              </SectionCard>
            ) : (
              <SectionCard
                title={tabLabel(tab)}
                kicker={tab === "pace" ? "Forward Performance" : tab === "sales" ? "Stayed Performance" : "Booking Creation"}
                description="The core reports still have full depth, but the experience is now tuned for fast reading before you go deep."
              >
                {loadingReport ? (
                  <p className="rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: "rgba(176,122,25,0.18)", background: "rgba(176,122,25,0.07)", color: "var(--mustard-dark)" }}>
                    Refreshing {tabLabel(tab).toLowerCase()} data. The current report stays visible while the latest lens loads.
                  </p>
                ) : null}

                <div className="grid gap-3 xl:grid-cols-5">
                  <div className="rounded-[22px] border bg-white/70 p-3.5 xl:col-span-2" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      {tab === "booked" ? "Bookings Made" : "Date Range"}
                    </p>
                    {tab === "booked" ? (
                      <>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {([
                            { id: "last_day", label: "Last day" },
                            { id: "last_7_days", label: "7 days" },
                            { id: "last_30_days", label: "30 days" },
                            { id: "last_90_days", label: "90 days" },
                            { id: "last_year", label: "Year" },
                            { id: "custom", label: "Custom" }
                          ] as const).map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              className="rounded-full px-3 py-2 text-sm"
                              style={
                                bookedRangePreset === option.id
                                  ? { background: "rgba(176,122,25,0.14)", color: "var(--mustard-dark)" }
                                  : { background: "white", border: "1px solid var(--border)" }
                              }
                              onClick={() => applyBookedPreset(option.id)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        {bookedRangePreset === "custom" ? (
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <input
                              type="date"
                              className="rounded-2xl border bg-white px-3 py-2.5 text-sm"
                              style={{ borderColor: "var(--border)" }}
                              value={activeRange?.stayDateFrom ?? ""}
                              onChange={(event) => {
                                setBookedRangePreset("custom");
                                setDateRanges((current) => ({
                                  ...current,
                                  booked: {
                                    ...current.booked,
                                    stayDateFrom: event.target.value
                                  }
                                }));
                              }}
                            />
                            <input
                              type="date"
                              className="rounded-2xl border bg-white px-3 py-2.5 text-sm"
                              style={{ borderColor: "var(--border)" }}
                              value={activeRange?.stayDateTo ?? ""}
                              onChange={(event) => {
                                setBookedRangePreset("custom");
                                setDateRanges((current) => ({
                                  ...current,
                                  booked: {
                                    ...current.booked,
                                    stayDateTo: event.target.value
                                  }
                                }));
                              }}
                            />
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <input
                          type="date"
                          className="rounded-2xl border bg-white px-3 py-2.5 text-sm"
                          style={{ borderColor: "var(--border)" }}
                          value={activeRange?.stayDateFrom ?? ""}
                          onChange={(event) =>
                            setDateRanges((current) => ({
                              ...current,
                              [tab]: {
                                ...current[tab as keyof DateRangesByTab],
                                stayDateFrom: event.target.value
                              }
                            }))
                          }
                        />
                        <input
                          type="date"
                          className="rounded-2xl border bg-white px-3 py-2.5 text-sm"
                          style={{ borderColor: "var(--border)" }}
                          value={activeRange?.stayDateTo ?? ""}
                          onChange={(event) =>
                            setDateRanges((current) => ({
                              ...current,
                              [tab]: {
                                ...current[tab as keyof DateRangesByTab],
                                stayDateTo: event.target.value
                              }
                            }))
                          }
                        />
                      </div>
                    )}
                  </div>
                  <div className="rounded-[22px] border bg-white/70 p-3.5" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Grain
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(tab === "booked" ? (["day", "week", "month"] as const) : (["week", "month"] as const)).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={granularity === value ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                          onClick={() => setGranularity(value)}
                        >
                          {value[0].toUpperCase() + value.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-[22px] border bg-white/70 p-3.5" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Bars
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {([
                        { id: "nights", label: "Roomnights" },
                        { id: "revenue", label: "Revenue" },
                        ...(tab === "pace" || tab === "sales" ? [{ id: "occupancy" as const, label: "Occupancy" }] : [])
                      ] as const).map((value) => (
                        <button
                          key={value.id}
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={barMetric === value.id ? { background: "var(--navy-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                          onClick={() => setBarMetric(value.id)}
                        >
                          {value.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-[22px] border bg-white/70 p-3.5" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Revenue Mode
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-full px-3 py-2 text-sm"
                        style={includeFees ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                        onClick={() => setIncludeFees(true)}
                      >
                        Include fees
                      </button>
                      <button
                        type="button"
                        className="rounded-full px-3 py-2 text-sm"
                        style={!includeFees ? { background: "var(--green-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                        onClick={() => setIncludeFees(false)}
                      >
                        Exclude fees
                      </button>
                    </div>
                  </div>
                </div>

                {tab === "pace" ? (
                  <div className="mt-4 rounded-[24px] border bg-white/70 p-4" style={{ borderColor: "var(--border)" }}>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                      Pace Reference
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {([
                        { id: "yoy_otb", label: "Same date last year" },
                        { id: "ly_stayed", label: "Stayed bookings last year" }
                      ] as const).map((value) => (
                        <button
                          key={value.id}
                          type="button"
                          className="rounded-full px-3 py-2 text-sm"
                          style={paceCompareMode === value.id ? { background: "var(--mustard-dark)", color: "#ffffff" } : { background: "white", border: "1px solid var(--border)" }}
                          onClick={() => setPaceCompareMode(value.id)}
                        >
                          {value.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {legacyTotals && hasData(report) ? (
                  <>
                    <div className="mt-5 grid gap-4 xl:grid-cols-4">
                      <SummaryCard
                        label="Total Roomnights"
                        value={formatInteger(legacyTotals.totalCurrentNights)}
                        detail={reportRangeLabel ? `Selected range total for ${reportRangeLabel}` : "Selected range total"}
                      />
                      <SummaryCard
                        label="Total Revenue"
                        value={formatCurrency(legacyTotals.totalCurrentRevenue, report?.meta.displayCurrency ?? displayCurrency)}
                        detail={reportRangeLabel ? `Selected range total for ${reportRangeLabel}` : "Selected range total"}
                        tone="gold"
                      />
                      <SummaryCard
                        label="Average Rate"
                        value={formatCurrency(legacyTotals.totalCurrentAdr, report?.meta.displayCurrency ?? displayCurrency)}
                        detail={reportRangeLabel ? `Average over ${reportRangeLabel}` : "Average over the selected range"}
                        tone="blue"
                      />
                      <SummaryCard
                        label="Average Occupancy"
                        value={formatPercent(legacyTotals.totalCurrentOccupancy)}
                        detail={reportRangeLabel ? `Average over ${reportRangeLabel}` : "Average over the selected range"}
                      />
                    </div>

                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--muted-text)" }}>
                          Business Review
                        </p>
                        <p className="mt-1 text-sm" style={{ color: "var(--muted-text)" }}>
                          {businessReviewSections.length > 0
                            ? `${formatInteger(businessReviewSections.length)} report section${businessReviewSections.length === 1 ? "" : "s"} queued`
                            : "Build a PDF review by adding the reports you want to present."}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {businessReviewSections.length === 0 ? (
                          <button
                            type="button"
                            className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                            style={{ background: "var(--green-dark)" }}
                            disabled={addingCurrentViewToBusinessReview}
                            onClick={() => void addCurrentViewToBusinessReview()}
                          >
                            {addingCurrentViewToBusinessReview ? "Creating..." : "Create Business Review"}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="rounded-full border px-3.5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                              style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                              disabled={addingCurrentViewToBusinessReview}
                              onClick={() => void addCurrentViewToBusinessReview()}
                            >
                              {addingCurrentViewToBusinessReview ? "Adding..." : "Add to Business Review"}
                            </button>
                            <button
                              type="button"
                              className="rounded-full px-3.5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                              style={{ background: "var(--navy-dark)" }}
                              disabled={exportingBusinessReview}
                              onClick={() => void handleExportBusinessReview()}
                            >
                              {exportingBusinessReview ? "Downloading..." : "Download Business Review"}
                            </button>
                            <button
                              type="button"
                              className="rounded-full border px-3.5 py-2 text-sm font-semibold"
                              style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                              onClick={() => setBusinessReviewManagerOpen(true)}
                            >
                              What&apos;s On So Far ({formatInteger(businessReviewSections.length)})
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div ref={reportChartCaptureRef} className="mt-5 h-[420px] rounded-[28px] border bg-white/80 p-4" style={{ borderColor: "var(--border)" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={chartData} margin={{ top: 12, right: 28, left: 12, bottom: 12 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                          <XAxis dataKey="bucketLabel" tick={{ fontSize: 12 }} />
                          <YAxis
                            yAxisId="left"
                            width={96}
                            tick={{ fontSize: 12 }}
                            tickFormatter={(value) => {
                              const numeric = Number(value);
                              if (barMetric === "revenue") return formatCurrencyCompact(numeric, report?.meta.displayCurrency ?? displayCurrency);
                              if (barMetric === "occupancy") return `${numeric.toFixed(0)}%`;
                              return formatInteger(numeric);
                            }}
                          />
                          {barMetric !== "occupancy" ? (
                            <YAxis
                              yAxisId="right"
                              orientation="right"
                              width={96}
                              tick={{ fontSize: 12 }}
                              tickFormatter={(value) => formatCurrencyCompact(Number(value), report?.meta.displayCurrency ?? displayCurrency)}
                            />
                          ) : null}
                          <Tooltip
                            formatter={(value: number | string, name: string) => {
                              const numeric = typeof value === "number" ? value : Number(value);
                              if (name.includes("ADR")) return formatCurrency(numeric, report?.meta.displayCurrency ?? displayCurrency);
                              if (name.includes("Occupancy") || barMetric === "occupancy") return `${numeric.toFixed(1)}%`;
                              if (barMetric === "revenue") return formatCurrency(numeric, report?.meta.displayCurrency ?? displayCurrency);
                              return formatInteger(numeric);
                            }}
                          />
                          <Legend />
                          <Bar yAxisId="left" name={currentSeriesLabel} dataKey="currentBar" fill="var(--green-dark)" radius={[10, 10, 0, 0]} />
                          <Bar yAxisId="left" name={lastYearSeriesLabel} dataKey="lastYearBar" fill="var(--green-light)" radius={[10, 10, 0, 0]} />
                          {barMetric !== "occupancy" ? <Line yAxisId="right" type="monotone" name={currentAdrSeriesLabel} dataKey="currentADR" stroke="var(--mustard-dark)" strokeWidth={2.5} dot={false} /> : null}
                          {barMetric !== "occupancy" ? <Line yAxisId="right" type="monotone" name={lastYearAdrSeriesLabel} dataKey="lastYearADR" stroke="var(--mustard-light)" strokeWidth={2.5} dot={false} /> : null}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>

                    <details className="mt-5 rounded-[24px] border bg-white/80 p-4" style={{ borderColor: "var(--border)" }}>
                      <summary className="cursor-pointer text-sm font-semibold">Open detailed table</summary>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                          style={{ borderColor: "var(--border-strong)", color: "var(--green-dark)" }}
                          disabled={exportingCurrentReportPdf}
                          onClick={() => void handleDownloadCurrentReportPdf()}
                        >
                          {exportingCurrentReportPdf ? "Downloading PDF..." : "Download PDF"}
                        </button>
                        <button
                          type="button"
                          className="rounded-full border px-3 py-1.5 text-sm font-semibold"
                          style={{ borderColor: "var(--border-strong)", color: "var(--navy-dark)" }}
                          disabled={exportingCurrentCsv}
                          onClick={handleDownloadCurrentCsv}
                        >
                          {exportingCurrentCsv ? "Downloading CSV..." : "Download CSV"}
                        </button>
                      </div>
                      <div className="mt-4 overflow-x-auto">
                        <table className="min-w-full border-collapse text-sm">
                          <thead>
                            <tr>
                              {[
                                "Bucket",
                                `Roomnights ${currentSeriesLabel.toLowerCase()}`,
                                `Roomnights ${lastYearSeriesLabel.toLowerCase()}`,
                                `Revenue ${currentSeriesLabel.toLowerCase()}`,
                                `Revenue ${lastYearSeriesLabel.toLowerCase()}`,
                                tab === "sales" ? "ADR" : `ADR ${currentSeriesLabel.toLowerCase()}`,
                                tab === "sales" ? "ADR previous year" : `ADR ${lastYearSeriesLabel.toLowerCase()}`
                              ].map((label) => (
                                <th key={label} className="border-b px-3 py-2 text-left font-semibold" style={{ borderColor: "var(--border)" }}>
                                  {label}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {tableRows.map((row) => (
                              <tr key={row.bucketKey}>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{row.bucketLabel}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatInteger(row.currentNights)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatInteger(row.lastYearNights)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatCurrency(row.currentRevenue, report?.meta.displayCurrency ?? displayCurrency)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatCurrency(row.lastYearRevenue, report?.meta.displayCurrency ?? displayCurrency)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatCurrency(row.currentAdr, report?.meta.displayCurrency ?? displayCurrency)}</td>
                                <td className="border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>{formatCurrency(row.lastYearAdr, report?.meta.displayCurrency ?? displayCurrency)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </>
                ) : (
                  <div className="mt-5">
                    <EmptyState title="No report data for this lens" description="Try widening the date range, changing granularity, or refreshing your filters." />
                  </div>
                )}
              </SectionCard>
            )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
