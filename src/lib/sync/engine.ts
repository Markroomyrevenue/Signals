import { addDays, format } from "date-fns";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getHostawayGatewayForTenant } from "@/lib/hostaway";
import { FetchReservationsArgs, HostawayGateway } from "@/lib/hostaway/types";
import { SYNC_CONFIG } from "@/lib/sync/config";
import { enqueueTenantSync } from "@/lib/queue/enqueue";
import { rebuildNightFactsForReservations } from "@/lib/sync/nightfact";
import { runPaceSnapshotForTenant } from "@/lib/sync/pace";
import { ensurePartitionCoverage } from "@/lib/db/partitions";
import { buildExtendedSyncReason } from "@/lib/sync/stages";

type TenantSyncInput = {
  tenantId: string;
  reason?: string;
  forceFull?: boolean;
  syncMode?: "core" | "extended";
  queueExtendedAfter?: boolean;
};

type ListingMap = Map<string, string>;

type SyncCounts = {
  listingsSynced: number;
  reservationsSynced: number;
  reservationsTouched: string[];
  calendarListingsSynced: number;
};

type ProgressDetails = Record<string, unknown>;

// Any SyncRun still flagged "running" after this many milliseconds is treated
// as interrupted (worker crashed, Railway disk filled, etc.). The successful
// sync paths normally finish well under five minutes, so 30 min is generous
// enough to avoid false positives during a slow sync.
const STALE_RUNNING_SYNC_THRESHOLD_MS = 30 * 60 * 1000;

async function writeSyncProgress(syncRunId: string, details: ProgressDetails): Promise<void> {
  try {
    await prisma.syncRun.update({
      where: { id: syncRunId },
      data: {
        details: details as Prisma.InputJsonValue
      }
    });
  } catch (error) {
    console.error("Failed to update sync progress", { syncRunId, error });
  }
}

/**
 * Marks any SyncRun still in "running" state past STALE_RUNNING_SYNC_THRESHOLD_MS
 * as failed, so the next successful sync starts from a clean slate.
 *
 * Called at the start of every sync. The data path is already self-healing
 * because `lastSyncAt` only advances on success — so the next sync re-fetches
 * everything from the previous successful sync onwards. This helper just
 * keeps the SyncRun rows accurate so the UI does not show an interrupted
 * sync as still-running forever.
 *
 * Emits an explicit log line when it does cleanup so Railway logs make the
 * recovery visible.
 */
export async function cleanupStaleRunningSyncs(tenantId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_SYNC_THRESHOLD_MS);
  const stale = await prisma.syncRun.findMany({
    where: {
      tenantId,
      status: "running",
      OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }]
    },
    select: { id: true, jobType: true, startedAt: true, createdAt: true }
  });

  if (stale.length === 0) return;

  const finishedAt = new Date();
  const result = await prisma.syncRun.updateMany({
    where: { id: { in: stale.map((row) => row.id) } },
    data: {
      status: "failed",
      finishedAt,
      errorMessage: "interrupted: marked failed by cleanupStaleRunningSyncs on next sync start"
    }
  });

  console.warn(
    `[sync] tenant=${tenantId} found ${result.count} stale running sync run(s); marking failed and re-syncing cleanly`,
    {
      ids: stale.map((row) => row.id),
      jobTypes: stale.map((row) => row.jobType)
    }
  );
}

async function syncCalendarsInline(params: {
  tenantId: string;
  listingIds: string[];
  dateFrom: string;
  dateTo: string;
  onProgress?: (synced: number, total: number) => void | Promise<void>;
}): Promise<number> {
  const concurrency = Math.max(1, Math.min(8, SYNC_CONFIG.calendarJobConcurrencyTarget));
  let synced = 0;
  const total = params.listingIds.length;

  for (let index = 0; index < params.listingIds.length; index += concurrency) {
    const batch = params.listingIds.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (listingId) => {
        await runCalendarSyncForListing({
          tenantId: params.tenantId,
          listingId,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo
        });
        return 1;
      })
    );
    synced += results.reduce((sum, value) => sum + value, 0);
    if (params.onProgress) {
      try {
        await params.onProgress(synced, total);
      } catch (progressError) {
        console.error("Calendar sync progress callback failed", progressError);
      }
    }
  }

  return synced;
}

