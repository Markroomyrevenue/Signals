import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPTH_MULTIPLIER_MAX,
  DEPTH_MULTIPLIER_MIN,
  computeMarketFactor,
  type MarketFactorNight
} from "./factor";
import type { MarketContext, MarketMetric, PricePosition } from "./types";
import { neutralMarketFactor } from "./types";

function ctx(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    engine: "pricelabs",
    asOf: "2026-07-18T09:00:00.000Z",
    source: "engine_snapshot",
    marketOccNext30: null,
    myOccNext30: null,
    pricePosition: null,
    dataAgeHours: 14,
    notes: [],
    ...overrides
  };
}

function occ(value: number): MarketMetric {
  return { value, window: "next30", source: "engine_snapshot" };
}

function pricePos(ratio: number): PricePosition {
  return {
    myRate: 120,
    neighborhoodMedian: Math.round((120 / ratio) * 100) / 100,
    ratio,
    date: "2026-08-02",
    source: "pl_neighborhood"
  };
}

function night(overrides: Partial<MarketFactorNight> = {}): MarketFactorNight {
  return {
    date: "2026-08-02",
    myRate: 120,
    expectedFill: 0.6,
    scaledFill: 0.5,
    behindCurve: true,
    ...overrides
  };
}

// ---- rule table -------------------------------------------------------------

const CASES: Array<{
  name: string;
  ctx: Partial<MarketContext>;
  night?: Partial<MarketFactorNight>;
  multiplier: number;
  holdBias: boolean;
}> = [
  // Rule 1 — soft + behind curve deepens, scaled with softness.
  { name: "soft occ 45% + behind", ctx: { marketOccNext30: occ(0.45) }, multiplier: 1.2, holdBias: false },
  { name: "soft occ 50% + behind (shallower)", ctx: { marketOccNext30: occ(0.5) }, multiplier: 1.1, holdBias: false },
  {
    name: "very soft occ 30% + priced 20% above: capped at 1.4",
    ctx: { marketOccNext30: occ(0.3), pricePosition: pricePos(1.2) },
    multiplier: 1.4,
    holdBias: false
  },
  { name: "soft by ratio only (1.2) + behind", ctx: { pricePosition: pricePos(1.2) }, multiplier: 1.2, holdBias: false },
  // Rule 2 — soft alone never deepens an on-curve night.
  {
    name: "soft occ 45% but NOT behind curve",
    ctx: { marketOccNext30: occ(0.45) },
    night: { behindCurve: false },
    multiplier: 1,
    holdBias: false
  },
  // Rule 3 — hot + behind holds shallower, scaled.
  { name: "hot occ 90% + behind", ctx: { marketOccNext30: occ(0.9) }, multiplier: 0.8, holdBias: true },
  { name: "hot by ratio only (0.85) + behind", ctx: { pricePosition: pricePos(0.85) }, multiplier: 0.8, holdBias: true },
  {
    name: "very hot occ 100% + priced 50% below: floored at 0.6",
    ctx: { marketOccNext30: occ(1), pricePosition: pricePos(0.5) },
    multiplier: 0.6,
    holdBias: true
  },
  // Rule 4 — hot + not behind = strongest hold.
  {
    name: "hot occ 90% + NOT behind curve",
    ctx: { marketOccNext30: occ(0.9) },
    night: { behindCurve: false },
    multiplier: 0.6,
    holdBias: true
  },
  // Rule 5 — mixed indicators never move a price.
  {
    name: "mixed: hot occ 85% but priced 20% above",
    ctx: { marketOccNext30: occ(0.85), pricePosition: pricePos(1.2) },
    multiplier: 1,
    holdBias: false
  },
  {
    name: "mixed: soft occ 40% but priced 20% below",
    ctx: { marketOccNext30: occ(0.4), pricePosition: pricePos(0.8) },
    multiplier: 1,
    holdBias: false
  },
  // Rule 6 — neutral readings.
  {
    name: "neutral occ 65%, ratio 1.0",
    ctx: { marketOccNext30: occ(0.65), pricePosition: pricePos(1) },
    multiplier: 1,
    holdBias: false
  }
];

for (const c of CASES) {
  test(`rule table: ${c.name}`, () => {
    const factor = computeMarketFactor(ctx(c.ctx), night(c.night));
    assert.equal(factor.depthMultiplier, c.multiplier);
    assert.equal(factor.holdBias, c.holdBias);
    assert.ok(
      factor.depthMultiplier >= DEPTH_MULTIPLIER_MIN && factor.depthMultiplier <= DEPTH_MULTIPLIER_MAX,
      "multiplier stays in bounds"
    );
  });
}

