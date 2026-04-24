import { env } from "@/lib/env";
import { withExternalApiCache } from "@/lib/external-api-cache";
import {
  AirRoiClient,
  AirRoiComparableListing,
  AirRoiComparableQuery,
  AirRoiCurrencyMode,
  AirRoiFutureRate,
  AirRoiMarket,
  AirRoiMarketQueryRequest,
  AirRoiMarketSummary,
  AirRoiMetricSeriesPoint
} from "@/lib/airroi/types";

type AirRoiClientConfig = {
  apiKey: string;
  baseUrl?: string;
  forceRefresh?: boolean;
  allowLiveFetch?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return null;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

class DefaultAirRoiClient implements AirRoiClient {
  private readonly apiKey: string;

  private readonly baseUrl: string;

  private readonly ttlMs: number;

  private readonly forceRefresh: boolean;

  private readonly allowLiveFetch: boolean;

  constructor(config: AirRoiClientConfig) {
    this.apiKey = config.apiKey.trim();
    this.baseUrl = (config.baseUrl ?? env.airroiBaseUrl).trim() || "https://api.airroi.com";
    this.ttlMs = Math.max(1, env.airroiCacheTtlDays) * 24 * 60 * 60 * 1000;
    this.forceRefresh = config.forceRefresh === true;
    this.allowLiveFetch = config.allowLiveFetch !== false;
  }

  private async requestJson<T>(requestLabel: string, input: string, init?: RequestInit): Promise<T> {
    if (!this.apiKey) {
      throw new Error("Missing AirROI API key.");
    }

    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const cached = await withExternalApiCache<unknown>({
      provider: "airroi",
      requestLabel,
      cacheKeyParts: [method, input, body],
      ttlMs: this.ttlMs,
      forceRefresh: this.forceRefresh,
      allowLiveFetch: this.allowLiveFetch,
      fetcher: async () => {
        const response = await fetch(input, {
          ...init,
          headers: {
            "x-api-key": this.apiKey,
            Accept: "application/json",
            ...(init?.headers ?? {})
          },
          cache: "no-store"
        });

        if (!response.ok) {
          const responseBody = await response.text().catch(() => "");
          throw new Error(`AirROI request failed (${response.status}): ${responseBody.slice(0, 250)}`);
        }

        return response.json();
      }
    });

    return cached.value as T;
  }

  async lookupMarket(params: { latitude: number; longitude: number }): Promise<AirRoiMarket | null> {
    const payload = await this.requestJson<Record<string, unknown>>(
      "markets/lookup",
      buildUrl(this.baseUrl, "/markets/lookup", {
        lat: params.latitude,
        lng: params.longitude
      })
    );

    if (!isRecord(payload)) return null;
    return {
      country: asString(payload.country),
      region: asString(payload.region) || undefined,
      locality: asString(payload.locality) || undefined,
      district: asString(payload.district) || undefined,
      fullName: asString(payload.full_name) || undefined
    };
  }

  async getMarketSummary(request: AirRoiMarketQueryRequest): Promise<AirRoiMarketSummary | null> {
    const payload = await this.requestJson<Record<string, unknown>>(
      "markets/summary",
      buildUrl(this.baseUrl, "/markets/summary"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request)
      }
    );

    if (!isRecord(payload) || !isRecord(payload.market)) return null;
    return {
      market: {
        country: asString(payload.market.country),
        region: asString(payload.market.region) || undefined,
        locality: asString(payload.market.locality) || undefined,
        district: asString(payload.market.district) || undefined
      },
      occupancy: asNumber(payload.occupancy),
      averageDailyRate: asNumber(payload.average_daily_rate),
      revPar: asNumber(payload.rev_par),
      revenue: asNumber(payload.revenue),
      bookingLeadTime: asNumber(payload.booking_lead_time),
      lengthOfStay: asNumber(payload.length_of_stay),
      minNights: asNumber(payload.min_nights),
      activeListingsCount: asNumber(payload.active_listings_count)
    };
  }

  private async getMetricSeries(path: string, request: AirRoiMarketQueryRequest): Promise<AirRoiMetricSeriesPoint[]> {
    const payload = await this.requestJson<Record<string, unknown>>(path, buildUrl(this.baseUrl, path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request)
    });

    const results = Array.isArray(payload.results) ? payload.results : [];
    return results
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        date: asString(entry.date),
        avg: asNumber(entry.avg) ?? 0,
        p25: asNumber(entry.p25) ?? undefined,
        p50: asNumber(entry.p50) ?? undefined,
        p75: asNumber(entry.p75) ?? undefined,
        p90: asNumber(entry.p90) ?? undefined
      }))
      .filter((entry) => entry.date.length > 0);
  }

  getMarketOccupancy(request: AirRoiMarketQueryRequest): Promise<AirRoiMetricSeriesPoint[]> {
    return this.getMetricSeries("/markets/metrics/occupancy", request);
  }

  getMarketAverageDailyRate(request: AirRoiMarketQueryRequest): Promise<AirRoiMetricSeriesPoint[]> {
    return this.getMetricSeries("/markets/metrics/average-daily-rate", request);
  }

  getMarketFuturePacing(request: AirRoiMarketQueryRequest): Promise<AirRoiMetricSeriesPoint[]> {
    return this.getMetricSeries("/markets/metrics/future/pacing", request);
  }

  async getComparableListings(query: AirRoiComparableQuery): Promise<AirRoiComparableListing[]> {
    const payload = await this.requestJson<Record<string, unknown>>(
      "listings/comparables",
      buildUrl(this.baseUrl, "/listings/comparables", {
        latitude: query.latitude,
        longitude: query.longitude,
        address: query.address,
        bedrooms: query.bedrooms,
        baths: query.baths,
        guests: query.guests,
        currency: query.currency ?? "native"
      })
    );

    const listings = Array.isArray(payload.listings) ? payload.listings : [];
    return listings
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => {
        const listingInfo = isRecord(entry.listing_info) ? entry.listing_info : {};
        const locationInfo = isRecord(entry.location_info) ? entry.location_info : {};
        const propertyDetails = isRecord(entry.property_details) ? entry.property_details : {};
        const bookingSettings = isRecord(entry.booking_settings) ? entry.booking_settings : {};
        const pricingInfo = isRecord(entry.pricing_info) ? entry.pricing_info : {};
        const ratings = isRecord(entry.ratings) ? entry.ratings : {};
        const performanceMetrics = isRecord(entry.performance_metrics) ? entry.performance_metrics : {};

        return {
          listingId: asString(listingInfo.listing_id),
          listingName: asString(listingInfo.listing_name) || "Comparable listing",
          roomType: asString(listingInfo.room_type) || null,
          location: {
            latitude: asNumber(locationInfo.latitude),
            longitude: asNumber(locationInfo.longitude),
            country: asString(locationInfo.country) || null,
            region: asString(locationInfo.region) || null,
            locality: asString(locationInfo.locality) || null,
            district: asString(locationInfo.district) || null,
            exactLocation: asBoolean(locationInfo.exact_location)
          },
          propertyDetails: {
            guests: asNumber(propertyDetails.guests),
            bedrooms: asNumber(propertyDetails.bedrooms),
            beds: asNumber(propertyDetails.beds),
            baths: asNumber(propertyDetails.baths)
          },
          bookingSettings: {
            instantBook: asBoolean(bookingSettings.instant_book),
            minNights: asNumber(bookingSettings.min_nights),
            cancellationPolicy: asString(bookingSettings.cancellation_policy) || null
          },
          pricingInfo: {
            currency: asString(pricingInfo.currency) || null,
            cleaningFee: asNumber(pricingInfo.cleaning_fee),
            extraGuestFee: asNumber(pricingInfo.extra_guest_fee),
            singleFeeStructure: asBoolean(pricingInfo.single_fee_structure)
          },
          ratings: {
            ratingOverall: asNumber(ratings.rating_overall),
            numReviews: asNumber(ratings.num_reviews)
          },
          performanceMetrics: {
            ttmAvgRate: asNumber(performanceMetrics.ttm_avg_rate),
            ttmOccupancy: asNumber(performanceMetrics.ttm_occupancy),
            l90dAvgRate: asNumber(performanceMetrics.l90d_avg_rate),
            l90dOccupancy: asNumber(performanceMetrics.l90d_occupancy),
            ttmAvgMinNights: asNumber(performanceMetrics.ttm_avg_min_nights),
            l90dAvgMinNights: asNumber(performanceMetrics.l90d_avg_min_nights)
          }
        } satisfies AirRoiComparableListing;
      })
      .filter((entry) => entry.listingId.length > 0);
  }

  async getListingFutureRates(listingId: string, currency: AirRoiCurrencyMode = "native"): Promise<AirRoiFutureRate[]> {
    const payload = await this.requestJson<Record<string, unknown>>(
      "listings/future/rates",
      buildUrl(this.baseUrl, "/listings/future/rates", {
        id: listingId,
        currency
      })
    );

    const rates = Array.isArray(payload.rates) ? payload.rates : [];
    return rates
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        date: asString(entry.date),
        available: asBoolean(entry.available) ?? false,
        rate: asNumber(entry.rate),
        minNights: asNumber(entry.min_nights)
      }))
      .filter((entry) => entry.date.length > 0);
  }
}

export function createAirRoiClient(config?: Partial<AirRoiClientConfig>): AirRoiClient | null {
  const apiKey = (config?.apiKey ?? env.airroiApiKey).trim();
  if (!apiKey) return null;

  return new DefaultAirRoiClient({
    apiKey,
    baseUrl: config?.baseUrl ?? env.airroiBaseUrl,
    forceRefresh: config?.forceRefresh ?? false,
    allowLiveFetch: config?.allowLiveFetch ?? false
  });
}
