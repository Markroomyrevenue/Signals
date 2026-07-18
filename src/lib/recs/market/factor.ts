/**
 * Pure market-factor rules: one listing's MarketContext + one night → a
 * bounded depth modifier for that night's drop, with contribution text that
 * ALWAYS states the actual numbers + windows used.
 *
 * The market factor SCALES a drop the rest of the recs engine already
 * decided to make; it never creates one, and floors + the anti-ratchet cap
 * always bind after it (owner design 2026-07-18).
 *
 * Rule table (occ = marketOccNext30 as a fraction; ratio = myRate /
 * neighborhood median on the representative date):
 *
 * | # | Condition                                        | depthMultiplier                                   | holdBias |
 * |---|--------------------------------------------------|---------------------------------------------------|----------|
 * | 0 | no usable signal (no occ AND no ratio)           | 1.0 (neutral)                                     | false    |
 * | 1 | SOFT (occ < 0.55 OR ratio > 1.15) + behindCurve  | 1 + min(0.4, softOcc + softRatio), cap 1.4        | false    |
 * |   |   softOcc  = max(0, (0.55 − occ) × 2)            |                                                   |          |
 * |   |   softRatio = 0.2 when ratio > 1.15, else 0      |                                                   |          |
 * | 2 | SOFT + NOT behindCurve                           | 1.0 — a soft market alone never deepens a night   | false    |
 * |   |                                                  | that is still on its booking curve                |          |
 * | 3 | HOT (occ > 0.80 OR ratio < 0.90) + behindCurve   | 1 − min(0.4, hotOcc + hotRatio), floor 0.6        | true     |
 * |   |   hotOcc  = max(0, (occ − 0.80) × 2)             |                                                   |          |
 * |   |   hotRatio = 0.2 when ratio < 0.90, else 0       |                                                   |          |
 * | 4 | HOT + NOT behindCurve                            | 0.6 (strongest hold — nothing to chase)           | true     |
 * | 5 | MIXED (a soft indicator AND a hot indicator)     | 1.0 — conflicting reads never move a price        | false    |
 * | 6 | neither soft nor hot                             | 1.0                                               | false    |
 * | S | data older than STALE_AFTER_HOURS (48h)          | dampen halfway toward 1: m ← 1 + (m − 1) / 2,     | keep     |
 * |   |                                                  | staleness stated in the contribution              |          |
 * | B | always                                           | clamp to [0.6, 1.4]                               |          |
 */

import type { MarketContext, MarketFactor } from "./types";
import { neutralMarketFactor } from "./types";

export const SOFT_MARKET_OCC = 0.55;
export const HOT_MARKET_OCC = 0.8;
export const SOFT_PRICE_RATIO = 1.15;
export const HOT_PRICE_RATIO = 0.9;
export const DEPTH_MULTIPLIER_MIN = 0.6;
export const DEPTH_MULTIPLIER_MAX = 1.4;
/** How fast occupancy distance from the threshold scales the effect. */
export const OCC_SLOPE = 2;
/** Flat contribution of an out-of-band price ratio. */
export const RATIO_STEP = 0.2;
/** Signals older than this are dampened halfway toward neutral. */
export const STALE_AFTER_HOURS = 48;

/** The night the factor is being computed for (recs-engine fields). */
export type MarketFactorNight = {
  date: string; // yyyy-mm-dd
  myRate: number;
  expectedFill: number | null;
  scaledFill: number | null;
  /** The recs engine's own judgement that this night trails its curve. */
  behindCurve: boolean;
};

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;
const gbp = (value: number): string => `£${Math.round(value * 100) / 100}`;

const SOURCE_LABELS: Record<string, string> = {
  engine_snapshot: "engine snapshot",
  pl_neighborhood: "PriceLabs neighbourhood",
  wh_neighborhood: "Wheelhouse neighbourhood"
};

/** "engine snapshot, 14h old" / "PriceLabs neighbourhood, n=28 days". */
function provenance(ctx: MarketContext): string {
  const parts: string[] = [SOURCE_LABELS[ctx.source] ?? ctx.source];
  if (ctx.marketOccNext30?.n !== undefined) parts.push(`n=${ctx.marketOccNext30.n} days`);
  if (ctx.dataAgeHours !== null && ctx.dataAgeHours >= 1) parts.push(`${Math.round(ctx.dataAgeHours)}h old`);
  return parts.join(", ");
}

