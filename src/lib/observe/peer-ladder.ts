/**
 * The peer fallback ladder (SIGNALS-OBSERVE-LEARN-SPEC.md §5).
 *
 * Governing principle: learn what books, not what books because it is cheap. A
 * booking after a price drop is evidence only if comparable un-moved listings
 * failed to book the same dates. For each event we build the tightest control
 * achievable, stepping down only as far as needed, and record the rung +
 * confidence (confidence falls as we descend):
 *   rung 1 — primary peer set (same area/size, base+min within ~20%, un-moved)
 *   rung 2 — thin portfolio (1–2 nearest comparables; lower confidence)
 *   rung 3 — base-to-base elasticity (no comparable; normalise by own base)
 *
 * Reuses `selectPortfolioPeerSetListingIds` (size + group matching) from the
 * pricing engine for rungs 1–2. Pure functions here are unit-tested; the DB
 * wrapper persists a `PeerControl` row.
 */

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { selectPortfolioPeerSetListingIds } from "@/lib/pricing/peer-set";
import { prisma } from "@/lib/prisma";

/** Minimum rung-1 peers before we trust the primary control. */
export const RUNG1_MIN_PEERS = 3;
/** Price band: peer base AND min must be within this fraction of the subject. */
export const PEER_BAND_PCT = 0.2;
/** At most this many nearest comparables form a thin (rung-2) control. */
export const THIN_MAX_PEERS = 2;

/** Confidence assigned per rung (drops as the ladder descends). */
export const RUNG_CONFIDENCE: Record<1 | 2 | 3, number> = { 1: 0.8, 2: 0.5, 3: 0.3 };

export type LadderListing = {
  listingId: string;
  bedroomsNumber: number | null;
  tags: string[];
  base: number | null;
  min: number | null;
};

export type PeerControlResult = {
  rung: 1 | 2 | 3;
  controlListingIds: string[];
  confidence: number;
};

/** |candidate − subject| / subject ≤ pct. Null on either side never matches. Pure. */
export function withinBand(subject: number | null, candidate: number | null, pct: number): boolean {
  if (subject === null || candidate === null || !Number.isFinite(subject) || !Number.isFinite(candidate)) {
    return false;
  }
  if (subject === 0) return candidate === 0;
  return Math.abs(candidate - subject) / Math.abs(subject) <= pct;
}

/**
 * Build the tightest control for one subject listing on one event. Pure.
 * `movers` are listings that ALSO moved on the event dates — excluded from any
 * control because they are not a clean "did nothing" comparison.
 */
export function buildPeerControl(args: {
  subject: LadderListing;
  candidates: LadderListing[];
  movers: Set<string>;
  bandPct?: number;
}): PeerControlResult {
  const { subject, candidates, movers } = args;
  const bandPct = args.bandPct ?? PEER_BAND_PCT;

  const byId = new Map(candidates.map((c) => [c.listingId, c]));
  const sizeGroupPeers = selectPortfolioPeerSetListingIds({
    subject: { listingId: subject.listingId, bedroomsNumber: subject.bedroomsNumber, tags: subject.tags },
    candidates: candidates.map((c) => ({
      listingId: c.listingId,
      bedroomsNumber: c.bedroomsNumber,
      tags: c.tags
    }))
  });

  // Size+group peers within the price band that did NOT move — the clean control.
  const inBand = sizeGroupPeers.filter((id) => {
    if (movers.has(id)) return false;
    const cand = byId.get(id);
    if (!cand) return false;
    return withinBand(subject.base, cand.base, bandPct) && withinBand(subject.min, cand.min, bandPct);
  });

  // Rung 1: a robust in-band control set.
  if (inBand.length >= RUNG1_MIN_PEERS) {
    return { rung: 1, controlListingIds: inBand, confidence: RUNG_CONFIDENCE[1] };
  }

  // Rung 2: thin — only 1–2 in-band peers, taken nearest-by-base. Lower confidence.
  if (inBand.length >= 1) {
    const thin = inBand
      .map((id) => ({ id, base: byId.get(id)!.base as number }))
      .sort((a, b) => Math.abs(a.base - (subject.base ?? a.base)) - Math.abs(b.base - (subject.base ?? b.base)))
      .slice(0, THIN_MAX_PEERS)
      .map((p) => p.id);
    return { rung: 2, controlListingIds: thin, confidence: RUNG_CONFIDENCE[2] };
  }

  // Rung 3: no in-band comparable — base-to-base elasticity against the whole
  // portfolio. No named control set; the empty list signals "portfolio elasticity".
  return { rung: 3, controlListingIds: [], confidence: RUNG_CONFIDENCE[3] };
}

/**
 * Persist a `PeerControl` row for an event. Tenant-scoped. `movedPickup` /
 * `controlPickup` are the optional measured bookings-per-day on the event dates
 * for the moved listing vs the control set (learning #1).
 */
