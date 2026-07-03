import assert from "node:assert/strict";
import test from "node:test";

import { renderReadoutHtml, type ReadoutData } from "./readout";

function sampleReadout(overrides: Partial<ReadoutData> = {}): ReadoutData {
  return {
    client: "Stay Belfast Apartments",
    slug: "stay-belfast",
    engine: "pricelabs",
    generatedAt: "2026-07-26T06:00:00.000Z",
    window: { startedAt: "2026-06-26T00:00:00.000Z", daysObserved: 30, status: "graduated", graduatedAt: "2026-07-26T00:00:00.000Z" },
    profile: {
      engine: "pricelabs",
      computedAt: "2026-07-26T06:00:00.000Z",
      leadTime: { medianLeadDays: 18, bucketPcts: { "0-1": 0.3 } },
      regret: { heldTooLowPct: 0.1, heldTooHighPct: 0.3, total: 40 },
      pricingPower: { event: { sensitivity: "inelastic", occupancy: 0.9 }, weekday: { sensitivity: "elastic", occupancy: 0.4 } },
      engineReaction: { available: true, dominant: "claw_back", fractions: { claw_back: 0.6, fight: 0.2, hold: 0.2, unknown: 0 } },
      feeDragPct: 0.12,
      cancellationSignal: "cheaper_cancel_more",
      rules: [{ key: "tolerates_empty_premium", description: "Tolerates empty premium nights to the wire." }]
    },
    suggestions: {
      count: 1,
      topRevenueAtRisk: 240,
      blocked: { total: 4, byReason: { event: 3, min_floor: 1 } },
      rows: [
        {
          listingId: "listing-xyz",
          listingName: "Castle Buildings 1-bed",
          dateFrom: "2026-07-28",
          dateTo: "2026-07-28",
          lever: "price",
          oldValue: 240,
          proposedValue: 210,
          type: "timed-pct",
          reason: "empty at 2d out; curve expects ~80% booked by now",
          revenueAtRisk: 240,
          confidence: 0.8,
          status: "pending"
        }
      ]
    },
    ...overrides
  };
}

test("renderReadoutHtml includes client, learned strategy, and the suggestion row", () => {
  const html = renderReadoutHtml(sampleReadout());
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("Stay Belfast Apartments"));
  assert.ok(html.includes("Day-30 readout"));
  assert.ok(html.includes("Tolerates empty premium nights")); // divergence rule
  assert.ok(html.includes("inelastic")); // pricing power
  assert.ok(html.includes("240 → 210")); // suggestion old→proposed
  assert.ok(html.includes("empty at 2d out")); // suggestion reason rendered
});

test("renderReadoutHtml escapes HTML in client-controlled fields", () => {
  const html = renderReadoutHtml(
    sampleReadout({ client: "Evil <script>alert(1)</script> Co" })
  );
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderReadoutHtml handles the no-suggestions / no-profile case", () => {
  const html = renderReadoutHtml(
    sampleReadout({ profile: null, suggestions: { count: 0, topRevenueAtRisk: null, blocked: null, rows: [] } })
  );
  assert.ok(html.includes("No suggestions"));
  assert.ok(html.includes("tracks the global norm"));
  assert.ok(!html.includes("Blocked by safety gates")); // no run yet ⇒ no blocked line
});

test("renderReadoutHtml shows the listing NAME, falling back to the id", () => {
  const html = renderReadoutHtml(sampleReadout());
  assert.ok(html.includes("Castle Buildings 1-bed"));

  const base = sampleReadout();
  const noName = renderReadoutHtml({
    ...base,
    suggestions: { ...base.suggestions, rows: [{ ...base.suggestions.rows[0], listingName: null }] }
  });
  assert.ok(noName.includes("listing-xyz")); // id fallback when the join misses
});

test("renderReadoutHtml renders the blocked-by-safety-gates trust line", () => {
  const html = renderReadoutHtml(sampleReadout());
  assert.ok(html.includes("Blocked by safety gates"));
  assert.ok(html.includes("event 3"));
  assert.ok(html.includes("min_floor 1"));
});
