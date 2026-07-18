/**
 * Recs-page drop sizing: "like Mark, but better" (DECISIONS.md 2026-07-18).
 *
 * The curve-based judgement in `observe/suggestions.ts` produces the BASE drop
 * (5-25%, untouched — its constants are not tuned here). This module composes
 * the final size for the 14-day recs window from four inputs, in order:
 *
 *   1. base   — the curve-derived drop (how far behind pace the night is);
 *   2. prior  — Mark's revealed sizing on this account (median episode drop per
 *               lead bucket, warm-started from ≥3%-move history). A PRIOR, not
 *               a target: weight scales with sample size, max 50%;
 *   3. dose   — measured drop outcomes vs matched controls (fill delta pp per
 *               lead×band cell). Evidence may push the size OUTSIDE Mark's
 *               habitual band — that is the product working, and the "why"
 *               says so — or shrink it where his drops measurably didn't land;
 *   4. market — the bounded market factor (soft market + behind curve →
 *               deeper; hot market → shallower or hold).
 *
 * Floors and the anti-ratchet cumulative cap ALWAYS bind downstream — this
 * module never sees or overrides them. Every component that fired is written
 * into `components` so the page can show an honest, decomposed "why" with
 * sample sizes, never manufactured confidence.
 */

import { leadBucketLabel } from "@/lib/observe/drop-outcomes";

export type MarkPriorBand = {
  /** Median drop fraction (0..1) of Mark's ≥3% episodes in this lead bucket. */
  medianDropPct: number;
  n: number;
  /** Human-readable evidence window, e.g. "since 2026-06-02". */
  window: string;
};

export type DoseResponseCell = {
  /** Fill delta (percentage points) of treated nights vs matched controls. */
  fillDeltaPp: number;
  n: number;
  /** The drop-size band the evidence covers, e.g. "7-15%". */
  band: string;
  /** Midpoint of the band as a fraction (e.g. 0.11 for 7-15%). */
  bandMidPct: number;
  /**
   * False when the cell carries no actual fill information (e.g. treated AND
   * control fill both 0%) or sits under the n bar — such cells are NAMED on
   * the page but never drive a resize. Default true for back-compat.
   */
  informative?: boolean;
};

export type SizingEvidence = {
  markPrior: MarkPriorBand | null;
  doseResponse: DoseResponseCell | null;
  provenance: "warm-start" | "live-observed";
};

export type MarketFactorInput = {
  depthMultiplier: number;
  holdBias: boolean;
  contribution: string;
};

export type ComposedSizing = {
  /** Final drop fraction (0..1). 0 means hold. */
  dropPct: number;
  hold: boolean;
  /** Plain-English decomposition, one line per component that fired. */
  components: string[];
};

/** Bounds for the composed size. The 25% ceiling of the base formula may be
 * exceeded when evidence + market justify it, but never past this cap; the
 * cumulative 25%/14d anti-ratchet and the min-price floor still bind after. */
export const RECS_MAX_SINGLE_DROP = 0.3;
export const RECS_MIN_DROP = 0.03;
/** Prior weight ramps with sample size and never exceeds this. */
export const MARK_PRIOR_MAX_WEIGHT = 0.5;
export const MARK_PRIOR_FULL_N = 20;
/** Dose-response cells thinner than this are context, not a sizing input. */
export const DOSE_MIN_N = 20;
/** A cell must beat controls by at least this many pp to justify deepening. */
export const DOSE_DEEPEN_MIN_PP = 5;

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

