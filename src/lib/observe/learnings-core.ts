/**
 * The seven learnings — PURE cores (SIGNALS-OBSERVE-LEARN-SPEC.md §6).
 *
 * Each learning's math lives here as a pure function so it is unit-testable on
 * fixtures with no DB. The DB wrappers in `learnings.ts` load the data and call
 * these. Learning #5 (engine reaction) is PriceLabs/Wheelhouse-only — the caller
 * skips it for the Hostaway-fallback client (Coorie Doon).
 */

// ---- 1. Pickup velocity, moved vs control -----------------------------------

export type PickupVelocity = {
  movedPerListingDay: number;
  controlPerListingDay: number;
  /** (moved / control) − 1; null when the control booked nothing. */
  liftPct: number | null;
};

/** Bookings-per-listing-day on the event dates, moved vs control. Pure. */
export function pickupVelocity(args: {
  movedBookings: number;
  movedListingDays: number;
  controlBookings: number;
  controlListingDays: number;
}): PickupVelocity {
  const moved = args.movedListingDays > 0 ? args.movedBookings / args.movedListingDays : 0;
  const control = args.controlListingDays > 0 ? args.controlBookings / args.controlListingDays : 0;
  return { movedPerListingDay: moved, controlPerListingDay: control, liftPct: control > 0 ? moved / control - 1 : null };
}

// ---- 2. Lead-time curves ----------------------------------------------------

export const LEAD_TIME_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "0-1", min: 0, max: 1 },
  { label: "2-3", min: 2, max: 3 },
  { label: "4-7", min: 4, max: 7 },
  { label: "8-14", min: 8, max: 14 },
  { label: "15-30", min: 15, max: 30 },
  { label: "31-60", min: 31, max: 60 },
  { label: "61-90", min: 61, max: 90 },
  { label: "91+", min: 91, max: Number.POSITIVE_INFINITY }
];

export type LeadTimeDistribution = {
  buckets: Array<{ label: string; count: number; pct: number }>;
  medianLeadDays: number | null;
  n: number;
};

