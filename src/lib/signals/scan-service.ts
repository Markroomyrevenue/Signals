/**
 * Signals rate scanner — the core scan/diff engine.
 *
 * Read-only with respect to the rest of the tool (see SIGNALS-RATE-SCAN-SPEC.md
 * §2.1): it fetches live Hostaway calendar rates with a GET-only gateway call
 * and diffs them *in memory* against the scanner's own `RateState` table. The
 * only tables it writes are the four `signals` tables — never `CalendarRate`,
 * `Reservation`, `NightFact`, or any other existing table.
 *
 * The file is split into pure functions (`normalizeCalendar`,
 * `diffListingCalendar`) that are unit-tested with mock inputs, and one DB
 * wrapper (`scanTenant`) that wires them to Prisma + the Hostaway gateway.
 */

import type { Prisma } from "@prisma/client";

import { getHostawayGatewayForTenant } from "@/lib/hostaway";
import type { HostawayCalendarRate } from "@/lib/hostaway/types";
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { parsePricingSettingsOverride } from "@/lib/pricing/settings";
import { prisma } from "@/lib/prisma";

import { attributeRecentBookings } from "./attribution";
import { computeYearlyAdrMedian } from "./baseline";
import { type Lever, PRICE_CHANGE_EPSILON, SCAN_HORIZON_DAYS } from "./config";

/** One calendar day after normalisation — the shape the diff works on. */
export type NormalizedDay = {
  date: string; // yyyy-mm-dd
  rate: number;
  minStay: number | null;
  available: boolean;
  currency: string;
};

/** The last-known value for a date, loaded from `RateState` (the diff baseline). */
export type PriorState = {
  rate: number;
  minStay: number | null;
  available: boolean;
};

/** A detected lever move, before it is persisted as a `RateChange` row. */
export type LeverChangeDraft = {
  date: string;
  lever: Lever;
  oldValue: number | null;
  newValue: number | null;
  changePct: number | null;
  yearlyAdrMedian: number | null;
  pctOfYearlyAdr: number | null;
};

export type RateScanResult = {
  scanId: string;
  listingCount: number;
  changeCount: number;
  failedCount: number;
  excludedCount: number;
  status: "success" | "partial" | "failed";
};

