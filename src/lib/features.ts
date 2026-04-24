export function liveMarketRefreshEnabled(): boolean {
  return process.env.ROOMY_ENABLE_LIVE_MARKET_REFRESH === "true";
}

