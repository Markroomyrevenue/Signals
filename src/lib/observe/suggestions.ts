/**
 * Gated suggestions (SIGNALS-OBSERVE-LEARN-SPEC.md §9).
 *
 * Once a client graduates, write `Suggestion` rows ordered by REVENUE AT RISK,
 * each judged against the EXPECTED BOOKING CURVE FOR THAT LEAD TIME (not against
 * final occupancy). Nothing is applied — every row is `pending` and waits for
 * human approval. The pure judging core is unit-tested; the DB generator is
 * tenant-scoped and read-only outside the `Suggestion` table.
 */

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { parsePricingSettingsOverride } from "@/lib/pricing/settings";
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

/**
 * Why a would-be suggestion was suppressed. Deliberately surfaced (counted +
 * persisted + rendered in the readout) as a trust metric: the reviewer can see
 * how many drops the safety gates held back, and why.
 */
export type SuggestionBlockedReason = "min_floor";

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
}): NightJudgement {
  const threshold = args.riskThreshold ?? RISK_FILL_THRESHOLD;
  if (args.booked || args.rate <= 0 || args.daysToStay < 0) {
    return { atRisk: false, revenueAtRisk: 0, proposedValue: null, dropPct: 0, confidence: 0, reason: "not at risk" };
  }
  if (args.expectedFill < threshold) {
    return {
      atRisk: false,
      revenueAtRisk: 0,
      proposedValue: null,
      dropPct: 0,
      confidence: 0,
      reason: `early on curve (expected fill ${(args.expectedFill * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%)`
    };
  }
  // Behind pace: scale the drop with how far past the curve we are.
  const dropPct = Math.min(0.25, Math.max(0.05, (args.expectedFill - threshold) * 0.5 + 0.05));
  const confidence = Math.min(0.9, args.expectedFill);
  const reason = `empty at ${args.daysToStay}d out; curve expects ~${(args.expectedFill * 100).toFixed(0)}% booked by now`;

  const floorKnown = args.floor !== null && args.floor !== undefined && args.floor > 0;
  const unclamped = Math.round(args.rate * (1 - dropPct));
  // Never propose below the listing's minimum price (ceil so a fractional floor
  // is never undercut by rounding).
  const proposedValue = floorKnown ? Math.max(unclamped, Math.ceil(args.floor as number)) : unclamped;
  if (proposedValue >= args.rate) {
    return {
      atRisk: true,
      revenueAtRisk: args.rate,
      proposedValue: null,
      dropPct: 0,
      confidence,
      reason: `${reason}; drop clamped to min price ${proposedValue} ≥ current rate — no room to drop`,
      blockedReason: "min_floor"
    };
  }
  return {
    atRisk: true,
    revenueAtRisk: args.rate,
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
      floor: night.floor
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
};

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
 * Generate `Suggestion` rows for a graduated client. Replaces the client's prior
 * PENDING suggestions (approved/rejected/applied rows are preserved) so the list
 * stays fresh with pace. Tenant-scoped; writes only the `Suggestion` table.
 */
export async function generateSuggestionsForClient(args: {
  tenantId: string;
  clientKey: string;
  now?: Date;
  horizonDays?: number;
  maxSuggestions?: number;
}): Promise<GenerateSuggestionsResult> {
  const { tenantId, clientKey } = args;
  const now = args.now ?? new Date();
  const today = fromDateOnly(toDateOnly(now));
  const horizonEnd = addUtcDays(today, args.horizonDays ?? SUGGESTION_HORIZON_DAYS);

  const lead = await computeLeadTime(tenantId);
  if (!lead || lead.n < 20) {
    return { generated: 0, topRevenueAtRisk: null, blocked: {} }; // not enough lead-time signal yet
  }

  const [available, occupied] = await Promise.all([
    prisma.calendarRate.findMany({
      where: { tenantId, available: true, date: { gte: today, lte: horizonEnd } },
      select: { listingId: true, date: true, rate: true }
    }),
    prisma.nightFact.findMany({
      where: { tenantId, isOccupied: true, date: { gte: today, lte: horizonEnd } },
      select: { listingId: true, date: true }
    })
  ]);
  const occupiedKey = new Set(occupied.map((o) => `${o.listingId}|${toDateOnly(o.date)}`));

  const candidateListingIds = [...new Set(available.map((a) => a.listingId))];
  const floors = await resolveListingFloors({ tenantId, listingIds: candidateListingIds, today });

  const nights: SuggestionNightInput[] = available.map((a) => {
    const dateStr = toDateOnly(a.date);
    return {
      listingId: a.listingId,
      date: dateStr,
      daysToStay: Math.round((a.date.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
      booked: occupiedKey.has(`${a.listingId}|${dateStr}`),
      rate: Number(a.rate),
      floor: floors.get(a.listingId) ?? null
    };
  });

  const { drafts, blocked } = buildSuggestionDrafts({
    nights,
    buckets: lead.buckets,
    maxSuggestions: args.maxSuggestions
  });

  // Replace prior pending rows; preserve human-actioned ones.
  await prisma.suggestion.deleteMany({ where: { tenantId, clientKey, status: "pending" } });
  if (drafts.length > 0) {
    await prisma.suggestion.createMany({
      data: drafts.map((d) => ({
        tenantId,
        clientKey,
        listingId: d.listingId,
        dateFrom: fromDateOnly(d.date),
        dateTo: fromDateOnly(d.date),
        lever: "price",
        oldValue: d.oldValue,
        proposedValue: d.proposedValue,
        type: "timed-pct",
        reason: d.reason,
        revenueAtRisk: d.revenueAtRisk,
        confidence: d.confidence,
        status: "pending",
        ...(d.detail ? { detail: d.detail } : {})
      }))
    });
  }

  return { generated: drafts.length, topRevenueAtRisk: drafts[0]?.revenueAtRisk ?? null, blocked };
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
