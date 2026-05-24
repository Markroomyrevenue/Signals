import assert from "node:assert/strict";
import test from "node:test";

import {
  computeKdCrossSectionalDelta,
  computeOwnCrossSectionalDelta,
  DEMAND_PACE_MIN_PEER_FILL,
  PEER_MIN_SAMPLE_SIZE,
  type PortfolioForwardFill
} from "./cross-sectional-demand";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fillFromFractions(args: {
  supply: number;
  fromIso: string;
  toIso: string;
  perDate: Array<{ date: string; fill: number }>;
}): PortfolioForwardFill {
  const nightsByDate = new Map<string, number>();
  for (const { date, fill } of args.perDate) {
    nightsByDate.set(date, Math.round(fill * args.supply));
  }
  return { nightsByDate, supply: args.supply, fromIso: args.fromIso, toIso: args.toIso };
}

// ---------------------------------------------------------------------------
// computeOwnCrossSectionalDelta — peer-count gate (pre-existing)
// ---------------------------------------------------------------------------

test("computeOwnCrossSectionalDelta — peer count below PEER_MIN_SAMPLE_SIZE → delta null", () => {
  // Only 5 peers in same month → below 8-gate.
  const fill = fillFromFractions({
    supply: 10,
    fromIso: "2026-06-01",
    toIso: "2026-06-30",
    perDate: [
      { date: "2026-06-15", fill: 0.50 }, // target
      { date: "2026-06-10", fill: 0.60 },
      { date: "2026-06-11", fill: 0.55 },
      { date: "2026-06-12", fill: 0.65 },
      { date: "2026-06-13", fill: 0.60 },
      { date: "2026-06-14", fill: 0.50 }
      // 5 peers — below gate.
    ]
  });
  const result = computeOwnCrossSectionalDelta({ targetIso: "2026-06-15", fill });
  assert.equal(result.delta, null);
  assert.equal(result.peerSampleSize, 5);
  assert.ok(result.peerSampleSize < PEER_MIN_SAMPLE_SIZE);
});

// ---------------------------------------------------------------------------
// computeOwnCrossSectionalDelta — Phase B sufficiency gate (2026-05-24)
// ---------------------------------------------------------------------------

test("computeOwnCrossSectionalDelta — sufficient peer fill → delta returned", () => {
  // peerMedianFill = 0.40, target = 0.60 → delta = 0.50 (+50%)
  // Above DEMAND_PACE_MIN_PEER_FILL (0.15) so delta passes through.
  const perDate: Array<{ date: string; fill: number }> = [];
  perDate.push({ date: "2026-06-15", fill: 0.60 });
  for (let i = 0; i < 12; i++) {
    perDate.push({ date: `2026-06-${(i + 1).toString().padStart(2, "0")}`, fill: 0.40 });
  }
  const fill = fillFromFractions({ supply: 10, fromIso: "2026-06-01", toIso: "2026-06-30", perDate });
  const result = computeOwnCrossSectionalDelta({ targetIso: "2026-06-15", fill });
  assert.ok(result.delta !== null, "delta should not be null on sufficient fill");
  assert.ok(Math.abs((result.delta as number) - 0.5) < 0.01, `expected ~+50% delta, got ${result.delta}`);
  assert.ok((result.peerMedianFill as number) >= DEMAND_PACE_MIN_PEER_FILL);
});

test("computeOwnCrossSectionalDelta — thin peer fill (<DEMAND_PACE_MIN_PEER_FILL) → delta null, multiplier falls back neutral", () => {
  // Far-future pattern: 12 same-month peers, each with 1 night on books out
  // of 10 supply = 10% fill — below the 15% gate. Target has 2 nights = 20% fill.
  // Without the gate this would produce delta = 0.20/0.10 - 1 = +100%, pinning
  // the demand multiplier at +40% ceiling. The gate returns null so the
  // multiplier falls back to neutral instead.
  const perDate: Array<{ date: string; fill: number }> = [];
  perDate.push({ date: "2026-12-15", fill: 0.20 }); // target: 2/10
  for (let i = 0; i < 12; i++) {
    perDate.push({ date: `2026-12-${(i + 1).toString().padStart(2, "0")}`, fill: 0.10 });
  }
  const fill = fillFromFractions({ supply: 10, fromIso: "2026-12-01", toIso: "2026-12-31", perDate });
  const result = computeOwnCrossSectionalDelta({ targetIso: "2026-12-15", fill });
  assert.equal(result.delta, null, "delta should be null when peer median fill is below the gate");
  assert.ok((result.peerMedianFill as number) < DEMAND_PACE_MIN_PEER_FILL);
  // Peer sample size IS sufficient (12 > 8) — the gate fires on FILL DENSITY, not peer count.
  assert.ok(result.peerSampleSize >= PEER_MIN_SAMPLE_SIZE);
});

test("computeOwnCrossSectionalDelta — exactly at DEMAND_PACE_MIN_PEER_FILL → delta returned (boundary)", () => {
  // peerMedianFill = exactly 15% (the gate value). Inclusive boundary
  // — gate is `< DEMAND_PACE_MIN_PEER_FILL`, so exactly at the gate
  // passes.
  const perDate: Array<{ date: string; fill: number }> = [];
  perDate.push({ date: "2026-06-15", fill: 0.20 });
  for (let i = 0; i < 12; i++) {
    perDate.push({ date: `2026-06-${(i + 1).toString().padStart(2, "0")}`, fill: DEMAND_PACE_MIN_PEER_FILL });
  }
  const fill = fillFromFractions({ supply: 100, fromIso: "2026-06-01", toIso: "2026-06-30", perDate });
  const result = computeOwnCrossSectionalDelta({ targetIso: "2026-06-15", fill });
  assert.ok(result.delta !== null, "exactly at gate should pass (inclusive)");
});

test("computeOwnCrossSectionalDelta — zero supply → null without NaN", () => {
  const fill: PortfolioForwardFill = {
    nightsByDate: new Map(),
    supply: 0,
    fromIso: "2026-06-01",
    toIso: "2026-06-30"
  };
  const result = computeOwnCrossSectionalDelta({ targetIso: "2026-06-15", fill });
  assert.equal(result.delta, null);
  assert.equal(result.targetFill, null);
  assert.equal(result.peerMedianFill, null);
});

// ---------------------------------------------------------------------------
// computeKdCrossSectionalDelta — sanity (peer-count gate)
// ---------------------------------------------------------------------------

test("computeKdCrossSectionalDelta — null forwardPace → empty result, no NaN", () => {
  const result = computeKdCrossSectionalDelta({
    targetIso: "2026-06-15",
    forwardPace: null
  });
  assert.equal(result.revparDelta, null);
  assert.equal(result.effectiveDelta, null);
  assert.equal(result.supplyGuardTriggered, false);
  assert.equal(result.peerSampleSize, 0);
});