function clamp(value: number): number {
  return Math.min(DEPTH_MULTIPLIER_MAX, Math.max(DEPTH_MULTIPLIER_MIN, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Compute the bounded market factor for one night. Pure — everything it uses
 * is on the arguments, and the verbatim numbers land in `inputs`.
 */
export function computeMarketFactor(ctx: MarketContext, night: MarketFactorNight): MarketFactor {
  const occ = ctx.marketOccNext30?.value ?? null;
  const ratio = ctx.pricePosition?.ratio ?? null;

  // Rule 0 — no usable signal.
  if (occ === null && ratio === null) return neutralMarketFactor(ctx.source);

  const softOcc = occ !== null && occ < SOFT_MARKET_OCC;
  const softRatio = ratio !== null && ratio > SOFT_PRICE_RATIO;
  const hotOcc = occ !== null && occ > HOT_MARKET_OCC;
  const hotRatio = ratio !== null && ratio < HOT_PRICE_RATIO;
  const soft = softOcc || softRatio;
  const hot = hotOcc || hotRatio;

  const inputs: MarketFactor["inputs"] = {
    marketOccNext30: occ,
    myOccNext30: ctx.myOccNext30?.value ?? null,
    priceRatio: ratio,
    myRate: ctx.pricePosition?.myRate ?? null,
    neighborhoodMedian: ctx.pricePosition?.neighborhoodMedian ?? null,
    behindCurve: night.behindCurve,
    dataAgeHours: ctx.dataAgeHours,
    source: ctx.source
  };

  // The numbers, always stated (spec: never a bare percentage).
  const sentences: string[] = [];
  if (occ !== null) {
    const mine = ctx.myOccNext30 !== null ? ` vs your ${pct(ctx.myOccNext30.value)}` : "";
    sentences.push(`market occ next 30: ${pct(occ)} (${provenance(ctx)})${mine}`);
  }
  if (ctx.pricePosition !== null) {
    const p = ctx.pricePosition;
    const above = p.ratio >= 1 ? "above" : "below";
    const distance = pct(Math.abs(p.ratio - 1));
    sentences.push(
      `your ${gbp(p.myRate)} is ${distance} ${above} the neighbourhood median ${gbp(p.neighborhoodMedian)} (${p.date})`
    );
  }

  let multiplier = 1;
  let holdBias = false;
  let verdict: string;

  if (soft && hot) {
    // Rule 5 — mixed.
    verdict = "mixed market reads — no market adjustment";
  } else if (soft) {
    if (night.behindCurve) {
      // Rule 1.
      const occBoost = occ !== null ? Math.max(0, (SOFT_MARKET_OCC - occ) * OCC_SLOPE) : 0;
      const ratioBoost = softRatio ? RATIO_STEP : 0;
      multiplier = 1 + Math.min(DEPTH_MULTIPLIER_MAX - 1, occBoost + ratioBoost);
      verdict = "soft market and this night is behind curve; drop deepened";
    } else {
      // Rule 2.
      verdict = "soft market but this night is on its curve; no deepening";
    }
  } else if (hot) {
    holdBias = true;
    if (night.behindCurve) {
      // Rule 3.
      const occCut = occ !== null ? Math.max(0, (occ - HOT_MARKET_OCC) * OCC_SLOPE) : 0;
      const ratioCut = hotRatio ? RATIO_STEP : 0;
      multiplier = 1 - Math.min(1 - DEPTH_MULTIPLIER_MIN, occCut + ratioCut);
      verdict = "market is absorbing supply; drop held shallower";
    } else {
      // Rule 4.
      multiplier = DEPTH_MULTIPLIER_MIN;
      verdict = "hot market and this night is on its curve; hold";
    }
  } else {
    // Rule 6.
    verdict = "market reads neutral; no market adjustment";
  }

  // Rule S — staleness dampening (toward 1, never past it; bounds preserved).
  const stale = ctx.dataAgeHours !== null && ctx.dataAgeHours > STALE_AFTER_HOURS;
  if (stale) {
    multiplier = 1 + (multiplier - 1) / 2;
    sentences.push(`signal is ${Math.round(ctx.dataAgeHours as number)}h old — effect dampened`);
  }

  multiplier = round4(clamp(multiplier));

  return {
    depthMultiplier: multiplier,
    holdBias,
    contribution: `${sentences.join("; ")} — ${verdict}`,
    inputs,
    source: ctx.source
  };
}