function buildCalendarRange(): { dateFrom: string; dateTo: string } {
  return {
    dateFrom: format(addDays(new Date(), -SYNC_CONFIG.calendarBackDays), "yyyy-MM-dd"),
    dateTo: format(addDays(new Date(), SYNC_CONFIG.calendarForwardDays), "yyyy-MM-dd")
  };
}

const CUSTOM_GROUP_TAG_PREFIX = "group:";

function normalizeDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function nightsBetween(arrival: Date, departure: Date): number {
  return Math.max(0, Math.round((departure.getTime() - arrival.getTime()) / (24 * 60 * 60 * 1000)));
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) {
    return {};
  }

  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return {
      value: String(value)
    };
  }
}

function toNumeric(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numericValuesEqual(left: Prisma.Decimal | number | string | null | undefined, right: number | null | undefined): boolean {
  return Math.abs(toNumeric(left) - toNumeric(right)) < 0.000001;
}

function timestampsEqual(left: Date | null | undefined, right: Date | null | undefined): boolean {
  return (left?.getTime() ?? 0) === (right?.getTime() ?? 0);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableJsonValue(entryValue)])
    );
  }

  return value;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left ?? {})) === JSON.stringify(stableJsonValue(right ?? {}));
}

function isCustomGroupTag(tag: string): boolean {
  return tag.trim().toLowerCase().startsWith(CUSTOM_GROUP_TAG_PREFIX);
}

function mergeListingTags(existingTags: string[], syncedTags: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const tag of [...syncedTags, ...existingTags.filter(isCustomGroupTag)]) {
    const normalized = tag.trim();
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }

  return merged;
}

async function syncListings(
  tenantId: string,
  gateway: HostawayGateway,
  onProgress?: (count: number) => void | Promise<void>
): Promise<ListingMap> {
  const map: ListingMap = new Map();
  const existingTagsByHostawayId = new Map(
    (
      await prisma.listing.findMany({
        where: { tenantId },
        select: {
          hostawayId: true,
          tags: true
        }
      })
    ).map((listing) => [listing.hostawayId, listing.tags ?? []])
  );
  let page = 1;

  while (true) {
    const response = await gateway.fetchListings(page);

    for (const listing of response.items) {
      const mergedTags = mergeListingTags(existingTagsByHostawayId.get(listing.id) ?? [], listing.tags ?? []);
      const row = await prisma.listing.upsert({
        where: {
          tenantId_hostawayId: {
            tenantId,
            hostawayId: listing.id
          }
        },
        update: {
          name: listing.name,
          externalName: listing.externalName ?? null,
          status: listing.status,
          timezone: listing.timezone ?? "Europe/London",
          tags: mergedTags,
          country: listing.country ?? null,
          countryCode: listing.countryCode ?? null,
          state: listing.state ?? null,
          city: listing.city ?? null,
          street: listing.street ?? null,
          address: listing.address ?? null,
          publicAddress: listing.publicAddress ?? null,
          postalCode: listing.postalCode ?? null,
          latitude: listing.latitude ?? null,
          longitude: listing.longitude ?? null,
          roomType: listing.roomType ?? null,
          propertyTypeId: listing.propertyTypeId ?? null,
          bedroomsNumber: listing.bedroomsNumber ?? null,
          bathroomsNumber: listing.bathroomsNumber ?? null,
          bedsNumber: listing.bedsNumber ?? null,
          personCapacity: listing.personCapacity ?? null,
          guestsIncluded: listing.guestsIncluded ?? null,
          minNights: listing.minNights ?? null,
          maxNights: listing.maxNights ?? null,
          cleaningFee: listing.cleaningFee ?? null,
          currencyCode: listing.currencyCode ?? null,
          averageReviewRating: listing.averageReviewRating ?? null,
          thumbnailUrl: listing.thumbnailUrl ?? null,
          airbnbListingUrl: listing.airbnbListingUrl ?? null,
          vrboListingUrl: listing.vrboListingUrl ?? null,
          rawJson: toPrismaJson(listing.raw)
        },
        create: {
          tenantId,
          hostawayId: listing.id,
          name: listing.name,
          externalName: listing.externalName ?? null,
          status: listing.status,
          timezone: listing.timezone ?? "Europe/London",
          tags: mergedTags,
          country: listing.country ?? null,
          countryCode: listing.countryCode ?? null,
          state: listing.state ?? null,
          city: listing.city ?? null,
          street: listing.street ?? null,
          address: listing.address ?? null,
          publicAddress: listing.publicAddress ?? null,
          postalCode: listing.postalCode ?? null,
          latitude: listing.latitude ?? null,
          longitude: listing.longitude ?? null,
          roomType: listing.roomType ?? null,
          propertyTypeId: listing.propertyTypeId ?? null,
          bedroomsNumber: listing.bedroomsNumber ?? null,
          bathroomsNumber: listing.bathroomsNumber ?? null,
          bedsNumber: listing.bedsNumber ?? null,
          personCapacity: listing.personCapacity ?? null,
          guestsIncluded: listing.guestsIncluded ?? null,
          minNights: listing.minNights ?? null,
          maxNights: listing.maxNights ?? null,
          cleaningFee: listing.cleaningFee ?? null,
          currencyCode: listing.currencyCode ?? null,
          averageReviewRating: listing.averageReviewRating ?? null,
          thumbnailUrl: listing.thumbnailUrl ?? null,
          airbnbListingUrl: listing.airbnbListingUrl ?? null,
          vrboListingUrl: listing.vrboListingUrl ?? null,
          rawJson: toPrismaJson(listing.raw)
        },
        select: {
          id: true
        }
      });

      existingTagsByHostawayId.set(listing.id, mergedTags);
      map.set(listing.id, row.id);
    }

    if (onProgress) {
      try {
        await onProgress(map.size);
      } catch (progressError) {
        console.error("Listing sync progress callback failed", progressError);
      }
    }

    if (!response.hasMore || response.items.length === 0) {
      break;
    }

    page += 1;
  }

  return map;
}

