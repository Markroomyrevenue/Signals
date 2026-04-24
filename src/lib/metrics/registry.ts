import { LEAD_TIME_BUCKETS, LOS_BUCKETS } from "@/lib/metrics/buckets";
import { MetricDataLoader } from "@/lib/metrics/data-loader";
import { dateToBucket, fromDateOnly, rangeToBuckets, resolveBookingRange, resolveStayRange } from "@/lib/metrics/helpers";
import { MetricDefinition, MetricId, MetricPoint, MetricQueryContext, MetricSeries } from "@/lib/metrics/types";

type StayBucketAggregate = {
  occupiedNights: number;
  availableNights: number;
  stayRevenue: number;
  liveRateSum: number;
  liveRateCount: number;
};

type BookingBucketAggregate = {
  bookingsCreated: number;
  bookedRevenue: number;
  cancellations: number;
};

function toPoints(
  values: Map<string, number>,
  orderedBuckets: string[]
): MetricPoint[] {
  return orderedBuckets.map((bucket) => ({
    x: bucket,
    value: values.get(bucket) ?? 0
  }));
}

async function buildStayBucketAggregates(
  loader: MetricDataLoader,
  context: MetricQueryContext
): Promise<{ buckets: string[]; aggregate: Map<string, StayBucketAggregate> }> {
  const range = resolveStayRange(context.filters);
  const granularity = loader.getGranularity();
  const stayDaily = await loader.getStayDaily();
  const availabilityDaily = await loader.getAvailabilityDaily();

  const buckets = rangeToBuckets(range.from, range.to, granularity);
  const aggregate = new Map<string, StayBucketAggregate>(
    buckets.map((bucket) => [
      bucket,
      {
        occupiedNights: 0,
        availableNights: 0,
        stayRevenue: 0,
        liveRateSum: 0,
        liveRateCount: 0
      }
    ])
  );

  const allDates = new Set<string>([...stayDaily.keys(), ...availabilityDaily.keys()]);
  for (const dateKey of allDates) {
    const date = fromDateOnly(dateKey);
    const bucket = dateToBucket(date, granularity);
    if (!aggregate.has(bucket)) continue;

    const current = aggregate.get(bucket)!;
    const stay = stayDaily.get(dateKey);
    const availability = availabilityDaily.get(dateKey);

    current.occupiedNights += stay?.occupiedNights ?? 0;
    current.stayRevenue += stay?.stayRevenue ?? 0;
    current.availableNights += availability?.availableNights ?? 0;
    current.liveRateSum += availability?.liveRateSum ?? 0;
    current.liveRateCount += availability?.liveRateCount ?? 0;
  }

  return {
    buckets,
    aggregate
  };
}

async function buildBookingBucketAggregates(
  loader: MetricDataLoader,
  context: MetricQueryContext
): Promise<{ buckets: string[]; aggregate: Map<string, BookingBucketAggregate> }> {
  const range = resolveBookingRange(context.filters);
  const granularity = loader.getGranularity();
  const bookingDaily = await loader.getBookingDaily();

  const buckets = rangeToBuckets(range.from, range.to, granularity);
  const aggregate = new Map<string, BookingBucketAggregate>(
    buckets.map((bucket) => [
      bucket,
      {
        bookingsCreated: 0,
        bookedRevenue: 0,
        cancellations: 0
      }
    ])
  );

  for (const [dateKey, value] of bookingDaily.entries()) {
    const bucket = dateToBucket(fromDateOnly(dateKey), granularity);
    if (!aggregate.has(bucket)) continue;

    const current = aggregate.get(bucket)!;
    current.bookingsCreated += value.bookingsCreated;
    current.bookedRevenue += value.bookedRevenue;
    current.cancellations += value.cancellations;
  }

  return {
    buckets,
    aggregate
  };
}

