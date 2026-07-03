/**
 * The daily observation orchestrator (SIGNALS-OBSERVE-LEARN-SPEC.md §3, §7).
 *
 * Per tenant, per run: resolve the engine source, ensure the 30-day window
 * (fresh clock on first run), warm-start backfill once, capture an engine
 * snapshot + diff into change events, and advance the window. The run stays
 * SILENT — it proposes and pushes NOTHING client-facing — until graduation;
 * Phase 4 fires the day-30 readout off `graduatedNow`. From day 1 it also
 * writes internal `shadow` suggestion rows (never surfaced, never applied) so
 * the ghost scorer can calibrate the method against what actually happened.
 * Tenant-scoped + read-only outside the observe tables throughout.
 *
 * The Hostaway-side event log (RateState diff → RateChange + 48h attribution +
 * rate-copy exclusion) keeps being produced by the existing rate-scan worker;
 * the observe loop reuses that output rather than re-scanning, so Hostaway is
 * read once. For `hostaway-scan` clients (Coorie Doon) that RateChange stream is
 * the entire event log — no engine snapshot is taken (spec §2 decision box).
 */

import { parsePricingSettingsOverride } from "@/lib/pricing/settings";
import { prisma } from "@/lib/prisma";

import { runBackfill, summarizeBackfill, type BackfillSummary } from "./backfill";
import { buildClientProfileDoc, writeClientProfile } from "./client-profile";
import { defaultClientKey } from "./config";
import { anonymiseForGlobal, bootstrapOrUpdateGlobalMethodology } from "./global-methodology";
import { computeClientLearnings, writeLearningLedger } from "./learnings";
import {
  advanceObservationWindow,
  ensureObservationWindow,
  type ObservationWindowRow
} from "./observation-window";
import { attachControlsForRecentChanges } from "./peer-ladder";
import { resolveObserveSource } from "./registry";
import { captureEngineSnapshotsForTenant, type CaptureResult } from "./snapshot";
import { scoreSettledSuggestions, type ScoreSettledResult } from "./suggestion-scoring";
import { generateSuggestionsForClient } from "./suggestions";

export type ObserveRunResult = {
  tenantId: string;
  tenantName: string;
  engine: string;
  daysObserved: number;
  status: string;
  graduatedNow: boolean;
  capture: CaptureResult;
  backfill: BackfillSummary | null;
  controls: { processed: number; byRung: Record<1 | 2 | 3, number> };
  learning: { profileRevision: number; globalSamples: number };
  suggestions: { generated: number; topRevenueAtRisk: number | null; mode: "pending" | "shadow" } | null;
};

/**
 * Compute the client's learnings, write its siloed profile, and fold the
 * anonymised view into the global methodology. Internal + read-only — this runs
 * during the silent window (the silence is about not PROPOSING/PUSHING; building
 * the internal learning docs is exactly what observation does). Returns the new
 * profile revision + the global sample count.
 */
async function accumulateLearning(args: {
  tenantId: string;
  clientKey: string;
  engine: string;
  includeNetRealised: boolean;
  now: Date;
}): Promise<{ profileRevision: number; globalSamples: number }> {
  const learnings = await computeClientLearnings({
    tenantId: args.tenantId,
    engine: args.engine,
    includeNetRealised: args.includeNetRealised,
    now: args.now
  });
  // Append the per-learning sample counts / null-reasons for this run — the
  // starvation record the readout matrix reads (a null learning and a computed
  // learning otherwise look identical in the logs).
  await writeLearningLedger({
    tenantId: args.tenantId,
    clientKey: args.clientKey,
    runAt: args.now,
    entries: learnings.ledger
  });
  const doc = buildClientProfileDoc(learnings);
  const profileRevision = await writeClientProfile({
    tenantId: args.tenantId,
    clientKey: args.clientKey,
    doc
  });
  const global = await bootstrapOrUpdateGlobalMethodology(anonymiseForGlobal(doc));
  return { profileRevision, globalSamples: global.samples };
}

/** Rate-copy TARGET listing ids (Signals pushes to these → "mark" source). */
async function collectRateCopyTargetListingIds(tenantId: string): Promise<Set<string>> {
  const rows = await prisma.pricingSetting.findMany({
    where: { tenantId, scope: "property", scopeRef: { not: null } },
    select: { scopeRef: true, settings: true }
  });
  const targets = new Set<string>();
  for (const row of rows) {
    const parsed = parsePricingSettingsOverride(row.settings);
    if (parsed.pricingMode === "rate_copy" && typeof row.scopeRef === "string" && row.scopeRef.trim()) {
      targets.add(row.scopeRef.trim());
    }
  }
  return targets;
}

/**
 * Run one daily observation pass for a tenant. Silent by design until day 30.
 */
