import assert from "node:assert/strict";
import test from "node:test";

import { resolvePropertyDeepDiveComparisonData } from "./service";

function totals(input: Partial<{ nights: number; revenueIncl: number; fees: number; inventoryNights: number }> = {}) {
  return {
    nights: input.nights ?? 0,
    revenueIncl: input.revenueIncl ?? 0,
    fees: input.fees ?? 0,
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
