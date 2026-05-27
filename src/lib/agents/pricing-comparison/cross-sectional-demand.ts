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
 * Data-sufficiency gate on the own-portfolio cross-sectional pace
 * signal (2026-05-24, overnight demand-horizon fix).
 *
 * The peer-count gate above is necessary but not sufficient — far-future
 * dates can have 30 same-month peers each with 0-3 nights on books.
 * The peer cohort is "large" by count but tiny by content; dividing
 * `target_fill / peer_median_fill - 1` then blows up to the rails on
 * any small absolute fluctuation (target with 3 nights vs peer median
 * 1 night = +200% delta → demand pinned at +40% ceiling).
 *
 * This gate enforces a floor on the peer MEDIAN FILL — the denominator
 * must be dense enough that the ratio is stable. Below the floor we
 * return null so the demand multiplier falls back to neutral (1.0)
 * instead of pinning at the rail; the calendar/holiday layer (Phase C)
 * provides far-future demand from known dates instead.
 *
 * Threshold of 15% was calibrated against the 2026-05-24 trial run
 * (see BUILD-LOG entry for the same date): cells beyond ~120 days
 * out had avg peer_median_fill of 12-20%; setting the gate at 15%
 * gates out the 180d+ horizon entirely (avg fill 12%, where the
 * worst pinning lives) while preserving 91-180d cells that still
 * have meaningful pace evidence (avg fill 20%).
 */
export const DEMAND_PACE_MIN_PEER_FILL = 0.15;

/**
 * Supply-guard threshold. Triggers when the target date's KD
 * `listing_count` is more than this fraction below its same-month
 * peer median AND the target's ADR delta is within the flat band
 * (see `SUPPLY_GUARD_FLAT_ADR_DELTA`) AND the adr_unbooked delta is
 * below `SUPPLY_GUARD_ADR_UNBOOKED_BYPASS` (added 2026-05-27 PM).
 */
export const SUPPLY_GUARD_CONTRACTION_THRESHOLD = -0.2;

/** Above this ADR delta the apparent RevPAR lift is treated as real demand. */
export const SUPPLY_GUARD_FLAT_ADR_DELTA = 0.05;

/**
 * Bypass threshold on `adr_unbooked` peer delta (2026-05-27 PM).
 *
 * The supply guard was designed to catch fire-sale scenarios — supply
 * contracted because units were dumped at low rates, lifting apparent
 * RevPAR-per-occupied while not signalling real demand. The booked-
 * ADR check (`SUPPLY_GUARD_FLAT_ADR_DELTA`) was the original "is the
 * rise real?" question, but booked ADR is by construction flat or
 * down on genuine demand spikes (what's left over is what nobody
 * wanted at the old price). adr_unbooked — the market's CALENDAR
 * asking-rate for unbooked inventory — is the right "is the rise
 * real?" check: a market asking 15%+ above peer median for the
 * still-available nights is publishing its conviction that demand is
 * up. Damping that signal because supply contracted is wrong.
 *
 * Aug 22 Sat (the canonical failure case under the prior logic):
 *   adr_unbooked +25.7% (market shouting "Fleadh"),
 *   supply -36.8% (event-week supply tightening),
 *   booked ADR -3.1% (flat — Fleadh inventory at fixed PriceLabs rates).
 * Old guard: fires (supply contracted + ADR flat) → corroborated +35.7%
 *   damped to ~0%.
 * New guard: bypass kicks in (adr_unbooked +25.7% ≥ 15%) → guard does
 *   not fire → +35.7% flows through.
 *
 * 0.15 chosen as the threshold so the bypass triggers on clearly
 * event-driven dates without firing on normal week-over-week noise
 * (sub-15% adr_unbooked deltas are common in flat markets). Same
 * threshold as the booking-window corroborator gate for consistency.
 */
export const SUPPLY_GUARD_ADR_UNBOOKED_BYPASS = 0.15;

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
  // Data-sufficiency gate (2026-05-24): a low peer-median fill makes the
  // ratio unstable — divides small numbers and swings to the rails on
  // tiny absolute fluctuations. Below DEMAND_PACE_MIN_PEER_FILL we drop
  // the delta to null so the multiplier returns neutral; the calendar
  // demand layer (Phase C) takes over for far-future dates.
  if (peerMedianFill < DEMAND_PACE_MIN_PEER_FILL) {
    return { delta: null, peerSampleSize: peerFills.length, targetFill, peerMedianFill };
  }
  const delta = targetFill / peerMedianFill - 1;
  return { delta, peerSampleSize: peerFills.length, targetFill, peerMedianFill };
}

