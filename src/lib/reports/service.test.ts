import assert from "node:assert/strict";
import test from "node:test";

import { applyRevenueToggles, resolvePropertyDeepDiveComparisonData } from "./service";

function totals(input: Partial<{ nights: number; revenueIncl: number; fees: number; vat: number; inventoryNights: number }> = {}) {
  return {
    nights: input.nights ?? 0,
    revenueIncl: input.revenueIncl ?? 0,
    fees: input.fees ?? 0,
    vat: input.vat ?? 0,
    inventoryNights: input.inventoryNights ?? 0
  };
}

function listingDaily(entries: Record<string, Record<string, ReturnType<typeof totals>>>) {
  return new Map(
    Object.entries(entries).map(([listingId, dailyEntries]) => [listingId, new Map(Object.entries(dailyEntries))])
  );
}

test("property drilldown keeps current revenue for listings without a comparable YoY reference", () => {
  const comparison = resolvePropertyDeepDiveComparisonData({
    scopedListingIds: ["new-listing", "mature-listing"],
    currentDaily: listingDaily({
      "new-listing": {
        "2026-04-05": totals({ nights: 2, revenueIncl: 400, inventoryNights: 2 })
      },
      "mature-listing": {
        "2026-04-05": totals({ nights: 1, revenueIncl: 200, inventoryNights: 1 }),
        "2026-04-24": totals({ nights: 1, revenueIncl: 260, inventoryNights: 1 })
      }
    }),
    lyStayedDaily: listingDaily({
      "new-listing": {},
      "mature-listing": {
        "2025-04-05": totals({ nights: 1, revenueIncl: 180, inventoryNights: 1 })
      }
    }),
    lyPaceDaily: listingDaily({
      "new-listing": {},
      "mature-listing": {
        "2025-04-24": totals({ nights: 1, revenueIncl: 210, inventoryNights: 1 })
      }
    }),
    lifecycleByListing: new Map([
      [
        "new-listing",
        {
          firstBookedNight: new Date("2026-01-10T00:00:00.000Z"),
          firstStayedRevenueDate: new Date("2026-01-10T00:00:00.000Z")
        }
      ],
      [
        "mature-listing",
        {
          firstBookedNight: new Date("2024-01-10T00:00:00.000Z"),
          firstStayedRevenueDate: new Date("2024-01-10T00:00:00.000Z")
        }
      ]
    ]),
    periodStart: new Date("2026-04-01T00:00:00.000Z"),
    periodEnd: new Date("2026-04-30T00:00:00.000Z"),
    lyStart: new Date("2025-04-01T00:00:00.000Z"),
    lyEnd: new Date("2025-04-30T00:00:00.000Z"),
    today: new Date("2026-04-20T00:00:00.000Z"),
    compareMode: "yoy_otb",
    periodMode: "mixed"
  });

  assert.equal(comparison.currentTotals.get("new-listing")?.revenueIncl, 400);
  assert.equal(comparison.referenceTotals.get("new-listing")?.revenueIncl, 0);
  assert.equal(comparison.currentByListingDaily.get("new-listing")?.get("2026-04-05")?.revenueIncl, 400);
  assert.equal(comparison.referenceTotals.get("mature-listing")?.revenueIncl, 390);

  const totalCurrentRevenue = Array.from(comparison.currentTotals.values()).reduce((sum, row) => sum + row.revenueIncl, 0);
  assert.equal(totalCurrentRevenue, 860);
});

function approx(actual: number, expected: number, eps = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

test("applyRevenueToggles produces the four fee/VAT combinations on clean inputs", () => {
  // Gross 120 = net 100 + 20% VAT (20), with a 12 cleaning fee inside the gross.
  const revenueIncl = 120;
  const fees = 12;
  const vat = 20;

  // Inc fees / Inc VAT: untouched gross.
  assert.equal(applyRevenueToggles(revenueIncl, fees, vat, true, true), 120);
  // Ex fees / Inc VAT: strip cleaning only.
  assert.equal(applyRevenueToggles(revenueIncl, fees, vat, false, true), 108);
  // Inc fees / Ex VAT: strip full VAT (scale = 1).
  assert.equal(applyRevenueToggles(revenueIncl, fees, vat, true, false), 100);
  // Ex fees / Ex VAT: strip cleaning, then VAT proportional to what survives (108/120).
  assert.equal(applyRevenueToggles(revenueIncl, fees, vat, false, false), 90);

  // VAT is removed proportionally on both fee paths => same 1/1.2 ratio.
  approx(100 / 120, 1 / 1.2, 1e-9);
  approx(90 / 108, 1 / 1.2, 1e-9);
});

test("applyRevenueToggles reconciles Cambridge June 2026 against Hostaway net revenue", () => {
  // Locked from the applyRevenueToggles header: gross 8450.22, cleaning 455.63,
  // VAT 1408.37 (= 8450.22 / 6). Hostaway "Rental Revenue" reports net 7038.90.
  const revenueIncl = 8450.22;
  const fees = 455.63;
  const vat = 1408.37;

  approx(applyRevenueToggles(revenueIncl, fees, vat, true, true), 8450.22);
  approx(applyRevenueToggles(revenueIncl, fees, vat, false, true), 7994.59);
  approx(applyRevenueToggles(revenueIncl, fees, vat, true, false), 7041.85);
  approx(applyRevenueToggles(revenueIncl, fees, vat, false, false), 6662.16);

  // Ex-VAT, fees-in is the figure that lines up with Hostaway's net (within rounding).
  const exVatInc = applyRevenueToggles(revenueIncl, fees, vat, true, false);
  approx(exVatInc, 7038.9, 3.0);
  approx(exVatInc / revenueIncl, 1 / 1.2, 1e-4);
});

test("applyRevenueToggles is a no-op for VAT on non-VAT listings and zero revenue", () => {
  // Non-VAT listing: vat = 0 => Ex-VAT equals Inc-VAT on both fee paths.
  assert.equal(applyRevenueToggles(200, 30, 0, true, false), 200);
  assert.equal(applyRevenueToggles(200, 30, 0, false, false), 170);

  // Zero revenue is guarded (no divide-by-zero in the scale step).
  assert.equal(applyRevenueToggles(0, 0, 0, true, false), 0);
  assert.equal(applyRevenueToggles(0, 0, 0, false, false), 0);

  // Fees larger than revenue never push the result negative.
  assert.equal(applyRevenueToggles(50, 80, 0, false, true), 0);
});
