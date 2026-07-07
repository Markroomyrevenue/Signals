/**
 * Rate-copy push pipeline.
 *
 * Reads `computeRateCopyByDate` results for a target listing and pushes
 * each per-date result (rate + min-stay) to Hostaway via the existing
 * push client. Persists a HostawayPushEvent row tagged `triggerSource`
 * (`'manual'` or `'scheduled'`) for audit.
 *
 * Used by:
 *   - `rate-copy-push-worker` ← HOURLY at :30 Europe/London (scheduled,
 *     delta-only), each preceded 30 min earlier by a
 *     source-sync step that refreshes the source listing's CalendarRate
 *     rows.
 *   - `POST /api/pricing/rate-copy/push-now` (manual UI button)
 *
 * Multi-tenant isolation is enforced because every Prisma read filters by
 * `tenantId` and the Hostaway client factory looks up credentials by
 * `tenantId` as well.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import {
  getHostawayPushClientForTenant,
  type HostawayCalendarPushRate,
  type HostawayCalendarReadRow
} from "@/lib/hostaway/push";
import { computeRateCopyByDate } from "@/lib/pricing/rate-copy";
import {
  resolvePricingSettings,
  parsePricingSettingsOverride,
  customGroupNamesFromTags,
  customGroupKey
} from "@/lib/pricing/settings";
import { computeMultiUnitOccupancyByDate } from "@/lib/pricing/multi-unit-occupancy";

export type RateCopyPushSummary = {
  tenantId: string;
  listingId: string;
  hostawayId: string;
  /** ISO date strings. */
  dateFrom: string;
  dateTo: string;
  /** Number of dates we attempted to push. */
  dateCount: number;
  /** Number of dates Hostaway accepted. */
  pushedCount: number;
  /** Skip counts by reason. */
  skipped: { no_source_rate: number; missing_user_min: number; other: number };
  /** Status of the push event row. */
  status: "success" | "failed" | "skipped" | "blocked-allowlist" | "verify-mismatch";
  errorMessage: string | null;
  eventId: string | null;
  /**
   * Dates with a computed rate this cycle (the pool considered before the
   * delta filter). `dateCount` is what we actually attempted to push (the
   * changed subset when `deltaOnly`). (Fix 3.)
   */
  consideredCount?: number;
  /** Dates deferred to the next cycle by the per-cycle cap (backpressure). */
  deferredCount?: number;
  /**
   * Dates Hostaway accepted (HTTP 200) but did NOT apply, caught by the
   * verify-after-push read-back. Typically fully-booked dates, whose price
   * updates Hostaway silently ignores. These stay divergent on Hostaway, so
   * the live-calendar delta re-pushes them every cycle until they land
   * (e.g. the hour after a cancellation frees the night).
   */
  unappliedCount?: number;
};

export type RateCopyPushOptions = {
  tenantId: string;
  /** Target listing.id (the listing whose rates we're WRITING). */
  listingId: string;
  /** ISO date `YYYY-MM-DD`. Defaults to today UTC. */
  dateFrom?: string;
  /** ISO date `YYYY-MM-DD`. Defaults to dateFrom + 365 days. */
  dateTo?: string;
  pushedBy: string;
  triggerSource: "manual" | "scheduled";
  /**
   * Push only dates whose computed rate or min-stay differs from the last
   * value we pushed (delta-only). Avoids re-pushing an unchanged 365-day
   * calendar every hour — API efficiency, not damping. A date with no push
   * history is treated as changed (pushed) to be safe. Defaults to false
   * (full re-push); the hourly scheduled path sets it true. (Fix 3.)
   */
  deltaOnly?: boolean;
};

/** Per-listing, per-cycle hard cap on dates pushed (backpressure backstop).
 *  Above the 365-day horizon so it never bites in normal operation; if a bulk
 *  config change makes every date change at once, the nearest dates go this
 *  cycle and the rest are logged + deferred to the next hourly cycle. */
const MAX_PUSH_DATES_PER_CYCLE = 400;

