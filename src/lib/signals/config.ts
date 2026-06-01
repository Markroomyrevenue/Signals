/**
 * Signals rate scanner — tunable knobs (single source of truth).
 *
 * The scanner is a read-only observer: it records how live Hostaway rates
 * move over time into its own four tables and never writes anywhere else.
 * Every value the scan/attribution/baseline logic depends on lives here so
 * there is exactly one place to tune behaviour.
 */

/** Days forward of today to scan the calendar for each listing. */
export const SCAN_HORIZON_DAYS = 365;

/** A booking is attributed to a rate change if it landed within this many
 *  hours of the change, on the same stay-date. */
export const ATTRIBUTION_WINDOW_HOURS = 48;

/** Trailing lookback for the "% of yearly ADR" baseline (booked nightly rate
 *  median). */
export const YEARLY_ADR_TRAILING_DAYS = 365;

/** Below this many booked nights in the trailing window there is not enough
 *  signal to trust a median — `computeYearlyAdrMedian` returns null. */
export const MIN_NIGHTS_FOR_BASELINE = 5;

/** Ignore sub-epsilon price noise so float dust is not logged as a "move"
 *  (currency units). */
export const PRICE_CHANGE_EPSILON = 0.01;

/** The three levers the scanner tracks. */
export const LEVERS = ["price", "min_stay", "availability"] as const;

export type Lever = (typeof LEVERS)[number];
