/**
 * Cross-sectional demand signal — peer baselines for the trial pricing
 * comparison agent. 2026-05-22 rewrite per
 * `TONIGHT-DEMAND-SIGNAL-2026-05-22.md`.
 *
 * Replaces the temporal demand baseline (forward-vs-trailing-12mo,
 * forward-vs-LY) with date-vs-peer-dates comparisons. Forward-still-
 * filling vs settled-finished was structurally negative on every
 * forward date because the forward date has less on-the-books than a
 * finished one — clamping demand to the floor and missing genuine
 * spikes. Cross-sectional comparisons cancel that bias: we compare
 * what's on the books NOW for the target date against what's on the
 * books NOW for its same-month peers, observed at the same snapshot.
 *
 * Two sources:
 *   - Own portfolio fill: portfolio-aggregated nights-on-books per
 *     stay date, reconstructed from `Reservation` (created_at /
 *     cancelled_at filters), divided by active-listing supply. Per-
 *     tenant. The signal is the target's deviation from the median
 *     fill across same-month peer dates in the forward window.
 *   - KeyData market: per-date market revpar_adj from the OTA daily
 *     endpoint. The signal is the target's deviation from the median
 *     revpar_adj across same-month peer dates. KD also gives ADR and
 *     listing_count per date, used for the supply guard.
 *
 * Peer baseline is MONTH-MATCHED but NOT day-of-week-matched: this is
 * deliberate per the spec. Weekly patterns (Sat above month median,
 * Mon below) emerge through demand itself, self-calibrating to whatever
 * market the engine runs in. A hardcoded weekly shape is a city-
 * specific assumption — Belfast is weekend-led, a business market
 * would be weekday-led. The automatic day-of-week multiplier is
 * retired in this rebuild (see `agent.ts` call site).
 */

import { prisma } from "@/lib/prisma";
import type { KeyDataForwardPace } from "@/lib/pricing/keydata-provider";

/**
 * Minimum number of peer dates (excluding the target) needed for a
 * valid cross-sectional baseline. Below this gate the signal is null
 * and the demand multiplier falls back gracefully to 1.0.
 *
 * Calibrated so a target near the start of a calendar month still has
 * a plausible peer cohort within the 91-day forward window (~3 weeks
 * of same-month peers).
 */
export const PEER_MIN_SAMPLE_SIZE = 8;

/**
 * Supply-guard threshold. Triggers when the target date's KD
 * `listing_count` is more than this fraction below its same-month
 * peer median AND the target's ADR delta is within the flat band
 * (see `SUPPLY_GUARD_FLAT_ADR_DELTA`).
 */
export const SUPPLY_GUARD_CONTRACTION_THRESHOLD = -0.2;

/** Above this ADR delta the apparent RevPAR lift is treated as real demand. */
export const SUPPLY_GUARD_FLAT_ADR_DELTA = 0.05;

/**
 * When the supply guard fires, the demand delta is damped to
 * `min(rpa_delta, max(adr_delta, 0) × SUPPLY_GUARD_ADR_GAIN)` so the
 * lift is bounded to ADR-driven movement. Gain of 2× lets a +5% ADR
 * lift become up to a +10% effective demand delta.
 */
export const SUPPLY_GUARD_ADR_GAIN = 2;

export type PortfolioForwardFill = {
  /** Map of YYYY-MM-DD → nights-on-books across the tenant. */
  nightsByDate: Map<string, number>;
  /** Active single-unit listing supply for the tenant (the fill denominator). */
  supply: number;
  /** ISO range covered (inclusive). */
  fromIso: string;
  toIso: string;
};

/**
 * Reconstruct the tenant's on-the-books fill for every stay date in
 * `[fromIso, toIso]` as of `asOfIso`. Counts distinct (listing, date)
 * pairs covered by an active reservation — i.e. created on/before
 * `asOfIso`, not cancelled by `asOfIso`, spanning the stay date.
 *
 * Excludes ownerstay (per the trailing-adr exclusions). Excludes
 * multi-unit parents (the trial scope is single-unit listings).
 *
 * Single SQL round-trip per tenant per run.
 */
