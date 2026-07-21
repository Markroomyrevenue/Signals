/**
 * PriceLabs write adapter — date-specific overrides (proven live by hand,
 * 2026-07-18, against `https://api.pricelabs.co/v1` with header `X-API-Key`;
 * the read key is also the write key).
 *
 * - Push:   POST /listings/{id}/overrides  — `price` MUST be an integer, and the
 *   body needs the listing's `pms` (e.g. "guesty" for Cityscape, "hostaway" for
 *   the others), resolved from a memoised GET /listings.
 * - Verify: GET /listings/{id}/overrides?pms&start_date&end_date — an override
 *   row for the date, `price` comes back as a STRING, within 0.5 of what we
 *   pushed. NEVER verify via listing_prices (24h refresh cycle — it lies).
 * - Revert: DELETE /listings/{id}/overrides with `{overrides:[{date}], pms}`,
 *   then verify-gone via the same GET.
 */

import { recsEngineFetch } from "./http";
import type {
  EngineWriteResult,
  RecsEnginePushAdapter,
  RecsOverrideReads,
  RecsPushTarget,
  RecsSelfTestReads,
  RecsVerifyResult
} from "./types";

const PRICELABS_BASE_URL = process.env.PRICELABS_BASE_URL ?? "https://api.pricelabs.co/v1";
const HEADER_NAME = "X-API-Key";

/** Verify tolerance: PriceLabs echoes the price as a string; treat ±0.5 as equal. */
const VERIFY_TOLERANCE = 0.5;

export type PriceLabsPushAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

