/**
 * Guesty Open API client. Thin typed wrapper around fetch() with:
 *
 *  - OAuth2 client-credentials token handling delegated to a
 *    `GuestyTokenProvider` (DB-backed in production — see token.ts).
 *    Guesty issues AT MOST FIVE access tokens per 24h per clientId, so
 *    this client NEVER fetches tokens itself and never loops on auth:
 *    an expired-token 403 triggers exactly ONE provider.refreshToken()
 *    followed by ONE retry, then the error propagates.
 *  - A hand-rolled throttle far below Guesty's published ceilings
 *    (15 req/sec, 120/min, 5000/hour, shared across all tokens on the
 *    account): 5 req/sec and max 4 in flight. 429s sleep for the
 *    Retry-After header (fallback exponential) and retry up to 3 times.
 *
 * Read-only by design: only GET requests are exposed. Signals never
 * writes anything to Guesty.
 */

export const GUESTY_API_BASE_URL = "https://open-api.guesty.com/v1";
export const GUESTY_TOKEN_URL = "https://open-api.guesty.com/oauth2/token";

export type GuestyTokenProvider = {
  /** Return a currently-valid access token (cached wherever the provider likes). */
  getToken: () => Promise<string>;
  /**
   * Force-issue a replacement token (called at most once per request, on a
   * 401/403 that suggests the cached token expired early). Implementations
   * MUST persist the new token so other processes reuse it.
   */
  refreshToken: () => Promise<string>;
};

export type GuestyClientConfig = {
  tokenProvider: GuestyTokenProvider;
  baseUrl?: string;
};

export type GuestyTokenResponse = {
  accessToken: string;
  /** Seconds the token is valid for (Guesty: 86400 = 24h). */
  expiresIn: number;
};

const MAX_REQ_PER_SECOND = 5;
const MAX_CONCURRENT = 4;
const MAX_429_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 90_000;

type QueryValue = string | number | boolean | null | undefined;

/** Single-account in-process throttle (per-client instance). */
class Throttle {
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private issued: number[] = [];

  async acquire(): Promise<void> {
    while (this.inFlight >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    while (true) {
      const now = Date.now();
      this.issued = this.issued.filter((t) => t >= now - 1000);
      if (this.issued.length < MAX_REQ_PER_SECOND) break;
      const waitMs = Math.max(1, this.issued[0] + 1000 - now);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.inFlight += 1;
    this.issued.push(Date.now());
  }

  release(): void {
    this.inFlight -= 1;
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

/**
 * Issue ONE access token via the OAuth2 client-credentials grant.
 *
 * QUOTA WARNING: Guesty allows a maximum of five tokens per 24h per
 * clientId. This function makes exactly one attempt — no retries, no
 * loops — so every call visibly spends quota. Callers (token.ts, the
 * Add-Client validation) are responsible for caching the result in the
 * guesty_connections row.
 */
export async function fetchGuestyAccessToken(
  clientId: string,
  clientSecret: string
): Promise<GuestyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "open-api",
    client_id: clientId,
    client_secret: clientSecret
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(GUESTY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString(),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 250);
    } catch {
      /* swallow */
    }
    throw new Error(`Guesty token request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  const parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("Guesty token response missing access_token");
  }
  const expiresIn = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : 86400;
  return { accessToken: parsed.access_token, expiresIn };
}

export function createGuestyClient(config: GuestyClientConfig) {
  const baseUrl = (config.baseUrl ?? GUESTY_API_BASE_URL).replace(/\/+$/, "");
  const throttle = new Throttle();

  async function request<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${baseUrl}${normalizedPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    let token = await config.tokenProvider.getToken();
    let authRetried = false;

    for (let attempt = 0; attempt < MAX_429_RETRIES + 1; attempt += 1) {
      await throttle.acquire();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json"
          },
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeoutId);
        throttle.release();
        if (isAbortError(error) && attempt < MAX_429_RETRIES) {
          await sleep(600 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
          continue;
        }
        if (isAbortError(error)) {
          throw new Error(`Guesty GET ${normalizedPath} timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
      throttle.release();

      // Expired-token symptom on Guesty is a 403 ("You don't have
      // permission..."); some gateways answer 401. Exactly ONE refresh,
      // then ONE retry — never a refresh loop (five-token quota).
      if ((response.status === 401 || response.status === 403) && !authRetried) {
        authRetried = true;
        token = await config.tokenProvider.refreshToken();
        continue;
      }

      if (response.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfterHeader = Number(response.headers.get("retry-after"));
        const retryAfterMs =
          Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? retryAfterHeader * 1000
            : 1000 * Math.pow(2, attempt);
        await sleep(retryAfterMs + Math.floor(Math.random() * 250));
        continue;
      }

      if (!response.ok) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          /* swallow */
        }
        const queryString = url.searchParams.toString();
        throw new Error(
          `Guesty GET ${normalizedPath}${queryString ? `?${queryString}` : ""} failed (${response.status})${
            bodyText ? `: ${bodyText.slice(0, 250)}` : ""
          }`
        );
      }

      return (await response.json()) as T;
    }
    throw new Error(`Guesty GET ${normalizedPath} exhausted retry budget`);
  }

  return {
    /**
     * GET /listings — offset-paginated (limit max 100). Returns the raw
     * body; the gateway interprets `results` + `count`.
     */
    listListings: (opts: { limit: number; skip: number }) =>
      request<{ results?: unknown[]; count?: number; limit?: number; skip?: number }>("/listings", {
        limit: opts.limit,
        skip: opts.skip
      }),

    /**
     * GET /reservations — offset-paginated (limit max 100). `filters` is
     * Guesty's JSON filter array; `fields` a space-separated projection.
     */
    listReservations: (opts: { limit: number; skip: number; filters?: string; fields?: string; sort?: string }) =>
      request<{ results?: unknown[]; count?: number; limit?: number; skip?: number }>("/reservations", {
        limit: opts.limit,
        skip: opts.skip,
        filters: opts.filters,
        fields: opts.fields,
        sort: opts.sort
      }),

    /**
     * GET /availability-pricing/api/calendar/listings/{id} — per-day
     * calendar (price, status, minNights, allotment for multi-units).
     */
    getCalendar: (listingId: string, startDate: string, endDate: string) =>
      request<{ data?: { days?: unknown[] }; days?: unknown[] }>(
        `/availability-pricing/api/calendar/listings/${encodeURIComponent(listingId)}`,
        { startDate, endDate, includeAllotment: true }
      ),

    /** GET /accounts/me — account metadata (name), used for display only. */
    getAccount: () => request<{ name?: string; _id?: string; [key: string]: unknown }>("/accounts/me")
  };
}

export type GuestyClient = ReturnType<typeof createGuestyClient>;
