/**
 * Run-of-dates grouping (Mark, 2026-07-19): "rather than 3 individual nights,
 * say these 3 nights go from £450 to £400" — with the system deciding the
 * per-night distribution.
 *
 * Grouping is a PRESENTATION + APPROVAL layer. Individual night rows remain
 * the atomic truth underneath: decision memory, ghost scoring, and engine
 * pushes are all per-night (the engines only accept per-date writes).
 * Approving a run approves its member nights; editing a run's total
 * redistributes proportionally; rejecting a run records each night.
 *
 * Rules (each decision carries its written reason):
 *  - Only PENDING DROP nights group; holds, actioned and pushed rows never do.
 *  - A run is ≥2 calendar-CONSECUTIVE nights on one listing (a booked or
 *    missing night breaks the run).
 *  - Weekday/weekend split is LEARNED, per listing, per generation — from the
 *    per-night day-of-week occupancy factors the generator judged with (Mark's
 *    "EO fills weekends late" is a hypothesis; the data decides, every time).
 *    When the weekend factors differ enough from the weekday ones, runs split
 *    at the boundary and the run says why. No signal → no split.
 *  - High-demand / odd nights stay INDIVIDUAL (the judgement call): a night
 *    whose current price or proposed drop stands well apart from its
 *    neighbours is pulled out of the run with the reason attached.
 *  - Presentation: when every night's drop is within tolerance of the same
 *    percentage, the run reads as "−10% across 3 nights"; otherwise as totals
 *    ("£450 → £400 across 3 nights").
 */

import type { RecsNightView } from "./data";

/** Fri + Sat nights are the weekend (same convention as the learnings). */
const WEEKEND_DOWS = new Set(["Fri", "Sat"]);
/** Mean weekend-vs-weekday occupancy-factor gap that triggers a split. */
export const WEEKEND_SPLIT_MIN_GAP = 0.15;
/** A night whose drop %-points deviate this much from the run median goes solo. */
export const SOLO_DROP_DEVIATION_PP = 8;
/** A night whose current price deviates this much (fraction) goes solo. */
export const SOLO_PRICE_DEVIATION = 0.25;
/** All drops within this of one % → present the run as a % drop. */
export const UNIFORM_PCT_TOLERANCE = 0.02;
export const MIN_RUN_NIGHTS = 2;

export type RecsRunView = {
  kind: "run";
  /** What the run recommends: sized drops or an explicit hold. */
  runKind: "drop" | "hold";
  listingId: string;
  suggestionIds: string[];
  dateFrom: string;
  dateTo: string;
  nightsCount: number;
  segment: "weekday" | "weekend" | "mixed";
  totalCurrent: number;
  totalProposed: number;
  /** Set when the run presents naturally as one percentage (negative). */
  uniformPct: number | null;
  /** Plain-English grouping decisions (split reason, solo pulls, framing). */
  why: string[];
  nights: RecsNightView[];
};

export type RunsResult = {
  runs: RecsRunView[];
  /** Suggestion ids that grouped into a run (UI hides their solo rows). */
  groupedIds: Set<string>;
  /** suggestionId → why the night was kept individual (shown as a chip). */
  soloReasons: Map<string, string>;
};

function isGroupableHold(night: RecsNightView): boolean {
  return (
    night.kind === "hold" &&
    night.status === "pending" &&
    night.suppressed === null &&
    night.currentPrice !== null &&
    night.currentPrice > 0
  );
}

