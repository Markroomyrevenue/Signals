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
import { prisma } from "@/lib/prisma";

import { computeLeadTime } from "./learnings";
import { LEAD_TIME_BUCKETS, type LeadTimeDistribution } from "./learnings-core";

/** Default horizon for forward suggestions (signal horizon is ~6 months). */
export const SUGGESTION_HORIZON_DAYS = 120;
/** Below this expected-fill, an empty night is normal — not yet at risk. */
export const RISK_FILL_THRESHOLD = 0.5;
/** Cap rows per client so the readout stays focused on what matters most. */
export const MAX_SUGGESTIONS = 50;

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
};

/**
 * Judge one forward night against the booking curve. Pure. An empty night whose
 * expected fill is already high (it should normally be booked by now) is behind
 * pace → revenue at risk → a timed-pct drop. A night still early on its curve is
 * fine. Booked nights are never at risk.
 */
export function judgeNightForSuggestion(args: {
  daysToStay: number;
  booked: boolean;
  rate: number;
  expectedFill: number;
  riskThreshold?: number;
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
  const proposedValue = Math.round(args.rate * (1 - dropPct));
  return {
    atRisk: true,
    revenueAtRisk: args.rate,
    proposedValue,
    dropPct,
    confidence: Math.min(0.9, args.expectedFill),
    reason: `empty at ${args.daysToStay}d out; curve expects ~${(args.expectedFill * 100).toFixed(0)}% booked by now`
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
};

/** Pure: turn forward nights + the curve into ordered, capped suggestion drafts. */
export function buildSuggestionDrafts(args: {
  nights: Array<{ listingId: string; date: string; daysToStay: number; booked: boolean; rate: number }>;
  buckets: LeadTimeDistribution["buckets"];
  maxSuggestions?: number;
}): SuggestionDraft[] {
  const drafts: SuggestionDraft[] = [];
  for (const night of args.nights) {
    const judged = judgeNightForSuggestion({
      daysToStay: night.daysToStay,
      booked: night.booked,
      rate: night.rate,
      expectedFill: expectedCumulativeFill(night.daysToStay, args.buckets)
    });
    if (judged.atRisk && judged.proposedValue !== null) {
      drafts.push({
        listingId: night.listingId,
        date: night.date,
        oldValue: night.rate,
        proposedValue: judged.proposedValue,
        revenueAtRisk: judged.revenueAtRisk,
        confidence: judged.confidence,
        reason: judged.reason
      });
    }
  }
  drafts.sort((a, b) => b.revenueAtRisk - a.revenueAtRisk);
  return drafts.slice(0, args.maxSuggestions ?? MAX_SUGGESTIONS);
}

export type GenerateSuggestionsResult = {
  generated: number;
  topRevenueAtRisk: number | null;
};

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
    return { generated: 0, topRevenueAtRisk: null }; // not enough lead-time signal yet
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

  const nights = available.map((a) => {
    const dateStr = toDateOnly(a.date);
    return {
      listingId: a.listingId,
      date: dateStr,
      daysToStay: Math.round((a.date.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
      booked: occupiedKey.has(`${a.listingId}|${dateStr}`),
      rate: Number(a.rate)
    };
  });

  const drafts = buildSuggestionDrafts({ nights, buckets: lead.buckets, maxSuggestions: args.maxSuggestions });

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
        status: "pending"
      }))
    });
  }

  return { generated: drafts.length, topRevenueAtRisk: drafts[0]?.revenueAtRisk ?? null };
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
