import { decryptText, encryptText } from "@/lib/crypto";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

// This module covers the WRITE path to Hostaway: pushing recommended
// nightly rates back into the channel manager's calendar. The pull-side
// `HostawayClient` is intentionally locked to GET-only; we add a small
// dedicated push client so the read-only invariant on the puller stays
// auditable. Both paths share the same token-store + scope ("general"),
// per Hostaway's docs that one OAuth scope covers read AND write.

export type HostawayCalendarPushRate = {
  date: string;
  dailyPrice: number;
  /** Optional min-stay to push alongside the rate. Sent as `minimumStay`
   *  on the Hostaway PUT body. Null/undefined means don't include the
   *  field — leaves the listing's existing min-stay untouched. */
  minStay?: number | null;
};

export type HostawayPushClient = {
  pushCalendarRate: (input: { date: string; dailyPrice: number; minStay?: number | null }) => Promise<{ ok: true; pushedCount: number }>;
  pushCalendarRatesBatch: (input: {
    dateFrom: string;
    dateTo: string;
    rates: HostawayCalendarPushRate[];
  }) => Promise<{ ok: true; pushedCount: number }>;
  fetchCalendarRates: (input: { dateFrom: string; dateTo: string }) => Promise<Array<{ date: string; price: number | null; minStay: number | null }>>;
};

const TOKEN_ENDPOINT = "/v1/accessTokens";
const DEFAULT_MIN_SPACING_MS = 250;
const MAX_RETRIES = 4;

