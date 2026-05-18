/**
 * Divergence-cause classifier.
 *
 * For every cell where |delta| > 5% between our recommended rate and the
 * Hostaway live rate (= PriceLabs's output), this classifies WHY the two
 * engines disagree:
 *
 *   - demand_disagreement: the two engines read demand differently. Lifts
 *     point in opposite directions, OR the magnitude of disagreement
 *     between their lifts exceeds 5pp.
 *   - level_disagreement: same demand read, different base/floor
 *     calibration. Lifts agree to within 5pp but the absolute price level
 *     diverges by >5%.
 *   - mixed: lifts agree directionally but their delta is 3-5pp — partial
 *     demand disagreement compounded with level differences.
 *
 * The "lift" is the cell's percentage deviation from the same listing's
 * own median rate over a ±14-day window. That gives a normalised view of
 * "how much each engine moved the price off its own baseline" — so
 * comparing lifts is a comparison of pricing INTENT, not raw level.
 */

export type DivergenceCause = "demand_disagreement" | "level_disagreement" | "mixed";

export type DivergenceLiftInput = {
  /** Our recommendation for the target date. */
  ourRate: number;
  /** PriceLabs' (Hostaway live) rate for the target date. */
  plRate: number;
  /** Our median recommendation across the ±14-day window for this listing. */
  ourBaseline: number;
  /** PriceLabs' median rate across the same ±14-day window. */
  plBaseline: number;
};

export type DivergenceLiftResult = {
  /** Always populated when both baselines are positive. */
  ourLift: number;
  plLift: number;
  liftDelta: number;
  /** null when |deltaPct| <= 5% (cell is in agreement). */
  divergenceCause: DivergenceCause | null;
};

const AGREEMENT_THRESHOLD = 0.05;
const LIFT_DELTA_DEMAND_THRESHOLD = 0.05;
const LIFT_DELTA_MIXED_LOWER = 0.03;
const LIFT_AMPLITUDE_FOR_SIGN_FLIP = 0.05;

export function classifyDivergence(input: DivergenceLiftInput): DivergenceLiftResult | null {
  if (
    !Number.isFinite(input.ourRate) ||
    !Number.isFinite(input.plRate) ||
    !Number.isFinite(input.ourBaseline) ||
    !Number.isFinite(input.plBaseline)
  ) {
    return null;
  }
  if (input.ourBaseline <= 0 || input.plBaseline <= 0 || input.plRate <= 0) return null;

  const deltaPct = (input.ourRate - input.plRate) / input.plRate;
  const ourLift = (input.ourRate - input.ourBaseline) / input.ourBaseline;
  const plLift = (input.plRate - input.plBaseline) / input.plBaseline;
  const liftDelta = ourLift - plLift;

  // Agreement — don't classify
  if (Math.abs(deltaPct) <= AGREEMENT_THRESHOLD) {
    return { ourLift, plLift, liftDelta, divergenceCause: null };
  }

  const signFlip =
    Math.sign(ourLift) !== 0 &&
    Math.sign(plLift) !== 0 &&
    Math.sign(ourLift) !== Math.sign(plLift) &&
    Math.abs(ourLift) > LIFT_AMPLITUDE_FOR_SIGN_FLIP &&
    Math.abs(plLift) > LIFT_AMPLITUDE_FOR_SIGN_FLIP;

  const absLiftDelta = Math.abs(liftDelta);

  let divergenceCause: DivergenceCause;
  if (signFlip || absLiftDelta > LIFT_DELTA_DEMAND_THRESHOLD) {
    divergenceCause = "demand_disagreement";
  } else if (absLiftDelta >= LIFT_DELTA_MIXED_LOWER) {
    divergenceCause = "mixed";
  } else {
    divergenceCause = "level_disagreement";
  }

  return { ourLift, plLift, liftDelta, divergenceCause };
}

/**
 * Compute the median rate over a ±N-day window from a series of
 * `{ date, rate }` rows. Returns null when fewer than `minSampleSize`
 * non-null rates are inside the window.
 */
export function medianRateInWindow(
  rows: Array<{ date: string; rate: number | null }>,
  centerDateIso: string,
  windowDays: number,
  minSampleSize = 3
): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(centerDateIso)) return null;
  const centerMs = new Date(`${centerDateIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(centerMs)) return null;
  const halfMs = windowDays * 24 * 60 * 60 * 1000;
  const inWindow: number[] = [];
  for (const r of rows) {
    if (r.rate === null || !Number.isFinite(r.rate) || r.rate <= 0) continue;
    const ms = new Date(`${r.date}T00:00:00Z`).getTime();
    if (!Number.isFinite(ms)) continue;
    if (Math.abs(ms - centerMs) <= halfMs) inWindow.push(r.rate);
  }
  if (inWindow.length < minSampleSize) return null;
  const sorted = [...inWindow].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
