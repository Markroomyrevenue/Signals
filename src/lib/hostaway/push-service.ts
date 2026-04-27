import type { Prisma } from "@prisma/client";

import { fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { loadResolvedPricingSettings } from "@/lib/pricing/settings";
import type { PricingResolvedSettings } from "@/lib/pricing/settings";
import { buildPricingCalendarReport } from "@/lib/reports/service";
import {
  getHostawayPushClientForTenant,
  HostawayPushError,
  type HostawayCalendarPushRate,
  type HostawayPushClient
} from "@/lib/hostaway/push";
import { prisma } from "@/lib/prisma";

// All work that the API route does — extracted so it is unit-testable.
// No NextResponse here, no auth here — those live in the route handler.
//
// Every external dependency (DB lookups, the Hostaway push client, the
// pricing-calendar pipeline, the time source) is injectable so the
// tests can run as plain `node --test` without a database or a
// network — see push-service.test.ts.

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

export type PushRatesListingLookup = {
  loadListing: (args: { tenantId: string; listingId: string }) => Promise<{
    id: string;
    hostawayId: string;
    tags: string[];
  } | null>;
  loadResolvedSettings: (args: {
    tenantId: string;
    listingId: string;
    tags: string[];
  }) => Promise<PricingResolvedSettings | null>;
  loadDisplayCurrency: (args: { tenantId: string }) => Promise<string>;
  loadRecommendationsForRange: (args: {
    tenantId: string;
    listingId: string;
    dateFrom: string;
    dateTo: string;
    displayCurrency: string;
  }) => Promise<Map<string, { recommendedRate: number | null; liveRate: number | null }>>;
};

export type PushRatesEventStore = {
  recordEvent: (args: {
    tenantId: string;
    listingId: string;
    pushedBy: string;
    dateFrom: string;
    dateTo: string;
    dateCount: number;
    status: "success" | "failed" | "skipped";
    errorMessage: string | null;
    payload: PushRatesPreview;
  }) => Promise<{ id: string }>;
  findLastEvent: (args: { tenantId: string; listingId: string }) => Promise<{
    id: string;
    dateCount: number;
    status: string;
    pushedBy: string;
    createdAt: Date;
  } | null>;
};

export type PushRatesClientFactory = (args: {
  tenantId: string;
  hostawayListingId: string;
}) => Promise<HostawayPushClient>;

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

const DEFAULT_LISTING_LOOKUP: PushRatesListingLookup = {
  async loadListing({ tenantId, listingId }) {
    const listing = await prisma.listing.findFirst({
      where: { id: listingId, tenantId },
      select: { id: true, hostawayId: true, tags: true }
    });
    if (!listing) return null;
    return { id: listing.id, hostawayId: listing.hostawayId, tags: listing.tags };
  },

  async loadResolvedSettings({ tenantId, listingId, tags }) {
    const map = await loadResolvedPricingSettings({
      tenantId,
      listings: [{ listingId, tags }]
    });
    return map.get(listingId)?.settings ?? null;
  },

  async loadDisplayCurrency({ tenantId }) {
    const tenantRow = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultCurrency: true }
    });
    return (tenantRow?.defaultCurrency ?? "GBP").toUpperCase();
  },

  async loadRecommendationsForRange({ tenantId, listingId, dateFrom, dateTo, displayCurrency }) {
    const monthStarts = eachMonthStart(dateFrom, dateTo);
    const cellsByDate = new Map<string, { recommendedRate: number | null; liveRate: number | null }>();
    for (const monthStart of monthStarts) {
      const report = await buildPricingCalendarReport({
        tenantId,
        request: {
          selectedMonthStart: monthStart,
          forceMarketRefresh: false,
          listingIds: [listingId],
          channels: [],
          statuses: [],
          displayCurrency
        },
        displayCurrency
      });
      const matchingRow = report.rows.find((r) => r.listingId === listingId);
      if (!matchingRow) continue;
      for (const cell of matchingRow.cells) {
        if (cell.date < dateFrom || cell.date > dateTo) continue;
        cellsByDate.set(cell.date, {
          recommendedRate: cell.recommendedRate,
          liveRate: cell.liveRate
        });
      }
    }
    return cellsByDate;
  }
};

