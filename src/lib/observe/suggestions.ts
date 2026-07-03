/**
 * Gated suggestions (SIGNALS-OBSERVE-LEARN-SPEC.md §9).
 *
 * Once a client graduates, write `Suggestion` rows ordered by REVENUE AT RISK,
 * each judged against the EXPECTED BOOKING CURVE FOR THAT LEAD TIME (not against
 * final occupancy). Nothing is applied — every row is `pending` and waits for
 * human approval. The pure judging core is unit-tested; the DB generator is
 * tenant-scoped and read-only outside the `Suggestion` table.
 */

import { getTrialLocalEventsForTenant } from "@/lib/agents/pricing-comparison/trial-events";
import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { eventAdjustmentForDate } from "@/lib/pricing/events";
import { parsePricingSettingsOverride, type PricingLocalEvent } from "@/lib/pricing/settings";
import { tenantNameSlug } from "@/lib/pricing/trial-tenants";
import { prisma } from "@/lib/prisma";

import { computeLeadTime } from "./learnings";
import { LEAD_TIME_BUCKETS, type LeadTimeDistribution } from "./learnings-core";

/** Default horizon for forward suggestions (signal horizon is ~6 months). */
export const SUGGESTION_HORIZON_DAYS = 120;
/** Below this expected-fill, an empty night is normal — not yet at risk. */
export const RISK_FILL_THRESHOLD = 0.5;
/** Cap rows per client so the readout stays focused on what matters most. */
export const MAX_SUGGESTIONS = 50;
/** How far back `rate_states` is scanned for the lowest-observed-rate floor fallback. */
export const FLOOR_LOOKBACK_DAYS = 180;
/** Per-night cumulative drop cap: prior non-pending drops within the trailing
 * window totalling this much block any further drop (anti-ratchet). */
export const CUMULATIVE_DROP_CAP = 0.25;
/** Trailing window (days) over which prior drops count toward the cumulative cap. */
export const CUMULATIVE_CAP_WINDOW_DAYS = 14;
/**
 * Machine-written statuses the daily regeneration replaces. These rows are
 * marked `superseded` — NEVER deleted — so the record of what was suggested
 * when, at what rate, survives for retrospective (ghost) scoring.
 * Human-actioned rows (`approved` / `rejected` / `applied`) are never touched.
 *
 * Volume + retention: rows are superseded daily, so the table grows by at most
 * ~`MAX_SUGGESTIONS` rows per client per day. Superseded rows older than 120
 * days may be pruned by a follow-up job — no pruning is built yet.
 */
export const SUPERSEDABLE_STATUSES = ["pending", "shadow"] as const;

/**
 * Why a would-be suggestion was suppressed. Deliberately surfaced (counted +
 * persisted + rendered in the readout) as a trust metric: the reviewer can see
 * how many drops the safety gates held back, and why.
 */
export type SuggestionBlockedReason = "min_floor" | "event" | "already_actioned" | "cumulative_cap";

export type SuggestionBlockedCounts = Partial<Record<SuggestionBlockedReason, number>>;

/**
 * Expected cumulative fill by `daysToStay` days before stay: the fraction of
 * bookings that typically arrive at least this far ahead (lead ≥ daysToStay).
 * Sums bucket pcts by each bucket's midpoint lead. Pure.
 */
export function expectedCumulativeFill(daysToStay: number, buckets: LeadTimeDistribution["buckets"]): number {
  const pctByLabel = new Map(buckets.map((b) => [b.label, b.pct]));
  let fill = 0;
  for (const def of LEAD_TIME_BUCKETS) {
    const mid = def.max === Number.POSITIVE_INFINITY ? def.min : (def.min + def.max) / 2;
    if (mid >= daysToStay) fill += pctByLabel.get(def.label) ?? 0;
  }
  return fill;
}

export type NightJudgement = {
  atRisk: boolean;
  revenueAtRisk: number;
  proposedValue: number | null;
  dropPct: number;
  confidence: number;
  reason: string;
  /** Set when the night IS at risk but a safety gate suppressed the drop. */
  blockedReason?: SuggestionBlockedReason;
  /** Set when no minimum-price floor could be resolved — the drop went out unclamped. */
  floorUnknown?: boolean;
};

