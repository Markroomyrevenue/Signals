import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "@app/api/signals/monthly-summary/route";

import {
  rollUpPortfolio,
  resolveMonthRange,
  summarizePriceChangePcts,
  summarizeTenantChanges,
  type ChangeRow
} from "./summary";

function changeRow(overrides: Partial<ChangeRow> = {}): ChangeRow {
  return {
    id: "c",
    listingId: "L1",
    lever: "price",
    date: "2026-05-02",
    oldValue: 100,
    newValue: 130,
    changePct: 0.3,
    pctOfYearlyAdr: 0.9,
    ...overrides
  };
}

test("resolveMonthRange parses an explicit YYYY-MM into a half-open UTC range", () => {
  const { month, start, end } = resolveMonthRange("2026-05", new Date("2026-06-15T00:00:00Z"));
  assert.equal(month, "2026-05");
  assert.equal(start.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(end.toISOString(), "2026-06-01T00:00:00.000Z");
});

test("resolveMonthRange defaults to the month that just ended", () => {
  const { month, start, end } = resolveMonthRange(undefined, new Date("2026-06-15T00:00:00Z"));
  assert.equal(month, "2026-05");
  assert.equal(start.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(end.toISOString(), "2026-06-01T00:00:00.000Z");
});

test("resolveMonthRange rolls back across a year boundary", () => {
  const { month } = resolveMonthRange(undefined, new Date("2026-01-10T00:00:00Z"));
  assert.equal(month, "2025-12");
});

test("resolveMonthRange ignores a malformed month and falls back to the just-ended month", () => {
  const { month } = resolveMonthRange("2026-13", new Date("2026-06-15T00:00:00Z"));
  assert.equal(month, "2026-05");
});

test("summarizePriceChangePcts reports count/median/min/max and handles empties", () => {
  assert.deepEqual(summarizePriceChangePcts([]), { count: 0, median: null, min: null, max: null });
  const stats = summarizePriceChangePcts([0.1, 0.3, 0.2]);
  assert.equal(stats.count, 3);
  assert.equal(stats.median, 0.2);
  assert.equal(stats.min, 0.1);
  assert.equal(stats.max, 0.3);
});

test("summarizeTenantChanges rolls up levers, price stats, conversions and top moves", () => {
  const changes: ChangeRow[] = [
    changeRow({ id: "c1", date: "2026-05-02", changePct: 0.3, newValue: 130 }),
    changeRow({ id: "c2", date: "2026-05-03", changePct: -0.1, newValue: 90 }),
    changeRow({ id: "c3", listingId: "L2", lever: "min_stay", date: "2026-05-04", oldValue: 2, newValue: 3, changePct: null, pctOfYearlyAdr: null }),
    changeRow({ id: "c4", listingId: "L2", lever: "availability", date: "2026-05-05", oldValue: 1, newValue: 0, changePct: null, pctOfYearlyAdr: null }),
    changeRow({ id: "c5", date: "2026-05-06", changePct: 1.0, newValue: 200 })
  ];
  const converted = new Set<string>(["c1", "c3", "c5"]);

  const summary = summarizeTenantChanges({
    tenantId: "t1",
    tenantName: "Tenant One",
    scansRun: 4,
    changes,
    convertedChangeIds: converted
  });

  assert.equal(summary.totalChanges, 5);
  assert.deepEqual(summary.leverBreakdown, { price: 3, min_stay: 1, availability: 1 });
  assert.equal(summary.priceChangePct.count, 3);
  assert.equal(summary.priceChangePct.median, 0.3);
  assert.equal(summary.priceChangePct.min, -0.1);
  assert.equal(summary.priceChangePct.max, 1.0);
  // c1, c3, c5 converted → 3 (c3 is min_stay but still a converted change).
  assert.equal(summary.convertedWithin48h, 3);
  // Top converted moves are price-only, largest |changePct| first: c5 (1.0) then c1 (0.3).
  assert.equal(summary.topConvertedMoves.length, 2);
  assert.equal(summary.topConvertedMoves[0].newValue, 200);
  assert.equal(summary.topConvertedMoves[1].newValue, 130);
});

test("rollUpPortfolio sums tenant summaries and recomputes combined price stats", () => {
  const tenantA = summarizeTenantChanges({
    tenantId: "a",
    tenantName: "A",
    scansRun: 2,
    changes: [changeRow({ id: "a1", changePct: 0.2 })],
    convertedChangeIds: new Set(["a1"])
  });
  const tenantB = summarizeTenantChanges({
    tenantId: "b",
    tenantName: "B",
    scansRun: 3,
    changes: [changeRow({ id: "b1", lever: "min_stay", changePct: null })],
    convertedChangeIds: new Set()
  });

  const portfolio = rollUpPortfolio([tenantA, tenantB], [0.2]);

  assert.equal(portfolio.tenantCount, 2);
  assert.equal(portfolio.scansRun, 5);
  assert.equal(portfolio.totalChanges, 2);
  assert.deepEqual(portfolio.leverBreakdown, { price: 1, min_stay: 1, availability: 0 });
  assert.equal(portfolio.convertedWithin48h, 1);
  assert.equal(portfolio.priceChangePct.count, 1);
  assert.equal(portfolio.priceChangePct.median, 0.2);
});

test("monthly-summary route returns 404 when SIGNALS_SUMMARY_KEY is unset", async () => {
  const original = process.env.SIGNALS_SUMMARY_KEY;
  delete process.env.SIGNALS_SUMMARY_KEY;
  try {
    const response = await GET(new Request("http://localhost/api/signals/monthly-summary?key=anything"));
    assert.equal(response.status, 404);
  } finally {
    if (original !== undefined) process.env.SIGNALS_SUMMARY_KEY = original;
  }
});

test("monthly-summary route returns 404 when the key does not match", async () => {
  const original = process.env.SIGNALS_SUMMARY_KEY;
  process.env.SIGNALS_SUMMARY_KEY = "the-real-key";
  try {
    const response = await GET(new Request("http://localhost/api/signals/monthly-summary?key=wrong"));
    assert.equal(response.status, 404);
  } finally {
    if (original === undefined) delete process.env.SIGNALS_SUMMARY_KEY;
    else process.env.SIGNALS_SUMMARY_KEY = original;
  }
});
