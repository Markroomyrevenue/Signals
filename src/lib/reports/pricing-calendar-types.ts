import type { PricingAnchorContext } from "@/lib/pricing/market-anchor";
import type {
  PricingDemandTier,
  PricingOccupancyScope,
  PricingQualityTier,
  PricingSensitivityMode,
  PricingSettingSource
} from "@/lib/pricing/settings";

export type PricingCalendarBaseSource =
  | "manual_override"
  | "market_comparable_daily"
  | "market_comparable_summary"
  | "market_adr_fallback"
  | "listing_history_fallback"
  | "live_rate_fallback"
  | "insufficient_data";

export type PricingConfidence = "high" | "medium" | "low";

export type PricingCalendarCellState = "booked" | "available" | "unavailable" | "unknown";

export type PricingCalendarMarketDataStatus = "cached_market_data" | "fallback_pricing" | "needs_setup";

/**
 * Pricing engine mode used to recommend nightly rates for this row.
 *
 * - `standard`: legacy single-unit pipeline (history → market → multipliers).
 * - `multi_unit`: multi-unit listings using the lead-time × occupancy matrix.
 * - `peer_shape`: TEMPORARY model for listings going live with
 *   `hostawayPushEnabled === true`. Anchors on the user's saved base/min
 *   and shapes the daily curve using the rest of the portfolio's available
 *   nightly rates. See `src/lib/pricing/peer-shape.ts` for the full spec.
 */
export type PricingCalendarMode = "standard" | "multi_unit" | "peer_shape" | "rate_copy";

export type PricingCalendarComparisonScopeMeta = {
  totalListings: number;
  appliedListings: number;
  activeBeforeDate: string | null;
};

export type PricingCalendarCell = {
  date: string;
  state: PricingCalendarCellState;
  liveRate: number | null;
  bookedRate: number | null;
  available: boolean | null;
  minStay: number | null;
  maxStay: number | null;
  recommendedRate: number | null;
  recommendedBaseRate: number | null;
  minimumSuggestedRate: number | null;
  anchorRate: number | null;
  areaAverageRate: number | null;
  baseSource: PricingCalendarBaseSource;
  marketMedianRate: number | null;
  historicalFloor: number | null;
  adjustmentPct: number | null;
  anchorSource: PricingCalendarBaseSource;
  confidence: PricingConfidence;
  currentMonthShortStayOccupancy: number | null;
  referenceMonthShortStayOccupancy: number | null;
  marketOccupancy: number | null;
  marketAverageDailyRate: number | null;
  marketFuturePacing: number | null;
  seasonalityPct: number | null;
  seasonalityMultiplier: number | null;
  dayOfWeekPct: number | null;
  dayOfWeekMultiplier: number | null;
  marketDemandTier: PricingDemandTier;
  marketDemandIndex: number;
  marketDemandMultiplier: number | null;
  dailyOccupancyPct: number | null;
  occupancyMultiplier: number | null;
  paceMultiplier: number | null;
  maximumPrice: number | null;
  /**
   * Multi-unit-only per-cell fields. All `null` for single-unit listings,
   * and the calendar UI hides the multi-unit chip + breakdown row in that
   * case. When non-null, the values reflect group-aggregated occupancy
   * (sum of sold ÷ sum of units across listings sharing a `group:` tag).
   */
  multiUnitUnitsSold: number | null;
  multiUnitUnitsTotal: number | null;
  multiUnitOccupancyPct: number | null;
  /** Days from today to this date — used by the matrix lookup. */
  multiUnitLeadTimeDays: number | null;
  /**
   * Peer-shape pricing fields. NON-null only when this row is on the
   * temporary peer-shape branch (`hostawayPushEnabled === true` AND a
   * user base override exists). `peerShapeFactor` is the average of
   * factor_P(D) = peer_rate / peer_yearly_adr across portfolio peers
   * available on this date. `peerShapePeerCount` is how many peers
   * contributed to the factor (when below ~3, factor falls back to 1).
   */
  peerShapeFactor: number | null;
  peerShapePeerCount: number | null;
  /**
   * Rate-copy pricing fields. NON-null only when this row is on the
   * rate-copy branch (`pricingMode === 'rate_copy'`). `rateCopySourceRate`
   * is the source listing's live Hostaway rate that we copied from.
   * `rateCopyOccupancyMultiplier` is the multi-unit occupancy adjustment
   * (1.0 for single-unit). `rateCopyFlooredAtMin` is true when the user's
   * minimum floor engaged on this date. `rateCopySkipReason` is set when
   * the date was skipped (e.g. source had no rate; user min not configured).
   */
  rateCopySourceRate: number | null;
  rateCopyOccupancyMultiplier: number | null;
  rateCopyFlooredAtMin: boolean | null;
  rateCopySkipReason: "no_source_rate" | "source_unavailable" | "missing_user_min" | "missing_target_base" | null;
  /**
   * Manual override metadata. NON-null when an active override applies to
   * this cell. The cell's `recommendedRate` already reflects it.
   * `dynamicRateBeforeOverride` shows what the model would have produced
   * without the override (useful for the inspector UI).
   */
  manualOverride: {
    id: string;
    type: "fixed" | "percentage_delta";
    value: number;
    minStay: number | null;
    notes: string | null;
    startDate: string;
    endDate: string;
  } | null;
  dynamicRateBeforeOverride: number | null;
  effectiveOccupancyScope: PricingOccupancyScope;
  comparableCount: number;
  comparableRateCount: number;
  recommendedPercentile: number | null;
  livePercentile: number | null;
  demandBand: 1 | 2 | 3 | 4 | 5;
  breakdown: Array<{
    label: string;
    amount: number | null;
    unit: "currency" | "percent" | "number" | "multiplier";
  }>;
};

