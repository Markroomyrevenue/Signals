import { env } from "@/lib/env";
import { normalizeReservationChannel, normalizeReservationStatus } from "@/lib/hostaway/normalize";
import {
  FetchReservationsArgs,
  HostawayCalendarRate,
  HostawayGateway,
  HostawayListing,
  HostawayPageResult,
  HostawayReservation
} from "@/lib/hostaway/types";

type HostawayRequestMethod = "GET" | "POST";

type QueryValue = string | number | boolean | null | undefined;
type QueryRecord = Record<string, QueryValue>;

type HostawayTokenState = {
  token: string | null;
  expiresAt: Date | null;
};

type HostawayTokenStore = {
  read: () => Promise<HostawayTokenState>;
  write: (token: string | null, expiresAt: Date | null) => Promise<void>;
};

type HostawayClientConfig = {
  baseUrl: string;
  accountId?: string | null;
  clientId: string;
  clientSecret: string;
  tokenStore: HostawayTokenStore;
};

const TOKEN_ENDPOINT = "/v1/accessTokens";
const DEFAULT_MIN_SPACING_MS = 250;
const MAX_RETRIES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(asString(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toQueryValue(value: QueryValue): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFieldRecord(value: Record<string, unknown>): Map<string, unknown> {
  const rows = new Map<string, unknown>();

  for (const [key, raw] of Object.entries(value)) {
    rows.set(key.toLowerCase().replace(/[^a-z0-9]/g, ""), raw);
  }

  return rows;
}

function hasAliasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function getFieldByAliases<T>(value: unknown, aliases: string[], transform: (raw: unknown) => T, fallback: T): T {
  if (!isRecord(value)) return fallback;

  const record = normalizeFieldRecord(value);
  for (const alias of aliases) {
    const key = alias.toLowerCase().replace(/[^a-z0-9]/g, "");
    const found = record.get(key);
    if (!hasAliasValue(found)) {
      continue;
    }

    return transform(found);
  }

  return fallback;
}

function normalizeContainer(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;

  const result = payload.result;
  if (isRecord(result)) {
    const resultItems = (result as Record<string, unknown>).items;
    const resultData = (result as Record<string, unknown>).data;
    if (Array.isArray(resultItems) || Array.isArray(resultData)) {
      return result;
    }
  }

  return payload;
}

function normalizeArrayResponse<T>(payload: unknown): T[] {
  const container = normalizeContainer(payload);
  if (Array.isArray(container)) return container as T[];

  const records: unknown[] = [];

  if (isRecord(container)) {
    const maybeItems = [
      container.result,
      container.data,
      container.resultData,
      container.payload,
      container.reservations,
      container.listings,
      container.calendar
    ];

    for (const candidate of maybeItems) {
      if (Array.isArray(candidate)) {
        records.push(...candidate);
      }
    }

    const nestedResult = isRecord(container.result) ? (container.result as Record<string, unknown>) : null;
    const nestedResultItems = nestedResult?.items;
    if (Array.isArray(nestedResultItems)) {
      records.push(...nestedResultItems);
    }
    const nestedResultData = nestedResult?.data;
    if (Array.isArray(nestedResultData)) {
      records.push(...nestedResultData);
    }
  }

  return records as T[];
}

function normalizeHasMore(payload: unknown, page: number): boolean {
  const container = normalizeContainer(payload);

  const checkValue = (target: unknown): boolean | null => {
    if (target === null || target === undefined) return null;

    if (typeof target === "boolean") {
      return target;
    }

    if (typeof target === "string") {
      const normalized = target.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }

    return null;
  };

  const directHasMore = getFieldByAliases(payload, ["hasMore", "has_more", "more", "morePages", "morepages"], checkValue, null);
  if (directHasMore !== null) return directHasMore;

  const containerHasMore = getFieldByAliases(container, ["hasMore", "has_more", "more", "morePages", "morepages"], checkValue, null);
  if (containerHasMore !== null) return containerHasMore;

  const nextPage = getFieldByAliases(container, ["nextPage", "next_page", "nextpage"], (next) => {
    const value = asNumber(next, NaN);
    return Number.isFinite(value) ? value : NaN;
  }, NaN);

  if (Number.isFinite(nextPage) && nextPage > page) {
    return true;
  }

  const pageCount = getFieldByAliases(container, ["pageCount", "page_count", "totalPages", "total_pages", "totalpages"], (total) => {
    const value = asNumber(total, NaN);
    return Number.isFinite(value) ? value : NaN;
  }, NaN);

  if (Number.isFinite(pageCount)) {
    return page >= 1 && page < pageCount;
  }

  const limit = getFieldByAliases(container, ["limit", "pageSize", "page_size"], (raw) => {
    const value = asNumber(raw, NaN);
    return Number.isFinite(value) ? value : NaN;
  }, NaN);
  const total = getFieldByAliases(container, ["total", "count", "totalCount", "total_count"], (raw) => {
    const value = asNumber(raw, NaN);
    return Number.isFinite(value) ? value : NaN;
  }, NaN);

  if (Number.isFinite(limit) && Number.isFinite(total)) {
    return page * limit < total;
  }

  return false;
}

function normalizeMoney(raw: unknown, fallback = 0): number {
  return asNumber(raw, fallback);
}

function toOptionalString(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function toOptionalNumber(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function deriveCityFromAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, "").trim())
    .filter(Boolean);

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] ?? "";
    if (/^(uk|united kingdom|scotland|england|wales|northern ireland)$/i.test(part)) continue;
    if (!/[a-z]/i.test(part)) continue;
    if (/\d/.test(part) && part.split(" ").length <= 2) continue;
    return part;
  }

  return undefined;
}

