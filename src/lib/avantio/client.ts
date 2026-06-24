/**
 * Avantio PMS API client (v2). Tiny typed wrapper around fetch() with a
 * hand-rolled throttle (no extra deps) that stays comfortably below
 * Avantio's published ceilings of 5 req/sec, 15 concurrent, 275/min:
 * 4 requests/second AND max 8 in flight. 429 responses are retried up
 * to 3 times with exponential backoff (+ Retry-After when provided).
 *
 * Designed to be a thin transport — the gateway / normalize layers
 * interpret the shape of the parsed JSON. Base URL + key are passed in
 * so callers can swap accounts (e.g. SSSA's production key vs. the
 * sandbox key) by constructing a new client.
 */

export type AvantioClientConfig = {
  baseUrl: string;
  apiKey: string;
};

export type AvantioPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type AvantioBookingFilters = {
  arrivalDate_from?: string;
  arrivalDate_to?: string;
  updatedAt_from?: string;
  updatedAt_to?: string;
  creationDate_from?: string;
  creationDate_to?: string;
  status?: string;
  accommodation?: string;
  sort?: string;
};

const MAX_REQ_PER_SECOND = 4;
const MAX_CONCURRENT = 8;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const HEADER_AUTH = "X-Avantio-Auth";
const DEFAULT_PAGE_SIZE = 100;
const BOOKING_PAGE_SIZE = 50;

type QueryValue = string | number | boolean | null | undefined;

/** Single-tenant in-process throttle. Per-client to keep limits isolated when callers construct >1. */
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

function extractNextCursor(links: unknown, baseUrl: string): string | null {
  if (!links || typeof links !== "object") return null;
  const next = (links as Record<string, unknown>).next;
  if (!next) return null;
  let href: string | null = null;
  if (typeof next === "string") {
    href = next;
  } else if (typeof next === "object" && next !== null) {
    const obj = next as Record<string, unknown>;
    if (typeof obj.href === "string") href = obj.href;
    else if (typeof obj.cursor === "string") return obj.cursor;
  }
  if (!href) return null;
  try {
    const parsed = new URL(href, baseUrl);
    return parsed.searchParams.get("pagination_cursor");
  } catch {
    return null;
  }
}