/** A property-scope `PricingSetting` row, reduced to what the exclusion needs. */
export type RateCopySettingRow = {
  scopeRef: string | null;
  settings: Prisma.JsonValue;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce raw Hostaway calendar rows into one clean `NormalizedDay` per date.
 *
 * Pure. Last row wins on duplicate dates, non-`yyyy-mm-dd` dates are dropped,
 * `minStay` collapses to null when missing or non-positive, currency upper-cases
 * to a 3-char code (default "GBP"). Output is sorted by date for stable diffs.
 */
export function normalizeCalendar(rows: HostawayCalendarRate[]): NormalizedDay[] {
  const byDate = new Map<string, NormalizedDay>();
  for (const row of rows) {
    const date = typeof row.date === "string" ? row.date.slice(0, 10) : "";
    if (!DATE_ONLY.test(date)) continue;

    const rate = Number(row.rate);
    const minStayRaw = typeof row.minStay === "number" ? Math.trunc(row.minStay) : null;
    const currency = (row.currency ?? "GBP").trim().toUpperCase().slice(0, 3) || "GBP";

    byDate.set(date, {
      date,
      rate: Number.isFinite(rate) ? rate : 0,
      minStay: minStayRaw !== null && minStayRaw > 0 ? minStayRaw : null,
      available: Boolean(row.available),
      currency
    });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Diff a freshly-fetched, normalised calendar against the prior `RateState`.
 *
 * Pure. Returns the lever moves to record and the full set of day-states to
 * upsert. A date with no prior state is *seeded* (state upserted) but emits no
 * change — there is no baseline to compare against. Sub-`PRICE_CHANGE_EPSILON`
 * price wobble is ignored so float dust is not logged as a move.
 */
export function diffListingCalendar(args: {
  fresh: NormalizedDay[];
  prior: Map<string, PriorState>;
  yearlyAdrMedian: number | null;
}): { changes: LeverChangeDraft[]; nextStates: NormalizedDay[] } {
  const { fresh, prior, yearlyAdrMedian } = args;
  const changes: LeverChangeDraft[] = [];

  for (const day of fresh) {
    const prev = prior.get(day.date);
    if (!prev) continue; // first time seen — seed only, no change

    if (Math.abs(day.rate - prev.rate) > PRICE_CHANGE_EPSILON) {
      const changePct = prev.rate !== 0 ? (day.rate - prev.rate) / prev.rate : null;
      const pctOfYearlyAdr =
        yearlyAdrMedian !== null && yearlyAdrMedian !== 0 ? day.rate / yearlyAdrMedian : null;
      changes.push({
        date: day.date,
        lever: "price",
        oldValue: prev.rate,
        newValue: day.rate,
        changePct,
        yearlyAdrMedian,
        pctOfYearlyAdr
      });
    }

    if (day.minStay !== prev.minStay) {
      changes.push({
        date: day.date,
        lever: "min_stay",
        oldValue: prev.minStay,
        newValue: day.minStay,
        changePct: null,
        yearlyAdrMedian: null,
        pctOfYearlyAdr: null
      });
    }

    if (day.available !== prev.available) {
      changes.push({
        date: day.date,
        lever: "availability",
        oldValue: prev.available ? 1 : 0,
        newValue: day.available ? 1 : 0,
        changePct: null,
        yearlyAdrMedian: null,
        pctOfYearlyAdr: null
      });
    }
  }

  return { changes, nextStates: fresh };
}

/**
 * Collect every listing id involved in rate-copy, for exclusion from scanning.
 *
 * Pure (spec §4 step 2). Given the tenant's property-scope `PricingSetting`
 * rows, returns the set of listing ids whose rates are driven by rate-copy —
 * **both** sides:
 *  - the **target** listing (the row's `scopeRef`, i.e. the listing configured
 *    with `pricingMode: "rate_copy"`), and
 *  - the **source** listing it copies from (`parsed.rateCopySourceListingId`),
 *    when that is a non-empty string.
 *
 * These listings' price moves come from Signals' own push / an external tool,
 * not from Mark's pricing instinct, so recording them would be noise. Excluded
 * listings are never fetched, diffed, or written — they stay exactly as they are.
 *
 * Note: this deliberately does NOT gate on `rateCopyPushEnabled` (unlike the
 * push worker's `collectRateCopySourceListingIds`). A rate_copy target is noise
 * whether or not the live push is currently switched on.
 */
export function collectRateCopyExclusionIds(rows: RateCopySettingRow[]): Set<string> {
  const excluded = new Set<string>();
  for (const row of rows) {
    const parsed = parsePricingSettingsOverride(row.settings);
    if (parsed.pricingMode !== "rate_copy") continue;

    // Target: the listing this property-scope row configures.
    if (typeof row.scopeRef === "string" && row.scopeRef.trim().length > 0) {
      excluded.add(row.scopeRef.trim());
    }
    // Source: the listing it copies its rates from.
    if (
      typeof parsed.rateCopySourceListingId === "string" &&
      parsed.rateCopySourceListingId.trim().length > 0
    ) {
      excluded.add(parsed.rateCopySourceListingId.trim());
    }
  }
  return excluded;
}

/** Build the `RateState` map for one listing in range, keyed by `yyyy-mm-dd`. */
function priorStateMap(
  rows: { date: Date; rate: unknown; minStay: number | null; available: boolean }[]
): Map<string, PriorState> {
  const map = new Map<string, PriorState>();
  for (const row of rows) {
    map.set(toDateOnly(row.date), {
      rate: Number(row.rate),
      minStay: row.minStay,
      available: row.available
    });
  }
  return map;
}

/**
 * Scan one tenant's live calendars and record any lever moves.
 *
 * Tenant-scoped end to end: every query filters by `tenantId`. On a per-listing
 * Hostaway fetch failure the listing is counted as failed and skipped (partial
 * results beat aborting — mirrors the rate-copy worker). Writes go only to the
 * four signals tables.
 */
export async function scanTenant(args: {
  tenantId: string;
  trigger: "scheduled" | "manual";
}): Promise<RateScanResult> {
  const { tenantId, trigger } = args;

  const scan = await prisma.rateScan.create({
    data: {
      tenantId,
      trigger,
      status: "success",
      listingCount: 0,
      changeCount: 0,
      failedCount: 0
    }
  });

  const activeListings = await prisma.listing.findMany({
    where: { tenantId, status: "active", removedAt: null },
    select: { id: true, hostawayId: true }
  });

  // Exclude every rate-copy listing (targets + sources) before scanning — their
  // moves are driven by push / an external tool, not Mark's instinct (spec §4
  // step 2). These listings are never fetched, diffed, or written.
  const rateCopyRows = await prisma.pricingSetting.findMany({
    where: { tenantId, scope: "property", scopeRef: { not: null } },
    select: { scopeRef: true, settings: true }
  });
  const excludedListingIds = collectRateCopyExclusionIds(rateCopyRows);
  const listings = activeListings.filter((listing) => !excludedListingIds.has(listing.id));
  const excludedCount = activeListings.length - listings.length;
  if (excludedCount > 0) {
    console.log(
      `[rate-scan] tenant=${tenantId} excluded ${excludedCount} rate-copy listing(s) from scan ` +
        `(${excludedListingIds.size} listing id(s) in rate-copy set)`
    );
  }

  const dateFrom = toDateOnly(new Date());
  const dateTo = toDateOnly(addUtcDays(fromDateOnly(dateFrom), SCAN_HORIZON_DAYS));
  const rangeStart = fromDateOnly(dateFrom);
  const rangeEnd = fromDateOnly(dateTo);

  const gateway = await getHostawayGatewayForTenant(tenantId);

  let changeCount = 0;
  let failedCount = 0;
  let firstError: string | null = null;

  for (const listing of listings) {
    let fresh: NormalizedDay[];
    try {
      const raw = await gateway.fetchCalendarRates(listing.hostawayId, dateFrom, dateTo);
      fresh = normalizeCalendar(raw);
    } catch (error) {
      failedCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (!firstError) firstError = message;
      console.error(`[rate-scan] fetch failed tenant=${tenantId} listing=${listing.id}: ${message}`);
      continue;
    }

    const priorRows = await prisma.rateState.findMany({
      where: { tenantId, listingId: listing.id, date: { gte: rangeStart, lte: rangeEnd } },
      select: { date: true, rate: true, minStay: true, available: true }
    });
    const prior = priorStateMap(priorRows);

    const yearlyAdrMedian = await computeYearlyAdrMedian(tenantId, listing.id);
    const { changes, nextStates } = diffListingCalendar({ fresh, prior, yearlyAdrMedian });
    changeCount += changes.length;

    const writes: Prisma.PrismaPromise<unknown>[] = [];
    if (changes.length > 0) {
      writes.push(
        prisma.rateChange.createMany({
          data: changes.map((change) => ({
            tenantId,
            listingId: listing.id,
            date: fromDateOnly(change.date),
            scanId: scan.id,
            lever: change.lever,
            oldValue: change.oldValue,
            newValue: change.newValue,
            changePct: change.changePct,
            yearlyAdrMedian: change.yearlyAdrMedian,
            pctOfYearlyAdr: change.pctOfYearlyAdr
          }))
        })
      );
    }
    for (const state of nextStates) {
      writes.push(
        prisma.rateState.upsert({
          where: { tenantId_listingId_date: { tenantId, listingId: listing.id, date: fromDateOnly(state.date) } },
          create: {
            tenantId,
            listingId: listing.id,
            date: fromDateOnly(state.date),
            rate: state.rate,
            minStay: state.minStay,
            available: state.available,
            currency: state.currency,
            lastScanId: scan.id,
            updatedAt: new Date()
          },
          update: {
            rate: state.rate,
            minStay: state.minStay,
            available: state.available,
            currency: state.currency,
            lastScanId: scan.id
          }
        })
      );
    }
    if (writes.length > 0) {
      await prisma.$transaction(writes);
    }
  }

  const status: RateScanResult["status"] =
    listings.length > 0 && failedCount === listings.length
      ? "failed"
      : failedCount > 0
        ? "partial"
        : "success";

  await prisma.rateScan.update({
    where: { id: scan.id },
    data: {
      listingCount: listings.length,
      changeCount,
      failedCount,
      status,
      error: firstError
    }
  });

  try {
    await attributeRecentBookings({ tenantId, scanId: scan.id });
  } catch (error) {
    // Attribution is a best-effort enrichment of an already-recorded scan;
    // a failure here must not mark the scan itself as failed.
    console.error(
      `[rate-scan] attribution failed tenant=${tenantId} scan=${scan.id}:`,
      error instanceof Error ? error.message : error
    );
  }

  return { scanId: scan.id, listingCount: listings.length, changeCount, failedCount, excludedCount, status };
}