/** Distribution of booking→stay lead times into the standard buckets. Pure. */
export function leadTimeDistribution(leadDays: number[]): LeadTimeDistribution {
  const usable = leadDays.filter((d) => Number.isFinite(d) && d >= 0);
  const counts = LEAD_TIME_BUCKETS.map((b) => ({
    label: b.label,
    count: usable.filter((d) => d >= b.min && d <= b.max).length,
    pct: 0
  }));
  const n = usable.length;
  for (const c of counts) c.pct = n > 0 ? c.count / n : 0;
  let median: number | null = null;
  if (n > 0) {
    const sorted = [...usable].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
  return { buckets: counts, medianLeadDays: median, n };
}

/**
 * Per-market lead-time distributions: entries grouped by their (already
 * normalised) market key, keeping only markets with at least `minNights`
 * usable observations — a thin market falls out entirely rather than
 * contributing a noisy curve. Entries with no market key join no market.
 * Pure. (Build prompt 07 Part B item 7 — the market-stratified global doc.)
 */
export function leadTimeByMarket(
  entries: Array<{ leadDays: number; market: string | null }>,
  minNights: number
): Record<string, LeadTimeDistribution> {
  const byMarket = new Map<string, number[]>();
  for (const entry of entries) {
    if (!entry.market) continue;
    const list = byMarket.get(entry.market) ?? [];
    list.push(entry.leadDays);
    byMarket.set(entry.market, list);
  }
  const out: Record<string, LeadTimeDistribution> = {};
  for (const [market, leads] of [...byMarket.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dist = leadTimeDistribution(leads);
    if (dist.n >= minNights) out[market] = dist;
  }
  return out;
}

// ---- 3. Regret, both directions (SETTLED nights only) ------------------------

export type RegretLabel = "held_too_low" | "held_too_high" | "none";

/**
 * Booked at/below min AND snapped up at least this multiple of the typical lead
 * ahead of stay (i.e. far earlier than normal) = held too low: it sold instantly
 * because it was cheap, so we left money on the table.
 */
export const REGRET_EARLY_FACTOR = 1.5;
/**
 * Booked nights with allocated revenue at/below this (currency units) are
 * artefact rows or owner blocks — excluded from every regret input.
 */
export const REGRET_NEAR_ZERO_REVENUE = 5;
/** Sold within this multiple of the min counts as "at/below min". */
export const REGRET_MIN_TOLERANCE = 1.05;

/**
 * Classify one SETTLED stay-date outcome (the night has passed; the outcome is
 * known). Regret is never assigned to forward availability — a night that books
 * tomorrow is not a regret today. Pure.
 *  - held_too_high — expired empty IN EXCESS of the seasonal expectation of
 *    empties (an expected soft-season empty is `none`, not a client trait).
 *  - held_too_low  — sold at/below the min in force near booking, unusually
 *    early (lead ≥ earlyFactor × the client's median lead).
 *  - none          — everything else, so the two regret shares no longer sum
 *    to 1 by construction.
 */
export function classifyRegret(args: {
  booked: boolean;
  /** For an unbooked settled night: beyond the seasonal expectation of empties? */
  excessEmpty: boolean;
  leadDays: number | null;
  baselineMedianLead: number | null;
  soldAtOrBelowMin: boolean;
  earlyFactor?: number;
}): RegretLabel {
  const earlyFactor = args.earlyFactor ?? REGRET_EARLY_FACTOR;
  if (!args.booked) {
    return args.excessEmpty ? "held_too_high" : "none";
  }
  if (
    args.soldAtOrBelowMin &&
    args.leadDays !== null &&
    args.baselineMedianLead !== null &&
    args.baselineMedianLead > 0 &&
    args.leadDays >= args.baselineMedianLead * earlyFactor
  ) {
    return "held_too_low";
  }
  return "none";
}

/** Where the seasonal empties expectation came from. */
export type RegretBaselineSource = "pace_yoy" | "trailing_dow" | "none";

export type RegretSummary = {
  /** null = the tenant has no engine min data, so this direction is unmeasurable. */
  heldTooLow: number | null;
  heldTooHigh: number;
  none: number;
  /** Settled nights classified (sold + expired-empty, exclusions applied). */
  total: number;
  windowDays: number;
  /** Raw empties observed in the window (before the seasonal expectation). */
  emptyNights: number;
  /** Seasonal expectation of empties; null when no baseline could be built. */
  expectedEmpties: number | null;
  baselineSource: RegretBaselineSource;
};

/** One settled night, prepared by the DB wrapper. */
export type SettledNight = {
  booked: boolean;
  /** Allocated revenue for booked nights (near-zero exclusion); null when empty. */
  revenueAllocated: number | null;
  leadDays: number | null;
  /** Gross accommodation fare / nights; null when the reservation join misses. */
  grossNightlyRate: number | null;
  /** The engine min in force NEAR the booking date; null when unknown. */
  minInForce: number | null;
};

/**
 * The min in force nearest to `at` by capture time — NOT the latest snapshot.
 * Comparing a 90-day-old booking against today's min flags nothing but the
 * fact the min moved since (the anachronistic-min artefact). Pure.
 */
export function nearestMinAt(snapshots: Array<{ capturedAt: Date; min: number }>, at: Date): number | null {
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of snapshots) {
    const dist = Math.abs(s.capturedAt.getTime() - at.getTime());
    if (dist < bestDist) {
      bestDist = dist;
      best = s.min;
    }
  }
  return best;
}

/**
 * Summarise regret over settled nights. Pure.
 * Near-zero-revenue booked nights are excluded entirely. Empties beyond the
 * seasonal expectation are `held_too_high`; expected empties are `none`. When
 * no baseline exists (`expectedEmpties` null) every empty counts as excess —
 * the profile rules guard on `baselineSource === "none"` so that one-sided
 * input cannot mint a rule. `heldTooLow` is null (not 0) without min data.
 */
export function computeSettledRegret(args: {
  nights: SettledNight[];
  baselineMedianLead: number | null;
  expectedEmpties: number | null;
  baselineSource: RegretBaselineSource;
  windowDays: number;
  minDataAvailable: boolean;
}): RegretSummary | null {
  const usable = args.nights.filter(
    (n) => !n.booked || (n.revenueAllocated !== null && n.revenueAllocated > REGRET_NEAR_ZERO_REVENUE)
  );
  if (usable.length === 0) return null;

  const emptyNights = usable.filter((n) => !n.booked).length;
  const excessCount = Math.min(
    emptyNights,
    Math.max(0, emptyNights - Math.round(args.expectedEmpties ?? 0))
  );

  let heldTooLow = 0;
  let heldTooHigh = 0;
  let none = 0;
  let excessLeft = excessCount;
  for (const night of usable) {
    const excessEmpty = !night.booked && excessLeft > 0;
    const label = classifyRegret({
      booked: night.booked,
      excessEmpty,
      leadDays: night.leadDays,
      baselineMedianLead: args.baselineMedianLead,
      soldAtOrBelowMin:
        args.minDataAvailable &&
        night.minInForce !== null &&
        night.grossNightlyRate !== null &&
        night.grossNightlyRate <= night.minInForce * REGRET_MIN_TOLERANCE
    });
    if (label === "held_too_high") {
      heldTooHigh += 1;
      excessLeft -= 1;
    } else if (label === "held_too_low") {
      heldTooLow += 1;
    } else {
      none += 1;
    }
  }

  return {
    heldTooLow: args.minDataAvailable ? heldTooLow : null,
    heldTooHigh,
    none,
    total: usable.length,
    windowDays: args.windowDays,
    emptyNights,
    expectedEmpties: args.expectedEmpties,
    baselineSource: args.baselineSource
  };
}

// ---- 4. Pricing power by date type ------------------------------------------

export type DateType = "event" | "holiday" | "weekend" | "weekday";
export type RateSensitivity = "inelastic" | "elastic" | "unknown";

export type PricingPowerByDateType = Record<
  DateType,
  { occupancy: number; meanRate: number | null; n: number; rateSensitivity: RateSensitivity }
>;

/**
 * Occupancy + mean rate + a coarse rate-sensitivity label per date type. Pure.
 * High occupancy regardless of rate ⇒ inelastic (pricing power); low occupancy
 * ⇒ elastic (price plays). Dates that book regardless of rate are where the
 * premium lives (spec §6 learning 4).
 */
export function pricingPowerByDateType(
  rows: Array<{ dateType: DateType; occupied: boolean; rate: number | null }>
): PricingPowerByDateType {
  const types: DateType[] = ["event", "holiday", "weekend", "weekday"];
  const out = {} as PricingPowerByDateType;
  for (const type of types) {
    const subset = rows.filter((r) => r.dateType === type);
    const n = subset.length;
    const occupied = subset.filter((r) => r.occupied).length;
    const rates = subset.map((r) => r.rate).filter((r): r is number => r !== null && Number.isFinite(r));
    const occupancy = n > 0 ? occupied / n : 0;
    const sensitivity: RateSensitivity =
      n < 5 ? "unknown" : occupancy >= 0.8 ? "inelastic" : occupancy < 0.5 ? "elastic" : "unknown";
    out[type] = {
      occupancy,
      meanRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      n,
      rateSensitivity: sensitivity
    };
  }
  return out;
}

// ---- 5. Engine reaction (PriceLabs / Wheelhouse only) -----------------------

export type EngineReaction = "claw_back" | "fight" | "hold" | "unknown";

/**
 * After a human move old→new on a lever, classify how the engine reacted by
 * comparing the engine's value some time later. Pure.
 *  - hold     — engine kept (within tolerance of) the human's new value
 *  - claw_back — engine reverted back toward the old value
 *  - fight    — engine pushed past new, away from the human's intent
 */
export function classifyEngineReaction(args: {
  oldValue: number | null;
  newValue: number | null;
  engineAfter: number | null;
  tolerancePct?: number;
}): EngineReaction {
  const { oldValue, newValue, engineAfter } = args;
  if (oldValue === null || newValue === null || engineAfter === null) return "unknown";
  const tol = (args.tolerancePct ?? 0.03) * Math.max(Math.abs(newValue), 1);
  if (Math.abs(engineAfter - newValue) <= tol) return "hold";
  const distToOld = Math.abs(engineAfter - oldValue);
  const distToNew = Math.abs(engineAfter - newValue);
  if (distToOld < distToNew) return "claw_back";
  // Past `new`, in the same direction the human pushed ⇒ fighting harder.
  const humanDir = Math.sign(newValue - oldValue);
  const engineDir = Math.sign(engineAfter - newValue);
  if (humanDir !== 0 && engineDir === humanDir) return "fight";
  return "unknown";
}

// ---- 6. Net realised rate after discounts/fees ------------------------------

export type NetRealisedRate = {
  grossPerNight: number | null;
  netPerNight: number | null;
  /** Fraction of gross lost to fees + discounts. */
  feeDragPct: number | null;
};

/** True realised nightly rate net of discounts + fees. Pure. */
export function netRealisedRate(args: {
  grossRevenue: number;
  discounts: number;
  fees: number;
  nights: number;
}): NetRealisedRate {
  if (args.nights <= 0) return { grossPerNight: null, netPerNight: null, feeDragPct: null };
  const gross = args.grossRevenue;
  const net = gross - args.discounts - args.fees;
  return {
    grossPerNight: gross / args.nights,
    netPerNight: net / args.nights,
    feeDragPct: gross > 0 ? (gross - net) / gross : null
  };
}

// ---- 7. Cancellation quality ------------------------------------------------

export type CancellationQuality = {
  cheapCancelRate: number | null;
  expensiveCancelRate: number | null;
  signal: "cheaper_cancel_more" | "expensive_cancel_more" | "no_signal";
};

/**
 * Do cheaper-won bookings cancel more? Split by win-price percentile (cheap ≤
 * 0.33, expensive ≥ 0.67) and compare cancel rates. Pure.
 */
export function cancellationQuality(
  bookings: Array<{ winPricePercentile: number; cancelled: boolean }>
): CancellationQuality {
  const cheap = bookings.filter((b) => b.winPricePercentile <= 0.33);
  const expensive = bookings.filter((b) => b.winPricePercentile >= 0.67);
  const rate = (set: typeof bookings): number | null =>
    set.length > 0 ? set.filter((b) => b.cancelled).length / set.length : null;
  const cheapRate = rate(cheap);
  const expRate = rate(expensive);
  let signal: CancellationQuality["signal"] = "no_signal";
  if (cheapRate !== null && expRate !== null) {
    if (cheapRate - expRate > 0.05) signal = "cheaper_cancel_more";
    else if (expRate - cheapRate > 0.05) signal = "expensive_cancel_more";
  }
  return { cheapCancelRate: cheapRate, expensiveCancelRate: expRate, signal };
}
