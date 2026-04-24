import type {
  AirRoiClient,
  AirRoiComparableListing,
  AirRoiComparableQuery,
  AirRoiCurrencyMode,
  AirRoiFutureRate,
  AirRoiMarket,
  AirRoiMarketFilter,
  AirRoiMarketQueryRequest,
  AirRoiMarketSummary,
  AirRoiMetricSeriesPoint
} from "@/lib/airroi/types";

export type MarketDataProvider = AirRoiClient;
export type MarketComparableListing = AirRoiComparableListing;
export type MarketComparableQuery = AirRoiComparableQuery;
export type MarketCurrencyMode = AirRoiCurrencyMode;
export type MarketFutureRate = AirRoiFutureRate;
export type MarketIdentity = AirRoiMarket;
export type MarketFilter = AirRoiMarketFilter;
export type MarketQueryRequest = AirRoiMarketQueryRequest;
export type MarketSummary = AirRoiMarketSummary;
export type MarketMetricSeriesPoint = AirRoiMetricSeriesPoint;

/**
 * Market data provider factory.
 *
 * ⚠️  AirROI is INTENTIONALLY DISABLED. Mark asked on 2026-04-24 that the app
 * make ZERO calls to the AirROI API — the next market data provider will be
 * Key Data, and we will switch over to it once the Key Data integration is
 * built. Until then, this function returns `null` unconditionally.
 *
 * The single caller (`buildMarketPricingContexts` in market-recommendations.ts)
 * safely handles a `null` return by short-circuiting to an empty context map,
 * so pricing recommendations will simply run without any external market
 * signals. This is the desired behaviour while we wait for Key Data.
 *
 * The `MARKET_PROVIDER` env var is reserved for the future (values will be
 * `"none"` | `"keydata"`); for now we treat everything as `"none"` to make
 * the moratorium explicit and impossible to bypass via the old
 * `ROOMY_ENABLE_LIVE_MARKET_REFRESH` flag.
 *
 * To re-enable a provider in the future:
 *   1. Implement a Key Data client that satisfies the `AirRoiClient` interface
 *      (rename the interface when the swap is final).
 *   2. Replace the body below with a switch on `process.env.MARKET_PROVIDER`.
 *   3. Delete the `@/lib/airroi` code path entirely.
 */
export function createMarketDataProvider(
  _config?: { forceRefresh?: boolean; allowLiveFetch?: boolean }
): MarketDataProvider | null {
  const provider = (process.env.MARKET_PROVIDER ?? "none").toLowerCase();
  if (provider !== "none" && provider !== "") {
    // Forward-compatible hook for Key Data. Fall through to `null` until the
    // Key Data client is actually wired up.
    console.warn(
      `[market-data-provider] MARKET_PROVIDER="${provider}" is not yet implemented; returning null.`
    );
  }
  return null;
}