async function ensureListingForReservation(
  tenantId: string,
  listingMap: ListingMap,
  hostawayListingId: string
): Promise<string> {
  const existing = listingMap.get(hostawayListingId);
  if (existing) return existing;

  const listing = await prisma.listing.upsert({
    where: {
      tenantId_hostawayId: {
        tenantId,
        hostawayId: hostawayListingId
      }
    },
    update: {
      status: "unknown"
    },
    create: {
      tenantId,
      hostawayId: hostawayListingId,
      name: `Listing ${hostawayListingId}`,
      status: "unknown",
      timezone: "Europe/London",
      tags: []
    },
    select: { id: true }
  });

  listingMap.set(hostawayListingId, listing.id);
  return listing.id;
}

const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "no-show", "no_show"]);

async function syncReservations(
  tenantId: string,
  gateway: HostawayGateway,
  listingMap: ListingMap,
  args: FetchReservationsArgs,
  onProgress?: (params: { processed: number; synced: number }) => void | Promise<void>
): Promise<{ synced: number; reservationIds: string[] }> {
  let page = 1;
  let afterId = args.afterId;
  let synced = 0;
  let processed = 0;
  const reservationIds: string[] = [];
  const useCursorPagination =
    typeof args.afterId === "string" ||
    typeof args.latestActivityStart === "string" ||
    typeof args.latestActivityEnd === "string";

  while (true) {
    const response = await gateway.fetchReservations({
      ...args,
      page: useCursorPagination ? 1 : page,
      afterId
    });
    const existingReservations = await prisma.reservation.findMany({
      where: {
        tenantId,
        hostawayId: {
          in: response.items.map((reservation) => reservation.id)
        }
      },
      select: {
        id: true,
        hostawayId: true,
        listingId: true,
        channel: true,
        status: true,
        createdAt: true,
        confirmedAt: true,
        arrival: true,
        departure: true,
        nights: true,
        guests: true,
        currency: true,
        total: true,
        accommodationFare: true,
        cleaningFee: true,
        guestFee: true,
        taxes: true,
        commission: true,
        cancelledAt: true,
        sourceUpdatedAt: true,
        rawJson: true
      }
    });
    const existingReservationByHostawayId = new Map(
      existingReservations.map((reservation) => [reservation.hostawayId, reservation])
    );

    for (const reservation of response.items) {
      processed += 1;
      const arrival = normalizeDate(reservation.arrivalDate);
      const departure = normalizeDate(reservation.departureDate);
      if (!arrival || !departure || departure <= arrival) {
        continue;
      }

      const listingId = await ensureListingForReservation(tenantId, listingMap, reservation.listingMapId);
      const createdAt = normalizeDate(reservation.insertedOn) ?? new Date();
      const confirmedAt = normalizeDate(reservation.confirmedOn);
      const sourceUpdatedAt = normalizeDate(reservation.updatedOn);
      const nights = reservation.nights > 0 ? reservation.nights : nightsBetween(arrival, departure);
      const rawJson = toPrismaJson(reservation.raw);
      const incomingStatus = reservation.status.toLowerCase();
      const isCancelled = CANCELLED_STATUSES.has(incomingStatus);

      // Detect cancellation: check if existing reservation was not cancelled but now is.
      // If so, set cancelledAt to the source update time or current time.
      let cancelledAt: Date | null = null;
      if (isCancelled) {
        const existing = existingReservationByHostawayId.get(reservation.id);

        if (existing?.cancelledAt) {
          // Already had a cancelledAt, keep it
          cancelledAt = existing.cancelledAt;
        } else if (existing && !CANCELLED_STATUSES.has(existing.status)) {
          // Was not cancelled before, now it is — record when
          cancelledAt = sourceUpdatedAt ?? new Date();
        } else if (!existing) {
          // New reservation coming in already cancelled
          cancelledAt = sourceUpdatedAt ?? createdAt;
        } else {
          // Was already cancelled but no cancelledAt recorded (legacy data)
          cancelledAt = sourceUpdatedAt ?? new Date();
        }
      }

      const normalizedChannel = reservation.channel ?? "unknown";
      const normalizedGuests = reservation.guests ?? null;
      const normalizedCleaningFee = reservation.cleaningFee ?? 0;
      const normalizedGuestFee = reservation.guestFee ?? 0;
      const normalizedTaxes = reservation.taxes ?? 0;
      const normalizedCommission = reservation.commission ?? 0;
      const existing = existingReservationByHostawayId.get(reservation.id);
      const reservationUnchanged =
        existing !== undefined &&
        existing.listingId === listingId &&
        (existing.channel ?? "unknown") === normalizedChannel &&
        existing.status === incomingStatus &&
        timestampsEqual(existing.createdAt, createdAt) &&
        timestampsEqual(existing.confirmedAt, confirmedAt) &&
        timestampsEqual(existing.arrival, arrival) &&
        timestampsEqual(existing.departure, departure) &&
        existing.nights === nights &&
        (existing.guests ?? null) === normalizedGuests &&
        existing.currency === reservation.currency &&
        numericValuesEqual(existing.total, reservation.totalPrice) &&
        numericValuesEqual(existing.accommodationFare, reservation.accommodationFare) &&
        numericValuesEqual(existing.cleaningFee, normalizedCleaningFee) &&
        numericValuesEqual(existing.guestFee, normalizedGuestFee) &&
        numericValuesEqual(existing.taxes, normalizedTaxes) &&
        numericValuesEqual(existing.commission, normalizedCommission) &&
        timestampsEqual(existing.cancelledAt, cancelledAt) &&
        timestampsEqual(existing.sourceUpdatedAt, sourceUpdatedAt) &&
        jsonValuesEqual(existing.rawJson, rawJson);

      if (reservationUnchanged) {
        continue;
      }

      const writeData = {
        listingId,
        channel: normalizedChannel,
        status: incomingStatus,
        createdAt,
        confirmedAt,
        arrival,
        departure,
        nights,
        guests: normalizedGuests,
        currency: reservation.currency,
        total: reservation.totalPrice,
        accommodationFare: reservation.accommodationFare,
        cleaningFee: normalizedCleaningFee,
        guestFee: normalizedGuestFee,
        taxes: normalizedTaxes,
        commission: normalizedCommission,
        cancelledAt,
        sourceUpdatedAt,
        rawJson
      };

      const row =
        existing === undefined
          ? await prisma.reservation.create({
              data: {
                tenantId,
                hostawayId: reservation.id,
                ...writeData
              },
              select: { id: true }
            })
          : await prisma.reservation.update({
              where: {
                tenantId_hostawayId: {
                  tenantId,
                  hostawayId: reservation.id
                }
              },
              data: writeData,
              select: { id: true }
            });

      synced += 1;
      reservationIds.push(row.id);
    }

    if (onProgress) {
      try {
        await onProgress({ processed, synced });
      } catch (progressError) {
        console.error("Reservation sync progress callback failed", progressError);
      }
    }

    if (!response.hasMore || response.items.length === 0) {
      break;
    }

    if (useCursorPagination) {
      afterId = response.items[response.items.length - 1]?.id;
      if (!afterId) {
        break;
      }
    } else {
      page += 1;
    }
  }

  return { synced, reservationIds };
}