/**
 * Pure delta filter: keep only the rates whose price (or, when we push one,
 * min-stay) differs from what Hostaway's calendar shows RIGHT NOW.
 *
 * The delta used to be reconstructed from our own past push-event payloads,
 * but Hostaway has a silent-refusal mode — a price update for a fully-booked
 * date returns HTTP 200 "success" and is never applied — so our event history
 * could claim a rate was live when Hostaway still showed a stale price. The
 * live calendar is the only truthful "already pushed" source, and comparing
 * against it makes every cycle self-healing: any divergence, whatever its
 * cause (booked-date refusal, manual edit in Hostaway, an old phantom
 * success), is re-pushed until the calendar actually reflects it.
 *
 * A date absent from the live read (or with a null price) is treated as
 * changed (kept) so we never silently skip a date we can't confirm.
 */
export function selectRatesDifferingFromLive(
  rates: HostawayCalendarPushRate[],
  liveByDate: Map<string, Pick<HostawayCalendarReadRow, "price" | "minStay">>
): HostawayCalendarPushRate[] {
  return rates.filter((r) => {
    const live = liveByDate.get(r.date);
    if (!live || live.price === null) return true;
    if (Math.abs(live.price - r.dailyPrice) > 0.5) return true;
    // Only compare min-stay when we are pushing one AND Hostaway reported
    // one — a null on either side must not cause an every-cycle re-push.
    if (
      typeof r.minStay === "number" &&
      r.minStay > 0 &&
      typeof live.minStay === "number" &&
      live.minStay !== r.minStay
    ) {
      return true;
    }
    return false;
  });
}

export type UnappliedRate = {
  date: string;
  expected: number;
  observed: number | null;
  /** Hostaway's availability on the date at verify time — `false` means the
   *  date is fully booked/blocked, the known cause of silent refusals. */
  targetBooked: boolean | null;
};

/**
 * Pure verify-after-push comparison: which pushed dates does Hostaway's
 * calendar NOT reflect? Hostaway 200-accepts price updates for fully-booked
 * dates without applying them (verified live 2026-07-07 on the Little
 * Feather student-accom listings), so a 200 alone proves nothing.
 */
export function findUnappliedRates(
  pushed: HostawayCalendarPushRate[],
  observed: HostawayCalendarReadRow[]
): UnappliedRate[] {
  const observedByDate = new Map(observed.map((row) => [row.date, row]));
  const out: UnappliedRate[] = [];
  for (const rate of pushed) {
    const row = observedByDate.get(rate.date) ?? null;
    const seen = row?.price ?? null;
    if (seen === null || Math.abs(seen - rate.dailyPrice) > 0.5) {
      out.push({
        date: rate.date,
        expected: rate.dailyPrice,
        observed: seen,
        targetBooked: row ? row.available === false : null
      });
    }
  }
  return out;
}

export function buildUnappliedMessage(unapplied: UnappliedRate[], attempted: number): string {
  const bookedCount = unapplied.filter((u) => u.targetBooked === true).length;
  const sample = unapplied
    .slice(0, 5)
    .map(
      (m) =>
        `${m.date}: sent ${m.expected} → Hostaway shows ${m.observed ?? "null"}${m.targetBooked === true ? " (fully booked)" : ""}`
    )
    .join("; ");
  let message = `Hostaway accepted the push (HTTP 200) but did not apply ${unapplied.length} of ${attempted} dates.`;
  if (bookedCount > 0) {
    message +=
      ` ${bookedCount} of them are fully booked on Hostaway, which ignores price updates for fully-booked dates` +
      ` — they are retried every hour and the fresh rate lands as soon as a unit frees up.`;
  }
  message += ` Sample: ${sample}`;
  return message;
}

const DEFAULT_HORIZON_DAYS = 365;

