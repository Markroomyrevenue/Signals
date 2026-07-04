/**
 * Cohort grain engine (build prompt 07 Part A; granularity audit
 * `reviews/observe-learn-2026-07/07-learning-granularity.md`).
 *
 * The shipped observe system learned almost everything at whole-client
 * (tenant) grain. Prod data shows that miscalibrates the daily-drop trigger
 * in both directions at once: on one tenant, `group:Argo` books at a median
 * lead of 54 days while `group:St James Apartments` books at 3 days — one
 * pooled curve fires false drops on the late-booking building and sits
 * silent on the early-booking one. This module fixes the grain:
 *
 * 1. `resolveCohortMemberships` — a listing's cohort memberships along
 *    independent dimensions (crossover expected: a listing is in its group
 *    AND its size band AND its city AND its tenant at once).
 * 2. `buildCohortCurveSet` / `resolveCohortCurve` — booking-lead curves
 *    resolved most-specific-first through a sample-gated ladder:
 *    listing → group → tenant × size band → tenant. Gates are named
 *    constants calibrated against prod counts (SELECTs run 2026-07-04,
 *    quoted at each constant).
 * 3. `buildCohortOccupancySet` / `resolveCohortOccupancy` — the DOW
 *    occupancy scaler resolved through the same ladder, so a ~200-unit
 *    student block no longer drowns 50 flats in a unit-weighted tenant
 *    average.
 *
 * Every resolved value carries `{rung, cohortKey, n}` provenance so the
 * consumer (the suggestion trigger) can record what each judgement was made
 * against.
 *
 * PURE: no DB access. The DB wrapper lives in `suggestions.ts`, which loads
 * tenant-scoped rows and calls these. The ladder pattern follows the trial's
 * booking-curve precedent (`src/lib/agents/pricing-comparison/booking-curve.ts`
 * CURVE_MIN_GROUP_SIZE / gate-then-fall-back; Mark's 2026-05-26 Castle
 * Buildings grain decision) — reused, not re-invented.
 *
 * `market` / `global` rungs are reserved in the type but never produced
 * here: cross-tenant learning is only allowed through the anonymised
 * GlobalMethodology path (CLAUDE.md tenant isolation), which is Part B's
 * market-stratified work. Within per-client generation the tenant rung is
 * terminal.
 */

import { addUtcDays, fromDateOnly } from "@/lib/metrics/helpers";

import { leadTimeDistribution, type LeadTimeDistribution } from "./learnings-core";

// ---- Sample gates (named constants, prod-calibrated 2026-07-04) -------------

/**
 * A listing gets its OWN lead-time curve only with at least this many
 * distinct bookings in the trailing 365 days.
 *
 * Prod (distinct reservations per listing, occupied night_facts with a lead,
 * trailing 365d, 2026-07-04): listings clearing 100 — Coorie Doon 0/45
 * (median 45), Escape Ordinary 0/52 (median 59), Little Feather 13/47
 * (median 50), Stay Belfast 10/15 (median 122), Yo's House 2/33 (median 62).
 * At 100 the listing rung is reserved for the deep-history minority
 * (25 listings estate-wide), matching the audit's stability rule of thumb:
 * ~100 bookings gives 8-bucket shares to roughly ±3-5pp; below that the
 * ladder falls back rather than fit noise.
 */
export const LISTING_CURVE_MIN_BOOKINGS = 100;

/**
 * A `group:` tag needs at least this many member listings to get its own
 * curve (mirrors the trial's `CURVE_MIN_GROUP_SIZE`). Prod groups
 * (2026-07-04): group:Student Accomodation 3, group:Argo 5,
 * group:Fitzrovia 7, group:St James Apartments 8 — all clear.
 */
export const GROUP_CURVE_MIN_LISTINGS = 3;

