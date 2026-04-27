import type { MultiUnitOccupancyLeadTimeMatrix } from "@/lib/pricing/settings";

/**
 * Looks up the per-date adjustment percentage for a multi-unit listing.
 *
 * Lookup contract (per the seeded portfolio default):
 *   1. Pick the row whose `occupancyMaxPct` is the SMALLEST value >= the
 *      current occupancy %. (Carry-on-edge: occupancies above the highest
 *      defined row use the topmost row.)
 *   2. Within that row, pick the SMALLEST `leadTimeBucket` >= the lead-time
 *      days. (Carry-on-edge: lead times beyond the topmost bucket use it
 *      too.)
 *   3. Return the resulting integer as a percentage delta off the base
 *      (e.g. -8 means the recommended rate gets multiplied by 0.92).
 *
 * Inputs are clamped to `[0, 100]` for occupancy and `[0, +∞)` for lead time
 * so a malformed cell can't fall through the cracks. Returns 0 when the
 * matrix is missing or has zero rows / buckets — the caller is expected to
 * have a sensible default matrix already, but defensive zero is safer than
 * NaN.
 */
export function lookupMultiUnitOccupancyLeadTimeAdjustmentPct(params: {
  matrix: MultiUnitOccupancyLeadTimeMatrix;
  occupancyPct: number;
  leadTimeDays: number;
}): number {
  const { matrix, occupancyPct, leadTimeDays } = params;
  if (!matrix || !Array.isArray(matrix.rows) || matrix.rows.length === 0) return 0;
  if (!Array.isArray(matrix.leadTimeBuckets) || matrix.leadTimeBuckets.length === 0) return 0;

  const clampedOcc = clamp(Number.isFinite(occupancyPct) ? occupancyPct : 0, 0, 100);
  const clampedLead = Math.max(0, Number.isFinite(leadTimeDays) ? Math.round(leadTimeDays) : 0);

  // Sort rows ascending by occupancyMaxPct so the carry-on-edge semantics
  // match regardless of how the matrix was authored.
  const sortedRows = [...matrix.rows].sort((left, right) => left.occupancyMaxPct - right.occupancyMaxPct);
  const matchedRow = sortedRows.find((row) => clampedOcc <= row.occupancyMaxPct) ?? sortedRows[sortedRows.length - 1];
  if (!matchedRow) return 0;

  const sortedBuckets = [...matrix.leadTimeBuckets].sort((left, right) => left - right);
  const matchedBucket =
    sortedBuckets.find((bucket) => clampedLead <= bucket) ?? sortedBuckets[sortedBuckets.length - 1];
  if (matchedBucket === undefined) return 0;

  const value = matchedRow.leadTimeAdjustmentsPct[String(matchedBucket)];
  if (typeof value === "number" && Number.isFinite(value)) return value;

  // Source data may be sparse — fall back to the rightmost defined value in
  // the same row so we never silently drop to 0.
  for (let index = sortedBuckets.length - 1; index >= 0; index -= 1) {
    const bucket = sortedBuckets[index];
    if (bucket === undefined) continue;
    const candidate = matchedRow.leadTimeAdjustmentsPct[String(bucket)];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return 0;
}

/**
 * Build a recommended-base price for a multi-unit listing. Pure function —
 * does no I/O.
 *
 * Formula (per owner spec, 2026-04-25):
 *   weighted average of:
 *     - cached market benchmark   (0.30)
 *     - last-365d own ADR         (0.30)
 *     - peer-set ADR              (0.25)   ← multi-unit ONLY
 *     - size anchor               (0.15)
 *   then × quality multiplier, then rounded to the nearest rounding
 *   increment.
 *
 * Reweighting: if peer-set ADR is null, the remaining anchors get bumped to
 * (cached market 0.40, last-year 0.40, size 0.20) so the recommendation
 * still has structural grounding.
 *
 * If all anchors are null we return null — the caller (calendar assembly)
 * will fall through to its existing fallback path.
 */
export function buildMultiUnitRecommendedBase(params: {
  marketBenchmarkBasePrice: number | null;
  trailing365dAdr: number | null;
  peerSetAdr: number | null;
  sizeAnchor: number | null;
  qualityMultiplier?: number;
  roundingIncrement?: number;
}): { finalRecommendedBasePrice: number | null } {
  const market = sanitisePositive(params.marketBenchmarkBasePrice);
  const trailing = sanitisePositive(params.trailing365dAdr);
  const peer = sanitisePositive(params.peerSetAdr);
  const size = sanitisePositive(params.sizeAnchor);

  // Build the signal list with the active weights. The peer-set ADR is the
  // distinguishing multi-unit anchor — when it's missing we redistribute its
  // weight across the remaining anchors instead of letting the blend tilt
  // arbitrarily based on whichever inputs happen to be non-null.
  const signals: Array<{ value: number; weight: number }> = [];
  const peerAvailable = peer !== null;

  if (market !== null) signals.push({ value: market, weight: peerAvailable ? 0.3 : 0.4 });
  if (trailing !== null) signals.push({ value: trailing, weight: peerAvailable ? 0.3 : 0.4 });
  if (peerAvailable) signals.push({ value: peer, weight: 0.25 });
  if (size !== null) signals.push({ value: size, weight: peerAvailable ? 0.15 : 0.2 });

  let result: number | null = null;
  if (signals.length > 0) {
    const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
    if (totalWeight > 0) {
      result = roundTo2(
        signals.reduce((sum, signal) => sum + signal.value * signal.weight, 0) / totalWeight
      );
    }
  }

  const qualityMultiplier = sanitisePositive(params.qualityMultiplier ?? 1) ?? 1;
  if (result !== null && qualityMultiplier !== 1) {
    result = roundTo2(result * qualityMultiplier);
  }

  if (
    result !== null &&
    params.roundingIncrement !== undefined &&
    Number.isFinite(params.roundingIncrement) &&
    params.roundingIncrement > 1
  ) {
    result = roundTo2(Math.round(result / params.roundingIncrement) * params.roundingIncrement);
  }

  return { finalRecommendedBasePrice: result };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sanitisePositive(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}
