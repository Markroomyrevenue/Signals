import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOKING_WINDOW_BONUS_CAP,
  BOOKING_WINDOW_BONUS_GATE,
  computeKdCrossSectionalDelta,
  computeOwnCrossSectionalDelta,
  DEMAND_PACE_MIN_PEER_FILL,
  KD_FAR_FUTURE_LEAD_DAYS,
  PEER_MIN_SAMPLE_SIZE,
  SUPPLY_GUARD_ADR_UNBOOKED_BYPASS,
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
// 2026-05-27 PM — always-on adr_unbooked + booking-window corroborator
//
// adr_unbooked is now the primary KD cross-sectional metric at every
// lead time (was: revpar_adj <75d / adr_unbooked ≥75d switch).
// `forwardRevparAdj` is still parsed and exposed (for the supply
// guard's adrDelta input + the diagnostic targetRevparAdj field) but
// no longer drives the primary delta.
//
// Booking-window corroborator (`forwardBookingWindow`) adds a bonus
// to the effective delta when BOTH:
//   - primary (adr_unbooked) delta is positive, AND
//   - booking-window delta > BOOKING_WINDOW_BONUS_GATE.
// Bonus = min(BOOKING_WINDOW_BONUS_CAP, bookingWindowDelta × 0.5).
// Never subtracts.
// ---------------------------------------------------------------------------

function makeForwardDay(args: {
  date: string;
  rpa?: number | null;
  unbooked: number | null;
  adr?: number;
  supply?: number | null;
  bookingWindow?: number | null;
}): KeyDataForwardPaceDay {
  return {
    date: args.date,
    forwardOccupancy: 0.5,
    forwardADR: args.adr ?? 200,
    forwardRevparAdj: args.rpa ?? 1.0,
    forwardAdrUnbooked: args.unbooked,
    forwardBookingWindow: args.bookingWindow ?? 30,
    marketSupplyCount: args.supply ?? 200,
    sampleSize: 1
  };
}

function makeForwardPace(rows: KeyDataForwardPaceDay[]): KeyDataForwardPace {
  return { perDate: rows, lastYearComparison: [], forwardBookingWindowMedian: 30 };
}

test("KD always-on adr_unbooked — KD_FAR_FUTURE_LEAD_DAYS retired (now 0)", () => {
  // 2026-05-27 PM: the 75d lead-time switch was retired in favour
  // of always-on adr_unbooked. Constant kept (set to 0) for callers
  // / tests that still reference it; the function no longer reads
  // it. Safe to delete once downstream usages have been audited.
  assert.equal(KD_FAR_FUTURE_LEAD_DAYS, 0);
});

