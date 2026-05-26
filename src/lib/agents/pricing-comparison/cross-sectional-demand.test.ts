import assert from "node:assert/strict";
import test from "node:test";

import {
  computeKdCrossSectionalDelta,
  computeOwnCrossSectionalDelta,
  DEMAND_PACE_MIN_PEER_FILL,
  KD_FAR_FUTURE_LEAD_DAYS,
  PEER_MIN_SAMPLE_SIZE,
  type PortfolioForwardFill
} from "./cross-sectional-demand";
import type { KeyDataForwardPace, KeyDataForwardPaceDay } from "@/lib/pricing/keydata-provider";

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

// ---------------------------------------------------------------------------
// 2026-05-26 PM — metric switch at KD_FAR_FUTURE_LEAD_DAYS
//
// At lead < threshold, the cross-sectional comparison reads
// `forwardRevparAdj` (pace metric — meaningful near-term). At lead >=
// threshold, it switches to `forwardAdrUnbooked` (calendar asking-
// rate — stays meaningful far-out where revpar_adj collapses).
// ---------------------------------------------------------------------------

function makeForwardDay(args: {
  date: string;
  rpa: number | null;
  unbooked: number | null;
  adr?: number;
  supply?: number | null;
}): KeyDataForwardPaceDay {
  return {
    date: args.date,
    forwardOccupancy: 0.5,
    forwardADR: args.adr ?? 200,
    forwardRevparAdj: args.rpa,
    forwardAdrUnbooked: args.unbooked,
    forwardBookingWindow: 30,
    marketSupplyCount: args.supply ?? 200,
    sampleSize: 1
  };
}

function makeForwardPace(rows: KeyDataForwardPaceDay[]): KeyDataForwardPace {
  return { perDate: rows, lastYearComparison: [], forwardBookingWindowMedian: 30 };
}

test("KD metric switch — pin KD_FAR_FUTURE_LEAD_DAYS to 75 per spec", () => {
  // Pinned: spec said 75 sits cleanly above the 60d region where
  // revpar_adj still works and below the 90d region where it has
  // fully collapsed. The constant is tunable but the trial assumes
  // this value.
  assert.equal(KD_FAR_FUTURE_LEAD_DAYS, 75);
});