/**
 * Judge one forward night against the booking curve. Pure. An empty night whose
 * expected fill is already high (it should normally be booked by now) is behind
 * pace → revenue at risk → a timed-pct drop. A night still early on its curve is
 * fine. Booked nights are never at risk.
 *
 * Safety gates (each returns `atRisk: true` + a `blockedReason` instead of a
 * drop, so the caller can count what was held back):
 * - `already_actioned`: a human has already approved (or a push has applied) a
 *   suggestion for this night — regenerating a fresh drop on top would compound
 *   cut-on-cut with no memory.
 * - `event`: the night carries a positive local-event adjustment (it is priced
 *   UP for an event, e.g. Fleadh Cheoil) — never propose a drop against an
 *   event lift; empty event nights are the event pricing playing out, not a
 *   pace problem.
 * - `cumulative_cap`: prior non-pending drops for this night within the
 *   trailing `CUMULATIVE_CAP_WINDOW_DAYS` days already total
 *   ≥ `CUMULATIVE_DROP_CAP` — the anti-ratchet stop.
 * - `min_floor`: `proposedValue` is clamped to `floor` (the listing's minimum
 *   price); if the clamped value is at or above the current rate there is no
 *   room to drop, so nothing is emitted. When `floor` is null/undefined the
 *   clamp is skipped and the judgement is flagged `floorUnknown`.
 */
export function judgeNightForSuggestion(args: {
  daysToStay: number;
  booked: boolean;
  rate: number;
  expectedFill: number;
  riskThreshold?: number;
  /** Resolved minimum price for the listing; null/undefined = unknown. */
  floor?: number | null;
  /** Local-event adjustment (%) covering this night; null/undefined = none. */
  eventAdjustmentPct?: number | null;
  /** An approved/applied suggestion already covers this night. */
  hasActionedSuggestion?: boolean;
  /** Sum of prior non-pending drop pcts (0..1) for this night, trailing window. */
  cumulativeDropPct?: number;
  /**
   * Trailing-365d final occupancy (0..1) for this night's day-of-week. The raw
   * curve is the share of EVENTUAL bookings with lead ≥ d, not the probability
   * the night is booked; multiplying by final occupancy calibrates the trigger
   * so it compares like with like. Default 1 (no scaling).
   */
  occupancyFactor?: number;
  /**
   * Unsold units on this night (multi-unit listings sell N rooms of one type;
   * `Listing.unitCount >= 2`). Scales revenueAtRisk — a 40-unit building with
   * one room left has 1 unit's revenue at risk, an empty one has 40. Default 1.
   */
  unsoldUnits?: number;
}): NightJudgement {
  const threshold = args.riskThreshold ?? RISK_FILL_THRESHOLD;
  if (args.booked || args.rate <= 0 || args.daysToStay < 0) {
    return { atRisk: false, revenueAtRisk: 0, proposedValue: null, dropPct: 0, confidence: 0, reason: "not at risk" };
  }
  const occupancyFactor = Math.min(1, Math.max(0, args.occupancyFactor ?? 1));
  const scaledFill = args.expectedFill * occupancyFactor;
  const fillLabel =
    `raw curve ${(args.expectedFill * 100).toFixed(0)}%` +
    (occupancyFactor < 1 ? `, occupancy-scaled ${(scaledFill * 100).toFixed(0)}%` : "");
  if (scaledFill < threshold) {
    return {
      atRisk: false,
      revenueAtRisk: 0,
      proposedValue: null,
      dropPct: 0,
      confidence: 0,
      reason: `early on curve (expected fill ${fillLabel} < ${(threshold * 100).toFixed(0)}%)`
    };
  }
  // Behind pace: scale the drop with how far past the curve we are.
  const dropPct = Math.min(0.25, Math.max(0.05, (scaledFill - threshold) * 0.5 + 0.05));
  const confidence = Math.min(0.9, scaledFill);
  // Multi-unit: revenue at risk is the nightly rate times the units still unsold.
  const revenueAtRisk = args.rate * Math.max(1, Math.round(args.unsoldUnits ?? 1));
  const reason = `empty at ${args.daysToStay}d out; curve expects ~${(scaledFill * 100).toFixed(0)}% booked by now (${fillLabel})`;

  // No compounding: a night a human already actioned never gets a fresh drop.
  if (args.hasActionedSuggestion) {
    return {
      atRisk: true,
      revenueAtRisk,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason: `${reason}; an approved/applied suggestion already covers this night — no fresh drop`,
      blockedReason: "already_actioned"
    };
  }

  // Event shield: a positively event-adjusted night is priced up on purpose —
  // never counter it with a drop.
  if (typeof args.eventAdjustmentPct === "number" && args.eventAdjustmentPct > 0) {
    return {
      atRisk: true,
      revenueAtRisk,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason: `${reason}; night carries a +${args.eventAdjustmentPct}% event adjustment — drop withheld`,
      blockedReason: "event"
    };
  }

  // Anti-ratchet: prior drops within the trailing window already total the cap.
  if ((args.cumulativeDropPct ?? 0) >= CUMULATIVE_DROP_CAP) {
    return {
      atRisk: true,
      revenueAtRisk,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason:
        `${reason}; prior drops in the last ${CUMULATIVE_CAP_WINDOW_DAYS}d total ` +
        `${(((args.cumulativeDropPct ?? 0)) * 100).toFixed(0)}% ≥ ${(CUMULATIVE_DROP_CAP * 100).toFixed(0)}% cap`,
      blockedReason: "cumulative_cap"
    };
  }

  const floorKnown = args.floor !== null && args.floor !== undefined && args.floor > 0;
  const unclamped = Math.round(args.rate * (1 - dropPct));
  // Never propose below the listing's minimum price (ceil so a fractional floor
  // is never undercut by rounding).
  const proposedValue = floorKnown ? Math.max(unclamped, Math.ceil(args.floor as number)) : unclamped;
  if (proposedValue >= args.rate) {
    return {
      atRisk: true,
      revenueAtRisk,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason: `${reason}; drop clamped to min price ${proposedValue} ≥ current rate — no room to drop`,
      blockedReason: "min_floor"
    };
  }
  return {
    atRisk: true,
    revenueAtRisk,
    proposedValue,
    dropPct,
    confidence,
    reason,
    ...(floorKnown ? {} : { floorUnknown: true })
  };
}