export async function loadPortfolioForwardFill(args: {
  tenantId: string;
  asOfIso: string;
  fromIso: string;
  toIso: string;
}): Promise<PortfolioForwardFill> {
  const { tenantId, asOfIso, fromIso, toIso } = args;
  const rows = (await prisma.$queryRaw`
    WITH active_listings AS (
      SELECT id FROM listings
      WHERE tenant_id = ${tenantId}
        AND status != 'inactive'
        AND COALESCE(unit_count, 1) < 2
    ), stay_dates AS (
      SELECT generate_series(${fromIso}::date, ${toIso}::date, '1 day'::interval)::date AS d
    )
    SELECT sd.d::text AS stay_date,
           COUNT(DISTINCT (r.listing_id || sd.d::text))::int AS nights_on_books
    FROM stay_dates sd
    LEFT JOIN reservations r
      ON r.tenant_id = ${tenantId}
     AND r.listing_id IN (SELECT id FROM active_listings)
     AND r.created_at <= ${asOfIso}::timestamptz
     AND (r.cancelled_at IS NULL OR r.cancelled_at > ${asOfIso}::timestamptz)
     AND r.arrival <= sd.d
     AND r.departure > sd.d
     AND COALESCE(r.status, '') != 'ownerstay'
    GROUP BY sd.d
    ORDER BY sd.d
  `) as Array<{ stay_date: string; nights_on_books: number }>;

  const supplyRow = (await prisma.$queryRaw`
    SELECT COUNT(*)::int AS supply
    FROM listings
    WHERE tenant_id = ${tenantId}
      AND status != 'inactive'
      AND COALESCE(unit_count, 1) < 2
  `) as Array<{ supply: number }>;
  const supply = supplyRow[0]?.supply ?? 0;

  const nightsByDate = new Map<string, number>();
  for (const r of rows) nightsByDate.set(r.stay_date, r.nights_on_books);
  return { nightsByDate, supply, fromIso, toIso };
}

/**
 * Compute the median of an array of numbers. Returns null on empty.
 * (Sort + middle — fine for the ~10-30 element arrays we use.)
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Extract month index 0..11 from an ISO date.
 */
function monthOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCMonth();
}

export type OwnCrossSectionalDelta = {
  /**
   * Target fill / peer median fill - 1. null when peer set is below
   * `PEER_MIN_SAMPLE_SIZE` or when supply is 0 / target has no data.
   */
  delta: number | null;
  /** Number of peer dates contributing to the baseline (excludes target). */
  peerSampleSize: number;
  /** Target date's fill rate (nights / supply). Informational. */
  targetFill: number | null;
  /** Median fill rate across the peer set. Informational. */
  peerMedianFill: number | null;
};

/**
 * Compute the target date's own-portfolio cross-sectional demand delta.
 * Peer set = same calendar month, within the loaded forward window,
 * excluding the target date.
 */
export function computeOwnCrossSectionalDelta(args: {
  targetIso: string;
  fill: PortfolioForwardFill;
}): OwnCrossSectionalDelta {
  const { targetIso, fill } = args;
  if (fill.supply <= 0) {
    return { delta: null, peerSampleSize: 0, targetFill: null, peerMedianFill: null };
  }
  const targetMonth = monthOf(targetIso);
  const peerFills: number[] = [];
  let targetFill: number | null = null;
  for (const [iso, nights] of fill.nightsByDate) {
    if (iso === targetIso) {
      targetFill = nights / fill.supply;
      continue;
    }
    if (monthOf(iso) !== targetMonth) continue;
    peerFills.push(nights / fill.supply);
  }
  if (peerFills.length < PEER_MIN_SAMPLE_SIZE) {
    return { delta: null, peerSampleSize: peerFills.length, targetFill, peerMedianFill: null };
  }
  const peerMedianFill = median(peerFills);
  if (peerMedianFill === null || peerMedianFill <= 0 || targetFill === null) {
    return { delta: null, peerSampleSize: peerFills.length, targetFill, peerMedianFill };
  }
  const delta = targetFill / peerMedianFill - 1;
  return { delta, peerSampleSize: peerFills.length, targetFill, peerMedianFill };
}

export type KdCrossSectionalDelta = {
  /** Target RPA / peer median RPA - 1. null when peer set is below gate or target has no data. */
  revparDelta: number | null;
  /** Target ADR / peer median ADR - 1. Drives the supply guard. */
  adrDelta: number | null;
  /** Target listing_count / peer median listing_count - 1. Negative = supply contracted. */
  supplyDelta: number | null;
  /** True when supply contraction + flat ADR triggers the guard. */
  supplyGuardTriggered: boolean;
  /** Effective demand delta after applying the supply-guard damper. */
  effectiveDelta: number | null;
  peerSampleSize: number;
  /** Target's revpar_adj. Informational. */
  targetRevparAdj: number | null;
  /** Median revpar_adj across the peer set. Informational. */
  peerMedianRevparAdj: number | null;
};

