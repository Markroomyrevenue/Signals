import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPeerFluctuation,
  computePeerFluctuationByDateFromRows,
  PEER_FLUCTUATION_MIN_SOURCES_PER_DATE,
  PEER_FLUCTUATION_SANITY_CAP
} from "@/lib/pricing/peer-fluctuation";

/* These tests cover the pure-aggregator logic — no Prisma, no network.
 * The DB-backed `computePeerFluctuationByDate` reuses the same aggregator,
 * so testing the pure path is sufficient for the price math. */

const MID_LOS = 5; // short-stay, well below the 14-night cutoff

test("aggregator: 4 sources with mixed CalendarRate + LY fallback yield correct fluctuation", () => {
  // Each source has yearly_adr=100. On the target date (2026-05-10):
  //   src-A: live rate 110  → fluct 0.10
  //   src-B: live rate 120  → fluct 0.20
  //   src-C: no live rate; LY booked 90 → fluct -0.10
  //   src-D: live rate 100  → fluct 0.00
  // mean = (0.10 + 0.20 - 0.10 + 0.00) / 4 = 0.05
  const historyRows = ["A", "B", "C", "D"].flatMap((id) =>
    Array.from({ length: 10 }, () => ({
      listingId: `src-${id}`,
      rate: 100,
      losNights: MID_LOS
    }))
  );
  const forwardRows = [
    { listingId: "src-A", dateOnly: "2026-05-10", available: true, rate: 110 },
    { listingId: "src-B", dateOnly: "2026-05-10", available: true, rate: 120 },
    { listingId: "src-D", dateOnly: "2026-05-10", available: true, rate: 100 }
  ];
  const lastYearRows = [{ listingId: "src-C", dateOnly: "2026-05-10", rate: 90, losNights: 3 }];

  const result = computePeerFluctuationByDateFromRows({
    historyRows,
    forwardRows,
    lastYearRows,
    fromDate: "2026-05-10",
    toDate: "2026-05-10"
  });
  const entry = result.get("2026-05-10");
  assert.ok(entry && !("skipReason" in entry));
  if (!entry || "skipReason" in entry) return;
  assert.equal(entry.sourceCount, 4);
  assert.ok(Math.abs(entry.fluctuation - 0.05) < 1e-9, `expected 0.05, got ${entry.fluctuation}`);
  assert.equal(entry.capEngaged, false);
});

test("aggregator: source missing both live rate and LY rate is skipped entirely", () => {
  // 3 sources have ADR=100. Source X has no forward rate AND no LY → it
  // shouldn't contribute. Remaining 2 are 120 and 80 → mean 0.0.
  const historyRows = ["A", "B", "X"].flatMap((id) =>
    Array.from({ length: 10 }, () => ({ listingId: `src-${id}`, rate: 100, losNights: MID_LOS }))
  );
  const forwardRows = [
    { listingId: "src-A", dateOnly: "2026-05-10", available: true, rate: 120 },
    { listingId: "src-B", dateOnly: "2026-05-10", available: true, rate: 80 }
  ];

  const result = computePeerFluctuationByDateFromRows({
    historyRows,
    forwardRows,
    lastYearRows: [],
    fromDate: "2026-05-10",
    toDate: "2026-05-10"
  });
  const entry = result.get("2026-05-10");
  assert.ok(entry && !("skipReason" in entry));
  if (!entry || "skipReason" in entry) return;
  assert.equal(entry.sourceCount, 2);
  assert.ok(Math.abs(entry.fluctuation - 0) < 1e-9);
});

test("aggregator: < 2 sources contributing produces a skip entry, not a fluctuation", () => {
  const historyRows = Array.from({ length: 10 }, () => ({
    listingId: "only-source",
    rate: 100,
    losNights: MID_LOS
  }));
  const forwardRows = [
    { listingId: "only-source", dateOnly: "2026-05-10", available: true, rate: 120 }
  ];
  const result = computePeerFluctuationByDateFromRows({
    historyRows,
    forwardRows,
    lastYearRows: [],
    fromDate: "2026-05-10",
    toDate: "2026-05-10"
  });
  const entry = result.get("2026-05-10");
  assert.ok(entry && "skipReason" in entry);
  if (!entry || !("skipReason" in entry)) return;
  assert.equal(entry.skipReason, "insufficient_sources");
});