export type SuggestionDraft = {
  listingId: string;
  date: string;
  oldValue: number;
  proposedValue: number;
  revenueAtRisk: number;
  confidence: number;
  reason: string;
  detail?: { floorUnknown?: boolean; floor?: number };
};

export type SuggestionNightInput = {
  listingId: string;
  date: string;
  daysToStay: number;
  booked: boolean;
  rate: number;
  /** Resolved minimum price for the listing; null/undefined = unknown (clamp skipped). */
  floor?: number | null;
  /** Local-event adjustment (%) covering this night; null/undefined = none. */
  eventAdjustmentPct?: number | null;
  /** An approved/applied suggestion already covers this night. */
  hasActionedSuggestion?: boolean;
  /** Sum of prior non-pending drop pcts (0..1) for this night, trailing window. */
  cumulativeDropPct?: number;
  /** Trailing-365d final occupancy (0..1) for this night's day-of-week. */
  occupancyFactor?: number;
  /** Unsold units on this night (multi-unit); scales revenueAtRisk. Default 1. */
  unsoldUnits?: number;
};

export type BuildSuggestionDraftsResult = {
  drafts: SuggestionDraft[];
  /** Would-be suggestions suppressed by a safety gate, by reason. Trust metric. */
  blocked: SuggestionBlockedCounts;
};

function countBlocked(blocked: SuggestionBlockedCounts, reason: SuggestionBlockedReason): void {
  blocked[reason] = (blocked[reason] ?? 0) + 1;
}