export class HostawayPushError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(message: string, status: number, responseBody: string) {
    super(message);
    this.name = "HostawayPushError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

type Logger = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

type PushClientConfig = {
  baseUrl: string;
  accountId?: string | null;
  clientId: string;
  clientSecret: string;
  tokenStore: {
    read: () => Promise<{ token: string | null; expiresAt: Date | null }>;
    write: (token: string | null, expiresAt: Date | null) => Promise<void>;
  };
  hostawayListingId: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() <= Date.now();
}

class HostawayPushClientImpl implements HostawayPushClient {
  private cachedToken: string | null = null;
  private cachedTokenExpiresAt: Date | null = null;
  private nextRequestAt = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: PushClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
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
        if (ms > 0) return ms;
      }
    }
    return 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
  }

  private async readStoredToken(): Promise<{ token: string | null; expiresAt: Date | null }> {
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
      // Best effort.
    }
  }

  private async ensureToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedToken && this.cachedTokenExpiresAt && !tokenExpired(this.cachedTokenExpiresAt)) {
      return this.cachedToken;
    }

    const stored = await this.readStoredToken();
    if (!forceRefresh && stored.token && stored.expiresAt && !tokenExpired(stored.expiresAt)) {
      this.cachedToken = stored.token;
      this.cachedTokenExpiresAt = stored.expiresAt;
      return stored.token;
    }

    return this.fetchAccessToken();
  }

  private async fetchAccessToken(): Promise<string> {
    await this.waitForRateLimit();

    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: "general"
    });

    const url = new URL(TOKEN_ENDPOINT, this.config.baseUrl.endsWith("/") ? this.config.baseUrl : `${this.config.baseUrl}/`);

    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HostawayPushError(
        `Hostaway access token request failed (${response.status})`,
        response.status,
        text.slice(0, 250)
      );
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken =
      (typeof payload.accessToken === "string" && payload.accessToken) ||
      (typeof payload.access_token === "string" && payload.access_token) ||
      (typeof payload.token === "string" && payload.token) ||
      "";
    if (!accessToken) {
      throw new HostawayPushError("Hostaway access token response missing access_token", 500, "");
    }

    const expiresIn =
      typeof payload.expiresIn === "number"
        ? payload.expiresIn
        : typeof payload.expires_in === "number"
          ? payload.expires_in
          : null;

    const expiresAt =
      expiresIn && Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000)
        : (() => {
            const fallback = new Date();
            fallback.setMonth(fallback.getMonth() + 23);
            return fallback;
          })();

    this.cachedToken = accessToken;
    this.cachedTokenExpiresAt = expiresAt;
    await this.writeStoredToken(accessToken, expiresAt);

    return accessToken;
  }

  private async putJson(path: string, body: unknown): Promise<Response> {
    let forceRefreshToken = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      await this.waitForRateLimit();

      const url = new URL(path, this.config.baseUrl.endsWith("/") ? this.config.baseUrl : `${this.config.baseUrl}/`);
      const token = await this.ensureToken(forceRefreshToken);
      forceRefreshToken = false;

      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      };
      if (this.config.accountId) {
        headers["X-Hostaway-Account-Id"] = this.config.accountId;
      }

      const response = await this.fetchImpl(url.toString(), {
        method: "PUT",
        headers,
        body: JSON.stringify(body)
      });

      if (response.status === 403) {
        // Token may be stale; force-refresh and retry once per attempt.
        await this.writeStoredToken(null, null);
        this.cachedToken = null;
        this.cachedTokenExpiresAt = null;
        if (attempt === MAX_RETRIES - 1) {
          const text = await response.text().catch(() => "");
          console.error(
            "[hostaway-push] 403 after retries",
            JSON.stringify({
              listingId: this.config.hostawayListingId,
              path: url.pathname,
              status: response.status,
              responseBody: text.slice(0, 500)
            })
          );
          throw new HostawayPushError(
            // Hostaway 403 after a fresh token usually means the API key
            // doesn't have access to this specific listing (wrong account)
            // OR the listing is locked by another integration on Hostaway
            // (e.g. PriceLabs claiming the listing). Surface their message
            // verbatim so the owner can act on it.
            text.trim().length > 0
              ? `Hostaway push forbidden (${response.status}): ${text.trim().slice(0, 240)}`
              : `Hostaway push forbidden (${response.status}). Likely causes: API key doesn't have write access to this listing, or another integration (e.g. PriceLabs) is currently claiming the calendar.`,
            response.status,
            text.slice(0, 500)
          );
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

    throw new HostawayPushError("Hostaway push retry budget exhausted", 0, "");
  }

  async pushCalendarRate(input: { date: string; dailyPrice: number; minStay?: number | null }): Promise<{ ok: true; pushedCount: number }> {
    const path = `/v1/listings/${encodeURIComponent(this.config.hostawayListingId)}/calendar/${encodeURIComponent(input.date)}`;
    const body: Record<string, unknown> = { dailyPrice: input.dailyPrice };
    if (typeof input.minStay === "number" && Number.isFinite(input.minStay) && input.minStay > 0) {
      body.minimumStay = input.minStay;
    }
    const response = await this.putJson(path, body);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.config.logger?.error?.("hostaway.push.single.failed", {
        listingId: this.config.hostawayListingId,
        date: input.date,
        status: response.status,
        responseBody: text.slice(0, 500)
      });
      console.error(
        "[hostaway-push] single-date PUT failed",
        JSON.stringify({
          listingId: this.config.hostawayListingId,
          date: input.date,
          status: response.status,
          responseBody: text.slice(0, 500)
        })
      );
      throw new HostawayPushError(
        text.trim().length > 0
          ? `Hostaway push failed (${response.status}): ${text.trim().slice(0, 240)}`
          : `Hostaway push failed (${response.status})`,
        response.status,
        text.slice(0, 500)
      );
    }

    this.config.logger?.info?.("hostaway.push.single.ok", {
      listingId: this.config.hostawayListingId,
      date: input.date
    });
    return { ok: true, pushedCount: 1 };
  }

  async pushCalendarRatesBatch(input: {
    dateFrom: string;
    dateTo: string;
    rates: HostawayCalendarPushRate[];
  }): Promise<{ ok: true; pushedCount: number }> {
    if (input.rates.length === 0) {
      return { ok: true, pushedCount: 0 };
    }

    // The Hostaway endpoint at PUT /v1/listings/{id}/calendar takes a
    // SINGLE date range and a SINGLE price. Variants with `dailyPrices`,
    // `data`, or `calendarDays` arrays are silently accepted (status:200,
    // status:"success") but never apply the prices — Hostaway's public
    // API simply ignores those array shapes. The proven schema is:
    //
    //   PUT /v1/listings/{id}/calendar
    //   { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "price": N }
    //
    // verified 2026-04-27 against listing 513515 by writing sentinel
    // prices and reading them back. To push N different prices for N
    // dates we make N PUTs (one per date, with startDate === endDate).
    // Hostaway's published rate limit (~10 req/sec) makes a 30-day push
    // a ~3 second operation, well under any UX threshold.
    //
    // Consecutive same-priced runs could be collapsed into a range call
    // as a future optimisation. For now we keep it simple and explicit.
    const path = `/v1/listings/${encodeURIComponent(this.config.hostawayListingId)}/calendar`;
    let pushedCount = 0;
    for (const rate of input.rates) {
      const body: Record<string, unknown> = {
        startDate: rate.date,
        endDate: rate.date,
        // Hostaway's API accepts either `price` or `dailyPrice`; we send
        // `price` because that's what their GET response uses to read the
        // value back, so any consistency check stays trivially correct.
        price: rate.dailyPrice
      };
      // Include `minimumStay` only when the caller explicitly sent one.
      // Omitting it preserves whatever min-stay is already configured on
      // the listing. Hostaway's PUT body accepts the field per their docs.
      if (typeof rate.minStay === "number" && Number.isFinite(rate.minStay) && rate.minStay > 0) {
        body.minimumStay = rate.minStay;
      }
      const response = await this.putJson(path, body);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.config.logger?.error?.("hostaway.push.daily.failed", {
          listingId: this.config.hostawayListingId,
          date: rate.date,
          status: response.status,
          responseBody: text.slice(0, 500)
        });
        console.error(
          "[hostaway-push] PUT failed",
          JSON.stringify({
            listingId: this.config.hostawayListingId,
            date: rate.date,
            status: response.status,
            responseBody: text.slice(0, 500)
          })
        );
        throw new HostawayPushError(
          text.trim().length > 0
            ? `Hostaway push failed for ${rate.date} (${response.status}): ${text.trim().slice(0, 200)}`
            : `Hostaway push failed for ${rate.date} (${response.status})`,
          response.status,
          text.slice(0, 500)
        );
      }
      pushedCount += 1;
    }
    this.config.logger?.info?.("hostaway.push.batch.ok", {
      listingId: this.config.hostawayListingId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      count: pushedCount
    });
    console.log(
      "[hostaway-push] batch ok",
      JSON.stringify({
        listingId: this.config.hostawayListingId,
        count: pushedCount
      })
    );
    return { ok: true, pushedCount };
  }

  /**
   * Read calendar rates back from Hostaway for a date range. Used by the
   * verify-after-push step to confirm that what we just sent actually
   * landed on Hostaway's side (defends against the silent-accept-then-
   * ignore class of failure we hit on 2026-04-27).
   */
  async fetchCalendarRates(input: {
    dateFrom: string;
    dateTo: string;
  }): Promise<Array<{ date: string; price: number | null; minStay: number | null }>> {
    const path = `/v1/listings/${encodeURIComponent(this.config.hostawayListingId)}/calendar?startDate=${encodeURIComponent(input.dateFrom)}&endDate=${encodeURIComponent(input.dateTo)}`;
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await this.ensureToken()}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HostawayPushError(
        `Hostaway calendar read failed (${response.status})`,
        response.status,
        text.slice(0, 500)
      );
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const items = Array.isArray((json as { result?: unknown }).result)
      ? ((json as { result: unknown[] }).result as Record<string, unknown>[])
      : Array.isArray(json)
        ? (json as Record<string, unknown>[])
        : [];
    return items
      .map((item) => {
        const date =
          typeof item.date === "string"
            ? item.date
            : typeof (item as { day?: unknown }).day === "string"
              ? (item.day as string)
              : "";
        const priceRaw = item.price ?? (item as { dailyPrice?: unknown }).dailyPrice ?? null;
        const price = typeof priceRaw === "number" ? priceRaw : Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;
        const minStayRaw =
          (item as { minimumStay?: unknown }).minimumStay ??
          (item as { minStay?: unknown }).minStay ??
          null;
        const minStay =
          typeof minStayRaw === "number"
            ? minStayRaw
            : Number.isFinite(Number(minStayRaw))
              ? Number(minStayRaw)
              : null;
        return { date, price, minStay };
      })
      .filter((row) => row.date.length === 10);
  }
}