test("aggregator: ±50% sanity cap engages and is reported", () => {
  // 2 sources, both pricing at 200 (100% above ADR=100). Raw fluct = 1.0.
  // Cap clamps to 0.5 and reports `capEngaged = true`.
  const historyRows = ["A", "B"].flatMap((id) =>
    Array.from({ length: 10 }, () => ({ listingId: `src-${id}`, rate: 100, losNights: MID_LOS }))
  );
  const forwardRows = [
    { listingId: "src-A", dateOnly: "2026-05-10", available: true, rate: 200 },
    { listingId: "src-B", dateOnly: "2026-05-10", available: true, rate: 200 }
  ];
  const result = computePeerFluctuationByDateFromRows({
    historyRows,
    forwardRows,
    lastYearRows: [],
    fromDate: "2026-05-10",
    toDate: "2026-05-10"
  });
  const entry = result.get("2026-05-10");
  assert.ok(entry && !("skipReason" in entry));
  if (!entry || "skipReason" in entry) return;
  assert.ok(Math.abs(entry.fluctuationRaw - 1.0) < 1e-9);
  assert.ok(Math.abs(entry.fluctuation - PEER_FLUCTUATION_SANITY_CAP) < 1e-9);
  assert.equal(entry.capEngaged, true);
});

test("aggregator: history rows with LOS > 14 are excluded from ADR", () => {
  // Long-stay LOS=20 contributes value 50 (drag down). Short-stay LOS=3
  // contributes value 100. With long-stay filter, ADR=100; without it,
  // ADR=75. The forward rate of 100 should produce 0% fluctuation.
  const historyRowsA = [
    { listingId: "src-A", rate: 50, losNights: 20 },
    ...Array.from({ length: 10 }, () => ({ listingId: "src-A", rate: 100, losNights: 3 }))
  ];
  const historyRowsB = Array.from({ length: 10 }, () => ({
    listingId: "src-B",
    rate: 100,
    losNights: 3
  }));
  const result = computePeerFluctuationByDateFromRows({
    historyRows: [...historyRowsA, ...historyRowsB],
    forwardRows: [
      { listingId: "src-A", dateOnly: "2026-05-10", available: true, rate: 100 },
      { listingId: "src-B", dateOnly: "2026-05-10", available: true, rate: 100 }
    ],
    lastYearRows: [],
    fromDate: "2026-05-10",
    toDate: "2026-05-10"
  });
  const entry = result.get("2026-05-10");
  assert.ok(entry && !("skipReason" in entry));
  if (!entry || "skipReason" in entry) return;
  assert.ok(Math.abs(entry.fluctuation - 0) < 1e-9);
});

test("applyPeerFluctuation: floor enforcement when fluctuation would push below user min", () => {
  const result = applyPeerFluctuation({
    fluctuation: { fluctuation: -0.4, fluctuationRaw: -0.4, capEngaged: false, sourceCount: 3 },
    userBase: 100,
    userMin: 80,
    roundingIncrement: 1
  });
  if (result.skipped) {
    assert.fail("did not expect skipped result");
  }
  // 100 × (1 - 0.4) = 60 → floor at 80.
  assert.equal(result.finalRate, 80);
});

test("applyPeerFluctuation: skips when fluctuation entry is a skipReason", () => {
  const result = applyPeerFluctuation({
    fluctuation: { skipReason: "insufficient_sources" },
    userBase: 100,
    userMin: 80,
    roundingIncrement: 1
  });
  if (!result.skipped) {
    assert.fail("expected skipped result");
  }
  assert.equal(result.skipReason, "insufficient_sources");
  assert.equal(result.finalRate, null);
});

test("PEER_FLUCTUATION_MIN_SOURCES_PER_DATE constant equals 2 (spec A.2 step 3)", () => {
  assert.equal(PEER_FLUCTUATION_MIN_SOURCES_PER_DATE, 2);
});

test("PEER_FLUCTUATION_SANITY_CAP constant equals 0.5 (spec A.2 step 4)", () => {
  assert.equal(PEER_FLUCTUATION_SANITY_CAP, 0.5);
});
