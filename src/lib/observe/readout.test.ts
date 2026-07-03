import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleEstateHealth,
  assembleStarvationMatrix,
  renderReadoutHtml,
  type ReadoutData
} from "./readout";
import { LEARNING_KEYS, type LearningKey } from "./learnings";

function allDays(days: number | null): Record<LearningKey, number | null> {
  return Object.fromEntries(LEARNING_KEYS.map((k) => [k, days])) as Record<LearningKey, number | null>;
}

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
    calibration: {
      scored: 120,
      booked: 68,
      bookedNoRateMove: 52,
      expiredEmpty: 47,
      cancelledAfterBooking: 5,
      avgRealisedVsProposed: 1.08,
      byDropSize: [
        { label: "<=10%", n: 80, booked: 50, bookedPct: 0.625, avgRealisedVsProposed: 1.11 },
        { label: "10-15%", n: 40, booked: 18, bookedPct: 0.45, avgRealisedVsProposed: 1.02 }
      ],
      byLeadTime: [{ label: "0-3d", n: 120, booked: 68, bookedPct: 0.57, avgRealisedVsProposed: 1.08 }]
    },
    estate: {
      tenants: [
        {
          tenantId: "tenant-1",
          name: "Stay Belfast Apartments",
          lastSuccessfulRunAt: "2026-07-26T05:35:00.000Z",
          daysObserved: 30,
          status: "graduated",
          warning: null
        }
      ],
      starvation: [
        { tenantId: "tenant-1", name: "Stay Belfast Apartments", daysSinceNonNull: allDays(0) }
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

// ---- Estate health + starvation matrix --------------------------------------

const NOW = new Date("2026-07-03T08:00:00.000Z");

test("assembleEstateHealth lists a tenant that has NO observation window, with a warning", () => {
  const rows = assembleEstateHealth({
    tenants: [
      { id: "t-observed", name: "Little Feather" },
      { id: "t-new", name: "Escape Ordinary (recreated)" }
    ],
    windows: [{ tenantId: "t-observed", lastRunAt: new Date("2026-07-03T05:35:00.000Z"), daysObserved: 12, status: "observing" }],
    now: NOW
  });

  assert.equal(rows.length, 2); // EVERY tenant appears, windowless or not
  const healthy = rows.find((r) => r.tenantId === "t-observed");
  assert.equal(healthy?.warning, null);
  assert.equal(healthy?.daysObserved, 12);

  const missing = rows.find((r) => r.tenantId === "t-new");
  assert.match(missing?.warning ?? "", /no observation window/);
  assert.equal(missing?.lastSuccessfulRunAt, null);
});

test("assembleEstateHealth warns when the last completed run is older than 48h", () => {
  const rows = assembleEstateHealth({
    tenants: [{ id: "t-stale", name: "Demo PM" }, { id: "t-fresh", name: "Fresh" }],
    windows: [
      { tenantId: "t-stale", lastRunAt: new Date("2026-06-30T05:35:00.000Z"), daysObserved: 20, status: "observing" },
      { tenantId: "t-fresh", lastRunAt: new Date("2026-07-02T05:35:00.000Z"), daysObserved: 5, status: "observing" }
    ],
    now: NOW
  });
  assert.match(rows.find((r) => r.tenantId === "t-stale")?.warning ?? "", /no completed run in 48h/);
  assert.equal(rows.find((r) => r.tenantId === "t-fresh")?.warning, null);
});

test("assembleStarvationMatrix computes days since the last non-null value, null when never", () => {
  const matrix = assembleStarvationMatrix({
    tenants: [{ id: "t1", name: "Little Feather" }],
    latestNonNull: [
      { tenantId: "t1", learning: "lead_time", runAt: new Date("2026-07-03T05:35:00.000Z") },
      { tenantId: "t1", learning: "pricing_power", runAt: new Date("2026-06-23T05:35:00.000Z") }
    ],
    now: NOW
  });
  assert.equal(matrix.length, 1);
  assert.equal(matrix[0].daysSinceNonNull.lead_time, 0);
  assert.equal(matrix[0].daysSinceNonNull.pricing_power, 10); // starved for 10 days
  assert.equal(matrix[0].daysSinceNonNull.regret, null); // never produced a value
  assert.equal(matrix[0].daysSinceNonNull.pickup_velocity, null);
});

test("renderReadoutHtml renders the estate section with a visible warning for a windowless tenant", () => {
  const html = renderReadoutHtml(
    sampleReadout({
      estate: {
        tenants: [
          {
            tenantId: "t-new",
            name: "Escape Ordinary (recreated)",
            lastSuccessfulRunAt: null,
            daysObserved: null,
            status: null,
            warning: "no observation window — this tenant has never been observed"
          }
        ],
        starvation: [{ tenantId: "t-new", name: "Escape Ordinary (recreated)", daysSinceNonNull: allDays(null) }]
      }
    })
  );
  assert.ok(html.includes("Estate health"));
  assert.ok(html.includes("Escape Ordinary (recreated)"));
  assert.ok(html.includes("no observation window"));
  assert.ok(html.includes("never")); // last run "never" + starvation cells
  assert.ok(html.includes("Learning starvation"));
});

test("renderReadoutHtml flags starved learnings (>7d) and shows fresh ones plainly", () => {
  const days = allDays(0);
  days.pricing_power = 12;
  const html = renderReadoutHtml(
    sampleReadout({
      estate: {
        tenants: [
          {
            tenantId: "t1",
            name: "Little Feather",
            lastSuccessfulRunAt: "2026-07-03T05:35:00.000Z",
            daysObserved: 30,
            status: "graduated",
            warning: null
          }
        ],
        starvation: [{ tenantId: "t1", name: "Little Feather", daysSinceNonNull: days }]
      }
    })
  );
  assert.ok(html.includes(`<td class="warn">12d</td>`)); // starved cell flagged
  assert.ok(html.includes("<td>0d</td>")); // fresh cell plain
  assert.ok(html.includes("#4 pricing power")); // matrix columns labelled by learning
});

// ---- Calibration section ------------------------------------------------------

test("renderReadoutHtml renders the calibration headline and buckets", () => {
  const html = renderReadoutHtml(sampleReadout());
  assert.ok(html.includes("Calibration — what actually happened to flagged nights"));
  assert.ok(html.includes("Of <b>120</b> nights the system would have dropped"));
  assert.ok(html.includes("<b>68</b> (57%) booked anyway with no drop applied"));
  assert.ok(html.includes("52 with no rate move by anyone"));
  assert.ok(html.includes("<b>108%</b> of the price the system proposed dropping to"));
  assert.ok(html.includes("47 expired empty; 5 booked then cancelled"));
  assert.ok(html.includes("By suggested drop size"));
  assert.ok(html.includes("By lead time at suggestion"));
  assert.ok(html.includes("&lt;=10%")); // bucket label escaped, with its n
  assert.ok(html.includes("<td>80</td>"));
});

test("renderReadoutHtml handles the not-yet-scored calibration case", () => {
  const html = renderReadoutHtml(sampleReadout({ calibration: null }));
  assert.ok(html.includes("Calibration"));
  assert.ok(html.includes("No scored suggestions yet"));
});