export function createAvantioClient(config: AvantioClientConfig) {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const throttle = new Throttle();

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    query?: Record<string, QueryValue>
  ): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${baseUrl}${normalizedPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      await throttle.acquire();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method,
          headers: {
            [HEADER_AUTH]: config.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeoutId);
        throttle.release();
        if (isAbortError(error) && attempt < MAX_RETRIES - 1) {
          await sleep(600 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
          continue;
        }
        if (isAbortError(error)) {
          throw new Error(
            `Avantio ${method} ${normalizedPath} timed out after ${REQUEST_TIMEOUT_MS}ms × ${MAX_RETRIES} attempts`
          );
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
      throttle.release();

      if (response.status === 429 && attempt < MAX_RETRIES - 1) {
        const retryAfterHeader = Number(response.headers.get("retry-after"));
        const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : 600 * Math.pow(2, attempt);
        await sleep(retryAfterMs + Math.floor(Math.random() * 200));
        continue;
      }

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          /* swallow */
        }
        // Include the query string in the error so a 400 on a paged
        // endpoint surfaces WHICH params Avantio rejected (Avantio's
        // `details` field also names the conflicting params).
        const queryString = url.searchParams.toString();
        let message = `Avantio ${method} ${normalizedPath}${queryString ? `?${queryString}` : ""} failed (${response.status})`;
        try {
          const parsed = JSON.parse(body) as { message?: unknown; details?: unknown };
          if (typeof parsed.message === "string") message += `: ${parsed.message}`;
          if (parsed.details) message += ` details=${JSON.stringify(parsed.details).slice(0, 250)}`;
        } catch {
          if (body) message += `: ${body.slice(0, 250)}`;
        }
        throw new Error(message);
      }

      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }
    throw new Error(`Avantio ${method} ${normalizedPath} exhausted retry budget`);
  }

  /**
   * Generic cursor-paged GET. Returns the page's items plus the next cursor
   * (null when this is the last page). Avantio v2 list responses look like
   * `{ data: T[], _links: { next: "https://…?pagination_cursor=X" } }`
   * (the `next` value is a bare URL string, not an object).
   *
   * `pagination_cursor` is mutually exclusive with EVERY other query
   * param Avantio accepts (HTTP 400 lists each excluded field by name —
   * `pagination_size`, `arrivalDate_from`, `arrivalDate_to`, `sort`, …).
   * The cursor itself encodes the page size, filters, and sort used to
   * build it. So when a cursor is present we send it alone and drop the
   * rest. Verified live 2026-06-24.
   */
  async function fetchPage<T>(
    path: string,
    query: Record<string, QueryValue>
  ): Promise<AvantioPage<T>> {
    const finalQuery: Record<string, QueryValue> = query.pagination_cursor
      ? { pagination_cursor: query.pagination_cursor }
      : { ...query };
    const body = await request<{ data?: T[]; _links?: unknown }>("GET", path, finalQuery);
    return {
      items: Array.isArray(body.data) ? body.data : [],
      nextCursor: extractNextCursor(body._links, baseUrl)
    };
  }

  return {
    /** GET /v2/whoami — sanity check for credentials + company id/name/currency. */
    whoami: () =>
      request<{
        data?: {
          company?: { id?: string | number; name?: string; currency?: string };
          [key: string]: unknown;
        };
      }>("GET", "/v2/whoami"),

    /** Paged list of accommodation summaries. Detail via getAccommodation(id). */
    listAccommodations: (opts: { cursor?: string | null; size?: number } = {}) =>
      fetchPage<Record<string, unknown>>("/v2/accommodations", {
        pagination_cursor: opts.cursor ?? undefined,
        pagination_size: opts.size ?? DEFAULT_PAGE_SIZE
      }),

    getAccommodation: (id: string) =>
      request<{ data?: Record<string, unknown> }>(
        "GET",
        `/v2/accommodations/${encodeURIComponent(id)}`
      ),

    getAvailabilities: (id: string) =>
      request<{ data?: unknown }>(
        "GET",
        `/v2/accommodations/${encodeURIComponent(id)}/availabilities`
      ),

    getRate: (id: string) =>
      request<{ data?: unknown }>("GET", `/v2/accommodations/${encodeURIComponent(id)}/rate`),

    getOccupationRule: (id: string) =>
      request<{ data?: unknown }>(
        "GET",
        `/v2/accommodations/${encodeURIComponent(id)}/occupation-rule`
      ),

    listBookings: (
      opts: {
        cursor?: string | null;
        size?: number;
        filters?: AvantioBookingFilters;
      } = {}
    ) =>
      // Bookings list caps pagination_size at 50 (verified live 2026-06-24:
      // `pagination_size=51` → 400 with `"limit":{"min":10,"max":50}`).
      // Accommodations + reviews accept up to 100.
      fetchPage<Record<string, unknown>>("/v2/bookings", {
        pagination_cursor: opts.cursor ?? undefined,
        pagination_size: Math.min(opts.size ?? BOOKING_PAGE_SIZE, BOOKING_PAGE_SIZE),
        ...(opts.filters ?? {})
      }),

    getBooking: (id: string) =>
      request<{ data?: Record<string, unknown> }>(
        "GET",
        `/v2/bookings/${encodeURIComponent(id)}`
      ),

    listReviews: (
      opts: { cursor?: string | null; size?: number; accommodationId?: string } = {}
    ) =>
      fetchPage<Record<string, unknown>>("/v2/reviews", {
        pagination_cursor: opts.cursor ?? undefined,
        pagination_size: opts.size ?? DEFAULT_PAGE_SIZE,
        accommodation: opts.accommodationId
      })
  };
}

export type AvantioClient = ReturnType<typeof createAvantioClient>;