/**
 * A `group:` tag's pooled distinct bookings must also clear this gate.
 *
 * Prod (pooled distinct reservations per group, trailing 365d, 2026-07-04):
 * group:Fitzrovia 907, group:Student Accomodation 522, group:Argo 338,
 * group:St James Apartments 93. The gate is 60 so all four live groups keep
 * their own curve — crucially including St James (93), the audit's smoking
 * gun (median lead 3d vs Argo's 54d on the SAME tenant) — while staying
 * above the ~50-booking "usable coarse curve" noise floor the audit set.
 */
export const GROUP_CURVE_MIN_BOOKINGS = 60;

/**
 * A tenant × size-band curve (single-unit stock only) needs this many pooled
 * distinct bookings. Prod (trailing 365d, 2026-07-04): thinnest live bands
 * are Little Feather 3+ = 165, Coorie Doon 3+ = 274, Stay Belfast 3+ = 280;
 * every other band 301-1,756. 100 clears all current bands; a future thin
 * band falls to the tenant curve instead of fitting noise.
 */
export const SIZE_BAND_CURVE_MIN_BOOKINGS = 100;

/**
 * A cohort's DOW occupancy is used only when EVERY day-of-week cell has at
 * least this many unit-night slots (one slot = one sellable unit on one
 * date inside the cohort's active window). 20 slots per cell ≈ 140 active
 * days for a single-unit listing (each DOW recurs ~weekly); the estimate's
 * SE is ~11pp — coarse but unbiased, and strictly better than borrowing a
 * 200-unit block's occupancy. Prod (2026-07-04): 160 of 194 listings with
 * any night_facts have ≥140 active days in the window (Coorie Doon 36/45,
 * Escape Ordinary 47/53, Little Feather 40/48, Stay Belfast 15/15, Yo's
 * House 22/33), so most listings resolve at their own rung and recent
 * additions fall back to group / size band / tenant.
 */
export const OCCUPANCY_MIN_SLOTS_PER_DOW = 20;

// ---- Memberships (dimension resolver, crossover expected) --------------------

export type CohortRung = "listing" | "group" | "size_band" | "tenant" | "market" | "global";

/** Provenance recorded on whatever consumed the resolved cohort value. */
export type CohortProvenance = {
  rung: CohortRung;
  cohortKey: string;
  /**
   * Sample size behind the value. Curves: distinct bookings (the gate
   * metric). Occupancy: occupied unit-nights observed in the window.
   */
  n: number;
};

/** The listing fields the resolver needs (matches `Listing` columns). */
export type CohortListing = {
  id: string;
  tags: string[];
  bedroomsNumber: number | null;
  city: string | null;
  unitCount: number | null;
};

export type SizeBand = "0-1" | "2" | "3+";

/** Size band per the prompt: 0-1 bed / 2 bed / 3+ bed. Null beds = studio-ish = 0-1. */
export function sizeBandFor(bedroomsNumber: number | null | undefined): SizeBand {
  const beds = bedroomsNumber ?? 0;
  if (beds <= 1) return "0-1";
  if (beds === 2) return "2";
  return "3+";
}

/** Multi-unit convention: `unitCount >= 2` means N rooms of one type. */
export function isMultiUnit(unitCount: number | null | undefined): boolean {
  return (unitCount ?? 1) >= 2;
}

/** The listing's `group:` tags (existing tag convention), deduped + sorted. */
export function groupTagsFor(tags: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    const tag = raw.trim();
    if (tag.toLowerCase().startsWith("group:") && tag.length > "group:".length) seen.add(tag);
  }
  return [...seen].sort();
}

/**
 * Normalised city key so e.g. "Belfast" / " belfast " land in one market
 * cohort (the two Belfast tenants share a market). Null when city is unset.
 */