function fallbackDateRange(): { from: string; to: string } {
  const today = new Date();
  return {
    from: format(addDays(today, -SYNC_CONFIG.reservationFallbackBackDays), "yyyy-MM-dd"),
    to: format(addDays(today, SYNC_CONFIG.reservationFallbackForwardDays), "yyyy-MM-dd")
  };
}

async function listTenantListingIds(tenantId: string): Promise<string[]> {
  const listings = await prisma.listing.findMany({
    where: { tenantId },
    select: { id: true }
  });

  return listings.map((listing) => listing.id);
}

async function runExtendedTenantSync(input: TenantSyncInput): Promise<SyncCounts> {
  await cleanupStaleRunningSyncs(input.tenantId);

  const syncRun = await prisma.syncRun.create({
    data: {
      tenantId: input.tenantId,
      jobType: input.reason ?? buildExtendedSyncReason("manual_trigger"),
      status: "running",
      startedAt: new Date(),
      details: {
        syncScope: "extended",
        stage: "calendar"
      }
    }
  });

  try {
    await ensurePartitionCoverage();

    const listingIds = await listTenantListingIds(input.tenantId);
    await writeSyncProgress(syncRun.id, {
      syncScope: "extended",
      stage: "calendar",
      calendarTotal: listingIds.length,
      calendarListingsSynced: 0
    });
    const calendarListingsSynced =
      listingIds.length === 0
        ? 0
        : await syncCalendarsInline({
            tenantId: input.tenantId,
            listingIds,
            ...buildCalendarRange(),
            onProgress: async (synced, total) => {
              await writeSyncProgress(syncRun.id, {
                syncScope: "extended",
                stage: "calendar",
                calendarTotal: total,
                calendarListingsSynced: synced
              });
            }
          });

    await writeSyncProgress(syncRun.id, {
      syncScope: "extended",
      stage: "pace",
      calendarTotal: listingIds.length,
      calendarListingsSynced
    });
    await runPaceSnapshotForTenant(input.tenantId, new Date(), 0);
    await prisma.hostawayConnection.updateMany({
      where: { tenantId: input.tenantId },
      data: { status: "active" }
    });

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        details: {
          syncScope: "extended",
          stage: "complete",
          listingsSynced: listingIds.length,
          reservationsSynced: 0,
          nightFactRowsUpserted: 0,
          calendarTotal: listingIds.length,
          calendarListingsSynced,
          calendarMode: "inline"
        }
      }
    });

    return {
      listingsSynced: listingIds.length,
      reservationsSynced: 0,
      reservationsTouched: [],
      calendarListingsSynced
    };
  } catch (error) {
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown sync error"
      }
    });

    throw error;
  }
}