/** Pure: turn forward nights + the curve into ordered, capped suggestion drafts. */
export function buildSuggestionDrafts(args: {
  nights: SuggestionNightInput[];
  buckets: LeadTimeDistribution["buckets"];
  maxSuggestions?: number;
}): BuildSuggestionDraftsResult {
  const drafts: SuggestionDraft[] = [];
  const blocked: SuggestionBlockedCounts = {};
  for (const night of args.nights) {
    const judged = judgeNightForSuggestion({
      daysToStay: night.daysToStay,
      booked: night.booked,
      rate: night.rate,
      expectedFill: expectedCumulativeFill(night.daysToStay, args.buckets),
      floor: night.floor,
      eventAdjustmentPct: night.eventAdjustmentPct,
      hasActionedSuggestion: night.hasActionedSuggestion,
      cumulativeDropPct: night.cumulativeDropPct,
      occupancyFactor: night.occupancyFactor,
      unsoldUnits: night.unsoldUnits
    });
    if (judged.blockedReason) {
      countBlocked(blocked, judged.blockedReason);
      continue;
    }
    if (judged.atRisk && judged.proposedValue !== null) {
      const floorKnown = night.floor !== null && night.floor !== undefined && night.floor > 0;
      drafts.push({
        listingId: night.listingId,
        date: night.date,
        oldValue: night.rate,
        proposedValue: judged.proposedValue,
        revenueAtRisk: judged.revenueAtRisk,
        confidence: judged.confidence,
        reason: judged.reason,
        ...(judged.floorUnknown
          ? { detail: { floorUnknown: true } }
          : floorKnown
            ? { detail: { floor: night.floor as number } }
            : {})
      });
    }
  }
  drafts.sort((a, b) => b.revenueAtRisk - a.revenueAtRisk);
  return { drafts: drafts.slice(0, args.maxSuggestions ?? MAX_SUGGESTIONS), blocked };
}

export type GenerateSuggestionsResult = {
  generated: number;
  topRevenueAtRisk: number | null;
  /** Would-be suggestions suppressed by the safety gates, by reason. */
  blocked: SuggestionBlockedCounts;
  /** `pending` (graduated: the human queue) or `shadow` (calibration only). */
  mode: "pending" | "shadow";
};

/** The exact row shape a regeneration writes to the `Suggestion` table. */
export type SuggestionInsertRow = {
  tenantId: string;
  clientKey: string;
  listingId: string;
  dateFrom: Date;
  dateTo: Date;
  lever: "price";
  oldValue: number;
  proposedValue: number;
  type: "timed-pct";
  reason: string;
  revenueAtRisk: number;
  confidence: number;
  status: "pending" | "shadow";
  detail?: { floorUnknown?: boolean; floor?: number };
};

/** The two `Suggestion`-table writes a regeneration needs (prisma or a fake). */
export type SuggestionRegenerationStore = {
  updateMany(args: {
    where: { tenantId: string; clientKey: string; status: { in: string[] } };
    data: { status: "superseded" };
  }): Promise<unknown>;
  createMany(args: { data: SuggestionInsertRow[] }): Promise<unknown>;
};

/**
 * Persist one regeneration pass: mark the client's prior machine-written rows
 * (`pending` + `shadow`) as `superseded` — never deleted; they are the ghost
 * scorer's raw material — then insert the fresh drafts with the given status
 * (`pending` for graduated clients, `shadow` during the observation window).
 * Human-actioned rows are untouched. Tenant + clientKey scoped.
 */
export async function applySuggestionRegeneration(args: {
  store: SuggestionRegenerationStore;
  tenantId: string;
  clientKey: string;
  status: "pending" | "shadow";
  drafts: SuggestionDraft[];
}): Promise<void> {
  await args.store.updateMany({
    where: { tenantId: args.tenantId, clientKey: args.clientKey, status: { in: [...SUPERSEDABLE_STATUSES] } },
    data: { status: "superseded" }
  });
  if (args.drafts.length > 0) {
    await args.store.createMany({
      data: args.drafts.map((d) => ({
        tenantId: args.tenantId,
        clientKey: args.clientKey,
        listingId: d.listingId,
        dateFrom: fromDateOnly(d.date),
        dateTo: fromDateOnly(d.date),
        lever: "price" as const,
        oldValue: d.oldValue,
        proposedValue: d.proposedValue,
        type: "timed-pct" as const,
        reason: d.reason,
        revenueAtRisk: d.revenueAtRisk,
        confidence: d.confidence,
        status: args.status,
        ...(d.detail ? { detail: d.detail } : {})
      }))
    });
  }
}

/**
 * Resolve the local events visible to the suggestion generator, via the shared
 * `eventAdjustmentForDate` helper's input shape (CLAUDE.md: one source of truth
 * for event date resolution; nothing is routed through `settings.localEvents`
 * writes). Two read-only sources:
 * 1. The trial-only events file (`trial-events.ts`) — e.g. Fleadh Cheoil 2026.
 * 2. Any `localEvents` already present in the tenant's pricing settings.
 * Portfolio/group-scope events apply tenant-wide (conservative: for a drop
 * SHIELD, over-blocking is the safe direction); property-scope events apply to
 * that listing only. Tenant-scoped, read-only. Also reused by the weekly
 * learner report's "coming up" section (weekly-report.ts).
 */