export async function recordPeerControl(args: {
  tenantId: string;
  listingId: string | null;
  engineChangeId?: string | null;
  rateChangeId?: string | null;
  eventDate?: Date | null;
  control: PeerControlResult;
  movedPickup?: number | null;
  controlPickup?: number | null;
  detail?: Record<string, unknown>;
}): Promise<string> {
  const row = await prisma.peerControl.create({
    data: {
      tenantId: args.tenantId,
      listingId: args.listingId,
      engineChangeId: args.engineChangeId ?? null,
      rateChangeId: args.rateChangeId ?? null,
      eventDate: args.eventDate ?? null,
      rung: args.control.rung,
      controlListingIds: args.control.controlListingIds,
      confidence: args.control.confidence,
      movedPickup: args.movedPickup ?? null,
      controlPickup: args.controlPickup ?? null,
      detail: args.detail ? (args.detail as object) : undefined
    },
    select: { id: true }
  });
  return row.id;
}

/** How many days back to look for price-drop events needing a control. */
export const CONTROL_LOOKBACK_DAYS = 14;
/** Cap on events processed per run so the daily job stays bounded. */
export const CONTROL_MAX_EVENTS = 50;

/**
 * Attach a `PeerControl` to each recent price-drop event that lacks one. Builds
 * the ladder against the portfolio's current size/base/min and the set of
 * listings that ALSO moved in the window (excluded from any control). Idempotent
 * per `rateChangeId`. Tenant-scoped + read-only outside `PeerControl`.
 */
export async function attachControlsForRecentChanges(args: {
  tenantId: string;
  lookbackDays?: number;
  maxEvents?: number;
  now?: Date;
}): Promise<{ processed: number; byRung: Record<1 | 2 | 3, number> }> {
  const { tenantId } = args;
  const now = args.now ?? new Date();
  const since = addUtcDays(fromDateOnly(toDateOnly(now)), -(args.lookbackDays ?? CONTROL_LOOKBACK_DAYS));

  // Recent price-drop events (a drop is where the moved-vs-control question bites).
  const drops = await prisma.rateChange.findMany({
    where: { tenantId, lever: "price", changePct: { lt: 0 }, detectedAt: { gte: since } },
    orderBy: { detectedAt: "desc" },
    take: args.maxEvents ?? CONTROL_MAX_EVENTS,
    select: { id: true, listingId: true, date: true }
  });
  if (drops.length === 0) return { processed: 0, byRung: { 1: 0, 2: 0, 3: 0 } };

  // Skip events that already have a control (idempotent re-runs).
  const existing = await prisma.peerControl.findMany({
    where: { tenantId, rateChangeId: { in: drops.map((d) => d.id) } },
    select: { rateChangeId: true }
  });
  const done = new Set(existing.map((e) => e.rateChangeId));
  const todo = drops.filter((d) => !done.has(d.id));
  if (todo.length === 0) return { processed: 0, byRung: { 1: 0, 2: 0, 3: 0 } };

  // Portfolio snapshot: size/tags from Listing, base/min from latest EngineSnapshot.
  const listings = await prisma.listing.findMany({
    where: { tenantId, removedAt: null },
    select: { id: true, bedroomsNumber: true, tags: true }
  });
  const snaps = await prisma.engineSnapshot.findMany({
    where: { tenantId, listingId: { not: null } },
    orderBy: { capturedAt: "desc" },
    select: { listingId: true, base: true, min: true },
    take: 5000
  });
  const baseMinByListing = new Map<string, { base: number | null; min: number | null }>();
  for (const s of snaps) {
    if (s.listingId && !baseMinByListing.has(s.listingId)) {
      baseMinByListing.set(s.listingId, {
        base: s.base === null ? null : Number(s.base),
        min: s.min === null ? null : Number(s.min)
      });
    }
  }
  const ladderListings: LadderListing[] = listings.map((l) => ({
    listingId: l.id,
    bedroomsNumber: l.bedroomsNumber,
    tags: l.tags,
    base: baseMinByListing.get(l.id)?.base ?? null,
    min: baseMinByListing.get(l.id)?.min ?? null
  }));

  // Movers: any listing with a price change in the window — not a clean control.
  const moverRows = await prisma.rateChange.findMany({
    where: { tenantId, lever: "price", detectedAt: { gte: since } },
    select: { listingId: true }
  });
  const movers = new Set(moverRows.map((m) => m.listingId));

  const byRung: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  let processed = 0;
  for (const drop of todo) {
    const subject = ladderListings.find((l) => l.listingId === drop.listingId);
    if (!subject) continue;
    const control = buildPeerControl({ subject, candidates: ladderListings, movers });
    await recordPeerControl({
      tenantId,
      listingId: drop.listingId,
      rateChangeId: drop.id,
      eventDate: drop.date,
      control
    });
    byRung[control.rung] += 1;
    processed += 1;
  }
  return { processed, byRung };
}
