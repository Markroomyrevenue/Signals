/**
 * Divergence-cause classifier.
 *
 * For every cell where |delta| > 5% between our recommended rate and the
 * Hostaway live rate (= PriceLabs's output), this classifies WHY the two
 * engines disagree:
 *
 *   - demand_spike_caught: KeyData market data confirms a real demand
 *     spike on this date (BOTH occupancy YoY delta >= +15pp AND ADR YoY
 *     lift >= +15%) AND our rate is materially above PL. We caught the
 *     spike, PL didn't (or is being conservative). The "Fleadh detector".
 *   - demand_spike_missed: same verified market spike, but our rate is
 *     materially BELOW PL. PL caught the event, we didn't — money on
 *     the table. Equally important: tells us where own-history pricing
 *     misses event-driven demand.
 *   - occupancy_driven: the gap is explained by OUR occupancy-based
 *     multiplier — if we removed the occupancy lift we'd land inside the
 *     agreement band. Our model adapted to occupancy pressure via
 *     PRICING_OCCUPANCY_LADDER, PriceLabs didn't.
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

export type DivergenceCause =
  | "demand_disagreement"
  | "level_disagreement"
  | "mixed"
  | "occupancy_driven"
  | "demand_spike_caught"
  | "demand_spike_missed";

export type DivergenceLiftInput = {
  /** Our recommendation for the target date. */
  ourRate: number;
  /** PriceLabs' (Hostaway live) rate for the target date. */
  plRate: number;
  /** Our median recommendation across the ±14-day window for this listing. */
  ourBaseline: number;
  /** PriceLabs' median rate across the same ±14-day window. */
  plBaseline: number;
  /**
   * The occupancy multiplier our engine applied to this cell — pulled
   * from `breakdown.occupancy` in the trial-pricing result. When omitted
   * or 1.0 the classifier never returns `occupancy_driven`. This is the
   * "good sign" path: if our gap vs PriceLabs is fully explained by us
   * lifting/discounting on occupancy via PRICING_OCCUPANCY_LADDER, the
   * cell is labelled `occupancy_driven` rather than demand/level/mixed.
   */
  ourOccupancyMultiplier?: number | null;
  /**
   * KeyData forward occupancy for the target date (0-1). Together with
   * `marketForwardOccLy`, used to detect a year-over-year occupancy
   * spike. Demand-spike classification requires BOTH occupancy and ADR
   * to be elevated vs LY — see DEMAND_SPIKE_* thresholds.
   */
  marketForwardOcc?: number | null;
  /** Same date last year — KeyData market occupancy. */
  marketForwardOccLy?: number | null;
  /** KeyData forward ADR for the target date. */
  marketForwardAdr?: number | null;
  /** Same date last year — KeyData market ADR. */
  marketForwardAdrLy?: number | null;
  /**
   * KeyData "revpar_adj" — adjusted RevPar that filters outlier rates
   * and promo periods. More stable than raw ADR × occupancy for trend
   * detection. When supplied AND its LY counterpart is supplied, the
   * spike detector uses revpar_adj YoY in place of ADR YoY (which we
   * found to be too noisy on weekly market aggregates).
   */
  marketForwardRevparAdj?: number | null;
  marketForwardRevparAdjLy?: number | null;
  /**
   * KeyData average booking window (days) for the week this target date
   * falls into. Used together with `marketBookingWindowMedian` to detect
   * unusually-early booking pace — a leading indicator the spike
   * detector picks up even when occupancy hasn't yet materialised.
   */
  marketBookingWindow?: number | null;
  /**
   * Trailing-13-week median of avg_booking_window across the forward
   * KeyData range. The classifier flags `marketBookingWindow >= median * 1.25`
   * as an unusual early-pace signal.
   */
  marketBookingWindowMedian?: number | null;
};