type OverrideRow = {
  date?: unknown;
  price?: unknown;
  price_type?: unknown;
  reason?: unknown;
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function createPriceLabsPushAdapter(
  options: PriceLabsPushAdapterOptions
): RecsEnginePushAdapter & RecsSelfTestReads & RecsOverrideReads {
  const baseUrl = (options.baseUrl ?? PRICELABS_BASE_URL).replace(/\/+$/, "");
  const authHeaders = { [HEADER_NAME]: options.apiKey };
  const fetchImpl = options.fetchImpl;
  const sleepImpl = options.sleepImpl;

  // pms per engine listing id, from a single memoised GET /listings per
  // service instance. `null` in the map = listing seen but no usable pms.
  let pmsById: Map<string, string | null> | null = null;

  async function loadPmsMap(): Promise<Map<string, string | null>> {
    if (pmsById) return pmsById;
    const payload = await recsEngineFetch<unknown>({
      url: `${baseUrl}/listings`,
      method: "GET",
      authHeaders,
      fetchImpl,
      sleepImpl
    });
    const listings = Array.isArray((payload as { listings?: unknown } | null)?.listings)
      ? ((payload as { listings: unknown[] }).listings)
      : Array.isArray(payload)
        ? (payload as unknown[])
        : [];
    const map = new Map<string, string | null>();
    for (const raw of listings) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const id = rec.id ?? rec.listing_id;
      if (id === null || id === undefined) continue;
      const pms = typeof rec.pms === "string" && rec.pms.trim().length > 0 ? rec.pms.trim() : null;
      map.set(String(id), pms);
    }
    pmsById = map;
    return map;
  }

  /**
   * Resolve the `pms` for a listing, or throw a clear error when the listing
   * id is not in this PriceLabs account (pushing to an unknown id must never
   * silently target something else).
   */
  async function pmsFor(engineListingId: string): Promise<string> {
    const map = await loadPmsMap();
    if (!map.has(engineListingId)) {
      throw new Error(
        `PriceLabs listing ${engineListingId} is not in this account (GET /listings returned ${map.size} listings) — refusing to push`
      );
    }
    return map.get(engineListingId) ?? "hostaway";
  }

  async function fetchOverrideForDate(
    engineListingId: string,
    date: string
  ): Promise<OverrideRow | null> {
    const pms = await pmsFor(engineListingId);
    const payload = await recsEngineFetch<{ overrides?: unknown }>({
      url:
        `${baseUrl}/listings/${encodeURIComponent(engineListingId)}/overrides` +
        `?pms=${encodeURIComponent(pms)}&start_date=${date}&end_date=${date}`,
      method: "GET",
      authHeaders,
      fetchImpl,
      sleepImpl
    });
    const rows = Array.isArray(payload?.overrides) ? (payload!.overrides as OverrideRow[]) : [];
    return rows.find((row) => String(row?.date ?? "") === date) ?? null;
  }

  return {
    engine: "pricelabs",

    async preview(target: RecsPushTarget): Promise<{ ok: boolean; blockedReason?: string }> {
      // The only PriceLabs pre-flight: the listing must be in the account so
      // the pms resolves. (The same check re-fires in execute as a hard throw.)
      const map = await loadPmsMap();
      if (!map.has(target.engineListingId)) {
        return { ok: false, blockedReason: "listing_not_in_engine_account" };
      }
      return { ok: true };
    },

    async execute(target: RecsPushTarget): Promise<EngineWriteResult> {
      const pms = await pmsFor(target.engineListingId);
      await recsEngineFetch<unknown>({
        url: `${baseUrl}/listings/${encodeURIComponent(target.engineListingId)}/overrides`,
        method: "POST",
        authHeaders,
        body: {
          overrides: [
            {
              date: target.date,
              // PriceLabs rejects/misapplies non-integer override prices.
              price: Math.round(target.price),
              price_type: "fixed",
              // REQUIRED with price_type "fixed" (400 DSO-CUR-MS without it,
              // found live 2026-07-19). Must match the PMS currency.
              currency: target.currency,
              reason: `signals-rec ${target.suggestionId}`
            }
          ],
          pms
        },
        fetchImpl,
        sleepImpl
      });
      return { ok: true };
    },

    async verify(target: RecsPushTarget): Promise<RecsVerifyResult> {
      const row = await fetchOverrideForDate(target.engineListingId, target.date);
      if (!row) return { attempted: true, verified: false, observedPrice: null };
      const observedPrice = toFiniteNumber(row.price);
      const verified =
        observedPrice !== null && Math.abs(observedPrice - Math.round(target.price)) <= VERIFY_TOLERANCE;
      return { attempted: true, verified, observedPrice };
    },

    async revert(target: RecsPushTarget): Promise<EngineWriteResult> {
      const pms = await pmsFor(target.engineListingId);
      await recsEngineFetch<unknown>({
        url: `${baseUrl}/listings/${encodeURIComponent(target.engineListingId)}/overrides`,
        method: "DELETE",
        authHeaders,
        // Delete rows need only the date; same envelope shape as the push.
        body: { overrides: [{ date: target.date }], pms },
        fetchImpl,
        sleepImpl
      });
      return { ok: true };
    },

    async verifyReverted(target: RecsPushTarget): Promise<RecsVerifyResult> {
      const row = await fetchOverrideForDate(target.engineListingId, target.date);
      if (!row) return { attempted: true, verified: true, observedPrice: null };
      return { attempted: true, verified: false, observedPrice: toFiniteNumber(row.price) };
    },

    /**
     * Overrides read (calendar-marking only): ONE GET /overrides for the whole
     * window (never per-date), collecting each returned override's `date`. Each
     * PriceLabs override is a single date, so no range expansion is needed;
     * dates are clamped to the window defensively and sliced to the date part.
     */
    async listOverrideDates(
      engineListingId: string,
      startDate: string,
      endDate: string
    ): Promise<string[]> {
      const pms = await pmsFor(engineListingId);
      const payload = await recsEngineFetch<{ overrides?: unknown }>({
        url:
          `${baseUrl}/listings/${encodeURIComponent(engineListingId)}/overrides` +
          `?pms=${encodeURIComponent(pms)}&start_date=${startDate}&end_date=${endDate}`,
        method: "GET",
        authHeaders,
        fetchImpl,
        sleepImpl
      });
      const rows = Array.isArray(payload?.overrides) ? (payload!.overrides as OverrideRow[]) : [];
      const dates = new Set<string>();
      for (const row of rows) {
        const raw = String(row?.date ?? "");
        if (raw.trim().length === 0) continue;
        const date = raw.slice(0, 10);
        if (date >= startDate && date <= endDate) dates.add(date);
      }
      return [...dates].sort();
    },

    /** Self-test only: current calendar price via POST /listing_prices (days: 1). */
    async readCurrentPrice(engineListingId: string, date: string): Promise<number | null> {
      const pms = await pmsFor(engineListingId);
      // Wrapped body required — a bare array yields an empty data array.
      const payload = await recsEngineFetch<unknown>({
        url: `${baseUrl}/listing_prices`,
        method: "POST",
        authHeaders,
        body: { listings: [{ id: engineListingId, pms, dateFrom: date, days: 1 }] },
        fetchImpl,
        sleepImpl
      });
      const arr = Array.isArray(payload) ? payload : [];
      const entry =
        arr.find((e) => {
          const id = e && typeof e === "object" ? (e as Record<string, unknown>).id : null;
          return String(id) === String(engineListingId);
        }) ?? arr[0];
      const data =
        entry && typeof entry === "object" ? (entry as { data?: unknown }).data : null;
      const days = Array.isArray(data) ? data : [];
      const day = days.find((d) => {
        const dd = d && typeof d === "object" ? (d as Record<string, unknown>).date : null;
        return String(dd ?? "") === date;
      });
      if (!day || typeof day !== "object") return null;
      const rec = day as Record<string, unknown>;
      return toFiniteNumber(rec.price ?? rec.user_price ?? rec.recommended_price);
    }
  };
}