export type PricingCalendarRow = {
  listingId: string;
  listingName: string;
  /**
   * Mirrors `Listing.unitCount`. `null` for single-unit listings (the
   * default for every existing row); >= 2 for a Hostaway listing that
   * represents N rooms of the same type. The calendar UI uses this to
   * render the "× N units" pill and amber row tone.
   */
  unitCount: number | null;
  /**
   * If this multi-unit listing belongs to a custom group with at least
   * one OTHER multi-unit listing in the same group, this is the
   * group key (e.g. "camden block"). Single-unit listings or
   * standalone multi-unit listings have `null` here.
   */
  multiUnitGroupKey: string | null;
  /**
   * Which pricing engine generated this row's per-cell recommendations.
   * The UI uses this to pick the right inspector breakdown (the
   * peer-shape branch hides the occupancy / seasonality / demand rows
   * because the peer-shape factor already encodes that intelligence).
   */
  pricingMode: PricingCalendarMode;
  marketLabel: string | null;
  marketScopeLabel: string | null;
  comparableCount: number;
  comparisonLosNights: number | null;
  marketDataStatus: PricingCalendarMarketDataStatus;
  marketDataMessage: string;
  basePriceSuggestion: {
    value: number | null;
    source: PricingCalendarBaseSource;
    breakdown: Array<{
      label: string;
      amount: number | null;
      unit: "currency" | "percent" | "number" | "multiplier";
    }>;
  };
  minimumPriceSuggestion: {
    value: number | null;
    source: PricingCalendarBaseSource;
    breakdown: Array<{
      label: string;
      amount: number | null;
      unit: "currency" | "percent" | "number" | "multiplier";
    }>;
  };
  pricingAnchors: PricingAnchorContext;
  settings: {
    resolvedGroupName: string | null;
    qualityTier: PricingQualityTier;
    occupancyScope: PricingOccupancyScope;
    seasonalitySensitivityMode: PricingSensitivityMode;
    dayOfWeekSensitivityMode: PricingSensitivityMode;
    demandSensitivityMode: PricingSensitivityMode;
    paceEnabled: boolean;
    // hostawayPushEnabled is the per-listing toggle that opens up the
    // "push live rates to Hostaway" UI. UI hides the push controls
    // when this is false; the API route also gates server-side.
    hostawayPushEnabled: boolean;
    sources: {
      basePriceOverride: PricingSettingSource;
      minimumPriceOverride: PricingSettingSource;
      qualityTier: PricingSettingSource;
      minimumPriceFactor: PricingSettingSource;
      seasonalitySensitivityMode: PricingSettingSource;
      dayOfWeekSensitivityMode: PricingSettingSource;
      demandSensitivityMode: PricingSettingSource;
      occupancyScope: PricingSettingSource;
      paceEnabled: PricingSettingSource;
      roundingIncrement: PricingSettingSource;
    };
  };
  cells: PricingCalendarCell[];
};

export type PricingCalendarResponse = {
  month: {
    start: string;
    end: string;
    label: string;
  };
  days: Array<{
    date: string;
    dayNumber: number;
    weekdayShort: string;
  }>;
  rows: PricingCalendarRow[];
  meta: {
    displayCurrency: string;
    comparisonScope: PricingCalendarComparisonScopeMeta;
    marketData: {
      mode: "stored" | "live_refresh";
      totalRows: number;
      rowsWithCachedMarketData: number;
      rowsUsingFallbackPricing: number;
      rowsNeedingSetup: number;
    };
  };
};
