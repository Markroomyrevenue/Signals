/**
 * KeyData provider — Belfast trial only.
 *
 * Implements the four §4.1 methods used by the new pricing model:
 *   - getMarketBenchmark     (P20/P50/P80 of comparable listings' last-12mo ADR)
 *   - getCitySeasonalityIndex (12 monthly multipliers, OTA market KPIs monthly)
 *   - getCityDayOfWeekIndex   (7 weekday multipliers, PM market KPIs daily)
 *   - getForwardPace          (per-date forward occ/ADR + LY comparison)
 *
 * Tyler @ KeyData confirmed (email forwarded mid-build): the trial key is
 * OTA-ONLY. PM endpoints are NOT in scope — we do not call them.
 *
 * Endpoint mapping (OTA-only):
 *   - POST /api/v1/ota/market/listings        → benchmark (compute P20/P50/P80)
 *   - POST /api/v1/ota/market/kpis/month      → seasonality + forward-pace fallback
 *   - POST /api/v1/ota/market/kpis/week       → forward pace (weekly granularity)
 *   - DoW: returns null. The OTA market KPIs are weekly aggregates only;
 *          true DoW would require listing-level availability calls and burn
 *          the trial budget. Trial pricing handles null DoW by collapsing
 *          to ownDoW only — see blendDayOfWeek() in trial-pricing.ts.
 *
 * Belfast market_uuid: Tyler did not provide directly. The provider tries
 * `KEYDATA_BELFAST_MARKET_UUID` env var first (let Mark paste it once
 * Tyler shares it); falls back to attempting a market-listings call with
 * an empty filter and reading the market block from the response.
 *
 * Belt-and-braces hard-fail: trial-mode check + non-Belfast marketKey check.
 */

import { cacheKey, readCache, writeCache } from "@/lib/pricing/keydata-cache";

export type KeyDataMarketBenchmarkInput = {
  marketKey: "belfast";
  bedrooms: number;
  roomType?: string;
  qualityTier?: "low_scale" | "mid_scale" | "upscale";
  amenities?: string[];
};

export type KeyDataMarketBenchmark = {
  p20: number;
  p50: number;
  p80: number;
  sampleSize: number;
};

export type KeyDataSeasonalityIndex = {
  /** 12 multipliers indexed Jan(0)..Dec(11). 1.0 = baseline, 1.10 = +10% over annual median. */
  months: number[];
  baselineAnnualMedian: number;
  sampleSize: number;
};

export type KeyDataDayOfWeekIndex = {
  /** 7 multipliers indexed Sun(0)..Sat(6). 1.0 = baseline. */
  days: number[];
  sampleSize: number;
};

export type KeyDataForwardPaceDay = {
  date: string; // YYYY-MM-DD
  forwardOccupancy: number; // 0-1
  forwardADR: number;
  /**
   * Adjusted RevPar (revpar_adj) from the KeyData daily KPI response.
   * KeyData adjusts this to filter out outlier rates / promo periods, so
   * it's more stable than raw ADR × occupancy when comparing dates.
   */
  forwardRevparAdj: number | null;
  /**
   * Average booking window in days for this date's bookings. Leading
   * indicator of event-driven demand: when this is unusually high vs
   * its 13-week trailing median, people are booking earlier than normal
   * for that target date.
   */
  forwardBookingWindow: number | null;
  /**
   * 2026-05-22 — market listing_count for the date from the KD daily
   * `/api/v1/ota/market/kpis/day` endpoint. Used as the supply guard
   * for the cross-sectional demand signal: when supply contracts >20%
   * vs the same-month peer median AND ADR is flat/down, the occupancy
   * lift is artificial (e.g. fire-sale) and the demand delta is damped
   * to ADR-only.
   */
  marketSupplyCount: number | null;
  sampleSize: number;
};

export type KeyDataForwardPaceLY = {
  date: string;
  forwardOccupancyLY: number;
  forwardADRLY: number;
  forwardRevparAdjLy: number | null;
  forwardBookingWindowLy: number | null;
};

export type KeyDataForwardPace = {
  perDate: KeyDataForwardPaceDay[];
  lastYearComparison: KeyDataForwardPaceLY[];
  /**
   * 13-week trailing median of avg_booking_window across the forward
   * range. Used by the classifier to compute booking-window lift per
   * target date.
   */
  forwardBookingWindowMedian: number | null;
};