/**
 * Compute the target date's KeyData cross-sectional demand delta from
 * the forward-pace `perDate` array (KD daily endpoint).
 *
 * Returns separate revpar / adr / supply deltas so the supply guard
 * can be applied. `effectiveDelta` is the value that should feed the
 * demand multiplier: raw revpar delta normally, damped to ADR-driven
 * when supply contracts >20% AND ADR is flat/down.
 */
export function computeKdCrossSectionalDelta(args: {
  targetIso: string;
  forwardPace: KeyDataForwardPace | null;
}): KdCrossSectionalDelta {
  const empty: KdCrossSectionalDelta = {
    revparDelta: null,
    adrDelta: null,
    supplyDelta: null,
    supplyGuardTriggered: false,
    effectiveDelta: null,
    peerSampleSize: 0,
    targetRevparAdj: null,
    peerMedianRevparAdj: null
  };
  if (!args.forwardPace) return empty;
  const targetMonth = monthOf(args.targetIso);

  let target: { rpa: number | null; adr: number; supply: number | null } | null = null;
  const peerRpa: number[] = [];
  const peerAdr: number[] = [];
  const peerSupply: number[] = [];

  for (const row of args.forwardPace.perDate) {
    if (row.date === args.targetIso) {
      target = {
        rpa: row.forwardRevparAdj,
        adr: row.forwardADR,
        supply: row.marketSupplyCount
      };
      continue;
    }
    if (monthOf(row.date) !== targetMonth) continue;
    if (row.forwardRevparAdj !== null && Number.isFinite(row.forwardRevparAdj)) {
      peerRpa.push(row.forwardRevparAdj);
    }
    if (Number.isFinite(row.forwardADR) && row.forwardADR > 0) peerAdr.push(row.forwardADR);
    if (row.marketSupplyCount !== null && Number.isFinite(row.marketSupplyCount) && row.marketSupplyCount > 0) {
      peerSupply.push(row.marketSupplyCount);
    }
  }

  if (!target) return empty;
  if (peerRpa.length < PEER_MIN_SAMPLE_SIZE) {
    return { ...empty, peerSampleSize: peerRpa.length, targetRevparAdj: target.rpa, peerMedianRevparAdj: median(peerRpa) };
  }

  const peerMedianRpa = median(peerRpa);
  const peerMedianAdr = median(peerAdr);
  const peerMedianSupply = median(peerSupply);

  const revparDelta =
    target.rpa !== null && peerMedianRpa !== null && peerMedianRpa > 0
      ? target.rpa / peerMedianRpa - 1
      : null;
  const adrDelta =
    peerMedianAdr !== null && peerMedianAdr > 0 ? target.adr / peerMedianAdr - 1 : null;
  const supplyDelta =
    target.supply !== null && peerMedianSupply !== null && peerMedianSupply > 0
      ? target.supply / peerMedianSupply - 1
      : null;

  // Supply guard — fires only when supply contracted >20% AND ADR is
  // flat/down. Both conditions required so genuine demand events
  // (Fleadh: supply -34%, ADR +7%) flow through unconditionally — the
  // contraction is itself a downstream signal of demand, not an
  // artifact.
  const supplyContracted =
    supplyDelta !== null && supplyDelta <= SUPPLY_GUARD_CONTRACTION_THRESHOLD;
  const adrFlat = adrDelta !== null && adrDelta < SUPPLY_GUARD_FLAT_ADR_DELTA;
  const supplyGuardTriggered = supplyContracted && adrFlat;

  let effectiveDelta: number | null = revparDelta;
  if (supplyGuardTriggered && revparDelta !== null) {
    // Damped to ADR-only movement: an ADR lift of +5% → at most +10%
    // effective demand. ADR drop / flat → 0 effective lift. Negative
    // ADR keeps a negative effective delta (downside path).
    const adrFloor = Math.max(adrDelta ?? 0, 0) * SUPPLY_GUARD_ADR_GAIN;
    effectiveDelta = Math.min(revparDelta, adrFloor);
  }

  return {
    revparDelta,
    adrDelta,
    supplyDelta,
    supplyGuardTriggered,
    effectiveDelta,
    peerSampleSize: peerRpa.length,
    targetRevparAdj: target.rpa,
    peerMedianRevparAdj: peerMedianRpa
  };
}