export type DivergenceLiftResult = {
  /** Always populated when both baselines are positive. */
  ourLift: number;
  plLift: number;
  liftDelta: number;
  /** null when |deltaPct| <= 5% (cell is in agreement). */
  divergenceCause: DivergenceCause | null;
  /**
   * What our rate would be if we removed the occupancy multiplier.
   * Surfaced so the daily report can show "our occupancy lift accounts
   * for £X of this divergence". null when the multiplier wasn't supplied.
   */
  rateWithoutOccupancy: number | null;
  /**
   * Year-over-year market occupancy delta in percentage points
   * (occ - occLy). Positive = market is busier than this date LY.
   * null when either input is missing.
   */
  marketOccYoYDeltaPp: number | null;
  /**
   * Year-over-year market ADR lift as a fraction ((adr - adrLy) / adrLy).
   * Positive = market is charging more than this date LY. null when
   * either input is missing.
   */
  marketAdrYoYLift: number | null;
  /**
   * Year-over-year revpar_adj lift. When non-null, this is what the
   * spike detector actually evaluates (since revpar_adj is more stable
   * than raw ADR). The marketAdrYoYLift field is retained for reporting
   * transparency.
   */
  marketRevparAdjYoYLift: number | null;
  /**
   * True when the spike condition fires. Two paths:
   *   - "Strong": BOTH occ YoY and ADR YoY clear the strict thresholds
   *     (default +15pp / +15%). Backwards-compatible.
   *   - "Soft": booking-window lift ≥ +25% above its 13-wk median AND
   *     at least one of occ YoY ≥ +5pp or ADR YoY ≥ +5%. This is the
   *     early-pace signal — picks up event-driven dates whose weekly
   *     occupancy hasn't yet caught up to the booking momentum.
   * Either path produces demand_spike_caught/missed.
   */
  isDemandSpike: boolean;
  /**
   * Lift of booking window vs trailing median. `marketBookingWindow /
   * marketBookingWindowMedian` minus 1. Surfaced in the report so Mark
   * can see how strongly the leading signal fired. null when inputs
   * are missing.
   */
  bookingWindowLift: number | null;
};

const AGREEMENT_THRESHOLD = 0.05;
const LIFT_DELTA_DEMAND_THRESHOLD = 0.05;
const LIFT_DELTA_MIXED_LOWER = 0.03;
const LIFT_AMPLITUDE_FOR_SIGN_FLIP = 0.05;
/**
 * Only consider a cell "occupancy-driven" when the occupancy multiplier
 * was non-trivial — at least a 1.5pp adjustment off neutral (1.0).
 * Cells where occupancy was effectively neutral can't have been "caused"
 * by occupancy, so they stay in the demand/level/mixed buckets.
 */
const OCCUPANCY_MULTIPLIER_MEANINGFUL_DEVIATION = 0.015;
/**
 * Demand-spike detector thresholds. A target date is in a "market spike"
 * when BOTH the YoY occupancy delta and the YoY ADR lift clear these
 * bars — neither alone is enough (busy-but-cheap = supply contraction;
 * expensive-but-empty = pricing experiment, not real demand).
 *
 * +15pp on occupancy and +15% on ADR is a deliberately conservative
 * default — Belfast Fleadh-level dates run 30–50%+ on both, so this
 * catches them cleanly without firing on routine seasonality.
 */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
const DEMAND_SPIKE_OCC_YOY_THRESHOLD_PP = envFloat("KEYDATA_SPIKE_OCC_YOY_PP", 0.15);
const DEMAND_SPIKE_ADR_YOY_THRESHOLD_PCT = envFloat("KEYDATA_SPIKE_ADR_YOY_PCT", 0.15);
/**
 * Soft-spike thresholds — fire when booking_window is unusually elevated
 * vs its 13-week trailing median AND a moderate YoY signal is present.
 * Catches early-pace events where the weekly occupancy bucket hasn't
 * caught up yet.
 */
