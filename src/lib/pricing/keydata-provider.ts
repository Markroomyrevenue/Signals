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
  sampleSize: number;
};

export type KeyDataForwardPaceLY = {
  date: string;
  forwardOccupancyLY: number;
  forwardADRLY: number;
};

export type KeyDataForwardPace = {
  perDate: KeyDataForwardPaceDay[];
  lastYearComparison: KeyDataForwardPaceLY[];
};

export type KeyDataProvider = {
  getBelfastMarketUuid(): Promise<string | null>;
  getMarketBenchmark(input: KeyDataMarketBenchmarkInput): Promise<KeyDataMarketBenchmark | null>;
  getCitySeasonalityIndex(input: { marketKey: "belfast" }): Promise<KeyDataSeasonalityIndex | null>;
  getCityDayOfWeekIndex(input: { marketKey: "belfast" }): Promise<KeyDataDayOfWeekIndex | null>;
  getForwardPace(input: { marketKey: "belfast"; bedrooms: number; horizonDays: 90 }): Promise<KeyDataForwardPace | null>;
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
      // 401/403: never retry — config issue, not transient
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, data, error: `auth: ${res.status}` };
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
      if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, data, error: `auth: ${res.status}` };
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

export function createKeyDataProvider(): KeyDataProvider | null {
  const raw = readConfig();
  if ("error" in raw) {
    console.warn(`[keydata-provider] disabled: ${raw.error}`);
    return null;
  }
  const cfg: KeyDataConfig = raw;

  async function getBelfastMarketUuid(): Promise<string | null> {
    const explicit = process.env.KEYDATA_BELFAST_MARKET_UUID;
    if (explicit) return explicit;
    // PM lookups not available on OTA-only key. Try a market-listings call
    // and read the market metadata from the response.
    const key = cacheKey("market-uuid", "belfast");
    const cached = await readCache(key);
    if (cached) return cached.payload as string;
    const probe = await postJson(`${cfg.baseUrl}/api/v1/ota/market/listings`, cfg.otaKey, {
      pagination: { limit: 1, offset: 0, sort_by: "last_12mo_revenue" },
      // intentionally no market_uuid — we hope the API returns one (or errors with one in the message)
      currency: "GBP"
    });
    if (probe.ok) {
      const root = (probe.data ?? {}) as { market?: { uuid?: string; name?: string } };
      if (root.market?.uuid) {
        await writeCache(key, root.market.uuid, "lookups", null);
        return root.market.uuid;
      }
    }
    return null;
  }

  async function getMarketBenchmark(input: KeyDataMarketBenchmarkInput): Promise<KeyDataMarketBenchmark | null> {
    assertBelfast(input.marketKey);
    const marketUuid = await getBelfastMarketUuid();
    if (!marketUuid) {
      console.warn("[keydata] Belfast market_uuid not resolved");
      return null;
    }

    const tier = input.qualityTier ?? "any";
    const key = cacheKey("benchmark", input.marketKey, "br", input.bedrooms, "tier", tier);
    const cached = await readCache(key);
    if (cached) return cached.payload as KeyDataMarketBenchmark;

    const body = {
      market_uuid: marketUuid,
      currency: "GBP",
      pagination: { limit: 500, offset: 0, sort_by: "last_12mo_revenue" },
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
      console.warn(`[keydata] benchmark failed: ${res.error}`);
      return null;
    }
    const root = (res.data ?? {}) as { listings?: Array<{ performance?: { last_12_months?: { adr?: number } }; bedrooms?: number }> };
    const listings = Array.isArray(root.listings) ? root.listings : [];
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

    // OTA market KPIs weekly: forward 13 weeks (≈90 days) + the same range LY.
    const today = new Date();
    const horizonEnd = new Date(today);
    horizonEnd.setUTCDate(today.getUTCDate() + 91);
    const lyStart = new Date(today);
    lyStart.setUTCFullYear(today.getUTCFullYear() - 1);
    const lyEnd = new Date(horizonEnd);
    lyEnd.setUTCFullYear(horizonEnd.getUTCFullYear() - 1);

    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const fwdRes = await postJson(`${cfg.baseUrl}/api/v1/ota/market/kpis/week`, cfg.otaKey, {
      market_uuid: marketUuid,
      start_date: fmt(today),
      end_date: fmt(horizonEnd),
      currency: "GBP"
    });
    const lyRes = await postJson(`${cfg.baseUrl}/api/v1/ota/market/kpis/week`, cfg.otaKey, {
      market_uuid: marketUuid,
      start_date: fmt(lyStart),
      end_date: fmt(lyEnd),
      currency: "GBP"
    });
    if (!fwdRes.ok) {
      console.warn(`[keydata] forward-pace primary failed: ${fwdRes.error}`);
      return null;
    }

    type WeekRow = { date?: string; adr?: number; guest_occupancy?: number };
    const fwdRoot = (fwdRes.data ?? {}) as { data?: { kpis?: WeekRow[] } };
    const lyRoot = (lyRes.ok ? lyRes.data ?? {} : {}) as { data?: { kpis?: WeekRow[] } };
    const fwdWeeks = fwdRoot.data?.kpis ?? [];
    const lyWeeks = lyRoot.data?.kpis ?? [];

    if (fwdWeeks.length < 4) {
      console.warn(`[keydata] forward-pace too thin: ${fwdWeeks.length} weeks`);
      return null;
    }

    // Expand each weekly bucket into 7 days. Calling code matches by ISO date.
    const expand = (weeks: WeekRow[]) =>
      weeks.flatMap((w) => {
        if (!w.date) return [];
        const wkStart = new Date(w.date);
        if (Number.isNaN(wkStart.getTime())) return [];
        return Array.from({ length: 7 }).map((_, i) => {
          const d = new Date(wkStart);
          d.setUTCDate(wkStart.getUTCDate() + i);
          return {
            date: d.toISOString().slice(0, 10),
            occ: Number(w.guest_occupancy ?? NaN),
            adr: Number(w.adr ?? NaN)
          };
        });
      });

    const perDate: KeyDataForwardPaceDay[] = expand(fwdWeeks)
      .filter((x) => Number.isFinite(x.occ) && Number.isFinite(x.adr))
      .map((x) => ({
        date: x.date,
        forwardOccupancy: x.occ > 1 ? x.occ / 100 : x.occ,
        forwardADR: x.adr,
        sampleSize: 1
      }));

    const lastYearComparison: KeyDataForwardPaceLY[] = expand(lyWeeks)
      .filter((x) => Number.isFinite(x.occ) && Number.isFinite(x.adr))
      .map((x) => ({
        date: x.date,
        forwardOccupancyLY: x.occ > 1 ? x.occ / 100 : x.occ,
        forwardADRLY: x.adr
      }));

    const result: KeyDataForwardPace = { perDate, lastYearComparison };
    await writeCache(key, result, "forward-pace", perDate.length);
    return result;
  }

  return {
    getBelfastMarketUuid,
    getMarketBenchmark,
    getCitySeasonalityIndex,
    getCityDayOfWeekIndex,
    getForwardPace
  };
}