export type KdCrossSectionalDelta = {
  /**
   * Target / peer median primary-metric - 1. The "primary metric" is
   * `forwardAdrUnbooked` from 2026-05-27 PM onwards (was a lead-time
   * switch between revpar_adj and adr_unbooked previously). Field name
   * kept as `revparDelta` for backward-compat with consumers and the
   * diagnostic table column; reasoning string + new
   * `primaryMetric` field below disambiguate.
   */
  revparDelta: number | null;
  /** Target ADR / peer median ADR - 1. Drives the supply guard. */
  adrDelta: number | null;
  /** Target listing_count / peer median listing_count - 1. Negative = supply contracted. */
  supplyDelta: number | null;
  /** True when supply contraction + flat ADR + sub-bypass adr_unbooked triggers the guard. */
  supplyGuardTriggered: boolean;
  /**
   * True when the guard WOULD have fired under the pre-2026-05-27-PM
   * two-condition logic but the new `adr_unbooked` bypass blocked it.
   * Diagnostic-only: surfaced in the reasoning string + report
   * attribution so the bypass-firing rate is visible.
   */
  supplyGuardBypassedByAdrUnbooked: boolean;
  /**
   * Effective demand delta after the booking-window corroborator bonus
   * AND the supply-guard damper. This is the value that feeds the
   * demand multiplier downstream.
   */
  effectiveDelta: number | null;
  peerSampleSize: number;
  /** Target's revpar_adj. Informational. */
  targetRevparAdj: number | null;
  /** Median revpar_adj across the peer set. Informational. */
  peerMedianRevparAdj: number | null;
  /**
   * Target / peer median booking-window - 1 (forwardBookingWindow).
   * Positive = people booking earlier than peer dates of the same DoW
   * nearby (event signal). null when the corroborator data is missing.
   */
  bookingWindowDelta: number | null;
  /**
   * True when the booking-window corroborator added a bonus to the
   * effective delta — i.e. both the primary delta AND the booking-
   * window delta agreed positive and cleared their gates.
   */
  bookingWindowCorroboratorTriggered: boolean;
  /** Diagnostic: amount the corroborator added to effectiveDelta (>=0). */
  bookingWindowBonus: number;
  /** Target's forwardBookingWindow (days). Informational. */
  targetBookingWindow: number | null;
  /** Median forwardBookingWindow across the peer set (days). Informational. */
  peerMedianBookingWindow: number | null;
};

/**
 * KD peer-set window (2026-05-26 redesign): peers are dates within
 * `KD_PEER_WINDOW_DAYS` of the target AND the same day-of-week. Replaces
 * the prior same-calendar-month peer logic, which was lead-time-
 * contaminated (late-month targets compared against early-month peers
 * that sat at completely different lead times). "Similar Saturdays
 * nearby" — same DoW + ±21d isolates the day-type and lead-time
 * concurrently.
 */
export const KD_PEER_WINDOW_DAYS = 21;

/**
 * Minimum same-DoW peer count for the KD signal to fire. The
 * lead-time-and-DoW-controlled window caps the cohort at ~6 (3 weeks
 * × 2 sides ÷ 7-day cadence); 3 keeps the median stable while
 * allowing the signal at the edges of the horizon where the window
 * is one-sided. Replaces the prior 8-peer gate (designed for the
 * same-calendar-month window which had ~30 peers).
 */
export const KD_PEER_MIN_SAMPLE_SIZE = 3;

/**
 * @deprecated 2026-05-27 PM. The lead-time switch from `forwardRevparAdj`
 * to `forwardAdrUnbooked` was retired in favour of always-on
 * `forwardAdrUnbooked` for the KD cross-sectional metric. Rationale:
 * the structural blind spots of cross-sectional pace (within-month
 * comparison, price elasticity, RM bias) apply at every lead time,
 * not just far-future. adr_unbooked is the market's calendar asking-
 * rate — independent of booking volume, the cleanest competitive
 * baseline at every lead. Pace + occupancy logic on top still drives
 * the actual lift/cut decisions.
 *
 * Constant kept (set to 0) for any callers / tests that still
 * reference it; the cross-sectional function no longer reads it.
 * Safe to delete once downstream usages have been audited.
 */