function asBooleanLike(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const str = asString(value, "false").trim().toLowerCase();
  return str === "true" || str === "1" || str === "yes";
}

function readMoneyFromObject(value: unknown, keys: string[]): number | null {
  if (!isRecord(value)) return null;
  const raw = getFieldByAliases(value, keys, asNumber, NaN);
  return Number.isFinite(raw) ? raw : null;
}

type ReservationFeeEntry = {
  amount: number;
  feeType: string;
  name: string;
};

type ReservationFeeBreakdown = {
  cleaningFee: number;
  guestFee: number;
  taxes: number;
  commission: number;
};

type ReservationFinancials = {
  totalPrice: number;
  accommodationFare: number;
  cleaningFee: number;
  guestFee: number;
  taxes: number;
  commission: number;
};

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isTaxFee(name: string): boolean {
  const token = normalizeToken(name);
  return (
    token.includes("tax") ||
    token.includes("vat") ||
    token.includes("gst") ||
    token.includes("lodging") ||
    token.includes("occupancy") ||
    token.includes("tourism")
  );
}

function isCleaningFee(name: string): boolean {
  const token = normalizeToken(name);
  return (
    token.includes("clean") ||
    token.includes("housekeep") ||
    token.includes("linen") ||
    token.includes("laundry") ||
    token.includes("towel")
  );
}

function isCommissionFee(name: string): boolean {
  const token = normalizeToken(name);
  return (
    token.includes("commission") ||
    token.includes("channelfee") ||
    token.includes("processingfee") ||
    token.includes("hostfee") ||
    token.includes("otapaymentprocessingfee")
  );
}

function parseFeeEntry(value: unknown): ReservationFeeEntry | null {
  if (!isRecord(value)) return null;

  const amount = readMoneyFromObject(value, ["amount", "value", "total", "price", "fee"]);
  if (amount === null || !Number.isFinite(amount) || amount === 0) return null;

  return {
    amount,
    feeType: getFieldByAliases(value, ["feeType", "type", "chargeType", "category"], asString, "").trim().toLowerCase(),
    name: getFieldByAliases(value, ["name", "label", "title", "description"], asString, "").trim()
  };
}

function readReservationFeeEntries(value: unknown): ReservationFeeEntry[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => parseFeeEntry(item))
    .filter((entry): entry is ReservationFeeEntry => entry !== null);
}