function addDays(iso: string, days: number): string {
  const d = fromDateOnly(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateOnly(d);
}

export async function executeRateCopyPush(opts: RateCopyPushOptions): Promise<RateCopyPushSummary> {
  const dateFrom = opts.dateFrom ?? toDateOnly(new Date());
  const dateTo = opts.dateTo ?? addDays(dateFrom, DEFAULT_HORIZON_DAYS);

  // 1. Load target listing + Hostaway id + tags (for group resolution)
  const listing = await prisma.listing.findFirst({
    where: { id: opts.listingId, tenantId: opts.tenantId },
    select: {
      id: true,
      hostawayId: true,
      tags: true,
      unitCount: true,
      bedroomsNumber: true,
      personCapacity: true
    }
  });
  if (!listing) {
    return {
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: "?",
      dateFrom,
      dateTo,
      dateCount: 0,
      pushedCount: 0,
      skipped: { no_source_rate: 0, missing_user_min: 0, other: 0 },
      status: "failed",
      errorMessage: `Listing ${opts.listingId} not found in tenant ${opts.tenantId}`,
      eventId: null
    };
  }

  // 2. Resolve pricing settings (portfolio → group → property)
  const portfolioRow = await prisma.pricingSetting.findFirst({
    where: { tenantId: opts.tenantId, scope: "portfolio", scopeRef: null }
  });
  const groupKeys = listing.tags
    .filter((t) => t.toLowerCase().startsWith("group:"))
    .map((t) => t.slice(6).trim().toLowerCase())
    .filter((k) => k.length > 0);
  const groupRow =
    groupKeys.length > 0
      ? await prisma.pricingSetting.findFirst({
          where: { tenantId: opts.tenantId, scope: "group", scopeRef: { in: groupKeys } }
        })
      : null;
  const propertyRow = await prisma.pricingSetting.findFirst({
    where: { tenantId: opts.tenantId, scope: "property", scopeRef: opts.listingId }
  });
  const { settings } = resolvePricingSettings({
    portfolio: parsePricingSettingsOverride(portfolioRow?.settings),
    group: parsePricingSettingsOverride(groupRow?.settings),
    property: parsePricingSettingsOverride(propertyRow?.settings)
  });

  // 3. Hard gates: must be in rate_copy mode, push must be enabled,
  //    source must be set, base + min must be set, listing must be synced
  if (settings.pricingMode !== "rate_copy") {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "Listing is not in rate_copy mode"
    });
  }
  if (!settings.rateCopyPushEnabled) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "rateCopyPushEnabled is false"
    });
  }
  if (!settings.rateCopySourceListingId) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "rateCopySourceListingId is unset"
    });
  }
  if (settings.basePriceOverride === null || settings.basePriceOverride <= 0) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "basePriceOverride is unset"
    });
  }
  const targetUserMin =
    settings.minimumPriceOverride !== null && settings.minimumPriceOverride > 0
      ? settings.minimumPriceOverride
      : settings.basePriceOverride * 0.7;

  // 4. Verify the source listing exists in the same tenant
  const sourceListing = await prisma.listing.findFirst({
    where: { id: settings.rateCopySourceListingId, tenantId: opts.tenantId },
    select: { id: true }
  });
  if (!sourceListing) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "failed",
      errorMessage: `Source listing ${settings.rateCopySourceListingId} not found in tenant`
    });
  }

  // 5. Compute multi-unit occupancy, honouring the listing's occupancyScope.
  //   - "group": pool ALL listings sharing this listing's group tag (incl.
  //     single-unit members), released-stock denominator. (Fix 1 + Fix 2.)
  //   - "portfolio": pool ALL the tenant's listings into one denominator, so
  //     the listing prices on whole-portfolio occupancy. (2026-06-30 follow-up.)
  //   - "property" (or non-grouped): this listing's OWN occupancy only,
  //     released-stock denominator (the standalone multi-unit path).
  //   The released denominator falls back to static unit_count per date when
  //   Hostaway availability is absent.
  const isMulti = listing.unitCount !== null && listing.unitCount >= 2;
  const groupScoped = settings.occupancyScope === "group" && groupKeys.length > 0;
  const portfolioScoped = settings.occupancyScope === "portfolio";

  let occupancyByDate: Awaited<ReturnType<typeof computeMultiUnitOccupancyByDate>> | null = null;
  let applyOccupancy = false;

  if (portfolioScoped) {
    // Pool every non-removed listing in the tenant into ONE denominator. We
    // override each member's tags to a single synthetic group so the aggregator
    // (which pools by group tag) treats the whole portfolio as one pool.
    const tenantListings = await prisma.listing.findMany({
      where: { tenantId: opts.tenantId, removedAt: null },
      select: { id: true, unitCount: true }
    });
    const memberInputs = (tenantListings.length > 0 ? tenantListings : [{ id: listing.id, unitCount: listing.unitCount }]).map(
      (m) => ({ listingId: m.id, tags: ["group:__portfolio__"], unitCount: m.unitCount })
    );
    occupancyByDate = await computeMultiUnitOccupancyByDate({
      tenantId: opts.tenantId,
      listingInputs: memberInputs,
      fromDate: dateFrom,
      toDate: dateTo,
      prisma,
      poolSingleUnitMembers: true
    });
    applyOccupancy = (occupancyByDate.get(opts.listingId)?.size ?? 0) > 0;
  } else if (groupScoped) {
    // Resolve the target's group key the same way the occupancy aggregator
    // does (case-insensitive, first custom-group tag). Group tags are stored
    // with original casing (e.g. `group:Student Accomodation`) so we cannot
    // match with Prisma's exact `has` — load the tenant's listings and filter
    // by computed group key.
    const targetGroupNames = customGroupNamesFromTags(listing.tags);
    const targetGroupKey = targetGroupNames.length > 0 ? customGroupKey(targetGroupNames[0]!) : null;
    const tenantListings = await prisma.listing.findMany({
      where: { tenantId: opts.tenantId, removedAt: null },
      select: { id: true, tags: true, unitCount: true }
    });
    const members = targetGroupKey
      ? tenantListings.filter((m) => {
          const names = customGroupNamesFromTags(m.tags);
          return names.length > 0 && customGroupKey(names[0]!) === targetGroupKey;
        })
      : [];
    const memberInputs = members.length > 0
      ? members.map((m) => ({ listingId: m.id, tags: m.tags, unitCount: m.unitCount }))
      : [{ listingId: listing.id, tags: listing.tags, unitCount: listing.unitCount }];
    occupancyByDate = await computeMultiUnitOccupancyByDate({
      tenantId: opts.tenantId,
      listingInputs: memberInputs,
      fromDate: dateFrom,
      toDate: dateTo,
      prisma,
      poolSingleUnitMembers: true
    });
    applyOccupancy = (occupancyByDate.get(opts.listingId)?.size ?? 0) > 0;
  } else if (isMulti) {
    occupancyByDate = await computeMultiUnitOccupancyByDate({
      tenantId: opts.tenantId,
      listingInputs: [
        { listingId: listing.id, tags: listing.tags, unitCount: listing.unitCount }
      ],
      fromDate: dateFrom,
      toDate: dateTo,
      prisma
    });
    applyOccupancy = true;
  }

  // 6. Compute the rate-copy result per date
  const rateCopyMap = await computeRateCopyByDate({
    prisma,
    tenantId: opts.tenantId,
    sourceListingId: settings.rateCopySourceListingId,
    targetListingId: opts.listingId,
    fromDate: dateFrom,
    toDate: dateTo,
    multiUnitMatrix: applyOccupancy ? settings.multiUnitOccupancyLeadTimeMatrix : null,
    targetDefaultMinStay: settings.minimumNightStay,
    targetUserMin,
    occupancyByDate: occupancyByDate?.get(opts.listingId) ?? null,
    roundingIncrement: settings.roundingIncrement,
    todayDateOnly: dateFrom
  });

  // 7. Build the push payload
  const rates: HostawayCalendarPushRate[] = [];
  const skipped = { no_source_rate: 0, missing_user_min: 0, other: 0 };
  let lastOverrideId: string | null = null;
  for (const [, entry] of rateCopyMap) {
    if ("skipReason" in entry) {
      if (entry.skipReason === "no_source_rate") skipped.no_source_rate += 1;
      else if (entry.skipReason === "missing_user_min") skipped.missing_user_min += 1;
      else skipped.other += 1;
      continue;
    }
    rates.push({ date: entry.date, dailyPrice: entry.rate, minStay: entry.minStay });
    if (entry.overrideApplied) lastOverrideId = entry.overrideApplied.id;
  }

  const consideredCount = rates.length;

  if (rates.length === 0) {
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "skipped",
      errorMessage: "No pushable dates after applying gates and skip reasons",
      skipped,
      consideredCount
    });
  }

  // 8. Allowlist guard — before ANY Hostaway call for this listing (the
  //    delta filter below reads the live calendar with tenant credentials).
  const allowlistRaw = process.env.HOSTAWAY_PUSH_ALLOWED_HOSTAWAY_IDS?.trim() ?? "";
  if (allowlistRaw.length > 0) {
    const allowlist = new Set(
      allowlistRaw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    );
    if (!allowlist.has(String(listing.hostawayId))) {
      const message = `Push refused: Hostaway listing ${listing.hostawayId} is not on the allowlist`;
      const event = await prisma.hostawayPushEvent.create({
        data: {
          tenantId: opts.tenantId,
          listingId: opts.listingId,
          pushedBy: opts.pushedBy,
          dateFrom: fromDateOnly(dateFrom),
          dateTo: fromDateOnly(dateTo),
          dateCount: rates.length,
          status: "blocked-allowlist",
          errorMessage: message,
          payload: { rates: rates.map((r) => ({ date: r.date, dailyPrice: r.dailyPrice, minStay: r.minStay ?? null })) } as Prisma.JsonObject,
          triggerSource: opts.triggerSource,
          overrideId: lastOverrideId
        }
      });
      return summary({
        tenantId: opts.tenantId,
        listingId: opts.listingId,
        hostawayId: listing.hostawayId,
        dateFrom,
        dateTo,
        status: "blocked-allowlist",
        errorMessage: message,
        skipped,
        eventId: event.id,
        dateCount: rates.length
      });
    }
  }

  // 9. Push client — also used for the live-calendar delta read (7b) and
  //    the verify-after-push read-back.
  const pushClient = await getHostawayPushClientForTenant({
    tenantId: opts.tenantId,
    hostawayListingId: listing.hostawayId
  });

  // 7b. Delta filter: push only dates whose computed rate differs from what
  //     Hostaway's calendar shows RIGHT NOW (see selectRatesDifferingFromLive
  //     for why the live calendar, not our push history, is the baseline).
  let pushRates = rates;
  if (opts.deltaOnly) {
    try {
      const live = await pushClient.fetchCalendarRates({ dateFrom, dateTo });
      pushRates = selectRatesDifferingFromLive(
        rates,
        new Map(live.map((row) => [row.date, row]))
      );
    } catch (err) {
      // Can't read the live calendar → assume everything changed. The
      // per-cycle cap bounds the burst, and re-pushing an unchanged rate is
      // harmless; silently skipping a changed one is not.
      console.warn(
        `[rate-copy-push] live calendar read failed listing=${listing.hostawayId} — falling back to full push`,
        err instanceof Error ? err.message : err
      );
      pushRates = rates;
    }
    if (pushRates.length === 0) {
      return summary({
        tenantId: opts.tenantId,
        listingId: opts.listingId,
        hostawayId: listing.hostawayId,
        dateFrom,
        dateTo,
        status: "success",
        errorMessage: null,
        skipped,
        pushedCount: 0,
        dateCount: 0,
        consideredCount
      });
    }
  }

  // 7c. Per-cycle cap (backpressure backstop): nearest dates first.
  let deferredCount = 0;
  if (pushRates.length > MAX_PUSH_DATES_PER_CYCLE) {
    pushRates = [...pushRates].sort((a, b) => a.date.localeCompare(b.date));
    deferredCount = pushRates.length - MAX_PUSH_DATES_PER_CYCLE;
    pushRates = pushRates.slice(0, MAX_PUSH_DATES_PER_CYCLE);
    console.warn(
      `[rate-copy-push] cap hit listing=${listing.hostawayId} pushing=${pushRates.length} deferred=${deferredCount}`
    );
  }

  // From here on, `rates` refers to the dates we actually push this cycle.
  rates.length = 0;
  rates.push(...pushRates);

  try {
    const result = await pushClient.pushCalendarRatesBatch({
      dateFrom,
      dateTo,
      rates
    });

    // Verify-after-push: read the calendar back and confirm every pushed
    // date actually carries the price we sent. Hostaway 200-accepts price
    // updates for fully-booked dates without applying them, so a 200 alone
    // is not proof. Unapplied dates are recorded on a `verify-mismatch`
    // event (verified dates only in `rates`), stay divergent on Hostaway,
    // and are therefore re-pushed by the live-calendar delta every cycle
    // until they land — e.g. the hour after a cancellation frees the night.
    let unapplied: UnappliedRate[] = [];
    try {
      let verifyFrom = rates[0]!.date;
      let verifyTo = rates[0]!.date;
      for (const r of rates) {
        if (r.date < verifyFrom) verifyFrom = r.date;
        if (r.date > verifyTo) verifyTo = r.date;
      }
      const observed = await pushClient.fetchCalendarRates({ dateFrom: verifyFrom, dateTo: verifyTo });
      unapplied = findUnappliedRates(rates, observed);
    } catch (verifyError) {
      // Verify failure shouldn't poison the push result — the PUTs returned
      // 2xx. Log and record success; the next cycle's live-calendar delta
      // re-checks every date anyway.
      console.warn(
        "[rate-copy-push] verify-after-push read failed (non-fatal)",
        JSON.stringify({
          listingId: opts.listingId,
          hostawayId: listing.hostawayId,
          message: verifyError instanceof Error ? verifyError.message : String(verifyError)
        })
      );
    }

    if (unapplied.length > 0) {
      const message = buildUnappliedMessage(unapplied, rates.length);
      console.error(
        "[rate-copy-push] verify-mismatch",
        JSON.stringify({
          listingId: opts.listingId,
          hostawayId: listing.hostawayId,
          unappliedCount: unapplied.length,
          attempted: rates.length,
          sample: unapplied.slice(0, 5)
        })
      );
      const unappliedDates = new Set(unapplied.map((u) => u.date));
      const verifiedRates = rates.filter((r) => !unappliedDates.has(r.date));
      const event = await prisma.hostawayPushEvent.create({
        data: {
          tenantId: opts.tenantId,
          listingId: opts.listingId,
          pushedBy: opts.pushedBy,
          dateFrom: fromDateOnly(dateFrom),
          dateTo: fromDateOnly(dateTo),
          dateCount: rates.length,
          status: "verify-mismatch",
          errorMessage: message,
          payload: {
            // `rates` on the event = what actually landed on Hostaway.
            rates: verifiedRates.map((r) => ({ date: r.date, dailyPrice: r.dailyPrice, minStay: r.minStay ?? null })),
            unappliedRates: unapplied.map((u) => ({
              date: u.date,
              dailyPrice: u.expected,
              observed: u.observed,
              targetBooked: u.targetBooked
            }))
          } as Prisma.JsonObject,
          triggerSource: opts.triggerSource,
          overrideId: lastOverrideId
        }
      });
      return summary({
        tenantId: opts.tenantId,
        listingId: opts.listingId,
        hostawayId: listing.hostawayId,
        dateFrom,
        dateTo,
        status: "verify-mismatch",
        errorMessage: message,
        skipped,
        pushedCount: verifiedRates.length,
        eventId: event.id,
        dateCount: rates.length,
        consideredCount,
        deferredCount,
        unappliedCount: unapplied.length
      });
    }

    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: opts.tenantId,
        listingId: opts.listingId,
        pushedBy: opts.pushedBy,
        dateFrom: fromDateOnly(dateFrom),
        dateTo: fromDateOnly(dateTo),
        dateCount: rates.length,
        status: "success",
        errorMessage: null,
        payload: { rates: rates.map((r) => ({ date: r.date, dailyPrice: r.dailyPrice, minStay: r.minStay ?? null })) } as Prisma.JsonObject,
        triggerSource: opts.triggerSource,
        overrideId: lastOverrideId
      }
    });
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "success",
      errorMessage: null,
      skipped,
      pushedCount: result.pushedCount,
      eventId: event.id,
      dateCount: rates.length,
      consideredCount,
      deferredCount,
      unappliedCount: 0
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const event = await prisma.hostawayPushEvent.create({
      data: {
        tenantId: opts.tenantId,
        listingId: opts.listingId,
        pushedBy: opts.pushedBy,
        dateFrom: fromDateOnly(dateFrom),
        dateTo: fromDateOnly(dateTo),
        dateCount: rates.length,
        status: "failed",
        errorMessage: message,
        payload: { rates: rates.map((r) => ({ date: r.date, dailyPrice: r.dailyPrice, minStay: r.minStay ?? null })) } as Prisma.JsonObject,
        triggerSource: opts.triggerSource,
        overrideId: lastOverrideId
      }
    });
    return summary({
      tenantId: opts.tenantId,
      listingId: opts.listingId,
      hostawayId: listing.hostawayId,
      dateFrom,
      dateTo,
      status: "failed",
      errorMessage: message,
      skipped,
      eventId: event.id,
      dateCount: rates.length
    });
  }
}

