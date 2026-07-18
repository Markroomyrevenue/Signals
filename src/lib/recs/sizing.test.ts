import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeRecSizing,
  sizingLeadBucket,
  DOSE_MIN_N,
  MARK_PRIOR_FULL_N,
  RECS_MAX_SINGLE_DROP,
  RECS_MIN_DROP
} from "./sizing";

test("no evidence, no market: base size ships untouched", () => {
  const out = composeRecSizing({ baseDropPct: 0.1, evidence: null, market: null });
  assert.equal(out.dropPct, 0.1);
  assert.equal(out.hold, false);
  assert.equal(out.components.length, 1);
  assert.match(out.components[0], /base drop 10%/);
});

test("mark prior pulls the size toward his habitual band, weight capped at 50%", () => {
  const out = composeRecSizing({
    baseDropPct: 0.2,
    evidence: {
      markPrior: { medianDropPct: 0.06, n: MARK_PRIOR_FULL_N * 5, window: "2026-06-02 → 2026-07-17" },
      doseResponse: null,
      provenance: "warm-start"
    },
    market: null
  });
  // weight capped at 0.5 → 0.2*0.5 + 0.06*0.5 = 0.13
  assert.ok(Math.abs(out.dropPct - 0.13) < 1e-9);
  assert.match(out.components[1], /n=100/);
});

test("thin prior gets proportionally little weight", () => {
  const out = composeRecSizing({
    baseDropPct: 0.2,
    evidence: {
      markPrior: { medianDropPct: 0.06, n: 4, window: "w" },
      doseResponse: null,
      provenance: "warm-start"
    },
    market: null
  });
  // weight = 4/20*0.5 = 0.1 → 0.2*0.9 + 0.06*0.1 = 0.186
  assert.ok(Math.abs(out.dropPct - 0.186) < 1e-9);
});

test("dose-response with enough n deepens halfway toward the winning band", () => {
  const out = composeRecSizing({
    baseDropPct: 0.08,
    evidence: {
      markPrior: null,
      doseResponse: { fillDeltaPp: 12, n: DOSE_MIN_N, band: "15%+", bandMidPct: 0.18 },
      provenance: "warm-start"
    },
    market: null
  });
  assert.ok(Math.abs(out.dropPct - 0.13) < 1e-9); // 0.08 + (0.18-0.08)/2
  assert.match(out.components.join(" "), /beat matched controls by 12pp/);
});

test("dose-response that failed controls shrinks the drop and says so", () => {
  const out = composeRecSizing({
    baseDropPct: 0.12,
    evidence: {
      markPrior: null,
      doseResponse: { fillDeltaPp: -3, n: 40, band: "7-15%", bandMidPct: 0.11 },
      provenance: "live-observed"
    },
    market: null
  });
  assert.ok(Math.abs(out.dropPct - 0.09) < 1e-9); // 0.12 * 0.75
  assert.match(out.components.join(" "), /did NOT beat matched controls/);
});

test("thin dose-response cells are named but never resize", () => {
  const out = composeRecSizing({
    baseDropPct: 0.1,
    evidence: {
      markPrior: null,
      doseResponse: { fillDeltaPp: 20, n: 5, band: "15%+", bandMidPct: 0.18 },
      provenance: "warm-start"
    },
    market: null
  });
  assert.equal(out.dropPct, 0.1);
  assert.match(out.components.join(" "), /too thin to size on/);
});

test("hot market holdBias turns a drop into a hold with the market reason", () => {
  const out = composeRecSizing({
    baseDropPct: 0.15,
    evidence: null,
    market: { depthMultiplier: 0.6, holdBias: true, contribution: "market occ next 30: 85% — market is hot" }
  });
  assert.equal(out.hold, true);
  assert.equal(out.dropPct, 0);
  assert.match(out.components.join(" "), /hold instead of drop/);
});

test("soft market deepens within the single-night cap", () => {
  const out = composeRecSizing({
    baseDropPct: 0.25,
    evidence: null,
    market: { depthMultiplier: 1.4, holdBias: false, contribution: "market occ next 30: 41% vs your 55%" }
  });
  assert.equal(out.dropPct, RECS_MAX_SINGLE_DROP); // 0.35 capped at 0.30
  assert.match(out.components.join(" "), /capped at single-night maximum/);
});

test("a composed size below the minimum becomes an explicit hold", () => {
  const out = composeRecSizing({
    baseDropPct: 0.04,
    evidence: null,
    market: { depthMultiplier: 0.6, holdBias: false, contribution: "market firm" }
  });
  assert.equal(out.hold, true);
  assert.equal(out.dropPct, 0);
  assert.ok(RECS_MIN_DROP > 0.04 * 0.6);
});

test("lead buckets delegate to the canonical observe labels", () => {
  assert.equal(sizingLeadBucket(0), "0-1");
  assert.equal(sizingLeadBucket(5), "4-7");
  assert.equal(sizingLeadBucket(14), "8-14");
  assert.equal(sizingLeadBucket(200), "91+");
  assert.equal(sizingLeadBucket(-1), null);
});