async function stayMetricSeries(
  context: MetricQueryContext,
  metricId: MetricId,
  name: string,
  formatter: "number" | "percent" | "currency",
  compute: (value: StayBucketAggregate) => number,
  chartKind: "line" | "bar" = "line"
): Promise<MetricSeries> {
  const { buckets, aggregate } = await buildStayBucketAggregates(context.loader, context);
  const values = new Map<string, number>();

  for (const [bucket, value] of aggregate.entries()) {
    values.set(bucket, compute(value));
  }

  return {
    metricId,
    name,
    formatter,
    domain: metricId === "live_rate" || metricId === "rate_index_vs_booked_adr" ? "rates" : "stay",
    chartKind,
    points: toPoints(values, buckets)
  };
}

async function bookingMetricSeries(
  context: MetricQueryContext,
  metricId: MetricId,
  name: string,
  formatter: "number" | "percent" | "currency",
  compute: (value: BookingBucketAggregate) => number,
  chartKind: "line" | "bar" = "line"
): Promise<MetricSeries> {
  const { buckets, aggregate } = await buildBookingBucketAggregates(context.loader, context);
  const values = new Map<string, number>();

  for (const [bucket, value] of aggregate.entries()) {
    values.set(bucket, compute(value));
  }

  return {
    metricId,
    name,
    formatter,
    domain: "book",
    chartKind,
    points: toPoints(values, buckets)
  };
}

