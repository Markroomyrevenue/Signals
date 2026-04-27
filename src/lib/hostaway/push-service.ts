import type { Prisma } from "@prisma/client";

import { fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { loadResolvedPricingSettings } from "@/lib/pricing/settings";
import { buildPricingCalendarReport } from "@/lib/reports/service";
import {
  getHostawayPushClientForTenant,
  HostawayPushError,
  type HostawayCalendarPushRate
} from "@/lib/hostaway/push";
import { prisma } from "@/lib/prisma";

// All work that the API route does — extracted so it is unit-testable.
// No NextResponse here, no auth here — those live in the route handler.

export type PushRatesPreviewItem = {
  date: string;
  currentRate: number | null;
  recommendedRate: number;
};

export type PushRatesPreview = {
  listingId: string;
  hostawayId: string;
  dateFrom: string;
  dateTo: string;
  count: number;
  dates: PushRatesPreviewItem[];
  displayCurrency: string;
};

export class PushRatesError extends Error {
  readonly status: number;
  readonly responseBody?: string;
  constructor(message: string, status: number, responseBody?: string) {
    super(message);
    this.name = "PushRatesError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonthsUtc(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function eachMonthStart(fromIso: string, toIso: string): string[] {
  const from = startOfMonthUtc(fromDateOnly(fromIso));
  const to = startOfMonthUtc(fromDateOnly(toIso));
  const months: string[] = [];
  for (let cursor = from; cursor.getTime() <= to.getTime(); cursor = addMonthsUtc(cursor, 1)) {
    months.push(toDateOnly(cursor));
  }
  return months;
}

export async function buildPushRatesPreview(args: {
  tenantId: string;
  listingId: string;
  dateFrom: string;
  dateTo: string;
  displayCurrency?: string;
}): Promise<PushRatesPreview> {
  if (args.dateFrom > args.dateTo) {
    throw new PushRatesError("dateFrom must be on or before dateTo", 400);
  }

  // Tenant-scoped lookup. We never trust the listingId from the request
  // until we've verified ownership.
  const listing = await prisma.listing.findFirst({
    where: { id: args.listingId, tenantId: args.tenantId },
    select: { id: true, hostawayId: true, tags: true }
  });

  if (!listing) {
    throw new PushRatesError("Listing not found for this tenant", 404);
  }

  // Server-side gate: verify the toggle is on for THIS listing scope.
  const settingsByListingId = await loadResolvedPricingSettings({
    tenantId: args.tenantId,
    listings: [{ listingId: listing.id, tags: listing.tags }]
  });

  const settings = settingsByListingId.get(listing.id)?.settings;
  if (!settings || settings.hostawayPushEnabled !== true) {
    throw new PushRatesError(
      "Pushing live rates to Hostaway is not enabled for this listing",
      403
    );
  }

  // Walk one or more months covering [dateFrom, dateTo] and collect the
  // recommended-rate cell values per date. We rely on the existing
  // pricing-calendar pipeline so the formula stays single-sourced.
  const monthStarts = eachMonthStart(args.dateFrom, args.dateTo);
  const tenantRow = await prisma.tenant.findUnique({
    where: { id: args.tenantId },
    select: { defaultCurrency: true }
  });
  const displayCurrency = (args.displayCurrency ?? tenantRow?.defaultCurrency ?? "GBP").toUpperCase();

  const cellsByDate = new Map<string, { recommendedRate: number | null; liveRate: number | null }>();

  for (const monthStart of monthStarts) {
    const report = await buildPricingCalendarReport({
      tenantId: args.tenantId,
      request: {
        selectedMonthStart: monthStart,
        forceMarketRefresh: false,
        listingIds: [listing.id],
        channels: [],
        statuses: [],
        displayCurrency
      },
      displayCurrency
    });

    const matchingRow = report.rows.find((r) => r.listingId === listing.id);
    if (!matchingRow) continue;

    for (const cell of matchingRow.cells) {
      if (cell.date < args.dateFrom || cell.date > args.dateTo) continue;
      cellsByDate.set(cell.date, {
        recommendedRate: cell.recommendedRate,
        liveRate: cell.liveRate
      });
    }
  }

  // Filter to dates that have a usable recommended rate. Booked dates are
  // intentionally skipped — the channel manager won't accept rate changes
  // on a booked night anyway, and surfacing a "push" for them would be
  // misleading to the owner.
  const dates: PushRatesPreviewItem[] = [];
  for (const [date, value] of [...cellsByDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (value.recommendedRate === null || !Number.isFinite(value.recommendedRate)) continue;
    dates.push({
      date,
      currentRate: value.liveRate ?? null,
      recommendedRate: Math.round(value.recommendedRate * 100) / 100
    });
  }

  return {
    listingId: listing.id,
    hostawayId: listing.hostawayId,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    count: dates.length,
    dates,
    displayCurrency
  };
}

export type PushRatesResult =
  | {
      ok: true;
      pushedCount: number;
      preview: PushRatesPreview;
      eventId: string;
    }
  | {
      ok: false;
      pushedCount: 0;
      preview: PushRatesPreview;
      eventId: string;
      errorMessage: string;
    };

export async function executePushRates(args: {
  tenantId: string;
  listingId: string;
  pushedBy: string;
  dateFrom: string;
  dateTo: string;
  displayCurrency?: string;
  fetchImpl?: typeof fetch;
}): Promise<PushRatesResult> {
  const preview = await buildPushRatesPreview({
    tenantId: args.tenantId,
    listingId: args.listingId,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    displayCurrency: args.displayCurrency
  });

  if (preview.count === 0) {
    // Nothing to push — but still record the attempt so the audit trail
    // is honest. Status "skipped" is distinct from "failed".
    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: args.tenantId,
        listingId: preview.listingId,
        pushedBy: args.pushedBy,
        dateFrom: fromDateOnly(preview.dateFrom),
        dateTo: fromDateOnly(preview.dateTo),
        dateCount: 0,
        status: "skipped",
        errorMessage: "No recommendable dates in range",
        payload: previewToJson(preview)
      }
    });
    return { ok: true, pushedCount: 0, preview, eventId: event.id };
  }

  const pushClient = await getHostawayPushClientForTenant({
    tenantId: args.tenantId,
    hostawayListingId: preview.hostawayId,
    fetchImpl: args.fetchImpl
  });

  const rates: HostawayCalendarPushRate[] = preview.dates.map((entry) => ({
    date: entry.date,
    dailyPrice: entry.recommendedRate
  }));

  try {
    const result = await pushClient.pushCalendarRatesBatch({
      dateFrom: preview.dateFrom,
      dateTo: preview.dateTo,
      rates
    });

    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: args.tenantId,
        listingId: preview.listingId,
        pushedBy: args.pushedBy,
        dateFrom: fromDateOnly(preview.dateFrom),
        dateTo: fromDateOnly(preview.dateTo),
        dateCount: result.pushedCount,
        status: "success",
        errorMessage: null,
        payload: previewToJson(preview)
      }
    });

    return {
      ok: true,
      pushedCount: result.pushedCount,
      preview,
      eventId: event.id
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Push failed";
    const responseBody = error instanceof HostawayPushError ? error.responseBody.slice(0, 1000) : undefined;
    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: args.tenantId,
        listingId: preview.listingId,
        pushedBy: args.pushedBy,
        dateFrom: fromDateOnly(preview.dateFrom),
        dateTo: fromDateOnly(preview.dateTo),
        dateCount: 0,
        status: "failed",
        errorMessage: responseBody ? `${message} :: ${responseBody}` : message,
        payload: previewToJson(preview)
      }
    });
    return {
      ok: false,
      pushedCount: 0,
      preview,
      eventId: event.id,
      errorMessage: message
    };
  }
}

function previewToJson(preview: PushRatesPreview): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(preview)) as Prisma.InputJsonValue;
}

export async function findLastPushEventForListing(args: {
  tenantId: string;
  listingId: string;
}): Promise<{
  id: string;
  dateCount: number;
  status: string;
  pushedBy: string;
  createdAt: Date;
} | null> {
  const event = await prisma.hostawayPushEvent.findFirst({
    where: { tenantId: args.tenantId, listingId: args.listingId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      dateCount: true,
      status: true,
      pushedBy: true,
      createdAt: true
    }
  });
  return event ?? null;
}