export async function runTenantSync(input: TenantSyncInput): Promise<SyncCounts> {
  if (input.syncMode === "extended") {
    return runExtendedTenantSync(input);
  }

  await cleanupStaleRunningSyncs(input.tenantId);

  const syncRun = await prisma.syncRun.create({
    data: {
      tenantId: input.tenantId,
      jobType: input.reason ?? "manual_sync",
      status: "running",
      startedAt: new Date(),
      details: {
        syncScope: "core",
        stage: "connecting",
        queueExtendedAfter: Boolean(input.queueExtendedAfter)
      }
    }
  });

  const baseProgress: ProgressDetails = {
    syncScope: "core",
    queueExtendedAfter: Boolean(input.queueExtendedAfter)
  };

  try {
    await ensurePartitionCoverage();

    const gateway = await getHostawayGatewayForTenant(input.tenantId);
    const connection = await prisma.hostawayConnection.findUnique({
      where: { tenantId: input.tenantId }
    });

    await writeSyncProgress(syncRun.id, {
      ...baseProgress,
      stage: "listings",
      listingsSynced: 0
    });

    const listingMap = await syncListings(input.tenantId, gateway, async (count) => {
      await writeSyncProgress(syncRun.id, {
        ...baseProgress,
        stage: "listings",
        listingsSynced: count
      });
    });

    const listingsSyncedCount = listingMap.size;

    const latestActivityStart = !input.forceFull && connection?.lastSyncAt
      ? format(addDays(connection.lastSyncAt, -1), "yyyy-MM-dd")
      : undefined;
    const latestActivityEnd = !input.forceFull && connection?.lastSyncAt
      ? format(addDays(new Date(), 1), "yyyy-MM-dd")
      : undefined;

    const reservationArgs: FetchReservationsArgs = latestActivityStart
      ? {
          latestActivityStart,
          latestActivityEnd
        }
      : { dateRange: fallbackDateRange() };

    await writeSyncProgress(syncRun.id, {
      ...baseProgress,
      stage: "reservations",
      listingsSynced: listingsSyncedCount,
      reservationsProcessed: 0,
      reservationsSynced: 0
    });

    const reservationResult = await syncReservations(
      input.tenantId,
      gateway,
      listingMap,
      reservationArgs,
      async ({ processed, synced }) => {
        await writeSyncProgress(syncRun.id, {
          ...baseProgress,
          stage: "reservations",
          listingsSynced: listingsSyncedCount,
          reservationsProcessed: processed,
          reservationsSynced: synced
        });
      }
    );

    const listingIds = [...listingMap.values()];
    await writeSyncProgress(syncRun.id, {
      ...baseProgress,
      stage: "night_facts",
      listingsSynced: listingIds.length,
      reservationsSynced: reservationResult.synced
    });
    const nightFactResult = await rebuildNightFactsForReservations(
      input.tenantId,
      reservationResult.reservationIds
    );
    const completedAt = new Date();

    if (connection) {
      await prisma.hostawayConnection.update({
        where: { tenantId: input.tenantId },
        data: {
          lastSyncAt: completedAt,
          status: "active"
        }
      });
    }

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "success",
        finishedAt: completedAt,
        details: {
          syncScope: "core",
          stage: "complete",
          listingsSynced: listingIds.length,
          reservationsSynced: reservationResult.synced,
          nightFactRowsUpserted: nightFactResult.rowsUpserted,
          calendarListingsSynced: 0,
          calendarMode: "deferred",
          extendedQueued: Boolean(input.queueExtendedAfter)
        }
      }
    });

    if (input.queueExtendedAfter) {
      try {
        await enqueueTenantSync({
          tenantId: input.tenantId,
          reason: buildExtendedSyncReason(input.reason),
          forceFull: input.forceFull,
          syncMode: "extended"
        });
      } catch (queueError) {
        console.error("Failed to queue extended tenant sync", queueError);
      }
    }

    return {
      listingsSynced: listingIds.length,
      reservationsSynced: reservationResult.synced,
      reservationsTouched: reservationResult.reservationIds,
      calendarListingsSynced: 0
    };
  } catch (error) {
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown sync error"
      }
    });

    throw error;
  }
}

