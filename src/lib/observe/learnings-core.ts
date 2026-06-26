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

// ---- 3. Regret, both directions ---------------------------------------------

export type RegretLabel = "held_too_low" | "held_too_high" | "none";

/** Default: a still-unbooked night within this many days of stay = held too high. */
export const REGRET_WIRE_DAYS = 7;
/**
 * Booked at/below min AND snapped up at least this multiple of the typical lead
 * ahead of stay (i.e. far earlier than normal) = held too low: it sold instantly
 * because it was cheap, so we left money on the table.
 */
export const REGRET_EARLY_FACTOR = 1.5;

/** Classify a single stay-date outcome for regret. Pure. */
export function classifyRegret(args: {
  booked: boolean;
  daysToStay: number;
  leadDays: number | null;
  baselineMedianLead: number | null;
  soldAtOrBelowMin: boolean;
  wireDays?: number;
  earlyFactor?: number;
}): RegretLabel {
  const wireDays = args.wireDays ?? REGRET_WIRE_DAYS;
  const earlyFactor = args.earlyFactor ?? REGRET_EARLY_FACTOR;
  if (!args.booked) {
    return args.daysToStay >= 0 && args.daysToStay <= wireDays ? "held_too_high" : "none";
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

export type RegretSummary = { heldTooLow: number; heldTooHigh: number; none: number; total: number };

/** Tally regret labels. Pure. */
export function summarizeRegret(labels: RegretLabel[]): RegretSummary {
  const summary: RegretSummary = { heldTooLow: 0, heldTooHigh: 0, none: 0, total: labels.length };
  for (const label of labels) {
    if (label === "held_too_low") summary.heldTooLow += 1;
    else if (label === "held_too_high") summary.heldTooHigh += 1;
    else summary.none += 1;
  }
  return summary;
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