const DEMAND_SPIKE_BOOKING_WINDOW_LIFT_THRESHOLD = envFloat("KEYDATA_SPIKE_BW_LIFT", 0.25);
const DEMAND_SPIKE_SOFT_OCC_YOY_THRESHOLD_PP = envFloat("KEYDATA_SPIKE_SOFT_OCC_YOY_PP", 0.05);
const DEMAND_SPIKE_SOFT_ADR_YOY_THRESHOLD_PCT = envFloat("KEYDATA_SPIKE_SOFT_ADR_YOY_PCT", 0.05);

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

  // Compute the occupancy-stripped counterpart up-front. Used both for
  // the occupancy_driven check and surfaced in the result so reports can
  // show "your occupancy lift accounts for £X".
  const occMult =
    typeof input.ourOccupancyMultiplier === "number" && Number.isFinite(input.ourOccupancyMultiplier) && input.ourOccupancyMultiplier > 0
      ? input.ourOccupancyMultiplier
      : null;
  const rateWithoutOccupancy = occMult !== null ? input.ourRate / occMult : null;

  // Compute the demand-spike signals from KeyData market data. Both must
  // be present for the spike check to fire.
  const marketOcc = input.marketForwardOcc;
  const marketOccLy = input.marketForwardOccLy;
  const marketAdr = input.marketForwardAdr;
  const marketAdrLy = input.marketForwardAdrLy;
  const marketOccYoYDeltaPp =
    typeof marketOcc === "number" && Number.isFinite(marketOcc) &&
    typeof marketOccLy === "number" && Number.isFinite(marketOccLy)
      ? marketOcc - marketOccLy
      : null;
  const marketAdrYoYLift =
    typeof marketAdr === "number" && Number.isFinite(marketAdr) && marketAdr > 0 &&
    typeof marketAdrLy === "number" && Number.isFinite(marketAdrLy) && marketAdrLy > 0
      ? (marketAdr - marketAdrLy) / marketAdrLy
      : null;
  // Prefer revpar_adj YoY for the spike check when both sides are
  // present — it's more stable than raw ADR YoY. Fall back to ADR YoY
  // otherwise so the detector still works on tenants/markets where
  // KeyData doesn't return revpar_adj.
  const marketRevparAdj = input.marketForwardRevparAdj;
  const marketRevparAdjLy = input.marketForwardRevparAdjLy;
  const marketRevparAdjYoYLift =
    typeof marketRevparAdj === "number" && Number.isFinite(marketRevparAdj) && marketRevparAdj > 0 &&
    typeof marketRevparAdjLy === "number" && Number.isFinite(marketRevparAdjLy) && marketRevparAdjLy > 0
      ? (marketRevparAdj - marketRevparAdjLy) / marketRevparAdjLy
      : null;
  const adrSpikeMetric = marketRevparAdjYoYLift !== null ? marketRevparAdjYoYLift : marketAdrYoYLift;
  const bw = input.marketBookingWindow;
  const bwMed = input.marketBookingWindowMedian;
  const bookingWindowLift =
    typeof bw === "number" && Number.isFinite(bw) && bw > 0 &&
    typeof bwMed === "number" && Number.isFinite(bwMed) && bwMed > 0
      ? bw / bwMed - 1
      : null;

  const strongSpike =
    marketOccYoYDeltaPp !== null &&
    adrSpikeMetric !== null &&
    marketOccYoYDeltaPp >= DEMAND_SPIKE_OCC_YOY_THRESHOLD_PP &&
    adrSpikeMetric >= DEMAND_SPIKE_ADR_YOY_THRESHOLD_PCT;
  // Soft spike — booking window meaningfully above its 13-wk median AND
  // at least a modest YoY signal on one axis. The dual gate avoids
  // false positives from generic seasonality (booking windows naturally
  // grow with horizon; we still need SOME YoY corroboration).
  const softSpike =
    bookingWindowLift !== null &&
    bookingWindowLift >= DEMAND_SPIKE_BOOKING_WINDOW_LIFT_THRESHOLD &&
    ((marketOccYoYDeltaPp !== null && marketOccYoYDeltaPp >= DEMAND_SPIKE_SOFT_OCC_YOY_THRESHOLD_PP) ||
      (adrSpikeMetric !== null && adrSpikeMetric >= DEMAND_SPIKE_SOFT_ADR_YOY_THRESHOLD_PCT));
  const isDemandSpike = strongSpike || softSpike;

  const baseExtras = { rateWithoutOccupancy, marketOccYoYDeltaPp, marketAdrYoYLift, marketRevparAdjYoYLift, isDemandSpike, bookingWindowLift };

  // Agreement — don't classify
  if (Math.abs(deltaPct) <= AGREEMENT_THRESHOLD) {
    return { ourLift, plLift, liftDelta, divergenceCause: null, ...baseExtras };
  }

  // Demand-spike check, evaluated FIRST so Fleadh-style dates with a
  // real verifiable market spike get the proper label regardless of
  // what the lift comparison says. If our rate is materially above PL
  // on a spike date we "caught" it; if we're below PL we "missed" it
  // (PL caught it, we didn't — money on the table).
  if (isDemandSpike) {
    const cause: DivergenceCause = deltaPct > 0 ? "demand_spike_caught" : "demand_spike_missed";
    return { ourLift, plLift, liftDelta, divergenceCause: cause, ...baseExtras };
  }

  // Occupancy-driven check, evaluated BEFORE demand/level so cells with
  // a clean occupancy explanation don't get misclassified. Conditions:
  //   1. Our occupancy multiplier was meaningfully off neutral, AND
  //   2. Removing it would bring our rate inside the agreement band
  //      vs PL (i.e. |deltaWithoutOcc| <= 5%).
  // Owner's call: this is the "good sign" bucket — our model lifted /
  // discounted price for an occupancy reason PL didn't react to.
  if (occMult !== null && Math.abs(occMult - 1) >= OCCUPANCY_MULTIPLIER_MEANINGFUL_DEVIATION && rateWithoutOccupancy !== null) {
    const deltaWithoutOccPct = (rateWithoutOccupancy - input.plRate) / input.plRate;
    if (Math.abs(deltaWithoutOccPct) <= AGREEMENT_THRESHOLD) {
      return { ourLift, plLift, liftDelta, divergenceCause: "occupancy_driven", ...baseExtras };
    }
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

  return { ourLift, plLift, liftDelta, divergenceCause, ...baseExtras };
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