/**
 * Trailing 12-month summary of a single listing from KeyData's view.
 * Used to sanity-check our own NightFact aggregates: if KeyData says a
 * listing did 67% occupancy at £180 ADR over the last year and our
 * internal data says 75% / £200, our pricing inputs are calibrated
 * wrong and base price recommendations will compound the error.
 */
/**
 * Trailing 12-month market summary, powers both:
 *   - the demand multiplier's "trailing baseline" half (so a forward
 *     date's occ + ADR can be measured against a stable 52-week median
 *     in addition to LY-same-week)
 *   - the KD-derived seasonality index (weekly KPIs aggregated by
 *     start-date month → monthly mean ÷ annual median → 12-element
 *     index array)
 *
 * Computed in one API round-trip per (market × bedroom band) and
 * cached for 14 days since the underlying data shifts slowly.
 */
export type KeyDataTrailingMarketKpis = {
  marketKey: "belfast";
  bedrooms: number;
  /** Median guest_occupancy across the 52 weekly buckets (0-1). */
  trailingMedianOccupancy: number | null;
  /** Median ADR across the 52 weekly buckets. */
  trailingMedianAdr: number | null;
  /** Median revpar_adj — more stable than ADR × occ. */
  trailingMedianRevparAdj: number | null;
  /**
   * 12-element seasonality index, monthAdr / annualMedianAdr.
   * Index 0 = January. Months with no data fall back to 1.0.
   */
  seasonalityByMonth: number[];
  /** Sample size — number of weekly buckets that had non-null ADR. */
  weeklySampleSize: number;
};

export type KeyDataListingKpiSummary = {
  listingId: string; // KD listing_id, e.g. "airbnb_<airbnb_id>"
  trailingAdr: number | null;
  trailingOccupancy: number | null; // 0-1
  /**
   * Average length of stay in nights across the trailing 12 months.
   * Used to convert the listing's per-stay cleaning fee into a per-night
   * cleaning-fee amount when stripping cleaning fees from KeyData's ADR
   * for an apples-to-apples calibration check (KD includes cleaning fee
   * in their ADR; our model and PriceLabs both exclude it).
   */
  trailingAvgStayLength: number | null;
  sampleMonths: number;
};

export type KeyDataProvider = {
  getBelfastMarketUuid(): Promise<string | null>;
  getMarketBenchmark(input: KeyDataMarketBenchmarkInput): Promise<KeyDataMarketBenchmark | null>;
  getCitySeasonalityIndex(input: { marketKey: "belfast" }): Promise<KeyDataSeasonalityIndex | null>;
  getCityDayOfWeekIndex(input: { marketKey: "belfast" }): Promise<KeyDataDayOfWeekIndex | null>;
  getForwardPace(input: { marketKey: "belfast"; bedrooms: number; horizonDays: 90 }): Promise<KeyDataForwardPace | null>;
  /**
   * Per-listing trailing 12-month KPI summary. Used to sanity-check
   * our own NightFact aggregates against KeyData's view of the same
   * listing. Cached for 7 days per listing (the underlying data
   * changes slowly).
   */
  getListingKpiSummary(input: { listingId: string }): Promise<KeyDataListingKpiSummary | null>;
  /**
   * Trailing 52-week market KPIs aggregated. One round-trip per
   * (market × bedroom band), cached 14d. Used as the trailing
   * baseline for the demand multiplier AND as the source for the
   * KD-derived monthly seasonality index.
   */
  getTrailingMarketKpis(input: { marketKey: "belfast"; bedrooms: number }): Promise<KeyDataTrailingMarketKpis | null>;
};

// Sample-size guards per §4.2 (non-negotiable).
export const MIN_BENCHMARK_SAMPLE = 20;
export const MIN_INDEX_SAMPLE = 50;

const HEADERS_JSON = { "content-type": "application/json", accept: "application/json" };

type KeyDataConfig = {
  baseUrl: string;
  pmKey: string;
  otaKey: string;
  trialMode: string;
};

function readConfig(): KeyDataConfig | { error: string } {
  const baseUrl = (process.env.KEYDATA_API_BASE_URL ?? "").replace(/\/+$/, "");
  const pmKey = process.env.KEYDATA_ACCESS_KEY ?? "";
  const otaKey = process.env.KEYDATA_OTA_ACCESS_KEY || pmKey;
  const trialMode = process.env.KEYDATA_TRIAL_MODE ?? "";
  if (!baseUrl) return { error: "KEYDATA_API_BASE_URL unset" };
  if (!pmKey) return { error: "KEYDATA_ACCESS_KEY unset" };
  if (trialMode !== "belfast-only") return { error: "KEYDATA_TRIAL_MODE must be 'belfast-only'" };
  return { baseUrl, pmKey, otaKey, trialMode };
}