export const KD_FAR_FUTURE_LEAD_DAYS = 0;

/**
 * Booking-window corroborator (2026-05-27 PM).
 *
 * `forwardBookingWindow` (KD's per-date average booking-window in
 * days) is a leading event signal: when bookings for a date are
 * coming in unusually early compared to peer dates, the date is
 * event-driven. Used as a CORROBORATOR — never the primary signal —
 * it boosts the KD demand delta when both the asking-rate signal
 * (forwardAdrUnbooked) AND the booking-window signal point up.
 *
 * Gate: booking-window cross-sectional delta must exceed
 * `BOOKING_WINDOW_BONUS_GATE` (target booking window ≥15% longer than
 * peer median — i.e. people are booking materially earlier than
 * comparable peer Saturdays/Mondays nearby).
 *
 * Cap: bonus contribution to the effective delta is bounded to
 * `BOOKING_WINDOW_BONUS_CAP` (an outer artefact guard — booking-
 * window data is noisier than ADR, capping the contribution stops
 * a single misfiring date from running unbounded).
 *
 * The corroborator NEVER subtracts. Negative booking-window deltas
 * (people booking later than usual) are ambiguous — could be a
 * genuine soft signal or just a slow-fill date — and the primary
 * pace + KD asking-rate already capture them. Only the up-side
 * corroboration adds confidence + extra lift.
 */
export const BOOKING_WINDOW_BONUS_GATE = 0.15;
export const BOOKING_WINDOW_BONUS_CAP = 0.10;

function dayOfWeekOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function isoDateDiffDays(a: string, b: string): number {
  return Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000);
}

/**
 * Compute the target date's KeyData cross-sectional demand delta from
 * the forward-pace `perDate` array (KD daily endpoint).
 *
 * 2026-05-26 redesign: peer set is now same-day-of-week + within
 * ±KD_PEER_WINDOW_DAYS of the target. Same lead-time-controlled
 * logic the own pace signal uses (booking-curve.ts).
 *
 * 2026-05-27 PM redesign — always-on `forwardAdrUnbooked`:
 *   - Previously: revpar_adj at lead <75d, adr_unbooked at lead ≥75d.
 *   - Now: adr_unbooked at every lead. adr_unbooked is the market's
 *     CALENDAR asking-rate (independent of booking volume), the
 *     cleanest competitive baseline at every lead. Pace + own
 *     occupancy logic on top does the actual lift/cut interpretation.
 *   - `forwardRevparAdj` is still read for `targetRevparAdj` /
 *     `peerMedianRevparAdj` (informational) but no longer drives the
 *     primary delta.
 *
 * 2026-05-27 PM addition — booking-window corroborator:
 *   - `forwardBookingWindow` cross-sectional delta (target vs same-
 *     DoW ±21d peer median) is computed alongside the primary delta.
 *   - When BOTH the primary adr_unbooked delta AND the booking-window
 *     delta are positive AND the booking-window delta clears
 *     `BOOKING_WINDOW_BONUS_GATE`, a bonus of
 *     `min(BOOKING_WINDOW_BONUS_CAP, bookingWindowDelta × 0.5)` is
 *     added to the effective delta.
 *   - The corroborator NEVER subtracts. Negative or sub-gate booking
 *     window: no contribution.
 *
 * Returns separate revpar / adr / supply / booking-window deltas so
 * the supply guard can be applied AFTER the corroborator bonus. The
 * supply guard logic is metric-agnostic — it fires on supply
 * contraction + flat ADR regardless of which metric drove the
 * primary delta.
 */
