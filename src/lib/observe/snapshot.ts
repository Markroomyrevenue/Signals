/**
 * Engine snapshot capture + diff (SIGNALS-OBSERVE-LEARN-SPEC.md §4, §6).
 *
 * Captures the engine's current levers as an `EngineSnapshot` (the engine-side
 * mirror of RateState), then diffs against the previous snapshot to emit
 * `EngineChange` events with an inferred source (engine | owner | mark). All
 * read-only against the engine. The pure diff + source-inference functions are
 * unit-tested; the DB wrapper is tenant-scoped and resilient (a per-listing
 * fetch failure is counted and skipped, never aborts the tenant).
 */

import { prisma } from "@/lib/prisma";

import { ENGINE_CHANGE_EPSILON, SOURCE_MATCH_WINDOW_HOURS } from "./config";
import type { ResolvedObserveSource } from "./registry";
import type { EngineRecentChange } from "./engine/types";

const HOUR_MS = 60 * 60 * 1000;

/** The lever values a snapshot diff compares. */
export type EngineSnapshotValues = {
  base: number | null;
  min: number | null;
  max: number | null;
  minStay: number | null;
};

export type EngineChangeSource = "engine" | "owner" | "mark";

/** One detected lever move, before it is persisted as an `EngineChange`. */
export type EngineChangeDraft = {
  lever: "base_price" | "min" | "max" | "min_stay";
  oldValue: number | null;
  newValue: number | null;
  changePct: number | null;
};

const NUMERIC_LEVERS: Array<{ key: "base" | "min" | "max"; lever: EngineChangeDraft["lever"] }> = [
  { key: "base", lever: "base_price" },
  { key: "min", lever: "min" },
  { key: "max", lever: "max" }
];

/**
 * Diff two consecutive snapshots into the levers that moved. Pure.
 * - base/min/max: a move beyond `ENGINE_CHANGE_EPSILON` (with changePct).
 * - min_stay: any integer change (no changePct).
 * A lever that was null and stays null, or is null on either side, emits nothing.
 */
export function diffEngineSnapshots(
  prev: EngineSnapshotValues,
  curr: EngineSnapshotValues
): EngineChangeDraft[] {
  const drafts: EngineChangeDraft[] = [];

  for (const { key, lever } of NUMERIC_LEVERS) {
    const oldVal = prev[key];
    const newVal = curr[key];
    if (oldVal === null || newVal === null) continue;
    if (Math.abs(newVal - oldVal) <= ENGINE_CHANGE_EPSILON) continue;
    drafts.push({
      lever,
      oldValue: oldVal,
      newValue: newVal,
      changePct: oldVal !== 0 ? (newVal - oldVal) / oldVal : null
    });
  }

  if (prev.minStay !== null && curr.minStay !== null && prev.minStay !== curr.minStay) {
    drafts.push({ lever: "min_stay", oldValue: prev.minStay, newValue: curr.minStay, changePct: null });
  }

  return drafts;
}

/**
 * Infer who moved a lever (spec §6). Pure, best-effort:
 *  - `engine` — the change's timing matches the engine's own `last_refreshed_at`
 *    or a `recent_changes` event (within `SOURCE_MATCH_WINDOW_HOURS`).
 *  - `mark` — the listing is a Signals rate-copy target (our tooling drives it).
 *  - `owner` — otherwise (a human moved a lever in the engine UI).
 */
export function inferEngineChangeSource(args: {
  detectedAt: Date;
  lastRefreshedAt: Date | null;
  recentChanges: EngineRecentChange[];
  isRateCopyTarget: boolean;
  matchWindowHours?: number;
}): EngineChangeSource {
  const windowMs = (args.matchWindowHours ?? SOURCE_MATCH_WINDOW_HOURS) * HOUR_MS;
  const detected = args.detectedAt.getTime();

  const matchesEngineTiming =
    (args.lastRefreshedAt !== null && Math.abs(detected - args.lastRefreshedAt.getTime()) <= windowMs) ||
    args.recentChanges.some((c) => Math.abs(detected - c.at.getTime()) <= windowMs);

  if (matchesEngineTiming) return "engine";
  if (args.isRateCopyTarget) return "mark";
  return "owner";
}

export type CaptureResult = {
  engine: string;
  captured: number;
  changes: number;
  failed: number;
  skipped: string | null;
};