function parseReservationFeeBreakdown(raw: Record<string, unknown>): ReservationFeeBreakdown {
  const sources: unknown[] = [
    raw.reservationFees,
    raw.fees,
    raw.feeItems,
    raw.charges
  ];

  for (const container of [raw.resources, raw.pricing]) {
    if (!isRecord(container)) continue;
    sources.push(container.fees, container.feeItems, container.charges);
  }

  const entries = sources.flatMap((source) => readReservationFeeEntries(source));
  if (entries.length === 0) {
    return {
      cleaningFee: 0,
      guestFee: 0,
      taxes: 0,
      commission: 0
    };
  }

  const guestEntries = entries.filter((entry) => entry.feeType.includes("guest"));
  const untypedEntries = entries.filter((entry) => entry.feeType === "");
  const nonHotelEntries = entries.filter((entry) => !entry.feeType.includes("hotel"));

  const selectedEntries =
    guestEntries.length > 0
      ? [...guestEntries, ...untypedEntries]
      : nonHotelEntries.length > 0
        ? nonHotelEntries
        : entries;

  const totals: ReservationFeeBreakdown = {
    cleaningFee: 0,
    guestFee: 0,
    taxes: 0,
    commission: 0
  };

  for (const entry of selectedEntries) {
    if (isCleaningFee(entry.name)) {
      totals.cleaningFee += entry.amount;
      continue;
    }

    if (isTaxFee(entry.name)) {
      totals.taxes += entry.amount;
      continue;
    }

    if (isCommissionFee(entry.name)) {
      totals.commission += entry.amount;
      continue;
    }

    totals.guestFee += entry.amount;
  }

  return totals;
}

function nonZeroOrFallback(primary: number, fallback: number): number {
  return Math.abs(primary) > 0 ? primary : fallback;
}

function parseReservationFinancials(raw: Record<string, unknown>, totalPriceRaw: number, accommodationFareRaw: number): ReservationFinancials {
  const breakdown = parseReservationFeeBreakdown(raw);

  const directCleaningFee =
    readMoneyFromObject(raw, ["cleaningFee", "cleaning_fee", "cleaning", "totalCleaningFee", "total_cleaning_fee"]) ?? 0;
  const directGuestFee =
    readMoneyFromObject(raw, ["guestFee", "guest_fee", "guestfee", "guestservicefee", "guest_service_fee", "guestfees", "guest_fee_total"]) ??
    readMoneyFromObject(raw, ["serviceFee", "service_fee", "serviceCharge", "service_charge"]) ??
    0;
  const directTaxes = readMoneyFromObject(raw, ["taxes", "tax", "vat", "taxAmount", "tax_amount"]) ?? 0;
  const directCommission = readMoneyFromObject(raw, ["commission", "commissionAmount", "commission_amount"]) ?? 0;

  const cleaningFee = nonZeroOrFallback(breakdown.cleaningFee, directCleaningFee);
  const guestFee = nonZeroOrFallback(breakdown.guestFee, directGuestFee);
  const taxes = nonZeroOrFallback(breakdown.taxes, directTaxes);
  const commission = nonZeroOrFallback(directCommission, breakdown.commission);

  let totalPrice = totalPriceRaw > 0 ? totalPriceRaw : 0;
  if (totalPrice <= 0 && accommodationFareRaw > 0) {
    totalPrice = accommodationFareRaw + cleaningFee + guestFee + taxes;
  }

  let accommodationFare = accommodationFareRaw > 0 ? accommodationFareRaw : 0;
  if (accommodationFare <= 0 && totalPrice > 0) {
    const derivedAccommodation = totalPrice - cleaningFee - guestFee;
    accommodationFare = derivedAccommodation > 0 ? derivedAccommodation : totalPrice;
  }

  if (totalPrice > 0 && accommodationFare > totalPrice) {
    accommodationFare = totalPrice;
  }

  return {
    totalPrice,
    accommodationFare,
    cleaningFee,
    guestFee,
    taxes,
    commission
  };
}

export class HostawayClient implements HostawayGateway {
  private cachedToken: string | null = null;
  private cachedTokenExpiresAt: Date | null = null;
  private tokenInflight: Promise<string> | null = null;
  private nextRequestAt = 0;

  constructor(private readonly config: HostawayClientConfig) {}

  private assertMethod(method: HostawayRequestMethod, path: string): void {
    const normalizedPath = path.toLowerCase();
    if (method !== "GET" && normalizedPath !== TOKEN_ENDPOINT.toLowerCase()) {
      throw new Error(`Hostaway client is read-only. Denied ${method} ${path}`);
    }
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const waitMs = this.nextRequestAt - now;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.nextRequestAt = Date.now() + DEFAULT_MIN_SPACING_MS;
  }