function assertBelfast(marketKey: string): void {
  if (marketKey !== "belfast") {
    throw new Error(`KeyData trial: non-Belfast marketKey rejected (${marketKey})`);
  }
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  retries = 2
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...HEADERS_JSON, "x-api-key": apiKey },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (res.ok) return { ok: true, status: res.status, data };
      // 401/403: never retry — config issue, not transient. Include the
      // response body in the error so callers can distinguish key-auth
      // failures (no body / "Unauthorized") from market-access denials
      // ("You don't have access to these markets") — same status code,
      // very different remediation.
      if (res.status === 401 || res.status === 403) {
        const bodySummary = typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data ?? {}).slice(0, 200);
        return { ok: false, status: res.status, data, error: `http ${res.status}: ${bodySummary}` };
      }
      lastError = `http ${res.status}: ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`;
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return { ok: false, status: res.status, data, error: lastError };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  return { ok: false, status: 0, data: null, error: lastError || "unknown fetch error" };
}

async function getJson(
  url: string,
  apiKey: string,
  retries = 2
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { ...HEADERS_JSON, "x-api-key": apiKey } });
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (res.ok) return { ok: true, status: res.status, data };
      if (res.status === 401 || res.status === 403) {
        const bodySummary = typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data ?? {}).slice(0, 200);
        return { ok: false, status: res.status, data, error: `http ${res.status}: ${bodySummary}` };
      }
      lastError = `http ${res.status}`;
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return { ok: false, status: res.status, data, error: lastError };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  return { ok: false, status: 0, data: null, error: lastError };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedAsc[lower];
  const weight = idx - lower;
  return sortedAsc[lower] * (1 - weight) + sortedAsc[upper] * weight;
}

// ---------------------------------------------------------------------------
// Live provider implementation
// ---------------------------------------------------------------------------

// Module-level flag so the "UUID is unset" warning only logs once per
// process instead of once per provider call. Each daily pipeline run is a
// new process, so Mark still sees the warning every day until he sets it.
let warnedAboutMissingUuid = false;