test("KD metric switch — near-term lead (≤74d) uses revpar_adj", () => {
  // Snapshot 2026-05-26, target 2026-06-15 = 20 days lead → use revpar_adj.
  // Target rpa=120, peer rpa median=100 → +20% delta.
  // Adr_unbooked deliberately set to nonsense values that the
  // function should IGNORE at this lead.
  const sat = "2026-06-13"; // -2 from target Sat
  const sat2 = "2026-06-20"; // +5 from target Sat
  const sat3 = "2026-06-27"; // +12 from target Sat
  const target = "2026-06-15"; // Monday
  const mon1 = "2026-06-08"; // -7
  const mon2 = "2026-06-22"; // +7
  const mon3 = "2026-06-29"; // +14
  const fp = makeForwardPace([
    makeForwardDay({ date: target, rpa: 120, unbooked: 999 }), // target Mon
    makeForwardDay({ date: mon1, rpa: 100, unbooked: 1 }),     // peer Mon
    makeForwardDay({ date: mon2, rpa: 100, unbooked: 1 }),     // peer Mon
    makeForwardDay({ date: mon3, rpa: 100, unbooked: 1 }),     // peer Mon
    makeForwardDay({ date: sat, rpa: 50, unbooked: 50 }),      // Sat — excluded by DoW
    makeForwardDay({ date: sat2, rpa: 50, unbooked: 50 }),
    makeForwardDay({ date: sat3, rpa: 50, unbooked: 50 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp, snapshotIso: "2026-05-26" });
  assert.ok(r.revparDelta !== null);
  assert.ok(Math.abs(r.revparDelta! - 0.20) < 1e-6, `expected +20% from revpar_adj, got ${r.revparDelta}`);
  assert.equal(r.peerSampleSize, 3);
});

test("KD metric switch — far-future lead (≥75d) uses adr_unbooked", () => {
  // Snapshot 2026-05-26, target 2026-12-15 = 203 days lead → use adr_unbooked.
  // Target unbooked=240, peer unbooked median=200 → +20% delta.
  // revpar_adj deliberately collapsed to ~£0 (typical far-future
  // reality) — function should ignore it at this lead.
  const target = "2026-12-15"; // Tue
  const peer1 = "2026-12-08"; // Tue -7
  const peer2 = "2026-12-22"; // Tue +7
  const peer3 = "2026-12-29"; // Tue +14
  const fp = makeForwardPace([
    makeForwardDay({ date: target, rpa: 1.5, unbooked: 240 }),
    makeForwardDay({ date: peer1, rpa: 1.2, unbooked: 200 }),
    makeForwardDay({ date: peer2, rpa: 1.3, unbooked: 200 }),
    makeForwardDay({ date: peer3, rpa: 1.4, unbooked: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp, snapshotIso: "2026-05-26" });
  assert.ok(r.revparDelta !== null);
  // "revparDelta" field carries the metric-switched primary delta
  // — at this lead it's the adr_unbooked delta.
  assert.ok(Math.abs(r.revparDelta! - 0.20) < 1e-6, `expected +20% from adr_unbooked at far-future, got ${r.revparDelta}`);
  assert.equal(r.peerSampleSize, 3);
});

test("KD metric switch — far-future cell with null adr_unbooked → null delta (graceful neutral)", () => {
  // Target has no adr_unbooked → cannot use it. Function returns
  // null delta so the demand multiplier falls through to neutral
  // (avoids the calendar-holiday + own-pace path overriding with
  // a misleading KD signal).
  const target = "2026-12-15";
  const peer1 = "2026-12-08";
  const peer2 = "2026-12-22";
  const peer3 = "2026-12-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, rpa: 2.0, unbooked: null }),  // target missing unbooked
    makeForwardDay({ date: peer1, rpa: 1.2, unbooked: 200 }),
    makeForwardDay({ date: peer2, rpa: 1.3, unbooked: 200 }),
    makeForwardDay({ date: peer3, rpa: 1.4, unbooked: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp, snapshotIso: "2026-05-26" });
  assert.equal(r.revparDelta, null, "primary delta must be null when far-future target missing adr_unbooked");
  assert.equal(r.effectiveDelta, null);
});

test("KD metric switch — boundary at exactly 74d uses revpar_adj (below threshold)", () => {
  // Snapshot 2026-05-26 → target 2026-08-08 = 74 days. Should still
  // use revpar_adj (the boundary is ≥75 for asking-rate).
  const target = "2026-08-08"; // Sat
  const peer1 = "2026-08-01"; // Sat
  const peer2 = "2026-08-15"; // Sat
  const peer3 = "2026-08-22"; // Sat
  const fp = makeForwardPace([
    makeForwardDay({ date: target, rpa: 120, unbooked: 50 }),
    makeForwardDay({ date: peer1, rpa: 100, unbooked: 100 }),
    makeForwardDay({ date: peer2, rpa: 100, unbooked: 100 }),
    makeForwardDay({ date: peer3, rpa: 100, unbooked: 100 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp, snapshotIso: "2026-05-26" });
  // Used revpar_adj → +20% (not adr_unbooked which would be -50%).
  assert.ok(r.revparDelta !== null && r.revparDelta > 0, `expected positive (revpar_adj path), got ${r.revparDelta}`);
});

test("KD metric switch — boundary at exactly 75d uses adr_unbooked (at-or-above threshold)", () => {
  // Snapshot 2026-05-26 → target 2026-08-09 = 75 days. Switches.
  const target = "2026-08-09"; // Sun
  const peer1 = "2026-08-02"; // Sun
  const peer2 = "2026-08-16"; // Sun
  const peer3 = "2026-08-23"; // Sun
  const fp = makeForwardPace([
    makeForwardDay({ date: target, rpa: 200, unbooked: 240 }),
    makeForwardDay({ date: peer1, rpa: 100, unbooked: 200 }),
    makeForwardDay({ date: peer2, rpa: 100, unbooked: 200 }),
    makeForwardDay({ date: peer3, rpa: 100, unbooked: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp, snapshotIso: "2026-05-26" });
  // Used adr_unbooked → +20% (not revpar_adj which would be +100%).
  assert.ok(r.revparDelta !== null);
  assert.ok(Math.abs(r.revparDelta! - 0.20) < 1e-6, `expected +20% (adr_unbooked), got ${r.revparDelta}`);
});

test("KD metric switch — snapshotIso omitted → legacy revpar_adj path (backward compat)", () => {
  // Without snapshotIso, the function defaults to revpar_adj for
  // the whole range. Keeps existing tests / callers working without
  // requiring them to pass the snapshot date.
  const target = "2026-12-15";
  const peer1 = "2026-12-08";
  const peer2 = "2026-12-22";
  const peer3 = "2026-12-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, rpa: 120, unbooked: 240 }),
    makeForwardDay({ date: peer1, rpa: 100, unbooked: 200 }),
    makeForwardDay({ date: peer2, rpa: 100, unbooked: 200 }),
    makeForwardDay({ date: peer3, rpa: 100, unbooked: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp /* no snapshotIso */ });
  // Legacy path → revpar_adj → +20%.
  assert.ok(r.revparDelta !== null);
  assert.ok(Math.abs(r.revparDelta! - 0.20) < 1e-6);
});