export async function resolveLocalEvents(args: {
  tenantId: string;
}): Promise<{ tenantWide: PricingLocalEvent[]; byListingId: Map<string, PricingLocalEvent[]> }> {
  const [tenant, settingRows] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: args.tenantId }, select: { id: true, name: true } }),
    prisma.pricingSetting.findMany({
      where: { tenantId: args.tenantId },
      select: { scope: true, scopeRef: true, settings: true }
    })
  ]);
  const tenantWide: PricingLocalEvent[] = tenant
    ? [...getTrialLocalEventsForTenant({ id: tenant.id, name: tenant.name, slug: tenantNameSlug(tenant.name) })]
    : [];
  const byListingId = new Map<string, PricingLocalEvent[]>();
  for (const row of settingRows) {
    const events = parsePricingSettingsOverride(row.settings).localEvents;
    if (!events || events.length === 0) continue;
    if (row.scope === "property" && typeof row.scopeRef === "string" && row.scopeRef.trim()) {
      const key = row.scopeRef.trim();
      byListingId.set(key, [...(byListingId.get(key) ?? []), ...events]);
    } else {
      tenantWide.push(...events);
    }
  }
  return { tenantWide, byListingId };
}

/**
 * Resolve each listing's minimum-price floor. Resolution order (first hit wins):
 * 1. Latest `EngineSnapshot.min` for the listing (the engine's own floor).
 * 2. The pricing-settings `minimumPriceOverride` for the listing (property scope).
 * 3. The lowest rate observed for the listing in `rate_states` over the trailing
 *    `FLOOR_LOOKBACK_DAYS` days.
 * Listings with no hit are absent from the map (floor unknown → clamp skipped,
 * draft flagged `floorUnknown`). Tenant-scoped, read-only.
 */
async function resolveListingFloors(args: {
  tenantId: string;
  listingIds: string[];
  today: Date;
}): Promise<Map<string, number>> {
  const { tenantId, listingIds } = args;
  const floors = new Map<string, number>();
  if (listingIds.length === 0) return floors;

  const [snapshotMins, settingRows, observedMins] = await Promise.all([
    // distinct+orderBy ⇒ the newest snapshot per listing that carries a min.
    prisma.engineSnapshot.findMany({
      where: { tenantId, listingId: { in: listingIds }, min: { not: null } },
      orderBy: { capturedAt: "desc" },
      distinct: ["listingId"],
      select: { listingId: true, min: true }
    }),
    prisma.pricingSetting.findMany({
      where: { tenantId, scope: "property", scopeRef: { in: listingIds } },
      select: { scopeRef: true, settings: true }
    }),
    prisma.rateState.groupBy({
      by: ["listingId"],
      where: {
        tenantId,
        listingId: { in: listingIds },
        rate: { gt: 0 },
        date: { gte: addUtcDays(args.today, -FLOOR_LOOKBACK_DAYS), lte: args.today }
      },
      _min: { rate: true }
    })
  ]);

  // Apply in reverse priority so higher-priority sources overwrite.
  for (const row of observedMins) {
    const min = row._min.rate === null ? null : Number(row._min.rate);
    if (min !== null && min > 0) floors.set(row.listingId, min);
  }
  for (const row of settingRows) {
    if (typeof row.scopeRef !== "string") continue;
    const parsed = parsePricingSettingsOverride(row.settings);
    const min = parsed.minimumPriceOverride;
    if (typeof min === "number" && min > 0) floors.set(row.scopeRef, min);
  }
  for (const row of snapshotMins) {
    const min = row.min === null ? null : Number(row.min);
    if (row.listingId && min !== null && min > 0) floors.set(row.listingId, min);
  }
  return floors;
}

/**
 * Trailing-365d final occupancy by UTC day-of-week (index 0 = Sunday), used to
 * calibrate the booking-curve trigger. Numerator: occupied unit-nights from
 * `NightFact` (per listing-date, capped at the listing's unitCount so stacked
 * facts cannot exceed capacity). Denominator: total sellable units × the number
 * of that DOW's dates in the window. Listings added mid-year overstate the
 * denominator slightly — that errs towards FEWER suggestions, the safe side.
 * Returns null (no scaling) when the tenant has no sellable units or no
 * occupied history. Tenant-scoped, read-only.
 */