export async function runCalendarSyncForListing(payload: {
  tenantId: string;
  listingId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<{ upserted: number }> {
  const listing = await prisma.listing.findFirst({
    where: {
      id: payload.listingId,
      tenantId: payload.tenantId
    }
  });

  if (!listing) {
    return { upserted: 0 };
  }

  const gateway = await getHostawayGatewayForTenant(payload.tenantId);
  const rates = await gateway.fetchCalendarRates(listing.hostawayId, payload.dateFrom, payload.dateTo);

  const preparedRates: Array<
    (typeof rates)[number] & {
      parsedDate: Date;
    }
  > = [];

  for (const rate of rates) {
    const parsedDate = normalizeDate(rate.date);
    if (!parsedDate) continue;
    preparedRates.push({
      ...rate,
      parsedDate
    });
  }

  for (let index = 0; index < preparedRates.length; index += 500) {
    const chunk = preparedRates.slice(index, index + 500);
    const now = new Date();

    const values = chunk.map((rate) =>
      Prisma.sql`(
        ${payload.tenantId},
        ${listing.id},
        ${rate.parsedDate},
        ${rate.available},
        ${rate.minStay ?? null},
        ${rate.maxStay ?? null},
        ${rate.rate},
        ${rate.currency},
        ${now},
        CAST(${JSON.stringify(rate.raw ?? {})} AS jsonb)
      )`
    );

    if (values.length === 0) {
      continue;
    }

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO calendar_rates (
        tenant_id,
        listing_id,
        date,
        available,
        min_stay,
        max_stay,
        rate,
        currency,
        updated_at,
        raw_json
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT (tenant_id, listing_id, date)
      DO UPDATE SET
        available = EXCLUDED.available,
        min_stay = EXCLUDED.min_stay,
        max_stay = EXCLUDED.max_stay,
        rate = EXCLUDED.rate,
        currency = EXCLUDED.currency,
        updated_at = EXCLUDED.updated_at,
        raw_json = EXCLUDED.raw_json
    `);
  }

  return { upserted: preparedRates.length };
}