export function createKeyDataProvider(): KeyDataProvider | null {
  const raw = readConfig();
  if ("error" in raw) {
    console.warn(`[keydata-provider] disabled: ${raw.error}`);
    return null;
  }
  const cfg: KeyDataConfig = raw;

  async function getBelfastMarketUuid(): Promise<string | null> {
    // Resolution order:
    //  1. KEYDATA_BELFAST_MARKET_UUID env var — always wins. Set this
    //     once Tyler confirms the Belfast UUID so the provider never
    //     burns a discovery call.
    //  2. Auto-discover via `GET /api/v1/pm/lookups`. The Postman docs
    //     for this endpoint document an `available_markets` array of
    //     `{ uuid, name }` objects. Note: this endpoint is on the PM
    //     surface, so a strict OTA-only key returns 401 here — that is
    //     fine, we just surface the error and return null.
    //
    // Cached so we don't re-discover every daily run.
    const explicit = process.env.KEYDATA_BELFAST_MARKET_UUID;
    if (explicit && explicit.trim().length > 0) return explicit.trim();

    const cacheKeyStr = cacheKey("market-uuid", "belfast", "v2");
    const cached = await readCache(cacheKeyStr);
    if (cached && typeof cached.payload === "string" && cached.payload.length > 0) {
      return cached.payload;
    }

    // The PM key is preferred for lookups, but fall back to the OTA key
    // because some accounts use a single key for both surfaces.
    const lookupKey = cfg.pmKey || cfg.otaKey;
    const probe = await getJson(`${cfg.baseUrl}/api/v1/pm/lookups`, lookupKey);
    if (!probe.ok) {
      // 401 here typically means "this key is OTA-only" — fail soft and
      // ask for the env var. Any other error is also fine to swallow:
      // the daily report still renders, just with no market signal.
      console.warn(
        `[keydata] auto-discovery via /api/v1/pm/lookups failed (${probe.error}). Set KEYDATA_BELFAST_MARKET_UUID in .env to the UUID returned by GET /api/v1/pm/lookups → available_markets[?name == "Belfast"].uuid.`
      );
      return null;
    }

    const root = (probe.data ?? {}) as {
      available_markets?: Array<{ uuid?: string; name?: string }>;
      default_market?: { uuid?: string; name?: string };
    };
    const markets = Array.isArray(root.available_markets) ? root.available_markets : [];
    const belfast = markets.find(
      (m) => typeof m.name === "string" && m.name.trim().toLowerCase().includes("belfast") && typeof m.uuid === "string" && m.uuid.length > 0
    );
    if (belfast?.uuid) {
      await writeCache(cacheKeyStr, belfast.uuid, "lookups", null);
      console.log(`[keydata] auto-discovered Belfast market_uuid=${belfast.uuid}`);
      return belfast.uuid;
    }

    // No Belfast in the available_markets list — surface the names we
    // DID see so Mark knows what's accessible to this key.
    const names = markets
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
    console.warn(
      `[keydata] lookups returned ${markets.length} markets but none matched "belfast". Available: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ", …" : ""}. Ask Tyler to grant Belfast access to this key, or set KEYDATA_BELFAST_MARKET_UUID manually.`
    );
    return null;
  }

  async function getMarketBenchmark(input: KeyDataMarketBenchmarkInput): Promise<KeyDataMarketBenchmark | null> {
    assertBelfast(input.marketKey);
    const marketUuid = await getBelfastMarketUuid();
    if (!marketUuid) {
      if (!warnedAboutMissingUuid) {
        console.warn(
          "[keydata] KEYDATA_BELFAST_MARKET_UUID env var is unset — provider cannot call OTA endpoints (every one requires market_uuid). Ask Tyler @ KeyData for the Belfast market UUID and set it in .env."
        );
        warnedAboutMissingUuid = true;
      }
      return null;
    }

    const tier = input.qualityTier ?? "any";
    const key = cacheKey("benchmark", input.marketKey, "br", input.bedrooms, "tier", tier);
    const cached = await readCache(key);
    if (cached) return cached.payload as KeyDataMarketBenchmark;

    // Beta API caps `pagination.limit` at 100, so we paginate when there
    // are more matches than fit in one page. We stop once we have at
    // least the benchmark sample minimum or `MAX_BENCHMARK_PAGES` worth
    // of data — whichever comes first — to keep us inside the daily
    // call budget.
    const PAGE_SIZE = 100;
    const MAX_BENCHMARK_PAGES = 5;
    const allListings: Array<{ performance?: { last_12_months?: { adr?: number } }; bedrooms?: number }> = [];
    for (let pageIndex = 0; pageIndex < MAX_BENCHMARK_PAGES; pageIndex += 1) {
      const body = {
        market_uuid: marketUuid,
        currency: "GBP",
        pagination: { limit: PAGE_SIZE, offset: pageIndex * PAGE_SIZE, sort_by: "last_12mo_revenue" },
        filters: {
          bedrooms: { min: Math.max(0, input.bedrooms - 1), max: input.bedrooms + 1 }
          // We deliberately don't pre-filter by quality tier here — KeyData's
          // OTA listing schema doesn't expose a tier field. Tier is applied
          // at the recommender stage via the existing similarity machinery.
        },
        data_select: { exclude: ["amenity_list", "host", "reviews"] }
      };
      const res = await postJson(`${cfg.baseUrl}/api/v1/ota/market/listings`, cfg.otaKey, body);
      if (!res.ok) {
        console.warn(`[keydata] benchmark failed (page ${pageIndex + 1}): ${res.error}`);
        if (pageIndex === 0) return null; // first page failure is fatal; later page failure just truncates
        break;
      }
      const root = (res.data ?? {}) as { listings?: Array<{ performance?: { last_12_months?: { adr?: number } }; bedrooms?: number }> };
      const batch = Array.isArray(root.listings) ? root.listings : [];
      allListings.push(...batch);
      // Stop early when KeyData returns less than a full page (no more data)
      if (batch.length < PAGE_SIZE) break;
      // Stop early when we already have enough samples
      if (allListings.length >= Math.max(MIN_BENCHMARK_SAMPLE * 4, PAGE_SIZE * 2)) break;
    }
    const listings = allListings;
    // Same-bedroom band first
    const sameBr = listings.filter((l) => l.bedrooms === input.bedrooms && Number.isFinite(l.performance?.last_12_months?.adr));
    let pool = sameBr;
    if (pool.length < MIN_BENCHMARK_SAMPLE) {
      // Broaden to ±1 bedroom (already in query filter)
      pool = listings.filter((l) => Number.isFinite(l.performance?.last_12_months?.adr));
    }
    if (pool.length < MIN_BENCHMARK_SAMPLE) {
      console.warn(`[keydata] benchmark sample too small: ${pool.length} < ${MIN_BENCHMARK_SAMPLE}`);
      return null;
    }
    const adrs = pool
      .map((l) => Number(l.performance?.last_12_months?.adr))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (adrs.length < MIN_BENCHMARK_SAMPLE) return null;
    const result: KeyDataMarketBenchmark = {
      p20: percentile(adrs, 0.2),
      p50: percentile(adrs, 0.5),
      p80: percentile(adrs, 0.8),
      sampleSize: adrs.length
    };
    await writeCache(key, result, "benchmark", result.sampleSize);
    return result;
  }

  async function getCitySeasonalityIndex(input: { marketKey: "belfast" }): Promise<KeyDataSeasonalityIndex | null> {
    assertBelfast(input.marketKey);
    const marketUuid = await getBelfastMarketUuid();
    if (!marketUuid) return null;
    const key = cacheKey("seasonality", input.marketKey, "v1");
    const cached = await readCache(key);
    if (cached) return cached.payload as KeyDataSeasonalityIndex;

    const today = new Date();
    const start = new Date(today.getFullYear() - 2, today.getMonth(), 1);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = today.toISOString().slice(0, 10);

    const body = {
      market_uuid: marketUuid,
      start_date: startStr,
      end_date: endStr,
      currency: "GBP"
    };
    const res = await postJson(`${cfg.baseUrl}/api/v1/ota/market/kpis/month`, cfg.otaKey, body);
    if (!res.ok) {
      console.warn(`[keydata] seasonality failed: ${res.error}`);
      return null;
    }
    const root = (res.data ?? {}) as { data?: { kpis?: Array<{ date?: string; adr?: number }> } };
    const kpis = Array.isArray(root.data?.kpis) ? root.data!.kpis! : [];
    if (kpis.length < 12) {
      console.warn(`[keydata] seasonality sample too small: ${kpis.length}`);
      return null;
    }
    // Aggregate ADR by month-of-year
    const sums = Array(12).fill(0);
    const counts = Array(12).fill(0);
    let totalAdrSum = 0;
    let totalAdrCount = 0;
    for (const row of kpis) {
      const adr = Number(row.adr);
      const d = row.date ? new Date(row.date) : null;
      if (!d || Number.isNaN(d.getTime()) || !Number.isFinite(adr) || adr <= 0) continue;
      const m = d.getUTCMonth();
      sums[m] += adr;
      counts[m] += 1;
      totalAdrSum += adr;
      totalAdrCount += 1;
    }
    const populatedMonths = counts.filter((c) => c > 0).length;
    if (populatedMonths < 8 || totalAdrCount < MIN_INDEX_SAMPLE / 4) {
      // require at least 8 months of data and a reasonable sample size
      console.warn(`[keydata] seasonality sample too thin: months=${populatedMonths}, total=${totalAdrCount}`);
      return null;
    }
    const baseline = totalAdrSum / totalAdrCount;
    const months = sums.map((s, i) => (counts[i] === 0 ? 1.0 : s / counts[i] / baseline));
    const result: KeyDataSeasonalityIndex = {
      months,
      baselineAnnualMedian: baseline,
      sampleSize: totalAdrCount
    };
    await writeCache(key, result, "seasonality", totalAdrCount);
    return result;
  }

  async function getCityDayOfWeekIndex(input: { marketKey: "belfast" }): Promise<KeyDataDayOfWeekIndex | null> {
    assertBelfast(input.marketKey);
    // OTA endpoints expose only weekly+monthly aggregates, no per-day breakdown.
    // Computing true DoW would require N listing-level availability calls
    // (each one covering 90 days × 7 days/week) — comfortably blowing the
    // 250-call trial budget. Per spec §3.3 the blend collapses to ownDoW
    // when marketDoWIndex is null, so this is a documented graceful path.
    return null;
  }

  async function getForwardPace(input: { marketKey: "belfast"; bedrooms: number; horizonDays: 90 }): Promise<KeyDataForwardPace | null> {
    assertBelfast(input.marketKey);
    const marketUuid = await getBelfastMarketUuid();
    if (!marketUuid) return null;
    const key = cacheKey("forward-pace", input.marketKey, "br", input.bedrooms);
    const cached = await readCache(key);
    if (cached) return cached.payload as KeyDataForwardPace;

    // OTA market KPIs DAILY: forward 91 days + the same range LY.
    // Switched 2026-05-22 from `/kpis/week` to `/kpis/day` to unlock true
    // per-date variation (the weekly endpoint returned 13 rows that the
    // provider had to expand 1-to-7, flattening day-of-week structure
    // at the KD layer — every weekday of a given week shared the same
    // occ/ADR/RPA value). Daily granularity is required for the new
    // cross-sectional demand signal in `cross-sectional-demand.ts`,
    // which compares each date against same-month peers and needs each
    // peer's actual per-date metric.
    const today = new Date();
    const horizonEnd = new Date(today);
    horizonEnd.setUTCDate(today.getUTCDate() + 91);
    const lyStart = new Date(today);
    lyStart.setUTCFullYear(today.getUTCFullYear() - 1);
    const lyEnd = new Date(horizonEnd);
    lyEnd.setUTCFullYear(horizonEnd.getUTCFullYear() - 1);

    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const fwdRes = await postJson(`${cfg.baseUrl}/api/v1/ota/market/kpis/day`, cfg.otaKey, {
      market_uuid: marketUuid,
      start_date: fmt(today),
      end_date: fmt(horizonEnd),
      currency: "GBP"
    });
    const lyRes = await postJson(`${cfg.baseUrl}/api/v1/ota/market/kpis/day`, cfg.otaKey, {
      market_uuid: marketUuid,
      start_date: fmt(lyStart),
      end_date: fmt(lyEnd),
      currency: "GBP"
    });
    if (!fwdRes.ok) {
      console.warn(`[keydata] forward-pace primary (daily) failed: ${fwdRes.error}`);
      return null;
    }

    type DayRow = {
      date?: string;
      adr?: number;
      guest_occupancy?: number;
      revpar_adj?: number;
      avg_booking_window?: number;
      listing_count?: number;
      ota_source?: string;
    };
    const fwdRoot = (fwdRes.data ?? {}) as { data?: { kpis?: DayRow[] } };
    const lyRoot = (lyRes.ok ? lyRes.data ?? {} : {}) as { data?: { kpis?: DayRow[] } };
    // KeyData returns separate rows per OTA (airbnb + vrbo). For our
    // comparison purposes Airbnb is the dominant signal in Belfast
    // (~200 listings vs ~20 VRBO), so we filter to Airbnb only to avoid
    // diluting metrics with the much smaller VRBO sample. Falls back to
    // all rows if no Airbnb is present.
    const filterOta = (rows: DayRow[]) => {
      const ab = rows.filter((r) => r.ota_source === "airbnb");
      return ab.length > 0 ? ab : rows;
    };
    const fwdDays = filterOta(fwdRoot.data?.kpis ?? []);
    const lyDays = filterOta(lyRoot.data?.kpis ?? []);

    if (fwdDays.length < 28) {
      console.warn(`[keydata] forward-pace daily too thin: ${fwdDays.length} days`);
      return null;
    }

    // Daily endpoint returns one row per date — no expansion needed.
    // For LY data we shift the API-returned date forward by 365 days
    // so the date keys line up with the current-year forward dates.
    const shiftDate = (iso: string, days: number) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };

    const perDate: KeyDataForwardPaceDay[] = fwdDays
      .filter((r) => !!r.date && Number.isFinite(Number(r.guest_occupancy)) && Number.isFinite(Number(r.adr)))
      .map((r) => {
        const occRaw = Number(r.guest_occupancy);
        return {
          date: r.date as string,
          forwardOccupancy: occRaw > 1 ? occRaw / 100 : occRaw,
          forwardADR: Number(r.adr),
          forwardRevparAdj: Number.isFinite(Number(r.revpar_adj)) ? Number(r.revpar_adj) : null,
          forwardBookingWindow: Number.isFinite(Number(r.avg_booking_window)) ? Number(r.avg_booking_window) : null,
          marketSupplyCount: Number.isFinite(Number(r.listing_count)) ? Number(r.listing_count) : null,
          sampleSize: 1
        };
      });

    const lastYearComparison: KeyDataForwardPaceLY[] = lyDays
      .filter((r) => !!r.date && Number.isFinite(Number(r.guest_occupancy)) && Number.isFinite(Number(r.adr)))
      .map((r) => {
        const shifted = shiftDate(r.date as string, 365);
        if (!shifted) return null;
        const occRaw = Number(r.guest_occupancy);
        return {
          date: shifted,
          forwardOccupancyLY: occRaw > 1 ? occRaw / 100 : occRaw,
          forwardADRLY: Number(r.adr),
          forwardRevparAdjLy: Number.isFinite(Number(r.revpar_adj)) ? Number(r.revpar_adj) : null,
          forwardBookingWindowLy: Number.isFinite(Number(r.avg_booking_window)) ? Number(r.avg_booking_window) : null
        };
      })
      .filter((r): r is KeyDataForwardPaceLY => r !== null);

    // Trailing median across all forward days — used as the baseline
    // for booking-window-lift detection by the divergence-cause classifier.
    const bwValues = fwdDays
      .map((r) => Number(r.avg_booking_window))
      .filter((v): v is number => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    const forwardBookingWindowMedian = bwValues.length > 0 ? bwValues[Math.floor(bwValues.length / 2)] : null;

    const result: KeyDataForwardPace = { perDate, lastYearComparison, forwardBookingWindowMedian };
    await writeCache(key, result, "forward-pace", perDate.length);
    return result;
  }

  /**
   * Per-listing trailing 12-month aggregate. Calls /api/v1/ota/listing/kpis/month
   * for the listing and averages ADR + occupancy across the months
   * returned. Caches per listing for 7 days.
   */
  async function getListingKpiSummary(input: { listingId: string }): Promise<KeyDataListingKpiSummary | null> {
    if (!input.listingId || input.listingId.length === 0) return null;
    const cacheKeyStr = cacheKey("listing-kpis", input.listingId, "12mo");
    const cached = await readCache(cacheKeyStr);
    if (cached) return cached.payload as KeyDataListingKpiSummary;

    const today = new Date();
    const start = new Date(today);
    start.setUTCFullYear(today.getUTCFullYear() - 1);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const res = await postJson(`${cfg.baseUrl}/api/v1/ota/listing/kpis/month`, cfg.otaKey, {
      listing_id: input.listingId,
      start_date: fmt(start),
      end_date: fmt(today),
      currency: "GBP"
    });
    if (!res.ok) {
      // Don't spam — log once at warn but cache a null result for an
      // hour so we don't retry on every render. (Cache layer doesn't
      // support negative caching, so we just return null and let the
      // 7-day TTL apply on next success.)
      console.warn(`[keydata] listing-kpis failed for ${input.listingId}: ${res.error}`);
      return null;
    }
    type MonthRow = { date?: string; adr?: number; guest_occupancy?: number; avg_stay_length?: number };
    const root = (res.data ?? {}) as { data?: { kpis?: MonthRow[] } };
    const kpis = Array.isArray(root.data?.kpis) ? root.data!.kpis! : [];
    if (kpis.length === 0) {
      const empty: KeyDataListingKpiSummary = { listingId: input.listingId, trailingAdr: null, trailingOccupancy: null, trailingAvgStayLength: null, sampleMonths: 0 };
      await writeCache(cacheKeyStr, empty, "listing-kpis", 0);
      return empty;
    }
    let adrSum = 0;
    let adrCount = 0;
    let occSum = 0;
    let occCount = 0;
    let stayLenSum = 0;
    let stayLenCount = 0;
    for (const m of kpis) {
      const adr = Number(m.adr);
      const occ = Number(m.guest_occupancy);
      const stay = Number(m.avg_stay_length);
      if (Number.isFinite(adr) && adr > 0) {
        adrSum += adr;
        adrCount += 1;
      }
      if (Number.isFinite(occ) && occ >= 0) {
        // KD returns occupancy as 0-1 in OTA endpoints; defensive cast.
        occSum += occ > 1 ? occ / 100 : occ;
        occCount += 1;
      }
      if (Number.isFinite(stay) && stay > 0) {
        stayLenSum += stay;
        stayLenCount += 1;
      }
    }
    const summary: KeyDataListingKpiSummary = {
      listingId: input.listingId,
      trailingAdr: adrCount > 0 ? adrSum / adrCount : null,
      trailingOccupancy: occCount > 0 ? occSum / occCount : null,
      trailingAvgStayLength: stayLenCount > 0 ? stayLenSum / stayLenCount : null,
      sampleMonths: Math.max(adrCount, occCount)
    };
    await writeCache(cacheKeyStr, summary, "listing-kpis", summary.sampleMonths);
    return summary;
  }

  /**
   * Trailing 52-week market summary. Single round-trip per
   * (market × bedroom band). Two outputs from one fetch: a trailing-
   * baseline (median occ/ADR/revpar across 52 weeks) for the demand
   * multiplier, and a 12-element monthly seasonality index from
   * weekly aggregation.
   */
  async function getTrailingMarketKpis(input: { marketKey: "belfast"; bedrooms: number }): Promise<KeyDataTrailingMarketKpis | null> {
    assertBelfast(input.marketKey);
    const marketUuid = await getBelfastMarketUuid();
    if (!marketUuid) {
      if (!warnedAboutMissingUuid) {
        console.warn(
          "[keydata] KEYDATA_BELFAST_MARKET_UUID env var is unset — provider cannot call OTA endpoints (every one requires market_uuid). Ask Tyler @ KeyData for the Belfast market UUID and set it in .env."
        );
        warnedAboutMissingUuid = true;
      }
      return null;
    }
    const key = cacheKey("trailing-market-kpis", input.marketKey, "br", input.bedrooms, "v2");
    const cached = await readCache(key);
    if (cached) return cached.payload as KeyDataTrailingMarketKpis;

    const today = new Date();
    const start = new Date(today);
    start.setUTCDate(today.getUTCDate() - 365);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const res = await postJson(`${cfg.baseUrl}/api/v1/ota/market/kpis/week`, cfg.otaKey, {
      market_uuid: marketUuid,
      start_date: fmt(start),
      end_date: fmt(today),
      currency: "GBP"
    });
    if (!res.ok) {
      console.warn(`[keydata] trailing-market-kpis failed: ${res.error}`);
      return null;
    }
    type WeekRow = {
      date?: string;
      adr?: number;
      guest_occupancy?: number;
      revpar_adj?: number;
      ota_source?: string;
    };
    const root = (res.data ?? {}) as { data?: { kpis?: WeekRow[] } };
    // Same OTA filtering as getForwardPace — Airbnb only when present
    // (avoids diluting the metric with the much smaller VRBO sample).
    const allRows = root.data?.kpis ?? [];
    const airbnbRows = allRows.filter((r) => r.ota_source === "airbnb");
    const rows = airbnbRows.length > 0 ? airbnbRows : allRows;

    // Trailing medians across the 52 weekly buckets.
    const occVals = rows.map((r) => Number(r.guest_occupancy)).filter((v): v is number => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const adrVals = rows.map((r) => Number(r.adr)).filter((v): v is number => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const revparVals = rows.map((r) => Number(r.revpar_adj)).filter((v): v is number => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const medianOf = (arr: number[]): number | null => (arr.length === 0 ? null : arr[Math.floor(arr.length / 2)]);
    const trailingMedianOccupancy = (() => {
      const m = medianOf(occVals);
      if (m === null) return null;
      return m > 1 ? m / 100 : m; // defensive: occ should be 0-1
    })();
    const trailingMedianAdr = medianOf(adrVals);
    const trailingMedianRevparAdj = medianOf(revparVals);

    // Monthly seasonality: group weeks by the month their start date
    // falls in. Compute monthly mean ADR. Then index each month against
    // the annual median (so July at £120 vs annual £100 median → 1.20×).
    const monthSums = Array(12).fill(0);
    const monthCounts = Array(12).fill(0);
    for (const r of rows) {
      const adr = Number(r.adr);
      if (!Number.isFinite(adr) || adr <= 0 || !r.date) continue;
      const d = new Date(r.date);
      if (Number.isNaN(d.getTime())) continue;
      const m = d.getUTCMonth();
      monthSums[m] += adr;
      monthCounts[m] += 1;
    }
    const monthMeans: Array<number | null> = monthSums.map((s, i) => (monthCounts[i] === 0 ? null : s / monthCounts[i]));
    const populatedMeans = monthMeans.filter((v): v is number => v !== null);
    const annualMedian = medianOf([...populatedMeans].sort((a, b) => a - b));
    const seasonalityByMonth = monthMeans.map((mean) => (mean === null || annualMedian === null || annualMedian <= 0 ? 1.0 : mean / annualMedian));

    const result: KeyDataTrailingMarketKpis = {
      marketKey: "belfast",
      bedrooms: input.bedrooms,
      trailingMedianOccupancy,
      trailingMedianAdr,
      trailingMedianRevparAdj,
      seasonalityByMonth,
      weeklySampleSize: adrVals.length
    };
    await writeCache(key, result, "seasonality", adrVals.length);
    return result;
  }

  return {
    getBelfastMarketUuid,
    getMarketBenchmark,
    getCitySeasonalityIndex,
    getCityDayOfWeekIndex,
    getForwardPace,
    getListingKpiSummary,
    getTrailingMarketKpis
  };
}