export function composeRecSizing(args: {
  baseDropPct: number;
  evidence: SizingEvidence | null;
  market: MarketFactorInput | null;
}): ComposedSizing {
  const components: string[] = [];
  let size = args.baseDropPct;
  components.push(`curve: behind pace → base drop ${pct(size)}`);

  const prior = args.evidence?.markPrior ?? null;
  if (prior && prior.n > 0 && prior.medianDropPct > 0) {
    const weight = Math.min(MARK_PRIOR_MAX_WEIGHT, (prior.n / MARK_PRIOR_FULL_N) * MARK_PRIOR_MAX_WEIGHT);
    const blended = size * (1 - weight) + prior.medianDropPct * weight;
    // Attribution-neutral by design: rate_changes has no source column, so a
    // mined "cut" may be the pricing engine's move rather than the operator's
    // (fidelity review 2026-07-18 — on engine-autoposting accounts "you
    // typically cut" would be factually false).
    components.push(
      `account prior: past cuts on this account ran ~${pct(prior.medianDropPct)} at this lead ` +
        `(n=${prior.n}, ${prior.window}; may include your pricing engine's own moves) → ${pct(blended)}`
    );
    size = blended;
  }

  const dose = args.evidence?.doseResponse ?? null;
  if (dose && (dose.informative ?? true) === false) {
    components.push(
      `evidence: outcome cells exist for this lead (${dose.band}, n=${dose.n}) but carry no usable fill signal — not used`
    );
  } else if (dose && dose.n >= DOSE_MIN_N) {
    if (dose.fillDeltaPp >= DOSE_DEEPEN_MIN_PP && dose.bandMidPct > size) {
      // Evidence says the deeper band landed: move halfway toward its midpoint.
      const deepened = size + (dose.bandMidPct - size) / 2;
      components.push(
        `evidence: ${dose.band} drops beat matched controls by ${dose.fillDeltaPp.toFixed(0)}pp fill ` +
          `(n=${dose.n}) → deepened to ${pct(deepened)}`
      );
      size = deepened;
    } else if (dose.fillDeltaPp <= 0) {
      const shrunk = size * 0.75;
      components.push(
        `evidence: ${dose.band} drops did NOT beat matched controls (${dose.fillDeltaPp.toFixed(0)}pp, n=${dose.n}) ` +
          `→ held shallower at ${pct(shrunk)}`
      );
      size = shrunk;
    } else {
      components.push(
        `evidence: ${dose.band} drops ran +${dose.fillDeltaPp.toFixed(0)}pp vs matched controls (n=${dose.n}) — not strong enough to resize`
      );
    }
  } else if (dose) {
    components.push(`evidence: too thin to size on (n=${dose.n} < ${DOSE_MIN_N}) — not used`);
  }

  if (args.market) {
    if (args.market.holdBias) {
      components.push(`market: ${args.market.contribution} → hold instead of drop`);
      return { dropPct: 0, hold: true, components };
    }
    if (args.market.depthMultiplier !== 1) {
      const adjusted = size * args.market.depthMultiplier;
      components.push(`market: ${args.market.contribution} → ${pct(adjusted)}`);
      size = adjusted;
    } else if (args.market.contribution) {
      components.push(`market: ${args.market.contribution}`);
    }
  }

  if (size < RECS_MIN_DROP) {
    components.push(`composed size ${pct(size)} below ${pct(RECS_MIN_DROP)} minimum — hold`);
    return { dropPct: 0, hold: true, components };
  }
  if (size > RECS_MAX_SINGLE_DROP) {
    components.push(`capped at single-night maximum ${pct(RECS_MAX_SINGLE_DROP)}`);
    size = RECS_MAX_SINGLE_DROP;
  }
  return { dropPct: size, hold: false, components };
}

/**
 * Lead-bucket key used to look up evidence for a night. Delegates to the
 * canonical `leadBucketLabel` (observe/drop-outcomes.ts → LEAD_TIME_BUCKETS:
 * 0-1 / 2-3 / 4-7 / 8-14 / 15-30 / 31-60 / 61-90 / 91+) so warm-start evidence
 * cells and sizing lookups always share one bucketing. Pure.
 */
export function sizingLeadBucket(daysToStay: number): string | null {
  return leadBucketLabel(daysToStay);
}