export function computeKdCrossSectionalDelta(args: {
  targetIso: string;
  forwardPace: KeyDataForwardPace | null;
  /**
   * @deprecated 2026-05-27 PM. The lead-time switch was retired —
   * adr_unbooked is now the always-on primary metric. snapshotIso
   * is no longer read; kept in the signature for backward compat
   * with the caller in agent.ts (one less coordinated edit).
   */
  snapshotIso?: string;
}): KdCrossSectionalDelta {
  const empty: KdCrossSectionalDelta = {
    revparDelta: null,
    adrDelta: null,
    supplyDelta: null,
    supplyGuardTriggered: false,
    supplyGuardBypassedByAdrUnbooked: false,
    effectiveDelta: null,
    peerSampleSize: 0,
    targetRevparAdj: null,
    peerMedianRevparAdj: null,
    bookingWindowDelta: null,
    bookingWindowCorroboratorTriggered: false,
    bookingWindowBonus: 0,
    targetBookingWindow: null,
    peerMedianBookingWindow: null
  };
  if (!args.forwardPace) return empty;
  const targetDow = dayOfWeekOf(args.targetIso);

  type TargetMetrics = {
    primary: number | null; // always adr_unbooked from 2026-05-27 PM
    rpa: number | null; // revpar_adj — informational only
    adr: number;
    supply: number | null;
    bw: number | null; // forwardBookingWindow
  };
  let target: TargetMetrics | null = null;
  const peerPrimary: number[] = []; // adr_unbooked
  const peerAdr: number[] = [];
  const peerSupply: number[] = [];
  const peerBookingWindow: number[] = [];

  for (const row of args.forwardPace.perDate) {
    // Primary metric is always adr_unbooked from 2026-05-27 PM. The
    // lead-time switch (KD_FAR_FUTURE_LEAD_DAYS) was retired in
    // favour of always-on calendar asking-rate.
    const primary = row.forwardAdrUnbooked;
    if (row.date === args.targetIso) {
      target = {
        primary: primary,
        rpa: row.forwardRevparAdj,
        adr: row.forwardADR,
        supply: row.marketSupplyCount,
        bw: row.forwardBookingWindow
      };
      continue;
    }
    // Same DoW + within ±KD_PEER_WINDOW_DAYS. Lead-time-controlled
    // because nearby dates have similar lead-time-to-stay, and
    // day-of-week-controlled because Sat/Sun/Mon book differently.
    if (dayOfWeekOf(row.date) !== targetDow) continue;
    if (Math.abs(isoDateDiffDays(row.date, args.targetIso)) > KD_PEER_WINDOW_DAYS) continue;
    if (primary !== null && Number.isFinite(primary) && primary > 0) {
      peerPrimary.push(primary);
    }
    if (Number.isFinite(row.forwardADR) && row.forwardADR > 0) peerAdr.push(row.forwardADR);
    if (row.marketSupplyCount !== null && Number.isFinite(row.marketSupplyCount) && row.marketSupplyCount > 0) {
      peerSupply.push(row.marketSupplyCount);
    }
    if (
      row.forwardBookingWindow !== null &&
      Number.isFinite(row.forwardBookingWindow) &&
      row.forwardBookingWindow > 0
    ) {
      peerBookingWindow.push(row.forwardBookingWindow);
    }
  }

  if (!target) return empty;
  // Sufficiency gate: need enough peers AND a non-null target value
  // for the primary (adr_unbooked) metric. When adr_unbooked is
  // missing on the target row, return neutral (null delta) so the
  // multiplier falls through to its null-input default.
  if (peerPrimary.length < KD_PEER_MIN_SAMPLE_SIZE || target.primary === null || !Number.isFinite(target.primary)) {
    return { ...empty, peerSampleSize: peerPrimary.length, targetRevparAdj: target.rpa, peerMedianRevparAdj: median(peerPrimary) };
  }

  const peerMedianPrimary = median(peerPrimary);
  const peerMedianAdr = median(peerAdr);
  const peerMedianSupply = median(peerSupply);
  const peerMedianBookingWindow = median(peerBookingWindow);

  // `revparDelta` field name kept for downstream backward-compat;
  // value is the adr_unbooked vs peer-median-adr_unbooked delta from
  // 2026-05-27 PM onwards.
  const revparDelta =
    target.primary !== null && peerMedianPrimary !== null && peerMedianPrimary > 0
      ? target.primary / peerMedianPrimary - 1
      : null;
  const adrDelta =
    peerMedianAdr !== null && peerMedianAdr > 0 ? target.adr / peerMedianAdr - 1 : null;
  const supplyDelta =
    target.supply !== null && peerMedianSupply !== null && peerMedianSupply > 0
      ? target.supply / peerMedianSupply - 1
      : null;
  const bookingWindowDelta =
    target.bw !== null && peerMedianBookingWindow !== null && peerMedianBookingWindow > 0
      ? target.bw / peerMedianBookingWindow - 1
      : null;

  // Booking-window corroborator (2026-05-27 PM). Fires when BOTH:
  //   - primary delta (revparDelta) is positive (the asking-rate
  //     signal says this date is above peers)
  //   - bookingWindowDelta exceeds the gate (people booking earlier
  //     for this date than for peer dates)
  // Adds min(cap, bookingWindowDelta × 0.5) to effectiveDelta. NEVER
  // subtracts: a negative or sub-gate booking window contributes 0.
  let bookingWindowBonus = 0;
  let bookingWindowCorroboratorTriggered = false;
  if (
    revparDelta !== null &&
    revparDelta > 0 &&
    bookingWindowDelta !== null &&
    bookingWindowDelta > BOOKING_WINDOW_BONUS_GATE
  ) {
    bookingWindowBonus = Math.min(BOOKING_WINDOW_BONUS_CAP, bookingWindowDelta * 0.5);
    bookingWindowCorroboratorTriggered = true;
  }

  // Supply guard — fires only when ALL THREE conditions hit:
  //   1. supply contracted >20% (event-week tightening shape), AND
  //   2. booked ADR is flat/down (rules out a genuine ADR-driven lift), AND
  //   3. adr_unbooked is below the bypass threshold (added 2026-05-27 PM:
  //      market's calendar asking-rate isn't shouting that demand is up).
  // The third condition catches the Aug 22 Sat case where supply
  // contracted AND booked ADR was flat (Fleadh-style fixed-rate
  // inventory) but adr_unbooked was clearly elevated (+25.7%) —
  // damping would erase a genuine demand signal.
  //
  // The damping math when the guard does fire is unchanged.
  const supplyContracted =
    supplyDelta !== null && supplyDelta <= SUPPLY_GUARD_CONTRACTION_THRESHOLD;
  const adrFlat = adrDelta !== null && adrDelta < SUPPLY_GUARD_FLAT_ADR_DELTA;
  const adrUnbookedBelowBypass =
    revparDelta === null || revparDelta < SUPPLY_GUARD_ADR_UNBOOKED_BYPASS;
  const supplyGuardTriggered = supplyContracted && adrFlat && adrUnbookedBelowBypass;
  // Diagnostic flag: true when the guard WOULD have fired under the
  // pre-2026-05-27-PM logic but the adr_unbooked bypass blocked it.
  // Surfaced for reasoning strings + downstream report attribution.
  const supplyGuardBypassedByAdrUnbooked =
    supplyContracted && adrFlat && !adrUnbookedBelowBypass;

  // Apply bonus BEFORE the supply guard so the guard's damping (when
  // it fires) sees the corroborated value. Bonus is additive on top
  // of the primary revparDelta.
  let effectiveDelta: number | null =
    revparDelta !== null ? revparDelta + bookingWindowBonus : null;
  if (supplyGuardTriggered && effectiveDelta !== null) {
    // Damped to ADR-only movement: an ADR lift of +5% → at most +10%
    // effective demand. ADR drop / flat → 0 effective lift. Negative
    // ADR keeps a negative effective delta (downside path).
    const adrFloor = Math.max(adrDelta ?? 0, 0) * SUPPLY_GUARD_ADR_GAIN;
    effectiveDelta = Math.min(effectiveDelta, adrFloor);
  }

  return {
    revparDelta,
    adrDelta,
    supplyDelta,
    supplyGuardTriggered,
    supplyGuardBypassedByAdrUnbooked,
    effectiveDelta,
    peerSampleSize: peerPrimary.length,
    // targetRevparAdj is informational and always carries the actual
    // revpar_adj value (not the adr_unbooked primary) so downstream
    // diagnostics keep their meaning.
    targetRevparAdj: target.rpa,
    peerMedianRevparAdj: peerMedianPrimary,
    bookingWindowDelta,
    bookingWindowCorroboratorTriggered,
    bookingWindowBonus,
    targetBookingWindow: target.bw,
    peerMedianBookingWindow
  };
}
