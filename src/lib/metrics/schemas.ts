import { z } from "zod";

export const metricIdSchema = z.enum([
  "occupied_nights",
  "available_nights",
  "occupancy_pct",
  "stay_revenue",
  "adr_stay",
  "revpar",
  "bookings_created_count",
  "booked_revenue_by_booking_date",
  "booked_revenue_by_booking_window",
  "booked_nights_by_booking_window",
  "booked_nights_by_los_bucket",
  "cancellation_rate",
  "adr_by_booking_window",
  "avg_los_by_booking_window",
  "pace_on_books_nights",
  "pickup_between_snapshots",
  "live_rate",
  "rate_index_vs_booked_adr",
  "channel_mix_bookings"
]);

const filtersSchema = z.object({
  dateMode: z.enum(["stay", "booking", "both"]).optional(),
  stayDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  stayDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bookingDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bookingDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  listingIds: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  statuses: z.array(z.string()).optional(),
  leadTimeBuckets: z.array(z.string()).optional(),
  losBuckets: z.array(z.string()).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  months: z.array(z.number().int().min(1).max(12)).optional(),
  years: z.array(z.number().int().min(2000).max(2100)).optional(),
  seasons: z.array(z.enum(["winter", "spring", "summer", "autumn"])).optional(),
  granularity: z.enum(["day", "week", "month"]).optional(),
  compareMode: z.enum(["none", "previous_period", "yoy"]).optional(),
  paceSnapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  pickupSnapshotStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  pickupSnapshotEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export const metricsRequestSchema = z.object({
  metricIds: z.array(metricIdSchema).min(1).max(3),
  filters: filtersSchema.default({}),
  displayCurrency: z.string().length(3).optional()
});