  private parseRetryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const rawSeconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(rawSeconds) && rawSeconds > 0) {
        return rawSeconds * 1000;
      }
      const parsedDate = Date.parse(retryAfter);
      if (!Number.isNaN(parsedDate)) {
        const ms = parsedDate - Date.now();
        if (ms > 0) {
          return ms;
        }
      }
    }

    const baseDelay = 600 * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * 100);
    return baseDelay + jitter;
  }

  private isTokenValid(token: string | null, expiresAt: Date | null): boolean {
    if (!token) return false;
    if (!expiresAt) return false;

    const now = Date.now();
    return expiresAt.getTime() > now;
  }

  private async readStoredToken(): Promise<HostawayTokenState> {
    try {
      return await this.config.tokenStore.read();
    } catch {
      return { token: null, expiresAt: null };
    }
  }

  private async writeStoredToken(token: string | null, expiresAt: Date | null): Promise<void> {
    try {
      await this.config.tokenStore.write(token, expiresAt);
    } catch {
      // Best effort: local cache will be used for this run
    }
  }

  private tokenExpiryFromResponse(raw: unknown): Date {
    const expiresIn = getFieldByAliases(raw, ["expiresIn", "expires_in"], (value) => {
      const parsed = Number(asString(value));
      return Number.isFinite(parsed) ? parsed : NaN;
    }, NaN);

    const now = new Date();
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      return new Date(now.getTime() + expiresIn * 1000);
    }

    const fallback = new Date(now);
    fallback.setMonth(fallback.getMonth() + 23);
    return fallback;
  }

  private async clearTokenState(): Promise<void> {
    this.cachedToken = null;
    this.cachedTokenExpiresAt = null;
    await this.writeStoredToken(null, null);
  }

  private async ensureToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedToken && this.cachedTokenExpiresAt && this.isTokenValid(this.cachedToken, this.cachedTokenExpiresAt)) {
      return this.cachedToken;
    }

    if (!forceRefresh && this.tokenInflight) {
      return this.tokenInflight;
    }

    const stored = await this.readStoredToken();
    if (!forceRefresh && this.isTokenValid(stored.token, stored.expiresAt)) {
      this.cachedToken = stored.token;
      this.cachedTokenExpiresAt = stored.expiresAt;
      return stored.token as string;
    }

    if (this.tokenInflight && forceRefresh) {
      return this.tokenInflight;
    }

    this.tokenInflight = this.fetchAccessToken();
    const token = await this.tokenInflight;
    this.tokenInflight = null;

    return token;
  }

  private async fetchAccessToken(): Promise<string> {
    await this.waitForRateLimit();

    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: "general"
    });

    const response = await this.request("POST", TOKEN_ENDPOINT, undefined, form);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Hostaway access token request failed (${response.status}): ${text.slice(0, 250)}`);
    }

    const payload = (await response.json().catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
    const accessToken = getFieldByAliases(payload, ["accessToken", "access_token", "token", "id_token"], asString, "");
    if (!accessToken) {
      throw new Error("Hostaway access token response did not include access token");
    }

    const expiresAt = this.tokenExpiryFromResponse(payload);
    this.cachedToken = accessToken;
    this.cachedTokenExpiresAt = expiresAt;
    await this.writeStoredToken(accessToken, expiresAt);

    return accessToken;
  }

  private async request(
    method: HostawayRequestMethod,
    path: string,
    query?: QueryRecord,
    formBody?: URLSearchParams,
    forceRefreshToken = false
  ): Promise<Response> {
    const normalizedMethod = method.toUpperCase() as HostawayRequestMethod;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    this.assertMethod(normalizedMethod, normalizedPath);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      await this.waitForRateLimit();

      const url = new URL(normalizedPath, this.config.baseUrl.endsWith("/") ? this.config.baseUrl : `${this.config.baseUrl}/`);
      if (query) {
        for (const [rawKey, rawValue] of Object.entries(query)) {
          const value = toQueryValue(rawValue);
          if (value === null) continue;
          url.searchParams.set(rawKey, value);
        }
      }

      const headers: Record<string, string> = {
        Accept: "application/json"
      };

      if (normalizedPath === TOKEN_ENDPOINT) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      } else {
        const token = await this.ensureToken(forceRefreshToken);
        headers.Authorization = `Bearer ${token}`;
        headers["Content-Type"] = "application/json";
        if (this.config.accountId) {
          headers["X-Hostaway-Account-Id"] = this.config.accountId;
        }
      }

      const response = await fetch(url.toString(), {
        method: normalizedMethod,
        headers,
        body: formBody ? formBody.toString() : undefined
      });

      if (response.status === 403 && normalizedPath !== TOKEN_ENDPOINT) {
        await this.clearTokenState();
        if (attempt === MAX_RETRIES - 1) {
          const text = await response.text().catch(() => "");
          throw new Error(`Hostaway request failed (${response.status}): ${text.slice(0, 250)}`);
        }

        forceRefreshToken = true;
        continue;
      }

      if (response.status === 429 && attempt < MAX_RETRIES - 1) {
        const waitMs = this.parseRetryDelay(response, attempt);
        await sleep(waitMs);
        continue;
      }

      return response;
    }

    throw new Error("Hostaway request retry budget exhausted");
  }

  private async parseJsonResponse(response: Response): Promise<unknown> {
    if (response.status === 204) {
      return {};
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Hostaway request failed (${response.status}): ${text.slice(0, 250)}`);
    }

    return response.json();
  }

  private async requestJson<T>(method: HostawayRequestMethod, path: string, query?: QueryRecord, formBody?: URLSearchParams, forceRefreshToken = false): Promise<T> {
    const response = await this.request(method, path, query, formBody, forceRefreshToken);
    return (await this.parseJsonResponse(response)) as T;
  }

  private toListing(raw: Record<string, unknown>): HostawayListing {
    const rawTags = raw.tags ?? raw.tagsList ?? raw.listingTags;
    const tags = Array.isArray(rawTags)
      ? rawTags.flatMap((entry) => {
          if (typeof entry === "string") {
            const normalized = entry.trim();
            return normalized ? [normalized] : [];
          }

          if (!isRecord(entry)) return [];
          const label = getFieldByAliases(entry, ["name", "label", "tag", "value"], asString, "").trim();
          return label ? [label] : [];
        })
      : [];
    const latitude = getFieldByAliases(raw, ["lat", "latitude"], asNumber, NaN);
    const longitude = getFieldByAliases(raw, ["lng", "lon", "longitude"], asNumber, NaN);
    const bathroomsNumber = getFieldByAliases(raw, ["bathroomsNumber", "bathrooms", "bathrooms_number"], asNumber, NaN);
    const cleaningFee = getFieldByAliases(raw, ["cleaningFee", "cleaning_fee"], (value) => normalizeMoney(value, NaN), NaN);
    const averageReviewRating = getFieldByAliases(
      raw,
      ["averageReviewRating", "average_review_rating", "reviewRating", "review_rating"],
      asNumber,
      NaN
    );
    const address = toOptionalString(getFieldByAliases(raw, ["address"], asString, ""));
    const publicAddress = toOptionalString(getFieldByAliases(raw, ["publicAddress", "public_address"], asString, ""));
    const city =
      toOptionalString(getFieldByAliases(raw, ["city", "locality"], asString, "")) ??
      deriveCityFromAddress(publicAddress) ??
      deriveCityFromAddress(address);

    return {
      id: getFieldByAliases(raw, ["id", "listingId", "listing_id", "listingMapId", "listingmapid"], asString, ""),
      name: getFieldByAliases(
        raw,
        [
          "internalListingName",
          "internal_listing_name",
          "internalName",
          "internal_name",
          "name",
          "externalListingName",
          "external_listing_name",
          "title",
          "unitName",
          "unit_name",
          "listingName",
          "listing_name"
        ],
        asString,
        "Unnamed Listing"
      ),
      externalName: toOptionalString(
        getFieldByAliases(raw, ["externalListingName", "external_listing_name", "publicName", "public_name"], asString, "")
      ),
      status: getFieldByAliases(raw, ["status", "specialStatus", "special_status"], asString, "active"),
      timezone: getFieldByAliases(raw, ["timezone", "timeZone", "time_zone", "timeZoneName"], asString, env.defaultTimezone),
      tags,
      country: toOptionalString(getFieldByAliases(raw, ["country"], asString, "")),
      countryCode: toOptionalString(getFieldByAliases(raw, ["countryCode", "country_code"], asString, ""))?.toUpperCase(),
      state: toOptionalString(getFieldByAliases(raw, ["state", "region"], asString, "")),
      city,
      street: toOptionalString(getFieldByAliases(raw, ["street"], asString, "")),
      address,
      publicAddress,
      postalCode: toOptionalString(getFieldByAliases(raw, ["zipcode", "zipCode", "postalCode", "postal_code"], asString, "")),
      latitude: toOptionalNumber(latitude),
      longitude: toOptionalNumber(longitude),
      roomType: toOptionalString(getFieldByAliases(raw, ["roomType", "room_type"], asString, "")),
      propertyTypeId: toOptionalNumber(getFieldByAliases(raw, ["propertyTypeId", "property_type_id"], asNumber, NaN)),
      bedroomsNumber: toOptionalNumber(getFieldByAliases(raw, ["bedroomsNumber", "bedrooms", "bedrooms_number"], asNumber, NaN)),
      bathroomsNumber: toOptionalNumber(bathroomsNumber),
      bedsNumber: toOptionalNumber(getFieldByAliases(raw, ["bedsNumber", "beds", "beds_number"], asNumber, NaN)),
      personCapacity: toOptionalNumber(getFieldByAliases(raw, ["personCapacity", "guests", "capacity"], asNumber, NaN)),
      guestsIncluded: toOptionalNumber(getFieldByAliases(raw, ["guestsIncluded", "guests_included"], asNumber, NaN)),
      minNights: toOptionalNumber(getFieldByAliases(raw, ["minNights", "min_nights"], asNumber, NaN)),
      maxNights: toOptionalNumber(getFieldByAliases(raw, ["maxNights", "max_nights"], asNumber, NaN)),
      cleaningFee: toOptionalNumber(cleaningFee),
      currencyCode: toOptionalString(getFieldByAliases(raw, ["currencyCode", "currency_code"], asString, ""))?.toUpperCase(),
      averageReviewRating: toOptionalNumber(averageReviewRating),
      thumbnailUrl: toOptionalString(getFieldByAliases(raw, ["thumbnailUrl", "thumbnail_url"], asString, "")),
      airbnbListingUrl: toOptionalString(getFieldByAliases(raw, ["airbnbListingUrl", "airbnb_listing_url"], asString, "")),
      vrboListingUrl: toOptionalString(getFieldByAliases(raw, ["vrboListingUrl", "vrbo_listing_url", "homeawayListingUrl"], asString, "")),
      raw
    };
  }

  private toReservation(raw: Record<string, unknown>): HostawayReservation {
    const insertedOn = getFieldByAliases(
      raw,
      [
        "reservationDate",
        "reservation_date",
        "bookedOn",
        "booked_on",
        "insertedOn",
        "inserted_on",
        "createdAt",
        "created_at",
        "bookingCreatedDate",
        "booking_created_date"
      ],
      asString,
      ""
    );
    const confirmedOn = getFieldByAliases(raw, ["confirmedOn", "confirmed_on", "confirmationDate", "confirmation_date"], asString, insertedOn);
    const arrivalDate = getFieldByAliases(raw, ["arrivalDate", "arrival_date", "arrival"], asString, "");
    const departureDate = getFieldByAliases(raw, ["departureDate", "departure_date", "departure"], asString, "");
    const totalPriceRaw = getFieldByAliases(
      raw,
      ["totalPrice", "total", "totalPriceFromChannel", "totalPriceNative", "total_price", "total_price_from_channel", "total_price_native"],
      (rawValue) => normalizeMoney(rawValue, 0),
      0
    );
    const accommodationFareRaw = getFieldByAliases(
      raw,
      ["accommodationFare", "accommodation_fare", "roomRevenue", "room_revenue", "accommodation", "baseRate", "base_rate"],
      (rawValue) => normalizeMoney(rawValue, 0),
      0
    );
    const financials = parseReservationFinancials(raw, totalPriceRaw, accommodationFareRaw);
    const channelName = getFieldByAliases(raw, ["channelName", "channel_name"], asString, "");
    const channel = getFieldByAliases(raw, ["channel"], asString, "");
    const source = getFieldByAliases(raw, ["source", "ota"], asString, "");
    const channelId = getFieldByAliases(raw, ["channelId", "channel_id"], asNumber, NaN);
    const reservationStatusRaw = getFieldByAliases(raw, ["status", "state"], asString, "unknown");
    const normalizedStatus = normalizeReservationStatus(reservationStatusRaw) || "unknown";
    const currency = getFieldByAliases(raw, ["currency", "currencyCode", "currency_code"], asString, "GBP").toUpperCase();

    return {
      id: getFieldByAliases(raw, ["id", "reservationId", "reservation_id", "bookingId", "booking_id"], asString, ""),
      listingMapId: getFieldByAliases(raw, ["listingMapId", "listingId", "listing_id", "listingid", "propertyId", "property_id"], asString, ""),
      channel: normalizeReservationChannel({ channelName, channel, source, channelId }),
      status: normalizedStatus,
      insertedOn,
      confirmedOn,
      arrivalDate,
      departureDate,
      nights: getFieldByAliases(raw, ["nights", "stayLength", "stay_length", "lengthOfStay", "length_of_stay", "totalReservationNights"], asNumber, 0),
      guests: getFieldByAliases(raw, ["guests", "guestCount", "guest_count", "numberOfGuests"], asNumber, 0) || undefined,
      currency,
      totalPrice: financials.totalPrice,
      accommodationFare: financials.accommodationFare,
      cleaningFee: financials.cleaningFee,
      guestFee: financials.guestFee,
      taxes: financials.taxes,
      commission: financials.commission,
      updatedOn: getFieldByAliases(raw, ["updatedOn", "updated_on", "updatedAt", "updated_at"], asString, ""),
      raw
    };
  }

  async fetchListings(page = 1): Promise<HostawayPageResult<HostawayListing>> {
    const payload = await this.requestJson<unknown>("GET", "/v1/listings", {
      page,
      limit: 200
    });

    const rawItems = normalizeArrayResponse<Record<string, unknown>>(payload);
    const items: HostawayListing[] = rawItems
      .map((raw) => (isRecord(raw) ? raw : null))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => this.toListing(item));

    return {
      items,
      page,
      hasMore: normalizeHasMore(payload, page)
    };
  }

  async fetchReservations(args: FetchReservationsArgs = {}): Promise<HostawayPageResult<HostawayReservation>> {
    const page = args.page ?? 1;
    const limit = 200;
    const usingCursorPagination =
      typeof args.afterId === "string" ||
      typeof args.latestActivityStart === "string" ||
      typeof args.latestActivityEnd === "string";
    const offset = usingCursorPagination ? undefined : Math.max(0, page - 1) * limit;
    const payload = await this.requestJson<unknown>("GET", "/v1/reservations", {
      offset,
      limit,
      includeResources: 1,
      afterId: args.afterId,
      sortOrder: usingCursorPagination ? "latestActivityDesc" : undefined,
      latestActivityStart: args.latestActivityStart,
      latestActivityEnd: args.latestActivityEnd,
      arrivalDateFrom: args.dateRange?.from,
      departureDateTo: args.dateRange?.to
    });

    const rawItems = normalizeArrayResponse<Record<string, unknown>>(payload);
    const items: HostawayReservation[] = rawItems
      .map((raw) => (isRecord(raw) ? raw : null))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => this.toReservation(item));

    const totalCount = getFieldByAliases(payload, ["count", "total", "totalCount", "total_count"], (raw) => {
      const value = asNumber(raw, NaN);
      return Number.isFinite(value) ? value : NaN;
    }, NaN);

    const hasMore = usingCursorPagination
      ? items.length === limit
      : Number.isFinite(totalCount)
        ? (offset ?? 0) + items.length < totalCount
        : normalizeHasMore(payload, page);

    return {
      items,
      page,
      hasMore
    };
  }

  async fetchCalendarRates(
    listingId: string,
    dateFrom: string,
    dateTo: string
  ): Promise<HostawayCalendarRate[]> {
    const payload = await this.requestJson<unknown>("GET", `/v1/listings/${encodeURIComponent(listingId)}/calendar`, {
      from: dateFrom,
      to: dateTo,
      includeResources: 1
    });

    const rawItems = normalizeArrayResponse<Record<string, unknown>>(payload);
    return rawItems
      .filter((raw): raw is Record<string, unknown> => isRecord(raw))
      .map((item) => ({
        date: getFieldByAliases(item, ["date", "day", "date_iso"], asString, ""),
        available: getFieldByAliases(item, ["available", "isAvailable", "is_available"], asBooleanLike, false),
        minStay: getFieldByAliases(item, ["minStay", "minStayNights", "min_stay", "minimumStay"], asNumber, 0),
        maxStay: getFieldByAliases(item, ["maxStay", "maxStayNights", "max_stay", "maximumStay"], asNumber, 0),
        rate: getFieldByAliases(item, ["rate", "price", "dailyRate", "daily_rate"], (raw) => normalizeMoney(raw, 0), 0),
        currency: getFieldByAliases(item, ["currency", "currencyCode", "currency_code"], asString, "GBP"),
        raw: item
      }));
  }
}

export function createHostawayClient(config: HostawayClientConfig): HostawayGateway {
  return new HostawayClient(config);
}