function isGroupableDrop(night: RecsNightView): boolean {
  return (
    night.kind === "drop" &&
    night.status === "pending" &&
    night.suppressed === null &&
    night.currentPrice !== null &&
    night.recommendedPrice !== null &&
    night.currentPrice > 0
  );
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * The learned weekday/weekend read for one listing's candidate nights, from
 * the occupancy factors the generator judged each night with. Null = not
 * enough signal on both sides (→ no split).
 */
export function weekendSignal(nights: RecsNightView[]): { gap: number; note: string } | null {
  const weekend = nights.filter((n) => WEEKEND_DOWS.has(n.dow) && n.occFactor !== null).map((n) => n.occFactor as number);
  const weekday = nights.filter((n) => !WEEKEND_DOWS.has(n.dow) && n.occFactor !== null).map((n) => n.occFactor as number);
  const weekendMean = mean(weekend);
  const weekdayMean = mean(weekday);
  if (weekendMean === null || weekdayMean === null) return null;
  const gap = weekendMean - weekdayMean;
  if (Math.abs(gap) < WEEKEND_SPLIT_MIN_GAP) return null;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  return {
    gap,
    note:
      gap > 0
        ? `weekends here fill stronger than weekdays (${pct(weekendMean)} vs ${pct(weekdayMean)} typical occupancy) — split so each runs on its own pattern`
        : `weekends here fill later/weaker than weekdays (${pct(weekendMean)} vs ${pct(weekdayMean)} typical occupancy) — split so each runs on its own pattern`
  };
}

/** Group one listing's nights into runs + solos. Pure. */
export function buildListingRuns(nights: RecsNightView[]): RunsResult {
  const runs: RecsRunView[] = [];
  const groupedIds = new Set<string>();
  const soloReasons = new Map<string, string>();

  const candidates = nights.filter(isGroupableDrop).sort((a, b) => a.date.localeCompare(b.date));

  // 1. Consecutive-date chains.
  const chains: RecsNightView[][] = [];
  let current: RecsNightView[] = [];
  for (const night of candidates) {
    if (current.length === 0 || night.date === nextDay(current[current.length - 1].date)) {
      current.push(night);
    } else {
      chains.push(current);
      current = [night];
    }
  }
  if (current.length > 0) chains.push(current);

  const wkndSignal = weekendSignal(candidates);

  for (const chain of chains) {
    if (chain.length < MIN_RUN_NIGHTS) continue;

    // 2. Weekday/weekend split — only when the listing's data says they differ.
    const segments: RecsNightView[][] = [];
    if (wkndSignal) {
      let seg: RecsNightView[] = [];
      for (const night of chain) {
        const isWeekend = WEEKEND_DOWS.has(night.dow);
        const segIsWeekend = seg.length > 0 && WEEKEND_DOWS.has(seg[0].dow);
        if (seg.length === 0 || isWeekend === segIsWeekend) seg.push(night);
        else {
          segments.push(seg);
          seg = [night];
        }
      }
      if (seg.length > 0) segments.push(seg);
    } else {
      segments.push(chain);
    }

    for (const segment of segments) {
      if (segment.length < MIN_RUN_NIGHTS) continue;

      // 3. High-demand / odd nights go solo (the judgement call, explained).
      const dropPcts = segment.map((n) => Math.abs(n.changePct ?? 0) * 100);
      const prices = segment.map((n) => n.currentPrice as number);
      const medianDropPp = median(dropPcts);
      const medianPrice = median(prices);
      const keep: RecsNightView[] = [];
      for (const night of segment) {
        const dropPp = Math.abs(night.changePct ?? 0) * 100;
        const priceDev = medianPrice > 0 ? Math.abs((night.currentPrice as number) - medianPrice) / medianPrice : 0;
        if (Math.abs(dropPp - medianDropPp) > SOLO_DROP_DEVIATION_PP) {
          soloReasons.set(
            night.suggestionId,
            `kept individual: its sizing (−${dropPp.toFixed(0)}%) stands apart from the run's (−${medianDropPp.toFixed(0)}%)`
          );
        } else if (priceDev > SOLO_PRICE_DEVIATION) {
          soloReasons.set(
            night.suggestionId,
            `kept individual: priced well apart from the run (£${Math.round(night.currentPrice as number)} vs run median £${Math.round(medianPrice)}) — likely a demand date`
          );
        } else {
          keep.push(night);
        }
      }
      if (keep.length < MIN_RUN_NIGHTS) {
        // Not enough left to be a run — nothing groups here; solo notes stand.
        continue;
      }

      const totalCurrent = keep.reduce((s, n) => s + (n.currentPrice as number), 0);
      const totalProposed = keep.reduce((s, n) => s + (n.recommendedPrice as number), 0);
      const pcts = keep.map((n) => n.changePct ?? 0);
      const uniform = Math.max(...pcts) - Math.min(...pcts) <= UNIFORM_PCT_TOLERANCE ? mean(pcts) : null;
      const allWeekend = keep.every((n) => WEEKEND_DOWS.has(n.dow));
      const allWeekday = keep.every((n) => !WEEKEND_DOWS.has(n.dow));

      const why: string[] = [];
      if (wkndSignal && (allWeekend || allWeekday)) why.push(wkndSignal.note);
      if (uniform !== null) why.push(`all ${keep.length} nights size to ~${Math.round(Math.abs(uniform) * 100)}% — shown as one percentage`);
      else why.push(`nights sized individually toward the same goal — shown as totals`);

      runs.push({
        kind: "run",
        runKind: "drop",
        listingId: keep[0].listingId,
        suggestionIds: keep.map((n) => n.suggestionId),
        dateFrom: keep[0].date,
        dateTo: keep[keep.length - 1].date,
        nightsCount: keep.length,
        segment: allWeekend ? "weekend" : allWeekday ? "weekday" : "mixed",
        totalCurrent: Math.round(totalCurrent),
        totalProposed: Math.round(totalProposed),
        uniformPct: uniform,
        why,
        nights: keep
      });
      for (const n of keep) groupedIds.add(n.suggestionId);
    }
  }

  // Hold runs (Mark, 2026-07-19): consecutive on-pace holds collapse into one
  // item — approving records the hold decision on every night (no pushes;
  // recommended = current). Suppressed holds keep their individual rows (each
  // carries its own held-back reason). No weekend split — the recommendation
  // is identical either side of it.
  const holdCandidates = nights.filter(isGroupableHold).sort((a, b) => a.date.localeCompare(b.date));
  let holdChain: RecsNightView[] = [];
  const flushHoldChain = (): void => {
    if (holdChain.length >= MIN_RUN_NIGHTS) {
      const total = Math.round(holdChain.reduce((s, n) => s + (n.currentPrice as number), 0));
      const allWeekend = holdChain.every((n) => WEEKEND_DOWS.has(n.dow));
      const allWeekday = holdChain.every((n) => !WEEKEND_DOWS.has(n.dow));
      runs.push({
        kind: "run",
        runKind: "hold",
        listingId: holdChain[0].listingId,
        suggestionIds: holdChain.map((n) => n.suggestionId),
        dateFrom: holdChain[0].date,
        dateTo: holdChain[holdChain.length - 1].date,
        nightsCount: holdChain.length,
        segment: allWeekend ? "weekend" : allWeekday ? "weekday" : "mixed",
        totalCurrent: total,
        totalProposed: total,
        uniformPct: null,
        why: [`all ${holdChain.length} nights are on pace — no change needed; one decision covers the run`],
        nights: holdChain
      });
      for (const n of holdChain) groupedIds.add(n.suggestionId);
    }
    holdChain = [];
  };
  for (const night of holdCandidates) {
    if (holdChain.length === 0 || night.date === nextDay(holdChain[holdChain.length - 1].date)) {
      holdChain.push(night);
    } else {
      flushHoldChain();
      holdChain = [night];
    }
  }
  flushHoldChain();

  runs.sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));

  return { runs, groupedIds, soloReasons };
}