export function normaliseCityKey(city: string | null | undefined): string | null {
  const norm = (city ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return norm.length > 0 ? norm : null;
}

export type CohortDimension = "listing" | "group" | "size_band" | "city" | "stock" | "tenant";

export type CohortMembership = { dimension: CohortDimension; cohortKey: string };

/**
 * All of a listing's cohort memberships along independent dimensions.
 * Crossover is expected and fine — a listing is simultaneously itself, in
 * 0..n groups, in one size band, in one city market, one stock type, and
 * its tenant. Downstream learners choose which dimensions they pool on;
 * the `city` and `stock` dimensions are provided for Part B's richer
 * learning cuts as well as the ladder here.
 */
export function resolveCohortMemberships(listing: CohortListing): CohortMembership[] {
  const memberships: CohortMembership[] = [{ dimension: "listing", cohortKey: `listing:${listing.id}` }];
  for (const tag of groupTagsFor(listing.tags)) memberships.push({ dimension: "group", cohortKey: tag });
  memberships.push({ dimension: "size_band", cohortKey: `size:${sizeBandFor(listing.bedroomsNumber)}` });
  const city = normaliseCityKey(listing.city);
  if (city) memberships.push({ dimension: "city", cohortKey: `city:${city}` });
  memberships.push({
    dimension: "stock",
    cohortKey: isMultiUnit(listing.unitCount) ? "stock:multi-unit" : "stock:single-unit"
  });
  memberships.push({ dimension: "tenant", cohortKey: "tenant" });
  return memberships;
}

// ---- Lead-time curve ladder ---------------------------------------------------

/** One occupied night with a booking lead, as loaded from `NightFact`. */
export type CurveLeadFact = {
  listingId: string;
  leadTimeDays: number;
  /** Distinct reservations are the bookings gate; null ids count 0 bookings. */
  reservationId: string | null;
};

export type CohortCurve = {
  cohortKey: string;
  distribution: LeadTimeDistribution;
  /** Distinct bookings behind the curve — the ladder's gate metric. */
  bookings: number;
  /** Member listings in the cohort (by membership, not by having facts). */
  listingCount: number;
};

export type CohortCurveSet = {
  /** All facts pooled — the terminal rung (exactly the old tenant curve). */
  tenant: CohortCurve | null;
  byListing: Map<string, CohortCurve>;
  /** Keyed by the `group:` tag. */
  byGroup: Map<string, CohortCurve>;
  /** Keyed `size:<band>`; single-unit stock only (blocks are not flat peers). */
  bySizeBand: Map<string, CohortCurve>;
  groupsByListing: Map<string, string[]>;
  /** Null for multi-unit listings — they skip the size-band rung. */
  sizeBandKeyByListing: Map<string, string | null>;
};

type CurveAccumulator = { leads: number[]; reservationIds: Set<string> };

function newAccumulator(): CurveAccumulator {
  return { leads: [], reservationIds: new Set() };
}

function accumulate(acc: CurveAccumulator, fact: CurveLeadFact): void {
  acc.leads.push(fact.leadTimeDays);
  if (fact.reservationId) acc.reservationIds.add(fact.reservationId);
}

function toCurve(cohortKey: string, acc: CurveAccumulator, listingCount: number): CohortCurve {
  return {
    cohortKey,
    distribution: leadTimeDistribution(acc.leads),
    bookings: acc.reservationIds.size,
    listingCount
  };
}

/**
 * Build every rung's curve for one tenant. Facts from listings absent from
 * `listings` (e.g. removed listings' history) still count toward the tenant
 * rung — matching the old `computeLeadTime` exactly — but join no
 * listing/group/size cohort. Pure.
 */
export function buildCohortCurveSet(args: {
  listings: CohortListing[];
  facts: CurveLeadFact[];
}): CohortCurveSet {
  const groupsByListing = new Map<string, string[]>();
  const sizeBandKeyByListing = new Map<string, string | null>();
  const groupMemberCounts = new Map<string, number>();
  const sizeBandMemberCounts = new Map<string, number>();
  for (const listing of args.listings) {
    const groups = groupTagsFor(listing.tags);
    groupsByListing.set(listing.id, groups);
    for (const tag of groups) groupMemberCounts.set(tag, (groupMemberCounts.get(tag) ?? 0) + 1);
    if (isMultiUnit(listing.unitCount)) {
      sizeBandKeyByListing.set(listing.id, null);
    } else {
      const key = `size:${sizeBandFor(listing.bedroomsNumber)}`;
      sizeBandKeyByListing.set(listing.id, key);
      sizeBandMemberCounts.set(key, (sizeBandMemberCounts.get(key) ?? 0) + 1);
    }
  }

  const tenantAcc = newAccumulator();
  const listingAccs = new Map<string, CurveAccumulator>();
  const groupAccs = new Map<string, CurveAccumulator>();
  const sizeBandAccs = new Map<string, CurveAccumulator>();
  for (const fact of args.facts) {
    if (!Number.isFinite(fact.leadTimeDays) || fact.leadTimeDays < 0) continue;
    accumulate(tenantAcc, fact);
    if (!groupsByListing.has(fact.listingId)) continue; // unknown listing: tenant rung only
    let listingAcc = listingAccs.get(fact.listingId);
    if (!listingAcc) listingAccs.set(fact.listingId, (listingAcc = newAccumulator()));
    accumulate(listingAcc, fact);
    for (const tag of groupsByListing.get(fact.listingId) ?? []) {
      let acc = groupAccs.get(tag);
      if (!acc) groupAccs.set(tag, (acc = newAccumulator()));
      accumulate(acc, fact);
    }
    const bandKey = sizeBandKeyByListing.get(fact.listingId);
    if (bandKey) {
      let acc = sizeBandAccs.get(bandKey);
      if (!acc) sizeBandAccs.set(bandKey, (acc = newAccumulator()));
      accumulate(acc, fact);
    }
  }

  const byListing = new Map<string, CohortCurve>();
  for (const [id, acc] of listingAccs) byListing.set(id, toCurve(`listing:${id}`, acc, 1));
  const byGroup = new Map<string, CohortCurve>();
  for (const [tag, acc] of groupAccs) byGroup.set(tag, toCurve(tag, acc, groupMemberCounts.get(tag) ?? 0));
  const bySizeBand = new Map<string, CohortCurve>();
  for (const [key, acc] of sizeBandAccs) bySizeBand.set(key, toCurve(key, acc, sizeBandMemberCounts.get(key) ?? 0));

  return {
    tenant: tenantAcc.leads.length > 0 ? toCurve("tenant", tenantAcc, args.listings.length) : null,
    byListing,
    byGroup,
    bySizeBand,
    groupsByListing,
    sizeBandKeyByListing
  };
}

export type ResolvedCohortCurve = {
  buckets: LeadTimeDistribution["buckets"];
  medianLeadDays: number | null;
  provenance: CohortProvenance;
};

function resolvedFrom(curve: CohortCurve, rung: CohortRung): ResolvedCohortCurve {
  return {
    buckets: curve.distribution.buckets,
    medianLeadDays: curve.distribution.medianLeadDays,
    provenance: { rung, cohortKey: curve.cohortKey, n: curve.bookings }
  };
}

/**
 * Most-specific-first ladder: listing (≥ LISTING_CURVE_MIN_BOOKINGS) →
 * group (≥ GROUP_CURVE_MIN_LISTINGS members AND ≥ GROUP_CURVE_MIN_BOOKINGS
 * pooled; smallest member pool wins, the trial's most-specific heuristic) →
 * tenant × size band (single-unit stock, ≥ SIZE_BAND_CURVE_MIN_BOOKINGS;
 * multi-unit listings skip this rung — a 200-unit block is not a studio
 * flat's peer) → tenant. Null only when the tenant has no curve at all.
 */
export function resolveCohortCurve(set: CohortCurveSet, listingId: string): ResolvedCohortCurve | null {
  const own = set.byListing.get(listingId);
  if (own && own.bookings >= LISTING_CURVE_MIN_BOOKINGS) return resolvedFrom(own, "listing");

  const groupCandidates = (set.groupsByListing.get(listingId) ?? [])
    .map((tag) => set.byGroup.get(tag))
    .filter(
      (g): g is CohortCurve =>
        !!g && g.listingCount >= GROUP_CURVE_MIN_LISTINGS && g.bookings >= GROUP_CURVE_MIN_BOOKINGS
    )
    .sort((a, b) => a.listingCount - b.listingCount || a.cohortKey.localeCompare(b.cohortKey));
  if (groupCandidates.length > 0) return resolvedFrom(groupCandidates[0], "group");

  const bandKey = set.sizeBandKeyByListing.get(listingId);
  if (bandKey) {
    const band = set.bySizeBand.get(bandKey);
    if (band && band.bookings >= SIZE_BAND_CURVE_MIN_BOOKINGS) return resolvedFrom(band, "size_band");
  }

  return set.tenant ? resolvedFrom(set.tenant, "tenant") : null;
}

// ---- Curve-set summaries (readout / weekly-report surfacing) -------------------

/** One cohort's curve summary for surfacing: rung eligibility + n + median. */
export type CohortCurveSummary = {
  cohortKey: string;
  /** Member listings in the cohort (by membership, not by having facts). */
  listingCount: number;
  /** Distinct bookings behind the curve — the ladder's gate metric (the n). */
  bookings: number;
  medianLeadDays: number | null;
  /** True when the cohort clears its ladder gate and is judged by its OWN curve. */
  ownCurve: boolean;
};

/**
 * Summarise a curve set for surfacing (build prompt 07 Part C): every group
 * and size-band cohort with its median lead, gate metric and whether it clears
 * its ladder gate. Sorted by cohortKey for stable rendering. Pure.
 */
export function summariseCohortCurveSet(set: CohortCurveSet): {
  tenant: { medianLeadDays: number | null; bookings: number } | null;
  groups: CohortCurveSummary[];
  sizeBands: CohortCurveSummary[];
} {
  const groups = [...set.byGroup.values()]
    .map((g) => ({
      cohortKey: g.cohortKey,
      listingCount: g.listingCount,
      bookings: g.bookings,
      medianLeadDays: g.distribution.medianLeadDays,
      ownCurve: g.listingCount >= GROUP_CURVE_MIN_LISTINGS && g.bookings >= GROUP_CURVE_MIN_BOOKINGS
    }))
    .sort((a, b) => a.cohortKey.localeCompare(b.cohortKey));
  const sizeBands = [...set.bySizeBand.values()]
    .map((b) => ({
      cohortKey: b.cohortKey,
      listingCount: b.listingCount,
      bookings: b.bookings,
      medianLeadDays: b.distribution.medianLeadDays,
      ownCurve: b.bookings >= SIZE_BAND_CURVE_MIN_BOOKINGS
    }))
    .sort((a, b) => a.cohortKey.localeCompare(b.cohortKey));
  return {
    tenant: set.tenant
      ? { medianLeadDays: set.tenant.distribution.medianLeadDays, bookings: set.tenant.bookings }
      : null,
    groups,
    sizeBands
  };
}

// ---- DOW occupancy ladder -----------------------------------------------------

/** One occupied unit-night, as loaded from `NightFact` (date-only string). */
export type OccupiedNightFact = { listingId: string; date: string };

export type CohortOccupancy = {
  cohortKey: string;
  /** Final occupancy (0..1) by UTC day-of-week, index 0 = Sunday. */
  factors: number[];
  /** Smallest per-DOW denominator (unit-night slots) — the gate metric. */
  minDowSlots: number;
  /** Occupied unit-nights observed — the provenance n. */
  occupiedUnitNights: number;
};

export type CohortOccupancySet = {
  tenant: CohortOccupancy | null;
  byListing: Map<string, CohortOccupancy>;
  byGroup: Map<string, CohortOccupancy>;
  bySizeBand: Map<string, CohortOccupancy>;
  groupsByListing: Map<string, string[]>;
  sizeBandKeyByListing: Map<string, string | null>;
};

type OccAccumulator = { occupied: number[]; slots: number[] };

function newOccAccumulator(): OccAccumulator {
  return { occupied: [0, 0, 0, 0, 0, 0, 0], slots: [0, 0, 0, 0, 0, 0, 0] };
}

function addInto(target: OccAccumulator, source: OccAccumulator): void {
  for (let d = 0; d < 7; d++) {
    target.occupied[d] += source.occupied[d];
    target.slots[d] += source.slots[d];
  }
}

function toOccupancy(cohortKey: string, acc: OccAccumulator): CohortOccupancy {
  return {
    cohortKey,
    factors: acc.occupied.map((occ, d) => (acc.slots[d] > 0 ? Math.min(1, occ / acc.slots[d]) : 1)),
    minDowSlots: Math.min(...acc.slots),
    occupiedUnitNights: acc.occupied.reduce((a, b) => a + b, 0)
  };
}

/**
 * Build every rung's DOW occupancy for one tenant. Pure.
 *
 * Numerator: occupied unit-nights per (listing, date), capped at the
 * listing's unitCount (stacked facts cannot exceed capacity). Denominator:
 * unitCount × the count of each DOW's dates in the listing's ACTIVE window
 * — from the later of `windowStart` and the listing's first occupied fact
 * — a deliberate change from the old tenant-wide scaler, which divided a
 * mid-year listing's occupancy over the full 365 days and understated it
 * (harmless when pooled tenant-wide; badly biased at listing grain).
 * Listings with no occupied facts contribute nothing. Facts from listings
 * absent from `listings` (e.g. removed) are ignored entirely — the old
 * scaler counted their nights in a numerator whose denominator excluded
 * them, slightly overstating tenant occupancy.
 *
 * `windowStart`/`windowEnd` are date-only strings; the window is
 * [windowStart, windowEnd) — windowEnd (today) excluded.
 */
export function buildCohortOccupancySet(args: {
  listings: CohortListing[];
  occupied: OccupiedNightFact[];
  windowStart: string;
  windowEnd: string;
}): CohortOccupancySet {
  const groupsByListing = new Map<string, string[]>();
  const sizeBandKeyByListing = new Map<string, string | null>();
  const unitCountByListing = new Map<string, number>();
  for (const listing of args.listings) {
    groupsByListing.set(listing.id, groupTagsFor(listing.tags));
    sizeBandKeyByListing.set(
      listing.id,
      isMultiUnit(listing.unitCount) ? null : `size:${sizeBandFor(listing.bedroomsNumber)}`
    );
    unitCountByListing.set(listing.id, Math.max(1, listing.unitCount ?? 1));
  }

  // Occupied units per (listing, date), capped at capacity; first fact date
  // per listing bounds its active window.
  const occupiedByNight = new Map<string, number>();
  const firstDateByListing = new Map<string, string>();
  for (const fact of args.occupied) {
    if (!unitCountByListing.has(fact.listingId)) continue;
    if (fact.date < args.windowStart || fact.date >= args.windowEnd) continue;
    const key = `${fact.listingId}|${fact.date}`;
    occupiedByNight.set(key, (occupiedByNight.get(key) ?? 0) + 1);
    const first = firstDateByListing.get(fact.listingId);
    if (!first || fact.date < first) firstDateByListing.set(fact.listingId, fact.date);
  }

  // Per-listing accumulators: numerator from capped nights, denominator from
  // the listing's active window.
  const listingAccs = new Map<string, OccAccumulator>();
  for (const [listingId, firstDate] of firstDateByListing) {
    const acc = newOccAccumulator();
    const unitCount = unitCountByListing.get(listingId) ?? 1;
    const activeFrom = firstDate > args.windowStart ? firstDate : args.windowStart;
    const end = fromDateOnly(args.windowEnd);
    for (let cursor = fromDateOnly(activeFrom); cursor.getTime() < end.getTime(); cursor = addUtcDays(cursor, 1)) {
      acc.slots[cursor.getUTCDay()] += unitCount;
    }
    listingAccs.set(listingId, acc);
  }
  for (const [key, count] of occupiedByNight) {
    const [listingId, date] = key.split("|");
    const acc = listingAccs.get(listingId);
    if (!acc) continue;
    const unitCount = unitCountByListing.get(listingId) ?? 1;
    acc.occupied[fromDateOnly(date).getUTCDay()] += Math.min(count, unitCount);
  }

  // Roll listings up into group / size-band / tenant accumulators.
  const tenantAcc = newOccAccumulator();
  const groupAccs = new Map<string, OccAccumulator>();
  const sizeBandAccs = new Map<string, OccAccumulator>();
  for (const [listingId, acc] of listingAccs) {
    addInto(tenantAcc, acc);
    for (const tag of groupsByListing.get(listingId) ?? []) {
      let groupAcc = groupAccs.get(tag);
      if (!groupAcc) groupAccs.set(tag, (groupAcc = newOccAccumulator()));
      addInto(groupAcc, acc);
    }
    const bandKey = sizeBandKeyByListing.get(listingId);
    if (bandKey) {
      let bandAcc = sizeBandAccs.get(bandKey);
      if (!bandAcc) sizeBandAccs.set(bandKey, (bandAcc = newOccAccumulator()));
      addInto(bandAcc, acc);
    }
  }

  const byListing = new Map<string, CohortOccupancy>();
  for (const [id, acc] of listingAccs) byListing.set(id, toOccupancy(`listing:${id}`, acc));
  const byGroup = new Map<string, CohortOccupancy>();
  for (const [tag, acc] of groupAccs) byGroup.set(tag, toOccupancy(tag, acc));
  const bySizeBand = new Map<string, CohortOccupancy>();
  for (const [key, acc] of sizeBandAccs) bySizeBand.set(key, toOccupancy(key, acc));

  return {
    tenant: listingAccs.size > 0 ? toOccupancy("tenant", tenantAcc) : null,
    byListing,
    byGroup,
    bySizeBand,
    groupsByListing,
    sizeBandKeyByListing
  };
}

export type ResolvedCohortOccupancy = {
  /** Final occupancy (0..1) by UTC day-of-week, index 0 = Sunday. */
  factors: number[];
  provenance: CohortProvenance;
};

function resolvedOccFrom(occ: CohortOccupancy, rung: CohortRung): ResolvedCohortOccupancy {
  return { factors: occ.factors, provenance: { rung, cohortKey: occ.cohortKey, n: occ.occupiedUnitNights } };
}

/**
 * Same ladder as the curve, gated on `OCCUPANCY_MIN_SLOTS_PER_DOW` for the
 * listing / group / size-band rungs; the tenant rung is the ungated
 * fallback (matching the old scaler's role). Group candidates prefer the
 * smallest member pool via fewest slots (most specific). Null only when the
 * tenant has no occupied history at all (old behaviour: no scaling).
 */
export function resolveCohortOccupancy(
  set: CohortOccupancySet,
  listingId: string
): ResolvedCohortOccupancy | null {
  const own = set.byListing.get(listingId);
  if (own && own.minDowSlots >= OCCUPANCY_MIN_SLOTS_PER_DOW) return resolvedOccFrom(own, "listing");

  const groupCandidates = (set.groupsByListing.get(listingId) ?? [])
    .map((tag) => set.byGroup.get(tag))
    .filter((g): g is CohortOccupancy => !!g && g.minDowSlots >= OCCUPANCY_MIN_SLOTS_PER_DOW)
    .sort((a, b) => a.minDowSlots - b.minDowSlots || a.cohortKey.localeCompare(b.cohortKey));
  if (groupCandidates.length > 0) return resolvedOccFrom(groupCandidates[0], "group");

  const bandKey = set.sizeBandKeyByListing.get(listingId);
  if (bandKey) {
    const band = set.bySizeBand.get(bandKey);
    if (band && band.minDowSlots >= OCCUPANCY_MIN_SLOTS_PER_DOW) return resolvedOccFrom(band, "size_band");
  }

  return set.tenant ? resolvedOccFrom(set.tenant, "tenant") : null;
}
