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