// ---------------------------------------------------------------------------
// Edited-total distribution
// ---------------------------------------------------------------------------

export type RunDistribution = {
  prices: Map<string, number>;
  /** Notes about clamps that shifted the split (floors binding etc.). */
  notes: string[];
  total: number;
};

/**
 * Distribute an edited run TOTAL across its nights: keep each night's relative
 * share of the proposed total, round to whole pounds, and put the rounding
 * remainder on the most expensive night. An edited total is a TYPED price —
 * the operator's call — so floors do NOT clamp the split (Mark, 2026-07-20);
 * nights that land below their floor are named in the notes instead. The
 * per-night fat-finger bound in approveSuggestion remains the hard guard.
 * Pure.
 */
export function distributeRunTotal(
  nights: Array<{
    suggestionId: string;
    proposed: number;
    floor: number | null;
    allowBelowFloor: boolean;
  }>,
  editedTotal: number
): RunDistribution {
  const notes: string[] = [];
  const proposedTotal = nights.reduce((s, n) => s + n.proposed, 0);
  if (!(editedTotal > 0) || !(proposedTotal > 0) || nights.length === 0) {
    return { prices: new Map(), notes: ["invalid total"], total: 0 };
  }
  const scale = editedTotal / proposedTotal;
  const prices = new Map<string, number>();
  for (const night of nights) {
    prices.set(night.suggestionId, Math.max(1, Math.round(night.proposed * scale)));
  }
  // Rounding remainder: nudge the most expensive night so the total lands
  // exactly on the typed figure.
  const sum = [...prices.values()].reduce((s, v) => s + v, 0);
  const remainder = Math.round(editedTotal - sum);
  if (remainder !== 0) {
    const adjustable = [...nights]
      .filter((n) => (prices.get(n.suggestionId) as number) + remainder >= 1)
      .sort((a, b) => (prices.get(b.suggestionId) as number) - (prices.get(a.suggestionId) as number));
    if (adjustable.length > 0) {
      const target = adjustable[0];
      prices.set(target.suggestionId, (prices.get(target.suggestionId) as number) + remainder);
    }
  }
  const belowFloor = nights.filter(
    (n) => n.floor !== null && (prices.get(n.suggestionId) as number) < n.floor
  );
  for (const night of belowFloor) {
    notes.push(
      `£${prices.get(night.suggestionId)} sits below the £${Math.ceil(night.floor as number)} floor — your call`
    );
  }
  const total = [...prices.values()].reduce((s, v) => s + v, 0);
  return { prices, notes, total };
}