function summary(args: {
  tenantId: string;
  listingId: string;
  hostawayId: string;
  dateFrom: string;
  dateTo: string;
  status: RateCopyPushSummary["status"];
  errorMessage: string | null;
  skipped?: RateCopyPushSummary["skipped"];
  pushedCount?: number;
  eventId?: string | null;
  dateCount?: number;
  consideredCount?: number;
  deferredCount?: number;
  unappliedCount?: number;
}): RateCopyPushSummary {
  return {
    tenantId: args.tenantId,
    listingId: args.listingId,
    hostawayId: args.hostawayId,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    dateCount: args.dateCount ?? 0,
    pushedCount: args.pushedCount ?? 0,
    skipped: args.skipped ?? { no_source_rate: 0, missing_user_min: 0, other: 0 },
    status: args.status,
    errorMessage: args.errorMessage,
    eventId: args.eventId ?? null,
    consideredCount: args.consideredCount,
    deferredCount: args.deferredCount,
    unappliedCount: args.unappliedCount
  };
}

export async function executeRateCopyPushForTenant(args: {
  tenantId: string;
  pushedBy: string;
  triggerSource: "manual" | "scheduled";
  /**
   * Optional explicit horizon. When omitted, each per-listing call uses
   * the `executeRateCopyPush` default (today → today + 365 days). The
   * scheduled worker passes the same explicit window so the daily push
   * walks a moving 365-day window forward each day.
   */
  dateFrom?: string;
  dateTo?: string;
  /** Delta-only push (push changed dates only). Hourly scheduled path sets this. (Fix 3.) */
  deltaOnly?: boolean;
}): Promise<RateCopyPushSummary[]> {
  // Find every property-scope pricing_settings row in the tenant where
  // pricingMode === 'rate_copy' AND rateCopyPushEnabled === true.
  const rows = await prisma.pricingSetting.findMany({
    where: { tenantId: args.tenantId, scope: "property", scopeRef: { not: null } }
  });
  const targets: string[] = [];
  for (const row of rows) {
    const parsed = parsePricingSettingsOverride(row.settings);
    if (parsed.pricingMode === "rate_copy" && parsed.rateCopyPushEnabled === true) {
      if (row.scopeRef) targets.push(row.scopeRef);
    }
  }
  const results: RateCopyPushSummary[] = [];
  for (const listingId of targets) {
    results.push(
      await executeRateCopyPush({
        tenantId: args.tenantId,
        listingId,
        pushedBy: args.pushedBy,
        triggerSource: args.triggerSource,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        deltaOnly: args.deltaOnly
      })
    );
  }
  return results;
}
