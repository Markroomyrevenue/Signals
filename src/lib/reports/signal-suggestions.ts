/**
 * signal-suggestions
 *
 * Read-only suggestion generator for attention-task / signal cards.
 *
 * Given a single signal (one row of `propertyDetective`) plus pre-loaded
 * historical patterns from THE SAME TENANT, produce 1-3 short text strings
 * that an Airbnb host can read at a glance. No links, no buttons, no API.
 *
 * Tenant isolation: this module is pure logic and does not query the
 * database. The caller must already have filtered all input data by
 * tenantId before calling `buildSignalSuggestions`.
 *
 * Sort order is decided by the caller; this only emits strings.
 *
 * 2026-04-26: minimum-stay tightening / loosening branches removed at owner
 * request (they hurt conversion). Replaced with a price-driven branch that
 * compares the calendar's recommended rate against the current calendar rate
 * for the affected date. The recommended rate must come from the same
 * pricing engine the calendar uses (`buildPricingCalendarRows`); this module
 * does not recompute it.
 */
export type SignalReasonKey =
  | "occ_7_under_60"
  | "occ_14_under_50"
  | "occ_30_under_30"
  | "pace_month_revenue_20"
  | "adr_month_diff_10";

export type SignalSuggestionInput = {
  /** The reason keys attached to this signal in priority order. */
  reasonKeys: SignalReasonKey[];
  /** Severity returned by the engine ("high" or "medium"). */
  severity: "high" | "medium";
  /** Days from "today" to the soonest issue this signal covers (0..365+). */
  daysToImpact: number;
  /** Listing display name (used in some templates for clarity). */
  listingName: string;
  /** Same-tenant historical context for this listing (and its peers). */
  history: SignalHistoryContext;
};

export type SignalPriceComparison = {
  /** Display label for the affected date (e.g. "Sat 9 May"). */
  dateLabel: string;
  /** Currently published rate for that date (e.g. live calendar rate). */
  currentRate: number;
  /** Recommended rate for that date from the calendar's pricing engine. */
  recommendedRate: number;
  /** ISO-4217 currency code, used to render the prices. */
  currency: string;
};

export type SignalHistoryContext = {
  /**
   * If this listing dropped its rate within ~7 days of check-in last year on a
   * similar week and that drop subsequently booked, hold the example here.
   * `dropPct` is positive (e.g. 10 means a 10% cut). `bookedAfterCutDays`
   * captures how soon after the cut the night converted.
   */
  lastYearRateCutThatBooked: {
    dropPct: number;
    bookedAfterCutDays: number;
    monthLabel: string;
  } | null;
  /**
   * Recent example (last ~14 days) where the same tenant held rate on a
   * similar property at similar occupancy and it still booked. Useful for
   * "holding may be safe" suggestions.
   */
  recentHeldRateThatBooked: {
    peerListingName: string;
  } | null;
  /**
   * Portfolio occupancy at the same horizon. If the rest of this tenant's
   * portfolio is also low, the message should hint at market-wide softness
   * rather than this listing being uniquely off.
   */
  portfolioOccupancyAtHorizon: number | null;
  /** Occupancy on this listing at the same horizon as the signal. */
  listingOccupancyAtHorizon: number | null;
  /**
   * Calendar-engine recommended rate vs current rate for the soonest
   * affected date. Caller must source the recommended rate from the same
   * pipeline that powers the calendar (no formula duplication here). Null
   * when the calendar has no recommendation or current rate for that date.
   */
  priceComparisonAtHorizon: SignalPriceComparison | null;
};

const MAX_SUGGESTIONS = 3;
const PRICE_GAP_THRESHOLD_PCT = 5;

/**
 * Build 1-3 short suggestion strings for a signal. Always read-only.
 *
 * Returned strings are intentionally plain English; the UI renders them as
 * a bullet list under the signal card.
 */