export function createHostawayPushClient(config: PushClientConfig): HostawayPushClient {
  return new HostawayPushClientImpl(config);
}

export async function getHostawayPushClientForTenant(args: {
  tenantId: string;
  hostawayListingId: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}): Promise<HostawayPushClient> {
  const dataMode = env.dataMode;
  if (dataMode !== "live") {
    throw new Error(`Pushing rates to Hostaway requires DATA_MODE=live (got ${dataMode}).`);
  }

  const connection = await prisma.hostawayConnection.findUnique({
    where: { tenantId: args.tenantId },
    select: {
      hostawayClientId: true,
      hostawayClientSecretEncrypted: true,
      hostawayAccountId: true
    }
  });

  if (!connection?.hostawayClientId || !connection.hostawayClientSecretEncrypted) {
    throw new Error("Missing Hostaway credentials for this tenant. Update settings before pushing rates.");
  }

  const tokenStore = {
    async read() {
      const latest = await prisma.hostawayConnection.findUnique({
        where: { tenantId: args.tenantId },
        select: {
          hostawayAccessTokenEncrypted: true,
          hostawayAccessTokenExpiresAt: true
        }
      });
      if (!latest?.hostawayAccessTokenEncrypted || !latest.hostawayAccessTokenExpiresAt) {
        return { token: null, expiresAt: null };
      }
      try {
        return {
          token: decryptText(latest.hostawayAccessTokenEncrypted),
          expiresAt: latest.hostawayAccessTokenExpiresAt
        };
      } catch {
        return { token: null, expiresAt: null };
      }
    },
    async write(token: string | null, expiresAt: Date | null) {
      await prisma.hostawayConnection.update({
        where: { tenantId: args.tenantId },
        data: {
          hostawayAccessTokenEncrypted: token ? encryptText(token) : null,
          hostawayAccessTokenExpiresAt: expiresAt
        }
      });
    }
  };

  return createHostawayPushClient({
    baseUrl: env.hostawayBaseUrl,
    accountId: connection.hostawayAccountId,
    clientId: connection.hostawayClientId,
    clientSecret: decryptText(connection.hostawayClientSecretEncrypted),
    tokenStore,
    hostawayListingId: args.hostawayListingId,
    fetchImpl: args.fetchImpl,
    logger: args.logger
  });
}
