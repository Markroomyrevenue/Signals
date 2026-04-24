export type MetricDomain = "stay" | "book" | "pace" | "rates" | "mix";
export type MetricFormatter = "number" | "percent" | "currency";
export type MetricGrain = "day" | "week" | "month";
export type MetricChartKind = "line" | "bar";

export type MetricId =
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

export type DateMode = "stay" | "booking" | "both";

export type MetricFilters = {
  dateMode?: DateMode;
  stayDateFrom?: string;
  stayDateTo?: string;
  bookingDateFrom?: string;
  bookingDateTo?: string;
  listingIds?: string[];
  channels?: string[];
  statuses?: string[];
  leadTimeBuckets?: string[];
  losBuckets?: string[];
  daysOfWeek?: number[];
  months?: number[];
  years?: number[];
  seasons?: Array<"winter" | "spring" | "summer" | "autumn">;
  granularity?: MetricGrain;
  paceSnapshotDate?: string;
  pickupSnapshotStart?: string;
  pickupSnapshotEnd?: string;
};

export type MetricPoint = {
  x: string;
  value: number;
};

export type MetricSeries = {
  metricId: MetricId;
  name: string;
  formatter: MetricFormatter;
  domain: MetricDomain;
  chartKind: MetricChartKind;
  points: MetricPoint[];
};

export type MetricQueryResult = {
  xKey: "x";
  series: MetricSeries[];
  meta?: Record<string, unknown>;
};

export type MetricQueryContext = {
  tenantId: string;
  filters: MetricFilters;
  displayCurrency: string;
  loader: MetricDataLoader;
};

export type MetricDefinition = {
  id: MetricId;
  name: string;
  description: string;
  domain: MetricDomain;
  grains: MetricGrain[];
  formatter: MetricFormatter;
  chartKind: MetricChartKind;
  query: (context: MetricQueryContext) => Promise<MetricSeries>;
};
import type { MetricDataLoader } from "@/lib/metrics/data-loader";
