/**
 * Warm-start backfill (SIGNALS-OBSERVE-LEARN-SPEC.md §7).
 *
 * Before forward observation, mine the history Signals already holds so the
 * profile starts warm, not cold: own booked nights (`NightFact`), pace
 * (`PaceSnapshot`), reservations, and the existing Hostaway-side `RateChange`
 * event log. Phase 2 records the breadth of available history and stamps the
 * window as backfilled; Phase 3 consumes the actual history (via the report
 * builders) when it builds the learnings. Read-only + tenant-scoped throughout.
 */

import { prisma } from "@/lib/prisma";

import { defaultClientKey } from "./config";
import { markBackfilled } from "./observation-window";

export type BackfillSummary = {
  tenantId: string;
  clientKey: string;
  nightFacts: number;
  paceSnapshots: number;
  reservations: number;
  rateChanges: number;
  earliestNight: string | null;
  latestNight: string | null;
  /** True once there is enough own history to bootstrap learning warmly. */
  warm: boolean;
};

/** Minimum booked nights for the history to count as a warm start. */
export const WARM_START_MIN_NIGHTS = 30;

function dateOnly(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Read-only summary of the history available to seed a client's profile.
 * Every query filters by `tenantId`.
 */
export async function summarizeBackfill(args: {
  tenantId: string;
  clientKey?: string;
}): Promise<BackfillSummary> {
  const { tenantId } = args;
  const clientKey = args.clientKey ?? defaultClientKey(tenantId);

  const [nightFacts, paceSnapshots, reservations, rateChanges, earliest, latest] = await Promise.all([
    prisma.nightFact.count({ where: { tenantId, isOccupied: true } }),
    prisma.paceSnapshot.count({ where: { tenantId } }),
    prisma.reservation.count({ where: { tenantId } }),
    prisma.rateChange.count({ where: { tenantId } }),
    prisma.nightFact.findFirst({
      where: { tenantId, isOccupied: true },
      orderBy: { date: "asc" },
      select: { date: true }
    }),
    prisma.nightFact.findFirst({
      where: { tenantId, isOccupied: true },
      orderBy: { date: "desc" },
      select: { date: true }
    })
  ]);

  return {
    tenantId,
    clientKey,
    nightFacts,
    paceSnapshots,
    reservations,
    rateChanges,
    earliestNight: dateOnly(earliest?.date ?? null),
    latestNight: dateOnly(latest?.date ?? null),
    warm: nightFacts >= WARM_START_MIN_NIGHTS
  };
}

/**
 * Run the backfill once for a client and stamp `backfilledAt`. Idempotent — the
 * window's `backfilledAt` guard means callers only invoke this when it is null.
 */
export async function runBackfill(args: {
  tenantId: string;
  clientKey?: string;
  now?: Date;
}): Promise<BackfillSummary> {
  const summary = await summarizeBackfill(args);
  await markBackfilled({ tenantId: args.tenantId, clientKey: summary.clientKey, now: args.now });
  console.log(
    `[observe] backfill tenant=${args.tenantId} nights=${summary.nightFacts} pace=${summary.paceSnapshots} ` +
      `reservations=${summary.reservations} rateChanges=${summary.rateChanges} warm=${summary.warm}`
  );
  return summary;
}