/**
 * Capture one snapshot per engine listing and diff it into `EngineChange` rows.
 * No-op for `hostaway-scan` sources (no engine API — their event log is the
 * rate-scanner's `RateChange`, spec §2 decision box). Tenant-scoped throughout.
 */
export async function captureEngineSnapshotsForTenant(args: {
  tenantId: string;
  source: ResolvedObserveSource;
  listingIdByHostawayId: Map<string, string>;
  rateCopyTargetListingIds: Set<string>;
  now?: Date;
}): Promise<CaptureResult> {
  const { tenantId, source, listingIdByHostawayId, rateCopyTargetListingIds } = args;
  const now = args.now ?? new Date();

  if (!source.adapter) {
    return { engine: source.kind, captured: 0, changes: 0, failed: 0, skipped: "no-engine-adapter" };
  }

  let listings;
  try {
    listings = await source.adapter.listClients();
  } catch (error) {
    console.error(
      `[observe] listClients failed tenant=${tenantId} engine=${source.kind}:`,
      error instanceof Error ? error.message : error
    );
    return { engine: source.kind, captured: 0, changes: 0, failed: 1, skipped: "list-failed" };
  }

  let captured = 0;
  let changes = 0;
  let failed = 0;

  for (const listing of listings) {
    try {
      const [levers, signals, recentChanges] = await Promise.all([
        source.adapter.fetchLevers(listing.engineListingId),
        source.adapter.fetchEngineSignals(listing.engineListingId),
        source.adapter.fetchRecentChanges(listing.engineListingId)
      ]);

      // PriceLabs/Wheelhouse listing id is the PMS (Hostaway) id, so it maps to
      // our Listing by hostawayId when present.
      const signalsListingId = listingIdByHostawayId.get(listing.engineListingId) ?? null;

      const prior = await prisma.engineSnapshot.findFirst({
        where: { tenantId, engine: source.kind, engineListingId: listing.engineListingId },
        orderBy: { capturedAt: "desc" },
        select: { id: true, base: true, min: true, max: true, minStay: true }
      });

      const snapshot = await prisma.engineSnapshot.create({
        data: {
          tenantId,
          engine: source.kind,
          engineListingId: listing.engineListingId,
          listingId: signalsListingId,
          base: levers.base,
          min: levers.min,
          max: levers.max,
          minStay: levers.minStay,
          recommendedBase: signals.recommendedBase,
          occNext7: signals.occNext7,
          occNext30: signals.occNext30,
          occNext60: signals.occNext60,
          marketOccNext7: signals.marketOccNext7,
          marketOccNext30: signals.marketOccNext30,
          marketOccNext60: signals.marketOccNext60,
          pushEnabled: listing.pushEnabled,
          lastRefreshedAt: listing.lastRefreshedAt,
          lastDatePushed: listing.lastDatePushed,
          capturedAt: now
        },
        select: { id: true }
      });
      captured += 1;

      if (prior) {
        const drafts = diffEngineSnapshots(
          {
            base: prior.base === null ? null : Number(prior.base),
            min: prior.min === null ? null : Number(prior.min),
            max: prior.max === null ? null : Number(prior.max),
            minStay: prior.minStay
          },
          { base: levers.base, min: levers.min, max: levers.max, minStay: levers.minStay }
        );

        for (const draft of drafts) {
          const changeSource = inferEngineChangeSource({
            detectedAt: now,
            lastRefreshedAt: listing.lastRefreshedAt,
            recentChanges,
            isRateCopyTarget: signalsListingId ? rateCopyTargetListingIds.has(signalsListingId) : false
          });
          await prisma.engineChange.create({
            data: {
              tenantId,
              engine: source.kind,
              engineListingId: listing.engineListingId,
              listingId: signalsListingId,
              lever: draft.lever,
              oldValue: draft.oldValue,
              newValue: draft.newValue,
              changePct: draft.changePct,
              source: changeSource,
              fromSnapshotId: prior.id,
              toSnapshotId: snapshot.id,
              detectedAt: now
            }
          });
          changes += 1;
        }
      }
    } catch (error) {
      failed += 1;
      console.error(
        `[observe] snapshot failed tenant=${tenantId} engine=${source.kind} listing=${listing.engineListingId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return { engine: source.kind, captured, changes, failed, skipped: null };
}