// ---- rule 0: no signal ------------------------------------------------------

test("no usable signal returns the neutral factor", () => {
  const factor = computeMarketFactor(ctx(), night());
  assert.deepEqual(factor, neutralMarketFactor("engine_snapshot"));
  assert.equal(factor.depthMultiplier, 1);
  assert.equal(factor.holdBias, false);
  assert.equal(factor.contribution, "no market signal available");
});

// ---- rule S: staleness dampening -------------------------------------------

test("stale data (>48h) dampens the multiplier halfway toward 1 and says so", () => {
  const fresh = computeMarketFactor(ctx({ marketOccNext30: occ(0.45), dataAgeHours: 14 }), night());
  const stale = computeMarketFactor(ctx({ marketOccNext30: occ(0.45), dataAgeHours: 72 }), night());
  assert.equal(fresh.depthMultiplier, 1.2);
  assert.equal(stale.depthMultiplier, 1.1); // 1 + (1.2 - 1) / 2
  assert.match(stale.contribution, /72h old/);
  assert.match(stale.contribution, /dampened/);
  assert.doesNotMatch(fresh.contribution, /dampened/);
});

test("staleness dampens a hold too but keeps the hold bias", () => {
  const factor = computeMarketFactor(
    ctx({ marketOccNext30: occ(0.9), dataAgeHours: 72 }),
    night({ behindCurve: false })
  );
  assert.equal(factor.depthMultiplier, 0.8); // 1 + (0.6 - 1) / 2
  assert.equal(factor.holdBias, true);
});

test("staleness leaves a neutral multiplier at exactly 1", () => {
  const factor = computeMarketFactor(ctx({ marketOccNext30: occ(0.65), dataAgeHours: 100 }), night());
  assert.equal(factor.depthMultiplier, 1);
});

test("exactly 48h old is NOT stale; unknown age is never dampened", () => {
  const boundary = computeMarketFactor(ctx({ marketOccNext30: occ(0.45), dataAgeHours: 48 }), night());
  assert.equal(boundary.depthMultiplier, 1.2);
  const unknownAge = computeMarketFactor(ctx({ marketOccNext30: occ(0.45), dataAgeHours: null }), night());
  assert.equal(unknownAge.depthMultiplier, 1.2);
});

// ---- contribution honesty ---------------------------------------------------

test("contribution always states the numbers, windows and provenance used", () => {
  const factor = computeMarketFactor(
    ctx({
      marketOccNext30: occ(0.83),
      myOccNext30: occ(0.61),
      dataAgeHours: 14
    }),
    night()
  );
  assert.match(factor.contribution, /market occ next 30: 83%/);
  assert.match(factor.contribution, /engine snapshot/);
  assert.match(factor.contribution, /14h old/);
  assert.match(factor.contribution, /vs your 61%/);
  assert.match(factor.contribution, /held shallower/);
});

test("contribution states the price position with rate, median and date", () => {
  const factor = computeMarketFactor(ctx({ pricePosition: pricePos(1.2) }), night());
  assert.match(factor.contribution, /£120/);
  assert.match(factor.contribution, /£100/);
  assert.match(factor.contribution, /20% above/);
  assert.match(factor.contribution, /2026-08-02/);
});

test("neighborhood-sourced contribution carries its n", () => {
  const factor = computeMarketFactor(
    ctx({
      source: "pl_neighborhood",
      marketOccNext30: { value: 0.45, window: "next30", source: "pl_neighborhood", n: 28 }
    }),
    night()
  );
  assert.match(factor.contribution, /PriceLabs neighbourhood/);
  assert.match(factor.contribution, /n=28 days/);
});

// ---- inputs are verbatim ----------------------------------------------------

test("inputs echo the exact numbers the rules consumed", () => {
  const factor = computeMarketFactor(
    ctx({
      marketOccNext30: occ(0.45),
      myOccNext30: occ(0.61),
      pricePosition: pricePos(1.2),
      dataAgeHours: 14
    }),
    night({ behindCurve: true })
  );
  assert.deepEqual(factor.inputs, {
    marketOccNext30: 0.45,
    myOccNext30: 0.61,
    priceRatio: 1.2,
    myRate: 120,
    neighborhoodMedian: 100,
    behindCurve: true,
    dataAgeHours: 14,
    source: "engine_snapshot"
  });
  assert.equal(factor.source, "engine_snapshot");
});