test("KD always-on adr_unbooked — near-term lead uses adr_unbooked (not revpar_adj)", () => {
  // 20-day lead: prior behaviour was revpar_adj, new behaviour is
  // adr_unbooked. Set revpar_adj to a nonsense value that would
  // give a wildly different delta to prove the function ignores it.
  const target = "2026-06-15"; // Mon
  const peer1 = "2026-06-08"; // Mon -7
  const peer2 = "2026-06-22"; // Mon +7
  const peer3 = "2026-06-29"; // Mon +14
  const fp = makeForwardPace([
    // Target: rpa=999 (would give +900% if used), unbooked=240
    makeForwardDay({ date: target, rpa: 999, unbooked: 240 }),
    makeForwardDay({ date: peer1, rpa: 100, unbooked: 200 }),
    makeForwardDay({ date: peer2, rpa: 100, unbooked: 200 }),
    makeForwardDay({ date: peer3, rpa: 100, unbooked: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp, snapshotIso: "2026-05-26" });
  assert.ok(r.revparDelta !== null);
  // adr_unbooked path: 240/200-1 = +20%. NOT +900% (revpar_adj path).
  assert.ok(Math.abs(r.revparDelta! - 0.20) < 1e-6, `expected +20% from adr_unbooked (always-on), got ${r.revparDelta}`);
  assert.equal(r.peerSampleSize, 3);
});

test("KD always-on adr_unbooked — far-future lead also uses adr_unbooked (unchanged from prior)", () => {
  // 200+ day lead: same metric. Pinning that the switch didn't go
  // the wrong way for any caller that's now passing snapshotIso.
  const target = "2026-12-15"; // Tue
  const peer1 = "2026-12-08";
  const peer2 = "2026-12-22";
  const peer3 = "2026-12-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, rpa: 1.5, unbooked: 240 }),
    makeForwardDay({ date: peer1, rpa: 1.2, unbooked: 200 }),
    makeForwardDay({ date: peer2, rpa: 1.3, unbooked: 200 }),
    makeForwardDay({ date: peer3, rpa: 1.4, unbooked: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp, snapshotIso: "2026-05-26" });
  assert.ok(r.revparDelta !== null);
  assert.ok(Math.abs(r.revparDelta! - 0.20) < 1e-6, `expected +20% from adr_unbooked, got ${r.revparDelta}`);
});

test("KD always-on adr_unbooked — null target adr_unbooked → null delta (graceful neutral)", () => {
  // Target missing adr_unbooked → cannot compute primary → null
  // delta, the multiplier falls through to neutral. Holds at every
  // lead (no longer just far-future).
  const target = "2026-06-15"; // 20-day lead
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, rpa: 200, unbooked: null }), // target missing unbooked
    makeForwardDay({ date: peer1, rpa: 100, unbooked: 200 }),
    makeForwardDay({ date: peer2, rpa: 100, unbooked: 200 }),
    makeForwardDay({ date: peer3, rpa: 100, unbooked: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp, snapshotIso: "2026-05-26" });
  assert.equal(r.revparDelta, null, "primary delta must be null when target missing adr_unbooked at any lead");
  assert.equal(r.effectiveDelta, null);
});

test("KD always-on adr_unbooked — snapshotIso omitted still uses adr_unbooked (backward compat)", () => {
  // Without snapshotIso, the function still uses adr_unbooked
  // (the always-on path). snapshotIso is now ignored.
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
  // adr_unbooked → +20%.
  assert.ok(r.revparDelta !== null);
  assert.ok(Math.abs(r.revparDelta! - 0.20) < 1e-6);
});

// ---------------------------------------------------------------------------
// Booking-window corroborator
// ---------------------------------------------------------------------------

test("booking-window corroborator — gate + cap pinned per spec", () => {
  assert.equal(BOOKING_WINDOW_BONUS_GATE, 0.15);
  assert.equal(BOOKING_WINDOW_BONUS_CAP, 0.10);
});

test("booking-window corroborator — fires when adr_unbooked positive AND booking-window positive + above gate", () => {
  // Target +20% adr_unbooked, +30% booking-window (well above
  // 15% gate). Corroborator should fire and add +0.10 to effective
  // delta (capped at 0.10; raw bonus = 0.30 × 0.5 = 0.15 → capped).
  const target = "2026-06-15"; // Mon
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, unbooked: 240, bookingWindow: 39 }),  // bw +30%
    makeForwardDay({ date: peer1, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer2, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer3, unbooked: 200, bookingWindow: 30 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.bookingWindowCorroboratorTriggered, true);
  // Bonus capped at 0.10 (raw 0.15 → cap fires).
  assert.equal(r.bookingWindowBonus, 0.10);
  // effectiveDelta = revparDelta (0.20) + bonus (0.10) = 0.30.
  assert.ok(Math.abs(r.effectiveDelta! - 0.30) < 1e-6, `expected effective +30%, got ${r.effectiveDelta}`);
});