export function buildSignalSuggestions(input: SignalSuggestionInput): string[] {
  const out: string[] = [];

  const isOccupancySignal = input.reasonKeys.some((key) => key.startsWith("occ_"));
  const isPaceSignal = input.reasonKeys.includes("pace_month_revenue_20");
  const isAdrSignal = input.reasonKeys.includes("adr_month_diff_10");
  const horizonShort = input.daysToImpact <= 14;
  const horizonMedium = input.daysToImpact > 14 && input.daysToImpact <= 60;

  // Pattern 1: same listing has a precedent of a same-week rate cut that booked.
  if ((isOccupancySignal || isPaceSignal) && input.history.lastYearRateCutThatBooked) {
    const { dropPct, bookedAfterCutDays, monthLabel } = input.history.lastYearRateCutThatBooked;
    const cutRounded = Math.round(dropPct);
    const dayWord = bookedAfterCutDays === 1 ? "day" : "days";
    out.push(
      `Last year on ${monthLabel} you dropped this listing's rate ~${cutRounded}% within ${bookedAfterCutDays} ${dayWord} of check-in and it booked. A similar trim may help here.`
    );
  }

  // Pattern 2: peer listing held rate recently and still booked - holding may be safe.
  if (
    (isOccupancySignal || isPaceSignal) &&
    horizonShort &&
    input.history.recentHeldRateThatBooked
  ) {
    out.push(
      `Last week you held rate on ${input.history.recentHeldRateThatBooked.peerListingName} at similar occupancy and it still booked - holding may be safe here for another day or two.`
    );
  }

  // Pattern 3: price-driven suggestion. Compare the calendar's recommended
  // rate against the current rate for the affected date. Only fires when
  // the gap is >5% — anything tighter is noise. Recommended rate comes from
  // the same calendar pipeline; this branch never recomputes the price.
  const price = input.history.priceComparisonAtHorizon;
  if ((isOccupancySignal || isPaceSignal) && price && price.currentRate > 0 && price.recommendedRate > 0) {
    const recommended = formatPriceForSuggestion(price.recommendedRate, price.currency);
    const current = formatPriceForSuggestion(price.currentRate, price.currency);
    const gapPct = ((price.recommendedRate - price.currentRate) / price.currentRate) * 100;
    if (gapPct <= -PRICE_GAP_THRESHOLD_PCT) {
      out.push(
        `Recommended rate for ${price.dateLabel} is ${recommended} (currently ${current}). Dropping to recommended may book the gap.`
      );
    } else if (gapPct >= PRICE_GAP_THRESHOLD_PCT) {
      out.push(
        `Recommended rate for ${price.dateLabel} is ${recommended} (currently ${current}). You may be leaving revenue on the table.`
      );
    }
  }

  // Pattern 4: portfolio-wide softness vs listing-specific softness.
  if (
    isOccupancySignal &&
    input.history.portfolioOccupancyAtHorizon !== null &&
    input.history.listingOccupancyAtHorizon !== null
  ) {
    const port = input.history.portfolioOccupancyAtHorizon;
    const self = input.history.listingOccupancyAtHorizon;
    if (port < 50 && self < port + 5) {
      out.push(
        `The rest of your portfolio is also at ${Math.round(port)}% occupancy in this window - the softness looks market-wide, not specific to this listing.`
      );
    } else if (port >= 65 && self < port - 10) {
      out.push(
        `Other listings in your portfolio are pacing at ${Math.round(port)}% in this window - this one is the outlier, so check rate and photos first.`
      );
    }
  }

  // Pattern 5: ADR much higher than LY - hold rate vs sanity-check.
  if (isAdrSignal) {
    if (horizonShort) {
      out.push(
        "ADR is well above last year on a near-term night - sanity-check whether you're losing the booking or just leaving a few percent on the table."
      );
    } else if (horizonMedium) {
      out.push(
        "ADR is well above last year for an upcoming month - if pacing is on track keep holding, otherwise consider trimming on weekday gap nights."
      );
    } else {
      out.push(
        "ADR is well above last year months out - safe to hold for now, but watch the next pace check before doubling down."
      );
    }
  }

  // Always-on fallback so a card never shows zero suggestions.
  if (out.length === 0) {
    if (isOccupancySignal && horizonShort) {
      out.push("Review near-term rates and restrictions for the next 14 days first.");
    } else if (isPaceSignal) {
      out.push("Inspect the pacing gap month-by-month and correct rate position before demand hardens elsewhere.");
    } else {
      out.push("Open the property in drilldown to confirm rate and availability.");
    }
  }

  return out.slice(0, MAX_SUGGESTIONS);
}

function formatPriceForSuggestion(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}
