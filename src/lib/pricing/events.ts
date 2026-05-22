/**
 * Shared local-event resolution helper.
 *
 * Lifted on 2026-05-22 from the two duplicate copies that previously
 * lived in `src/lib/reports/pricing-report-assembly.ts` (full version
 * with `multiple`/`selectedDates` support) and `src/lib/reports/service.ts`
 * (range-only version) into a single source of truth so the trial
 * comparison agent can resolve events without writing a third copy.
 *
 * The full version is the canonical one — it handles BOTH
 * `dateSelectionMode === "range"` (event applies on every date from
 * `startDate` to `endDate` inclusive) AND
 * `dateSelectionMode === "multiple"` (event applies only on the dates
 * in `selectedDates`). The simpler range-only behaviour falls out
 * automatically when `dateSelectionMode` is undefined / not "multiple".
 */

import type { PricingLocalEvent } from "@/lib/pricing/settings";

/**
 * Return the first local event covering `dateOnly`, or null if no event
 * matches. Caller decides what to do with the event (typically
 * `(1 + event.adjustmentPct / 100)` is multiplied into the daily rate).
 *
 * `dateOnly` is the YYYY-MM-DD string of the target date in local /
 * report timezone. Comparison is lexicographic on YYYY-MM-DD which is
 * date-correct.
 */
export function eventAdjustmentForDate(
  events: PricingLocalEvent[],
  dateOnly: string
): PricingLocalEvent | null {
  return (
    events.find((event) => {
      if (event.dateSelectionMode === "multiple" && event.selectedDates && event.selectedDates.length > 0) {
        return event.selectedDates.includes(dateOnly);
      }
      return event.startDate <= dateOnly && event.endDate >= dateOnly;
    }) ?? null
  );
}