test("booking-window corroborator — bonus capped at +0.10 even when half-bw-delta exceeds cap", () => {
  // booking-window delta = +1.00 (100% earlier). raw bonus =
  // 1.00 × 0.5 = 0.50, capped at 0.10.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, unbooked: 240, bookingWindow: 60 }), // bw +100%
    makeForwardDay({ date: peer1, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer2, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer3, unbooked: 200, bookingWindow: 30 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.bookingWindowCorroboratorTriggered, true);
  assert.equal(r.bookingWindowBonus, BOOKING_WINDOW_BONUS_CAP);
});

test("booking-window corroborator — does NOT fire when booking-window short (below gate)", () => {
  // booking-window delta = +10% (below 15% gate). No bonus added.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, unbooked: 240, bookingWindow: 33 }), // bw +10% (sub-gate)
    makeForwardDay({ date: peer1, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer2, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer3, unbooked: 200, bookingWindow: 30 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.bookingWindowCorroboratorTriggered, false);
  assert.equal(r.bookingWindowBonus, 0);
  // effectiveDelta = revparDelta only.
  assert.ok(Math.abs(r.effectiveDelta! - 0.20) < 1e-6, `expected +20% (no bonus), got ${r.effectiveDelta}`);
});

test("booking-window corroborator — does NOT subtract when booking-window short and adr_unbooked positive", () => {
  // booking-window delta = -50% (people booking later than usual).
  // adr_unbooked +20%. Corroborator NEVER subtracts. effectiveDelta
  // should match revparDelta exactly.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, unbooked: 240, bookingWindow: 15 }), // bw -50%
    makeForwardDay({ date: peer1, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer2, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer3, unbooked: 200, bookingWindow: 30 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.bookingWindowCorroboratorTriggered, false);
  assert.equal(r.bookingWindowBonus, 0);
  // effectiveDelta = revparDelta (negative bw does NOT pull it down).
  assert.ok(Math.abs(r.effectiveDelta! - 0.20) < 1e-6, `expected +20% (negative bw ignored), got ${r.effectiveDelta}`);
});

test("booking-window corroborator — does NOT fire when adr_unbooked negative (no double-confirmation)", () => {
  // adr_unbooked -20% (target priced below peers). booking-window
  // +50% (above gate). Corroborator should NOT fire because primary
  // is negative — corroborator only adds confidence to positive
  // signals, never amplifies downside.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, unbooked: 160, bookingWindow: 45 }), // unbooked -20%, bw +50%
    makeForwardDay({ date: peer1, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer2, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer3, unbooked: 200, bookingWindow: 30 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.bookingWindowCorroboratorTriggered, false);
  assert.equal(r.bookingWindowBonus, 0);
  // effectiveDelta = revparDelta unchanged (-20%).
  assert.ok(Math.abs(r.effectiveDelta! - (-0.20)) < 1e-6, `expected -20% (no positive corroboration on downside), got ${r.effectiveDelta}`);
});

test("booking-window corroborator — diagnostic fields populated even when corroborator doesn't fire", () => {
  // bookingWindowDelta should be computed and exposed even when the
  // gate isn't cleared, so diagnostics can show what the signal
  // was. Pin: delta computed, triggered=false, bonus=0.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, unbooked: 240, bookingWindow: 33 }), // bw +10% (sub-gate)
    makeForwardDay({ date: peer1, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer2, unbooked: 200, bookingWindow: 30 }),
    makeForwardDay({ date: peer3, unbooked: 200, bookingWindow: 30 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.ok(r.bookingWindowDelta !== null);
  assert.ok(Math.abs(r.bookingWindowDelta! - 0.10) < 1e-6, `expected +10% bw delta, got ${r.bookingWindowDelta}`);
  assert.equal(r.targetBookingWindow, 33);
  assert.equal(r.peerMedianBookingWindow, 30);
  assert.equal(r.bookingWindowCorroboratorTriggered, false);
  assert.equal(r.bookingWindowBonus, 0);
});

// ---------------------------------------------------------------------------
// 2026-05-27 PM — supply-guard adr_unbooked bypass
//
// Pre-2026-05-27 PM the guard fired on supply contracted + booked-ADR
// flat. Now it requires a third condition: adr_unbooked also below
// the SUPPLY_GUARD_ADR_UNBOOKED_BYPASS threshold (0.15). When the
// market is asking ≥15% above peer median for unbooked inventory,
// the supply contraction is genuine demand, not a fire-sale artefact.
//
// Canonical failure case: Aug 22 Sat (Fleadh) — supply -36.8%,
// booked ADR -3.1%, adr_unbooked +25.7%. Old guard fires → corroborated
// demand erased. New guard bypassed → demand flows through.
// ---------------------------------------------------------------------------

test("supply-guard bypass — pin SUPPLY_GUARD_ADR_UNBOOKED_BYPASS = 0.15 per spec", () => {
  assert.equal(SUPPLY_GUARD_ADR_UNBOOKED_BYPASS, 0.15);
});

test("supply-guard bypass — all three conditions hit → guard fires (damp)", () => {
  // Pre-bypass logic: supply -25%, booked ADR +2% (flat-ish, sub-5%),
  // adr_unbooked +5% (sub-15% bypass threshold). All three legs hit
  // → guard fires → effective delta damped to 0 (ADR is +2%, so adrFloor
  // = max(0.02, 0) × 2 = 0.04; min(adr_unbooked +0.05, 0.04) = 0.04).
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    // Target: unbooked 210/peer-200 = +5%; adr 204/peer-200 = +2%; supply 150/peer-200 = -25%
    makeForwardDay({ date: target, unbooked: 210, adr: 204, supply: 150 }),
    makeForwardDay({ date: peer1, unbooked: 200, adr: 200, supply: 200 }),
    makeForwardDay({ date: peer2, unbooked: 200, adr: 200, supply: 200 }),
    makeForwardDay({ date: peer3, unbooked: 200, adr: 200, supply: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.supplyGuardTriggered, true, "guard must fire when all 3 legs hit");
  assert.equal(r.supplyGuardBypassedByAdrUnbooked, false);
  // adr_unbooked raw = +5%, but damped to adrFloor = +4% by the guard.
  assert.ok(r.effectiveDelta !== null);
  assert.ok(Math.abs(r.effectiveDelta! - 0.04) < 1e-6, `expected effective +4% (damped), got ${r.effectiveDelta}`);
});

test("supply-guard bypass — adr_unbooked >= 15% blocks guard even with supply + ADR conditions met", () => {
  // The Aug 22 Sat canonical case: supply -37%, booked ADR -3%, but
  // adr_unbooked +26% (clearly above the 15% bypass threshold). Old
  // guard would fire and erase demand; new guard is BYPASSED.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    // Target: unbooked 252/peer-200 = +26%; adr 194/peer-200 = -3%; supply 126/peer-200 = -37%
    makeForwardDay({ date: target, unbooked: 252, adr: 194, supply: 126 }),
    makeForwardDay({ date: peer1, unbooked: 200, adr: 200, supply: 200 }),
    makeForwardDay({ date: peer2, unbooked: 200, adr: 200, supply: 200 }),
    makeForwardDay({ date: peer3, unbooked: 200, adr: 200, supply: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.supplyGuardTriggered, false, "guard MUST NOT fire when adr_unbooked is above the bypass threshold");
  assert.equal(r.supplyGuardBypassedByAdrUnbooked, true, "bypass diagnostic must surface that the guard would have fired pre-bypass");
  // effectiveDelta flows through at the raw adr_unbooked +26%.
  assert.ok(r.effectiveDelta !== null);
  assert.ok(Math.abs(r.effectiveDelta! - 0.26) < 1e-6, `expected effective +26% (not damped), got ${r.effectiveDelta}`);
});

test("supply-guard bypass — adr_unbooked just under 15% does not bypass (damp still fires)", () => {
  // Boundary check: adr_unbooked +14% is below the 15% threshold, so
  // the bypass does NOT kick in — guard still fires on the supply +
  // booked-ADR legs.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    // Target: unbooked 228/peer-200 = +14%; adr 200 = +0%; supply 150 = -25%
    makeForwardDay({ date: target, unbooked: 228, adr: 200, supply: 150 }),
    makeForwardDay({ date: peer1, unbooked: 200, adr: 200, supply: 200 }),
    makeForwardDay({ date: peer2, unbooked: 200, adr: 200, supply: 200 }),
    makeForwardDay({ date: peer3, unbooked: 200, adr: 200, supply: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.supplyGuardTriggered, true, "+14% adr_unbooked is below bypass threshold; guard fires");
  assert.equal(r.supplyGuardBypassedByAdrUnbooked, false);
  // ADR flat → adrFloor=0 → effective damped to min(0.14, 0) = 0.
  assert.equal(r.effectiveDelta, 0);
});

test("supply-guard bypass — supply contraction NOT below threshold → guard never fires (no bypass relevant)", () => {
  // Supply only -10% (above the -20% threshold). Guard's first leg
  // doesn't hit; effective delta = raw adr_unbooked. Bypass diagnostic
  // is FALSE because the guard wasn't a candidate to fire.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  const fp = makeForwardPace([
    makeForwardDay({ date: target, unbooked: 260, adr: 200, supply: 180 }), // supply -10%
    makeForwardDay({ date: peer1, unbooked: 200, adr: 200, supply: 200 }),
    makeForwardDay({ date: peer2, unbooked: 200, adr: 200, supply: 200 }),
    makeForwardDay({ date: peer3, unbooked: 200, adr: 200, supply: 200 })
  ]);
  const r = computeKdCrossSectionalDelta({ targetIso: target, forwardPace: fp });
  assert.equal(r.supplyGuardTriggered, false);
  assert.equal(r.supplyGuardBypassedByAdrUnbooked, false);
  // effective = raw adr_unbooked +30%.
  assert.ok(r.effectiveDelta !== null);
  assert.ok(Math.abs(r.effectiveDelta! - 0.30) < 1e-6, `expected effective +30% (no damping), got ${r.effectiveDelta}`);
});

// ---------------------------------------------------------------------------
// 2026-05-27 PM — corroborator stacking still works post-consolidation
// ---------------------------------------------------------------------------

test("corroborator stacking — adr_unbooked +20% AND bookingWindow +20% > adr_unbooked +20% alone", () => {
  // Sanity: the booking-window corroborator (just shipped) still adds
  // bonus when both signals point up — independent of the
  // own-pace removal in this ship.
  const target = "2026-06-15";
  const peer1 = "2026-06-08";
  const peer2 = "2026-06-22";
  const peer3 = "2026-06-29";
  // With corroborator firing (+20% bw vs peer median 30):
  const corroborated = computeKdCrossSectionalDelta({
    targetIso: target,
    forwardPace: makeForwardPace([
      makeForwardDay({ date: target, unbooked: 240, bookingWindow: 36 }), // bw +20%
      makeForwardDay({ date: peer1, unbooked: 200, bookingWindow: 30 }),
      makeForwardDay({ date: peer2, unbooked: 200, bookingWindow: 30 }),
      makeForwardDay({ date: peer3, unbooked: 200, bookingWindow: 30 })
    ])
  });
  // Without corroborator (booking window at peer median):
  const alone = computeKdCrossSectionalDelta({
    targetIso: target,
    forwardPace: makeForwardPace([
      makeForwardDay({ date: target, unbooked: 240, bookingWindow: 30 }), // bw at peer median
      makeForwardDay({ date: peer1, unbooked: 200, bookingWindow: 30 }),
      makeForwardDay({ date: peer2, unbooked: 200, bookingWindow: 30 }),
      makeForwardDay({ date: peer3, unbooked: 200, bookingWindow: 30 })
    ])
  });
  assert.equal(corroborated.bookingWindowCorroboratorTriggered, true);
  assert.equal(alone.bookingWindowCorroboratorTriggered, false);
  assert.ok(corroborated.effectiveDelta! > alone.effectiveDelta!,
    `corroborated ${corroborated.effectiveDelta} should beat alone ${alone.effectiveDelta}`);
  // Corroborated = +20% + min(0.10, 0.10) = +30%; alone = +20%.
  assert.ok(Math.abs(corroborated.effectiveDelta! - 0.30) < 1e-6);
  assert.ok(Math.abs(alone.effectiveDelta! - 0.20) < 1e-6);
});
