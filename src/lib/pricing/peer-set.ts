import type { PrismaClient } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { customGroupKey, customGroupNamesFromTags } from "@/lib/pricing/settings";

/**
 * Subject listing description used to find structurally-similar peers in
 * the same portfolio.
 */
export type PeerSetSubjectListing = {
  listingId: string;
  bedroomsNumber: number | null;
  tags: string[];
};

export type PeerSetCandidateListing = {
  listingId: string;
  bedroomsNumber: number | null;
  tags: string[];
};

/**
 * Returns the listing ids that count as "peer set" matches for the subject
 * listing. Pure function exposed for tests.
 *
 * Rules (per owner spec):
 *   - Peer must share the subject's `bedroomsNumber`. A null bedroom count
 *     never matches anything.
 *   - If EITHER the subject OR the candidate has a custom group tag
 *     (`group:<name>`), they must share the same group key.
 *   - If neither has a group tag, the subject's whole portfolio is fair
 *     game (subject to the bedroom-count match).
 *   - The subject is never its own peer.
 */
export function selectPortfolioPeerSetListingIds(params: {
  subject: PeerSetSubjectListing;
  candidates: PeerSetCandidateListing[];
}): string[] {
  const subjectBedrooms = params.subject.bedroomsNumber;
  if (subjectBedrooms === null || !Number.isFinite(subjectBedrooms)) return [];

  const subjectGroupNames = customGroupNamesFromTags(params.subject.tags);
  const subjectGroupKey = subjectGroupNames.length > 0 ? customGroupKey(subjectGroupNames[0]!) : null;

  return params.candidates
    .filter((candidate) => candidate.listingId !== params.subject.listingId)
    .filter((candidate) => candidate.bedroomsNumber === subjectBedrooms)
    .filter((candidate) => {
      const candidateGroupNames = customGroupNamesFromTags(candidate.tags);
      const candidateGroupKey =
        candidateGroupNames.length > 0 ? customGroupKey(candidateGroupNames[0]!) : null;
      if (subjectGroupKey === null && candidateGroupKey === null) return true;
      // If either side has a group, both must share it.
      return subjectGroupKey !== null && candidateGroupKey === subjectGroupKey;
    })
    .map((candidate) => candidate.listingId);
}

/**
 * Pure aggregator. Computes the trailing-window peer-set ADR from a list of
 * already-loaded night_facts rows. Filters out long stays (> 14 nights) and
 * cancelled rows; returns `null` if fewer than 14 qualifying nights remain.
 */
export function computePortfolioPeerSetAdrFromNightFacts(params: {
  nights: Array<{
    revenueAllocated: number;
    losNights: number | null;
    status: string | null;
  }>;
  minQualifyingNights?: number;
}): number | null {
  const minNights = params.minQualifyingNights ?? 14;
  let totalRevenue = 0;
  let totalNights = 0;

  for (const night of params.nights) {
    if (!Number.isFinite(night.revenueAllocated) || night.revenueAllocated <= 0) continue;
    if (night.losNights !== null && night.losNights > 14) continue;
    const status = (night.status ?? "").trim().toLowerCase();
    if (status === "cancelled" || status === "canceled" || status === "no_show" || status === "no-show") continue;
    totalRevenue += night.revenueAllocated;
    totalNights += 1;
  }

  if (totalNights < minNights) return null;
  return Math.round((totalRevenue / totalNights) * 100) / 100;
}

/**
 * Loads peer-set ADR from the live DB. Multi-tenant safe: every query
 * filters by `tenantId`.
 *
 * - Selects peer listing ids using `selectPortfolioPeerSetListingIds`.
 * - Pulls trailing-`windowDays` night_facts for those listings.
 * - Returns null when peer set is empty or fewer than 14 qualifying
 *   nights are available — caller falls back to the reweighted blend.
 */
export async function computePortfolioPeerSetAdr(params: {
  tenantId: string;
  subjectListing: PeerSetSubjectListing;
  allListings: PeerSetCandidateListing[];
  prisma: PrismaClient;
  windowDays: number;
  todayDateOnly?: string;
  minQualifyingNights?: number;
}): Promise<number | null> {
  const peerIds = selectPortfolioPeerSetListingIds({
    subject: params.subjectListing,
    candidates: params.allListings
  });
  if (peerIds.length === 0) return null;

  const today = params.todayDateOnly ?? toDateOnly(new Date());
  const windowEnd = fromDateOnly(today);
  const windowStart = addUtcDays(windowEnd, -Math.max(1, Math.round(params.windowDays)));

  const rows = await params.prisma.nightFact.findMany({
    where: {
      tenantId: params.tenantId,
      listingId: { in: peerIds },
      date: { gte: windowStart, lt: windowEnd },
      isOccupied: true
    },
    select: {
      revenueAllocated: true,
      losNights: true,
      status: true
    }
  });

  return computePortfolioPeerSetAdrFromNightFacts({
    nights: rows.map((row) => ({
      revenueAllocated: typeof row.revenueAllocated === "number" ? row.revenueAllocated : Number(row.revenueAllocated),
      losNights: row.losNights ?? null,
      status: row.status ?? null
    })),
    minQualifyingNights: params.minQualifyingNights
  });
}