const DEFAULT_EVENT_STORE: PushRatesEventStore = {
  async recordEvent(args) {
    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: args.tenantId,
        listingId: args.listingId,
        pushedBy: args.pushedBy,
        dateFrom: fromDateOnly(args.dateFrom),
        dateTo: fromDateOnly(args.dateTo),
        dateCount: args.dateCount,
        status: args.status,
        errorMessage: args.errorMessage,
        payload: previewToJson(args.payload)
      }
    });
    return { id: event.id };
  },

  async findLastEvent({ tenantId, listingId }) {
    const event = await prisma.hostawayPushEvent.findFirst({
      where: { tenantId, listingId },
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
};

const DEFAULT_CLIENT_FACTORY: PushRatesClientFactory = ({ tenantId, hostawayListingId }) =>
  getHostawayPushClientForTenant({ tenantId, hostawayListingId });

export type PushRatesDeps = {
  listingLookup?: PushRatesListingLookup;
  eventStore?: PushRatesEventStore;
  pushClientFactory?: PushRatesClientFactory;
};

export async function buildPushRatesPreview(
  args: {
    tenantId: string;
    listingId: string;
    dateFrom: string;
    dateTo: string;
    displayCurrency?: string;
  },
  deps: PushRatesDeps = {}
): Promise<PushRatesPreview> {
  if (args.dateFrom > args.dateTo) {
    throw new PushRatesError("dateFrom must be on or before dateTo", 400);
  }

  const listingLookup = deps.listingLookup ?? DEFAULT_LISTING_LOOKUP;

  const listing = await listingLookup.loadListing({
    tenantId: args.tenantId,
    listingId: args.listingId
  });
  if (!listing) {
    throw new PushRatesError("Listing not found for this tenant", 404);
  }

  const settings = await listingLookup.loadResolvedSettings({
    tenantId: args.tenantId,
    listingId: listing.id,
    tags: listing.tags
  });
  if (!settings || settings.hostawayPushEnabled !== true) {
    throw new PushRatesError(
      "Pushing live rates to Hostaway is not enabled for this listing",
      403
    );
  }

  const displayCurrency =
    (args.displayCurrency ?? (await listingLookup.loadDisplayCurrency({ tenantId: args.tenantId }))).toUpperCase();

  const cellsByDate = await listingLookup.loadRecommendationsForRange({
    tenantId: args.tenantId,
    listingId: listing.id,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    displayCurrency
  });

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

export async function executePushRates(
  args: {
    tenantId: string;
    listingId: string;
    pushedBy: string;
    dateFrom: string;
    dateTo: string;
    displayCurrency?: string;
  },
  deps: PushRatesDeps = {}
): Promise<PushRatesResult> {
  const preview = await buildPushRatesPreview(args, deps);
  const eventStore = deps.eventStore ?? DEFAULT_EVENT_STORE;
  const clientFactory = deps.pushClientFactory ?? DEFAULT_CLIENT_FACTORY;

  if (preview.count === 0) {
    const event = await eventStore.recordEvent({
      tenantId: args.tenantId,
      listingId: preview.listingId,
      pushedBy: args.pushedBy,
      dateFrom: preview.dateFrom,
      dateTo: preview.dateTo,
      dateCount: 0,
      status: "skipped",
      errorMessage: "No recommendable dates in range",
      payload: preview
    });
    return { ok: true, pushedCount: 0, preview, eventId: event.id };
  }

  const pushClient = await clientFactory({
    tenantId: args.tenantId,
    hostawayListingId: preview.hostawayId
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

    const event = await eventStore.recordEvent({
      tenantId: args.tenantId,
      listingId: preview.listingId,
      pushedBy: args.pushedBy,
      dateFrom: preview.dateFrom,
      dateTo: preview.dateTo,
      dateCount: result.pushedCount,
      status: "success",
      errorMessage: null,
      payload: preview
    });

    return { ok: true, pushedCount: result.pushedCount, preview, eventId: event.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Push failed";
    const responseBody = error instanceof HostawayPushError ? error.responseBody.slice(0, 1000) : undefined;
    const event = await eventStore.recordEvent({
      tenantId: args.tenantId,
      listingId: preview.listingId,
      pushedBy: args.pushedBy,
      dateFrom: preview.dateFrom,
      dateTo: preview.dateTo,
      dateCount: 0,
      status: "failed",
      errorMessage: responseBody ? `${message} :: ${responseBody}` : message,
      payload: preview
    });
    return { ok: false, pushedCount: 0, preview, eventId: event.id, errorMessage: message };
  }
}

function previewToJson(preview: PushRatesPreview): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(preview)) as Prisma.InputJsonValue;
}

export async function findLastPushEventForListing(
  args: { tenantId: string; listingId: string },
  deps: PushRatesDeps = {}
): Promise<{
  id: string;
  dateCount: number;
  status: string;
  pushedBy: string;
  createdAt: Date;
} | null> {
  const eventStore = deps.eventStore ?? DEFAULT_EVENT_STORE;
  return eventStore.findLastEvent(args);
}
