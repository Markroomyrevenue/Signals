import { z } from "zod";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const reportsRequestSchema = z.object({
  stayDateFrom: dateOnlySchema,
  stayDateTo: dateOnlySchema,
  granularity: z.enum(["day", "week", "month"]).default("month"),
  listingIds: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  includeFees: z.boolean().default(true),
  activeBeforeDate: dateOnlySchema.optional(),
  barMetric: z.enum(["nights", "revenue", "occupancy"]).default("revenue"),
  compareMode: z.enum(["yoy_otb", "ly_stayed"]).default("yoy_otb"),
  displayCurrency: z.string().length(3).optional(),
  snapshotDate: dateOnlySchema.optional()
});

export type ReportsRequest = z.infer<typeof reportsRequestSchema>;

export const bookWindowRequestSchema = z.object({
  mode: z.enum(["booked", "checked_in"]).default("booked"),
  lookbackDays: z.union([
    z.literal(7),
    z.literal(14),
    z.literal(30),
    z.literal(90),
    z.literal(180),
    z.literal(365)
  ]).default(30),
  customDateFrom: dateOnlySchema.optional(),
  customDateTo: dateOnlySchema.optional(),
  listingIds: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  includeFees: z.boolean().default(true),
  displayCurrency: z.string().length(3).optional()
}).superRefine((value, ctx) => {
  const hasCustomDateFrom = Boolean(value.customDateFrom);
  const hasCustomDateTo = Boolean(value.customDateTo);

  if (hasCustomDateFrom !== hasCustomDateTo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Custom booking window ranges require both a start and end date.",
      path: [hasCustomDateFrom ? "customDateTo" : "customDateFrom"]
    });
  }

  if (value.customDateFrom && value.customDateTo && value.customDateFrom > value.customDateTo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Custom booking window start date must be on or before the end date.",
      path: ["customDateTo"]
    });
  }
});

export type BookWindowRequest = z.infer<typeof bookWindowRequestSchema>;

export const homeDashboardRequestSchema = z.object({
  listingIds: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  includeFees: z.boolean().default(true),
  activeBeforeDate: dateOnlySchema.optional(),
  bookedCustomDateFrom: dateOnlySchema.optional(),
  bookedCustomDateTo: dateOnlySchema.optional(),
  stayedCustomDateFrom: dateOnlySchema.optional(),
  stayedCustomDateTo: dateOnlySchema.optional(),
  focusFinderUseFilteredScope: z.boolean().default(false),
  displayCurrency: z.string().length(3).optional()
});

export type HomeDashboardRequest = z.infer<typeof homeDashboardRequestSchema>;

export const reservationsReportRequestSchema = z.object({
  bookingDateFrom: dateOnlySchema,
  bookingDateTo: dateOnlySchema,
  listingIds: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  includeFees: z.boolean().default(true),
  activeBeforeDate: dateOnlySchema.optional(),
  displayCurrency: z.string().length(3).optional()
});

export type ReservationsReportRequest = z.infer<typeof reservationsReportRequestSchema>;

export const propertyDeepDiveRequestSchema = z.object({
  granularity: z.enum(["week", "month"]).default("month"),
  compareMode: z.enum(["yoy_otb", "ly_stayed"]).default("yoy_otb"),
  selectedPeriodStart: dateOnlySchema.optional(),
  listingIds: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  includeFees: z.boolean().default(true),
  activeBeforeDate: dateOnlySchema.optional(),
  displayCurrency: z.string().length(3).optional()
});

export type PropertyDeepDiveRequest = z.infer<typeof propertyDeepDiveRequestSchema>;

export const pricingCalendarRequestSchema = z.object({
  selectedMonthStart: dateOnlySchema,
  pricingGroupName: z.string().trim().min(1).max(60).optional(),
  forceMarketRefresh: z.boolean().default(false),
  listingIds: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  activeBeforeDate: dateOnlySchema.optional(),
  displayCurrency: z.string().length(3).optional()
});

export type PricingCalendarRequest = z.infer<typeof pricingCalendarRequestSchema>;