const METRICS: MetricDefinition[] = [
  {
    id: "occupied_nights",
    name: "Occupied Nights",
    description: "Stayed occupied nights",
    domain: "stay",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "bar",
    query: (context) =>
      stayMetricSeries(
        context,
        "occupied_nights",
        "Occupied Nights",
        "number",
        (value) => value.occupiedNights,
        "bar"
      )
  },
  {
    id: "available_nights",
    name: "Available Nights",
    description: "Available nights from calendar rates",
    domain: "stay",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "bar",
    query: (context) =>
      stayMetricSeries(
        context,
        "available_nights",
        "Available Nights",
        "number",
        (value) => value.availableNights,
        "bar"
      )
  },
  {
    id: "occupancy_pct",
    name: "Occupancy %",
    description: "Occupied nights / available nights",
    domain: "stay",
    grains: ["day", "week", "month"],
    formatter: "percent",
    chartKind: "line",
    query: (context) =>
      stayMetricSeries(context, "occupancy_pct", "Occupancy %", "percent", (value) =>
        value.availableNights > 0 ? value.occupiedNights / value.availableNights : 0
      )
  },
  {
    id: "stay_revenue",
    name: "Stay Revenue",
    description: "Nightly allocated stay revenue",
    domain: "stay",
    grains: ["day", "week", "month"],
    formatter: "currency",
    chartKind: "bar",
    query: (context) =>
      stayMetricSeries(context, "stay_revenue", "Stay Revenue", "currency", (value) => value.stayRevenue, "bar")
  },
  {
    id: "adr_stay",
    name: "ADR (Stay)",
    description: "Stay revenue / occupied nights",
    domain: "stay",
    grains: ["day", "week", "month"],
    formatter: "currency",
    chartKind: "line",
    query: (context) =>
      stayMetricSeries(context, "adr_stay", "ADR (Stay)", "currency", (value) =>
        value.occupiedNights > 0 ? value.stayRevenue / value.occupiedNights : 0
      )
  },
  {
    id: "revpar",
    name: "RevPAR",
    description: "Stay revenue / available nights",
    domain: "stay",
    grains: ["day", "week", "month"],
    formatter: "currency",
    chartKind: "line",
    query: (context) =>
      stayMetricSeries(context, "revpar", "RevPAR", "currency", (value) =>
        value.availableNights > 0 ? value.stayRevenue / value.availableNights : 0
      )
  },
  {
    id: "bookings_created_count",
    name: "Bookings Created",
    description: "Bookings by booking date",
    domain: "book",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "bar",
    query: (context) =>
      bookingMetricSeries(
        context,
        "bookings_created_count",
        "Bookings Created",
        "number",
        (value) => value.bookingsCreated,
        "bar"
      )
  },
  {
    id: "booked_revenue_by_booking_date",
    name: "Booked Revenue",
    description: "Booked revenue by booking date",
    domain: "book",
    grains: ["day", "week", "month"],
    formatter: "currency",
    chartKind: "bar",
    query: (context) =>
      bookingMetricSeries(
        context,
        "booked_revenue_by_booking_date",
        "Booked Revenue",
        "currency",
        (value) => value.bookedRevenue,
        "bar"
      )
  },
  {
    id: "booked_revenue_by_booking_window",
    name: "Booked Revenue by Booking Window",
    description: "Booked revenue grouped by lead-time bucket",
    domain: "book",
    grains: ["day", "week", "month"],
    formatter: "currency",
    chartKind: "bar",
    query: async (context) => {
      const bucketStats = await context.loader.getBookingWindowBuckets();

      return {
        metricId: "booked_revenue_by_booking_window",
        name: "Booked Revenue by Booking Window",
        formatter: "currency",
        domain: "book",
        chartKind: "bar",
        points: LEAD_TIME_BUCKETS.map((bucket) => ({
          x: bucket.id,
          value: bucketStats.get(bucket.id)?.bookedRevenue ?? 0
        }))
      };
    }
  },
  {
    id: "booked_nights_by_booking_window",
    name: "Booked Nights by Booking Window",
    description: "Booked nights grouped by lead-time bucket",
    domain: "book",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "bar",
    query: async (context) => {
      const bucketStats = await context.loader.getBookingWindowBuckets();

      return {
        metricId: "booked_nights_by_booking_window",
        name: "Booked Nights by Booking Window",
        formatter: "number",
        domain: "book",
        chartKind: "bar",
        points: LEAD_TIME_BUCKETS.map((bucket) => ({
          x: bucket.id,
          value: bucketStats.get(bucket.id)?.bookedNights ?? 0
        }))
      };
    }
  },
  {
    id: "booked_nights_by_los_bucket",
    name: "Booked Nights by LOS Bucket",
    description: "Booked nights grouped by LOS bucket",
    domain: "book",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "bar",
    query: async (context) => {
      const bucketStats = await context.loader.getBookedNightsByLosBucket();

      return {
        metricId: "booked_nights_by_los_bucket",
        name: "Booked Nights by LOS Bucket",
        formatter: "number",
        domain: "book",
        chartKind: "bar",
        points: LOS_BUCKETS.map((bucket) => ({
          x: bucket.id,
          value: bucketStats.get(bucket.id) ?? 0
        }))
      };
    }
  },
  {
    id: "cancellation_rate",
    name: "Cancellation Rate",
    description: "Cancellations / bookings created",
    domain: "book",
    grains: ["day", "week", "month"],
    formatter: "percent",
    chartKind: "line",
    query: (context) =>
      bookingMetricSeries(context, "cancellation_rate", "Cancellation Rate", "percent", (value) =>
        value.bookingsCreated > 0 ? value.cancellations / value.bookingsCreated : 0
      )
  },
  {
    id: "adr_by_booking_window",
    name: "ADR by Booking Window",
    description: "ADR grouped by lead-time bucket",
    domain: "book",
    grains: ["day", "week", "month"],
    formatter: "currency",
    chartKind: "line",
    query: async (context) => {
      const bucketStats = await context.loader.getBookingWindowBuckets();

      return {
        metricId: "adr_by_booking_window",
        name: "ADR by Booking Window",
        formatter: "currency",
        domain: "book",
        chartKind: "line",
        points: LEAD_TIME_BUCKETS.map((bucket) => ({
          x: bucket.id,
          value: bucketStats.get(bucket.id)?.adr ?? 0
        }))
      };
    }
  },
  {
    id: "avg_los_by_booking_window",
    name: "Average LOS by Booking Window",
    description: "Average LOS grouped by lead-time bucket",
    domain: "book",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "line",
    query: async (context) => {
      const bucketStats = await context.loader.getBookingWindowBuckets();

      return {
        metricId: "avg_los_by_booking_window",
        name: "Average LOS by Booking Window",
        formatter: "number",
        domain: "book",
        chartKind: "line",
        points: LEAD_TIME_BUCKETS.map((bucket) => ({
          x: bucket.id,
          value: bucketStats.get(bucket.id)?.avgLos ?? 0
        }))
      };
    }
  },
  {
    id: "pace_on_books_nights",
    name: "Pace On-Books Nights",
    description: "Nights on books by selected snapshot",
    domain: "pace",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "bar",
    query: async (context) => {
      const granularity = context.loader.getGranularity();
      const range = resolveStayRange(context.filters);
      const buckets = rangeToBuckets(range.from, range.to, granularity);
      const values = new Map<string, number>(buckets.map((bucket) => [bucket, 0]));

      const pace = await context.loader.getPaceForSnapshot();
      for (const [dateKey, value] of pace.daily.entries()) {
        const bucket = dateToBucket(fromDateOnly(dateKey), granularity);
        values.set(bucket, (values.get(bucket) ?? 0) + value.nightsOnBooks);
      }

      return {
        metricId: "pace_on_books_nights",
        name: "Pace On-Books Nights",
        formatter: "number",
        domain: "pace",
        chartKind: "bar",
        points: toPoints(values, buckets)
      };
    }
  },
  {
    id: "pickup_between_snapshots",
    name: "Pickup Between Snapshots",
    description: "Delta nights between two snapshots",
    domain: "pace",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "bar",
    query: async (context) => {
      const granularity = context.loader.getGranularity();
      const range = resolveStayRange(context.filters);
      const buckets = rangeToBuckets(range.from, range.to, granularity);
      const values = new Map<string, number>(buckets.map((bucket) => [bucket, 0]));

      const pickup = await context.loader.getPickupBetweenSnapshots();
      for (const [dateKey, value] of pickup.daily.entries()) {
        const bucket = dateToBucket(fromDateOnly(dateKey), granularity);
        values.set(bucket, (values.get(bucket) ?? 0) + value.pickupNights);
      }

      return {
        metricId: "pickup_between_snapshots",
        name: "Pickup Between Snapshots",
        formatter: "number",
        domain: "pace",
        chartKind: "bar",
        points: toPoints(values, buckets)
      };
    }
  },
  {
    id: "live_rate",
    name: "Live Rate",
    description: "Average available live rate from calendar",
    domain: "rates",
    grains: ["day", "week", "month"],
    formatter: "currency",
    chartKind: "line",
    query: (context) =>
      stayMetricSeries(context, "live_rate", "Live Rate", "currency", (value) =>
        value.liveRateCount > 0 ? value.liveRateSum / value.liveRateCount : 0
      )
  },
  {
    id: "rate_index_vs_booked_adr",
    name: "Rate Index vs Booked ADR",
    description: "Live rate divided by booked ADR",
    domain: "rates",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "line",
    query: (context) =>
      stayMetricSeries(context, "rate_index_vs_booked_adr", "Rate Index vs Booked ADR", "number", (value) => {
        const liveRate = value.liveRateCount > 0 ? value.liveRateSum / value.liveRateCount : 0;
        const adr = value.occupiedNights > 0 ? value.stayRevenue / value.occupiedNights : 0;
        return adr > 0 ? liveRate / adr : 0;
      })
  },
  {
    id: "channel_mix_bookings",
    name: "Channel Mix (Bookings)",
    description: "Bookings grouped by channel",
    domain: "mix",
    grains: ["day", "week", "month"],
    formatter: "number",
    chartKind: "bar",
    query: async (context) => {
      const mix = await context.loader.getChannelMixBookings();
      const points = [...mix.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([channel, bookings]) => ({
          x: channel,
          value: bookings
        }));

      return {
        metricId: "channel_mix_bookings",
        name: "Channel Mix (Bookings)",
        formatter: "number",
        domain: "mix",
        chartKind: "bar",
        points
      };
    }
  }
];

const METRIC_MAP = new Map<MetricId, MetricDefinition>(METRICS.map((metric) => [metric.id, metric]));

export function getMetricDefinition(metricId: MetricId): MetricDefinition | null {
  return METRIC_MAP.get(metricId) ?? null;
}

export function listMetricDefinitions(): MetricDefinition[] {
  return METRICS;
}
