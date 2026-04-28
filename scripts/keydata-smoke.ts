/**
 * One-shot smoke test for the KeyData provider. Logs everything to stdout
 * (and to BUILD-LOG via the calling shell). Used during the overnight build
 * to verify the endpoints and capture the Belfast market_uuid.
 */
import { ensureEnvLoaded } from "@/lib/load-env";
ensureEnvLoaded();

import { createKeyDataProvider } from "@/lib/pricing/keydata-provider";

async function main(): Promise<void> {
  const provider = createKeyDataProvider();
  if (!provider) {
    console.log("[smoke] provider returned null — env config issue");
    process.exit(2);
  }

  console.log("[smoke] resolving Belfast market_uuid…");
  const uuid = await provider.getBelfastMarketUuid();
  console.log("[smoke] belfast market_uuid:", uuid);

  if (!uuid) {
    console.log("[smoke] no UUID; aborting further calls");
    return;
  }

  console.log("[smoke] benchmark for 2BR mid_scale…");
  const benchmark = await provider.getMarketBenchmark({
    marketKey: "belfast",
    bedrooms: 2,
    qualityTier: "mid_scale"
  });
  console.log("[smoke] benchmark:", benchmark);

  console.log("[smoke] seasonality…");
  const seasonality = await provider.getCitySeasonalityIndex({ marketKey: "belfast" });
  console.log("[smoke] seasonality:", seasonality ? { months: seasonality.months.map((m) => m.toFixed(3)), sampleSize: seasonality.sampleSize, baseline: seasonality.baselineAnnualMedian.toFixed(2) } : null);

  console.log("[smoke] day-of-week…");
  const dow = await provider.getCityDayOfWeekIndex({ marketKey: "belfast" });
  console.log("[smoke] dow:", dow ? { days: dow.days.map((m) => m.toFixed(3)), sampleSize: dow.sampleSize } : null);

  console.log("[smoke] forward-pace 2BR…");
  const fwd = await provider.getForwardPace({ marketKey: "belfast", bedrooms: 2, horizonDays: 90 });
  console.log("[smoke] forward-pace:", fwd ? { dates: fwd.perDate.length, lyDates: fwd.lastYearComparison.length, firstDate: fwd.perDate[0], lastDate: fwd.perDate[fwd.perDate.length - 1] } : null);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