async function computeDowOccupancy(args: { tenantId: string; today: Date }): Promise<number[] | null> {
  const { tenantId, today } = args;
  const windowStart = addUtcDays(today, -365);
  const [listings, facts] = await Promise.all([
    prisma.listing.findMany({
      where: { tenantId, removedAt: null },
      select: { id: true, unitCount: true }
    }),
    prisma.nightFact.findMany({
      where: { tenantId, isOccupied: true, date: { gte: windowStart, lt: today } },
      select: { listingId: true, date: true }
    })
  ]);
  const unitCountByListing = new Map(listings.map((l) => [l.id, Math.max(1, l.unitCount ?? 1)]));
  const totalUnits = listings.reduce((sum, l) => sum + Math.max(1, l.unitCount ?? 1), 0);
  if (totalUnits === 0 || facts.length === 0) return null;

  // Occupied units per (listing, date), capped at the listing's capacity.
  const occupiedByNight = new Map<string, { dow: number; listingId: string; count: number }>();
  for (const fact of facts) {
    const key = `${fact.listingId}|${toDateOnly(fact.date)}`;
    const entry = occupiedByNight.get(key);
    if (entry) entry.count += 1;
    else occupiedByNight.set(key, { dow: fact.date.getUTCDay(), listingId: fact.listingId, count: 1 });
  }
  const occupiedByDow = [0, 0, 0, 0, 0, 0, 0];
  for (const entry of occupiedByNight.values()) {
    occupiedByDow[entry.dow] += Math.min(entry.count, unitCountByListing.get(entry.listingId) ?? 1);
  }
  const dowDateCounts = [0, 0, 0, 0, 0, 0, 0];
  for (let cursor = windowStart; cursor.getTime() < today.getTime(); cursor = addUtcDays(cursor, 1)) {
    dowDateCounts[cursor.getUTCDay()] += 1;
  }
  return occupiedByDow.map((occupied, dow) => {
    const denominator = totalUnits * dowDateCounts[dow];
    return denominator > 0 ? Math.min(1, occupied / denominator) : 1;
  });
}

/**
 * Per-night guards against compounding drops, from prior `Suggestion` rows for
 * the SAME tenant/listing/date (any clientKey — night safety is per night):
 * - `actioned`: nights covered by an approved/applied suggestion (never re-drop).
 * - `cumulativeDropPct`: sum of non-pending drop pcts created within the trailing
 *   `CUMULATIVE_CAP_WINDOW_DAYS` days, keyed `listingId|date`.
 * Tenant-scoped, read-only.
 */
async function resolvePriorSuggestionGuards(args: {
  tenantId: string;
  today: Date;
  horizonEnd: Date;
  now: Date;
}): Promise<{ actioned: Set<string>; cumulativeDropPct: Map<string, number> }> {
  const { tenantId, today, horizonEnd } = args;
  const [actionedRows, recentRows] = await Promise.all([
    prisma.suggestion.findMany({
      where: {
        tenantId,
        lever: "price",
        status: { in: ["approved", "applied"] },
        listingId: { not: null },
        dateTo: { gte: today },
        dateFrom: { lte: horizonEnd }
      },
      select: { listingId: true, dateFrom: true, dateTo: true }
    }),
    prisma.suggestion.findMany({
      where: {
        tenantId,
        lever: "price",
        // Only rows a human (or a push) acted on count toward the anti-ratchet
        // cap. `superseded` and `shadow` rows were never applied — before the
        // supersession change they were simply deleted, so counting them now
        // would wrongly ratchet-block every regenerated night.
        status: { notIn: [...SUPERSEDABLE_STATUSES, "superseded"] },
        listingId: { not: null },
        createdAt: { gte: addUtcDays(args.now, -CUMULATIVE_CAP_WINDOW_DAYS) },
        oldValue: { not: null },
        proposedValue: { not: null },
        dateTo: { gte: today },
        dateFrom: { lte: horizonEnd }
      },
      select: { listingId: true, dateFrom: true, dateTo: true, oldValue: true, proposedValue: true }
    })
  ]);

  const eachNight = (dateFrom: Date, dateTo: Date, visit: (dateStr: string) => void): void => {
    let cursor = dateFrom.getTime() > today.getTime() ? dateFrom : today;
    const end = dateTo.getTime() < horizonEnd.getTime() ? dateTo : horizonEnd;
    while (cursor.getTime() <= end.getTime()) {
      visit(toDateOnly(cursor));
      cursor = addUtcDays(cursor, 1);
    }
  };

  const actioned = new Set<string>();
  for (const row of actionedRows) {
    eachNight(row.dateFrom, row.dateTo, (dateStr) => actioned.add(`${row.listingId}|${dateStr}`));
  }

  const cumulativeDropPct = new Map<string, number>();
  for (const row of recentRows) {
    const oldValue = Number(row.oldValue);
    const proposedValue = Number(row.proposedValue);
    if (!(oldValue > 0) || !(proposedValue < oldValue)) continue; // only actual drops count
    const dropPct = (oldValue - proposedValue) / oldValue;
    eachNight(row.dateFrom, row.dateTo, (dateStr) => {
      const key = `${row.listingId}|${dateStr}`;
      cumulativeDropPct.set(key, (cumulativeDropPct.get(key) ?? 0) + dropPct);
    });
  }
  return { actioned, cumulativeDropPct };
}