export async function runObserveForTenant(args: {
  tenantId: string;
  trigger: "scheduled" | "manual";
  now?: Date;
}): Promise<ObserveRunResult> {
  const { tenantId } = args;
  const now = args.now ?? new Date();

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true }
  });
  if (!tenant) throw new Error(`observe: tenant ${tenantId} not found`);

  const source = resolveObserveSource(tenant);
  const clientKey = defaultClientKey(tenantId);

  const window = await ensureObservationWindow({ tenantId, clientKey, now });

  // Warm-start backfill once per client (guarded by backfilledAt).
  const backfill = window.backfilledAt ? null : await runBackfill({ tenantId, clientKey, now });

  // Resolve engine listing ids (PMS ids) to our Listing rows for the snapshot.
  const listings = await prisma.listing.findMany({
    where: { tenantId, removedAt: null },
    select: { id: true, hostawayId: true }
  });
  const listingIdByHostawayId = new Map(listings.map((l) => [l.hostawayId, l.id]));
  const rateCopyTargetListingIds = await collectRateCopyTargetListingIds(tenantId);

  const capture = await captureEngineSnapshotsForTenant({
    tenantId,
    source,
    listingIdByHostawayId,
    rateCopyTargetListingIds,
    now
  });

  // Attach a peer control to each recent price-drop event (spec §5).
  const controls = await attachControlsForRecentChanges({ tenantId, now });

  // Build the siloed profile + fold the anonymised view into the global doc.
  const learning = await accumulateLearning({
    tenantId,
    clientKey,
    engine: source.kind,
    includeNetRealised: false,
    now
  });

  const { window: advanced, graduatedNow } = await advanceObservationWindow({ tenantId, clientKey, now });

  // Suggestions run EVERY day. Graduated clients write `pending` rows (the
  // human-approval queue, spec §9). Clients still inside the window write
  // `shadow` rows from day 1 — invisible to the readout's pending list and the
  // day-30 email, they exist purely as calibration data for the ghost scorer,
  // so the 30 silent days produce testable predictions instead of nothing.
  // Nothing is applied in either mode; the client-facing silence holds.
  const suggestionStatus = advanced.status === "graduated" ? ("pending" as const) : ("shadow" as const);
  const suggestions = await generateSuggestionsForClient({ tenantId, clientKey, now, status: suggestionStatus });

  console.log(
    `[observe] tenant=${tenant.name} engine=${source.kind} day=${advanced.daysObserved}/30 ` +
      `status=${advanced.status} captured=${capture.captured} changes=${capture.changes} ` +
      `controls=${controls.processed} profileRev=${learning.profileRevision}` +
      ` suggestions=${suggestions.generated} (${suggestions.mode})` +
      (graduatedNow ? " GRADUATED (day-30 readout firing)" : " (silent)")
  );

  return {
    tenantId,
    tenantName: tenant.name,
    engine: source.kind,
    daysObserved: advanced.daysObserved,
    status: advanced.status,
    graduatedNow,
    capture,
    backfill,
    controls,
    learning,
    suggestions
  };
}

export type WeeklySettleResult = {
  tenantId: string;
  backfill: BackfillSummary;
  window: ObservationWindowRow;
  learning: { profileRevision: number; globalSamples: number };
  scoring: ScoreSettledResult;
};

/**
 * Weekly settle (spec §10). Recomputes the learnings INCLUDING the net-realised
 * rate (#6) — which is only meaningful once the week's Hostaway financials have
 * settled — re-writes the profile, and folds the anonymised view into the global
 * doc. Also runs the GHOST SCORER: every suggestion (shadow, superseded,
 * pending) whose stay date has settled gets its real-world outcome recorded on
 * `Suggestion.detail.score`. Read-only outside the observe tables; tenant-scoped.
 */
export async function runWeeklySettleForTenant(args: {
  tenantId: string;
  now?: Date;
}): Promise<WeeklySettleResult> {
  const { tenantId } = args;
  const now = args.now ?? new Date();
  const clientKey = defaultClientKey(tenantId);

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`observe-settle: tenant ${tenantId} not found`);
  const source = resolveObserveSource(tenant);

  await ensureObservationWindow({ tenantId, clientKey, now });
  const backfill = await summarizeBackfill({ tenantId, clientKey });
  const learning = await accumulateLearning({
    tenantId,
    clientKey,
    engine: source.kind,
    includeNetRealised: true,
    now
  });
  const { window } = await advanceObservationWindow({ tenantId, clientKey, now });
  // Ghost scoring: settle the real-world outcome of every past-dated suggestion
  // (shadow/superseded/pending). Writes only Suggestion.detail; applies nothing.
  const scoring = await scoreSettledSuggestions({ tenantId, now });
  console.log(
    `[observe-settle] tenant=${tenantId} day=${window.daysObserved}/30 nights=${backfill.nightFacts} ` +
      `profileRev=${learning.profileRevision} scored=${scoring.scored} rechecked=${scoring.rechecked} ` +
      `(net-realised settled, read-only)`
  );
  return { tenantId, backfill, window, learning, scoring };
}
