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
  /** Min-stay to push alongside the rate. Set ONLY when an active manual
   *  override on this date carries a min-stay — null means "leave the
   *  listing's existing min-stay untouched on Hostaway". */
  minStay: number | null;
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
  }) => Promise<
    Map<string, { recommendedRate: number | null; liveRate: number | null; overrideMinStay?: number | null }>
  >;
};

export type PushRatesEventStore = {
  recordEvent: (args: {
    tenantId: string;
    listingId: string;
    pushedBy: string;
    dateFrom: string;
    dateTo: string;
    dateCount: number;
    status: "success" | "failed" | "skipped" | "blocked-allowlist" | "verify-mismatch";
    errorMessage: string | null;
    payload: PushRatesPreview;
    /** 'manual' for UI-driven pushes, 'scheduled' for the daily rate-copy
     *  worker. Default 'manual' for legacy callers. */
    triggerSource?: "manual" | "scheduled";
    /** FK-style reference to PricingManualOverride.id when the pushed
     *  rates included override-adjusted dates. */
    overrideId?: string | null;
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

export type PushRatesCalendarStore = {
  /** Persist the verify-after-push read-back into the local calendar_rates
   *  copy, so the app's "Hostaway live" figures reflect a push immediately
   *  instead of waiting for the next scheduled sync. UPDATE-only: dates
   *  with no synced row yet are skipped (the row needs currency/raw fields
   *  only a full sync provides) and picked up by the next sync. */
  applyObservedRates: (args: {
    tenantId: string;
    listingId: string;
    rows: Array<{ date: string; price: number | null; minStay: number | null; available: boolean | null }>;
  }) => Promise<{ updated: number }>;
};

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
    const cellsByDate = new Map<
      string,
      { recommendedRate: number | null; liveRate: number | null; overrideMinStay: number | null }
    >();
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
          liveRate: cell.liveRate,
          overrideMinStay: cell.manualOverride?.minStay ?? null
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
        payload: previewToJson(args.payload),
        triggerSource: args.triggerSource ?? "manual",
        overrideId: args.overrideId ?? null
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

const DEFAULT_CALENDAR_STORE: PushRatesCalendarStore = {
  async applyObservedRates({ tenantId, listingId, rows }) {
    let updated = 0;
    const now = new Date();
    for (const row of rows) {
      if (row.price === null && row.minStay === null && row.available === null) continue;
      const data: { updatedAt: Date; rate?: number; minStay?: number; available?: boolean } = {
        updatedAt: now
      };
      if (row.price !== null) data.rate = row.price;
      if (row.minStay !== null) data.minStay = row.minStay;
      if (row.available !== null) data.available = row.available;
      const res = await prisma.calendarRate.updateMany({
        where: { tenantId, listingId, date: fromDateOnly(row.date) },
        data
      });
      updated += res.count;
    }
    return { updated };
  }
};

export type PushRatesDeps = {
  listingLookup?: PushRatesListingLookup;
  eventStore?: PushRatesEventStore;
  pushClientFactory?: PushRatesClientFactory;
  calendarStore?: PushRatesCalendarStore;
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
    // Diagnostic log so we can see exactly which listing/tenant tried to
    // push and what the resolver decided. Goes to stdout (Railway logs);
    // contains no Hostaway secrets.
    console.warn(
      "[hostaway-push] denied: hostawayPushEnabled is not true",
      JSON.stringify({
        tenantId: args.tenantId,
        listingId: listing.id,
        listingTags: listing.tags,
        settingsLoaded: settings !== null,
        resolvedPushEnabled: settings?.hostawayPushEnabled ?? null
      })
    );
    throw new PushRatesError(
      // Owner-friendly message that points at the exact thing they need to
      // change. The previous message said only "not enabled" which was
      // ambiguous between "no admin role" and "toggle off".
      "The 'Push live rates to Hostaway' toggle is currently OFF for this listing on the server. Open the property pricing card in the calendar inspector, switch it ON, then try pushing again.",
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
      recommendedRate: Math.round(value.recommendedRate * 100) / 100,
      minStay: value.overrideMinStay ?? null
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
  const calendarStore = deps.calendarStore ?? DEFAULT_CALENDAR_STORE;

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

  // Hard safety guard: a comma-separated allowlist of Hostaway listing IDs
  // that we are permitted to push rates to. When unset, no allowlist is
  // enforced (existing behaviour); when set, ANY push to a listing whose
  // hostawayId is not on the list is refused server-side BEFORE the HTTP
  // call. Used during go-live to guarantee that a misconfiguration or a
  // bug can't push rates to a listing the owner didn't intend to test.
  // Owner explicitly requested this for the Little Feather rollout where
  // only "Mark Test Listing" (Hostaway id 513515) is fair game.
  const allowlistRaw = process.env.HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS?.trim() ?? "";
  if (allowlistRaw.length > 0) {
    const allowlist = new Set(
      allowlistRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    );
    if (!allowlist.has(String(preview.hostawayId))) {
      const message = `Push refused: Hostaway listing ${preview.hostawayId} is not on the HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS allowlist`;
      const event = await eventStore.recordEvent({
        tenantId: args.tenantId,
        listingId: preview.listingId,
        pushedBy: args.pushedBy,
        dateFrom: preview.dateFrom,
        dateTo: preview.dateTo,
        dateCount: 0,
        status: "blocked-allowlist",
        errorMessage: message,
        payload: preview
      });
      console.warn("[hostaway-push] blocked by allowlist", JSON.stringify({
        hostawayId: preview.hostawayId,
        listingId: preview.listingId,
        allowlistSize: allowlist.size
      }));
      throw new PushRatesError(message, 403);
    }
  }

  const pushClient = await clientFactory({
    tenantId: args.tenantId,
    hostawayListingId: preview.hostawayId
  });

  const rates: HostawayCalendarPushRate[] = preview.dates.map((entry) => ({
    date: entry.date,
    dailyPrice: entry.recommendedRate,
    // Only override dates carry a min-stay; null leaves Hostaway's
    // existing min-stay untouched for that date (push.ts omits the field).
    minStay: entry.minStay
  }));

  try {
    // 2026-04-27: per-date URL `PUT /v1/listings/{id}/calendar/{date}`
    // returned 404 — the single-date endpoint doesn't exist on Hostaway's
    // public API, so the batch endpoint is the only path. Our first batch
    // attempt was rejected because the payload field names didn't match
    // Hostaway's expected schema. The push.ts batch method now tries
    // multiple shape variants automatically.
    const result = await pushClient.pushCalendarRatesBatch({
      dateFrom: preview.dateFrom,
      dateTo: preview.dateTo,
      rates
    });

    // Verify-after-push: read the calendar back from Hostaway and confirm
    // every date we pushed actually has the expected price now. Required
    // because Hostaway has a documented (today-discovered) silent-accept
    // failure mode where the wrong payload shape returns 2xx + status:
    // "success" without applying anything. If verify finds mismatches we
    // record an audit row with status "verify-mismatch" and surface a
    // clear error to the user — better to hear "this didn't actually
    // land" now than to find out via a guest booking at the wrong price.
    let mismatch: {
      date: string;
      field: "price" | "minStay";
      expected: number;
      observed: number | null;
      targetBooked: boolean | null;
    }[] = [];
    try {
      const observed = await pushClient.fetchCalendarRates({
        dateFrom: preview.dateFrom,
        dateTo: preview.dateTo
      });
      const observedByDate = new Map(observed.map((row) => [row.date, row]));
      // Persist the read-back into the local calendar copy so the app's
      // "Hostaway live" figures update immediately after a push instead of
      // showing the last scheduled sync. Non-fatal: a failure here never
      // poisons the push result — the next sync repairs the copy anyway.
      try {
        const applied = await calendarStore.applyObservedRates({
          tenantId: args.tenantId,
          listingId: preview.listingId,
          rows: observed
        });
        console.log(
          "[hostaway-push] local calendar refreshed from verify read",
          JSON.stringify({ listingId: preview.listingId, updated: applied.updated })
        );
      } catch (calendarError) {
        console.warn(
          "[hostaway-push] local calendar refresh failed (non-fatal)",
          JSON.stringify({
            listingId: preview.listingId,
            message: calendarError instanceof Error ? calendarError.message : String(calendarError)
          })
        );
      }
      for (const rate of rates) {
        const row = observedByDate.get(rate.date) ?? null;
        const seen = row?.price ?? null;
        if (seen === null || Math.abs(seen - rate.dailyPrice) > 0.5) {
          mismatch.push({
            date: rate.date,
            field: "price",
            expected: rate.dailyPrice,
            observed: seen,
            targetBooked: row ? row.available === false : null
          });
        }
        // Min-stay verify: only for dates where we explicitly sent one
        // (i.e. an override min-stay). Hostaway shares the silent-accept
        // failure mode for this field, so read-back is the only proof.
        if (typeof rate.minStay === "number" && rate.minStay > 0) {
          const seenMinStay = typeof row?.minStay === "number" ? row.minStay : null;
          if (seenMinStay === null || seenMinStay !== rate.minStay) {
            mismatch.push({
              date: rate.date,
              field: "minStay",
              expected: rate.minStay,
              observed: seenMinStay,
              targetBooked: row ? row.available === false : null
            });
          }
        }
      }
    } catch (verifyError) {
      // Verify failure shouldn't poison the push result — log and
      // continue with success since the PUT itself returned 2xx.
      console.warn(
        "[hostaway-push] verify-after-push failed (non-fatal)",
        JSON.stringify({
          listingId: preview.listingId,
          message: verifyError instanceof Error ? verifyError.message : String(verifyError)
        })
      );
    }

    if (mismatch.length > 0) {
      const bookedCount = mismatch.filter((m) => m.targetBooked === true).length;
      const sample = mismatch
        .slice(0, 5)
        .map(
          (m) =>
            `${m.date}: sent ${m.field === "minStay" ? "min-stay " : ""}${m.expected} → Hostaway shows ${m.observed ?? "null"}${m.targetBooked === true ? " (fully booked)" : ""}`
        )
        .join("; ");
      const bookedNote =
        bookedCount > 0
          ? ` ${bookedCount} of the ${mismatch.length} are fully booked on Hostaway, which ignores price updates for fully-booked dates — the hourly rate-copy worker keeps retrying them, so the fresh rate lands as soon as a unit frees up.`
          : "";
      const mismatchDateCount = new Set(mismatch.map((m) => m.date)).size;
      const message = `Push accepted (200) but Hostaway calendar didn't reflect ${mismatchDateCount} of ${rates.length} dates.${bookedNote} Sample: ${sample}`;
      console.error("[hostaway-push] verify-mismatch", JSON.stringify({
        listingId: preview.listingId,
        mismatchCount: mismatch.length,
        totalCount: rates.length,
        sample: mismatch.slice(0, 5)
      }));
      const event = await eventStore.recordEvent({
        tenantId: args.tenantId,
        listingId: preview.listingId,
        pushedBy: args.pushedBy,
        dateFrom: preview.dateFrom,
        dateTo: preview.dateTo,
        dateCount: rates.length,
        status: "verify-mismatch",
        errorMessage: message,
        payload: preview
      });
      return { ok: false, pushedCount: 0, preview, eventId: event.id, errorMessage: message };
    }

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