/**
 * Generate `Suggestion` rows for a client — `pending` for graduated clients,
 * `shadow` from day 1 for clients still observing (calibration data only). The
 * client's prior machine-written rows (pending/shadow) are marked `superseded`
 * — not deleted — so the list stays fresh with pace while the history survives
 * for scoring. Approved/rejected/applied rows are untouched. Tenant-scoped;
 * writes only the `Suggestion` table.
 */
export async function generateSuggestionsForClient(args: {
  tenantId: string;
  clientKey: string;
  now?: Date;
  horizonDays?: number;
  maxSuggestions?: number;
  /**
   * `pending` (default) for graduated clients — the human-approval queue.
   * `shadow` for clients still inside the observation window: rows are written
   * from day 1 purely as calibration data for the ghost scorer, and are never
   * shown in the readout's pending list or the day-30 email.
   */
  status?: "pending" | "shadow";
}): Promise<GenerateSuggestionsResult> {
  const { tenantId, clientKey } = args;
  const now = args.now ?? new Date();
  const mode = args.status ?? "pending";
  const today = fromDateOnly(toDateOnly(now));
  const horizonEnd = addUtcDays(today, args.horizonDays ?? SUGGESTION_HORIZON_DAYS);

  const lead = await computeLeadTime(tenantId);
  if (!lead || lead.n < 20) {
    return { generated: 0, topRevenueAtRisk: null, blocked: {}, mode }; // not enough lead-time signal yet
  }

  const [available, occupied, listingRows] = await Promise.all([
    prisma.calendarRate.findMany({
      where: { tenantId, available: true, date: { gte: today, lte: horizonEnd } },
      select: { listingId: true, date: true, rate: true }
    }),
    prisma.nightFact.findMany({
      where: { tenantId, isOccupied: true, date: { gte: today, lte: horizonEnd } },
      select: { listingId: true, date: true }
    }),
    prisma.listing.findMany({
      where: { tenantId, removedAt: null },
      select: { id: true, unitCount: true }
    })
  ]);
  // Occupied UNITS per (listing, date) — multi-unit listings (unitCount >= 2)
  // sell N rooms of one type, so one occupied NightFact is one unit sold.
  const occupiedUnitsByNight = new Map<string, number>();
  for (const o of occupied) {
    const key = `${o.listingId}|${toDateOnly(o.date)}`;
    occupiedUnitsByNight.set(key, (occupiedUnitsByNight.get(key) ?? 0) + 1);
  }
  const unitCountByListing = new Map(listingRows.map((l) => [l.id, Math.max(1, l.unitCount ?? 1)]));

  const candidateListingIds = [...new Set(available.map((a) => a.listingId))];
  const [floors, localEvents, priorGuards, dowOccupancy] = await Promise.all([
    resolveListingFloors({ tenantId, listingIds: candidateListingIds, today }),
    resolveLocalEvents({ tenantId }),
    resolvePriorSuggestionGuards({ tenantId, today, horizonEnd, now }),
    computeDowOccupancy({ tenantId, today })
  ]);
  const eventsForListing = (listingId: string): PricingLocalEvent[] => {
    const propertyEvents = localEvents.byListingId.get(listingId);
    return propertyEvents ? [...localEvents.tenantWide, ...propertyEvents] : localEvents.tenantWide;
  };

  const nights: SuggestionNightInput[] = available.map((a) => {
    const dateStr = toDateOnly(a.date);
    const nightKey = `${a.listingId}|${dateStr}`;
    const unitCount = unitCountByListing.get(a.listingId) ?? 1;
    const occupiedUnits = Math.min(occupiedUnitsByNight.get(nightKey) ?? 0, unitCount);
    return {
      listingId: a.listingId,
      date: dateStr,
      daysToStay: Math.round((a.date.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
      // Multi-unit: only a fully-sold night counts as booked; a 40-unit building
      // with one unit sold still has 39 units at risk.
      booked: unitCount >= 2 ? occupiedUnits >= unitCount : occupiedUnits > 0,
      rate: Number(a.rate),
      floor: floors.get(a.listingId) ?? null,
      eventAdjustmentPct: eventAdjustmentForDate(eventsForListing(a.listingId), dateStr)?.adjustmentPct ?? null,
      hasActionedSuggestion: priorGuards.actioned.has(nightKey),
      cumulativeDropPct: priorGuards.cumulativeDropPct.get(nightKey) ?? 0,
      occupancyFactor: dowOccupancy?.[a.date.getUTCDay()] ?? 1,
      unsoldUnits: Math.max(1, unitCount - occupiedUnits)
    };
  });

  const { drafts, blocked } = buildSuggestionDrafts({
    nights,
    buckets: lead.buckets,
    maxSuggestions: args.maxSuggestions
  });

  // Supersede prior machine-written rows (never delete — history is the ghost
  // scorer's evidence), then insert the fresh generation.
  await applySuggestionRegeneration({ store: prisma.suggestion, tenantId, clientKey, status: mode, drafts });

  // Persist the blocked-by-reason counts (trust metric) on the client's
  // observation window so the readout can render its "blocked" line.
  const blockedTotal = Object.values(blocked).reduce((sum, n) => sum + (n ?? 0), 0);
  await prisma.observationWindow.updateMany({
    where: { tenantId, clientKey },
    data: {
      lastSuggestionRun: {
        generatedAt: now.toISOString(),
        generated: drafts.length,
        mode,
        blocked,
        blockedTotal
      }
    }
  });

  return { generated: drafts.length, topRevenueAtRisk: drafts[0]?.revenueAtRisk ?? null, blocked, mode };
}

/** Read a client's suggestions ordered by revenue at risk. Tenant-scoped, read-only. */
export async function readSuggestions(args: {
  tenantId: string;
  clientKey?: string;
  status?: string;
  limit?: number;
}): Promise<
  Array<{
    listingId: string | null;
    dateFrom: string;
    dateTo: string;
    lever: string;
    oldValue: number | null;
    proposedValue: number | null;
    type: string;
    reason: string;
    revenueAtRisk: number | null;
    confidence: number | null;
    status: string;
  }>
> {
  const rows = await prisma.suggestion.findMany({
    where: {
      tenantId: args.tenantId,
      ...(args.clientKey ? { clientKey: args.clientKey } : {}),
      ...(args.status ? { status: args.status } : {})
    },
    orderBy: { revenueAtRisk: "desc" },
    take: args.limit ?? 100,
    select: {
      listingId: true,
      dateFrom: true,
      dateTo: true,
      lever: true,
      oldValue: true,
      proposedValue: true,
      type: true,
      reason: true,
      revenueAtRisk: true,
      confidence: true,
      status: true
    }
  });
  return rows.map((r) => ({
    listingId: r.listingId,
    dateFrom: toDateOnly(r.dateFrom),
    dateTo: toDateOnly(r.dateTo),
    lever: r.lever,
    oldValue: r.oldValue === null ? null : Number(r.oldValue),
    proposedValue: r.proposedValue === null ? null : Number(r.proposedValue),
    type: r.type,
    reason: r.reason,
    revenueAtRisk: r.revenueAtRisk === null ? null : Number(r.revenueAtRisk),
    confidence: r.confidence === null ? null : Number(r.confidence),
    status: r.status
  }));
}
