/**
 * Wheelhouse write adapter — custom rates (proven live by hand, 2026-07-18,
 * against `https://api.usewheelhouse.com/ss_api/v1`).
 *
 * - Writes need BOTH headers: `X-Integration-Api-Key: <read key>` AND
 *   `X-User-Api-Key: <write key>`. Both are sent on every call here.
 * - Pre-check (preview): GET custom_rates — if the target date falls inside ANY
 *   existing range that is not an exact single-day range for that same date
 *   (i.e. not one of OUR previous pushes), BLOCK. Owner rows (e.g. the December
 *   adjustment ranges) are never overwritten.
 * - Push: PUT custom_rates with a single-day range, rate_type "fixed", and the
 *   approved price in all seven day-of-week fields. 409 = concurrent request on
 *   the listing → bounded retry (max 3 attempts, backoff).
 * - Revert: DELETE custom_rates for the single-day range (→ 204; the date
 *   returns to Wheelhouse's recommended price), then verify-gone via GET.
 * - Rate limit is 20 req/min → baseDelayMs 3500 on every call.
 */

import { recsEngineFetch } from "./http";
import type {
  EngineWriteResult,
  RecsEnginePushAdapter,
  RecsPushTarget,
  RecsSelfTestReads,
  RecsVerifyResult
} from "./types";

const WHEELHOUSE_BASE_URL =
  process.env.WHEELHOUSE_BASE_URL ?? "https://api.usewheelhouse.com/ss_api/v1";
const READ_HEADER = "X-Integration-Api-Key";
const WRITE_HEADER = "X-User-Api-Key";
/** Wheelhouse caps at 20 req/min — same base delay the read adapter uses. */
const WHEELHOUSE_BASE_DELAY_MS = 3500;
/** 409 (concurrent request on the listing) retry bound: 3 attempts total. */
const WRITE_MAX_ATTEMPTS = 3;
const VERIFY_TOLERANCE = 0.5;

const DOW_FIELDS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
] as const;

export type WheelhousePushAdapterOptions = {
  readKey: string;
  writeKey: string;
  baseUrl?: string;
  /** Wheelhouse channel scope; the proven contract uses "hostaway". */
  channel?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

type CustomRateRow = Record<string, unknown>;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function rowDate(row: CustomRateRow, field: "start_date" | "end_date"): string | null {
  const raw = row[field];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  // Tolerate timestamps ("2026-12-20T00:00:00Z") — keep the date part only.
  return raw.slice(0, 10);
}

/** A row is "ours" only when it is the exact single-day range for the date. */
function isExactSingleDayRow(row: CustomRateRow, date: string): boolean {
  return rowDate(row, "start_date") === date && rowDate(row, "end_date") === date;
}

function rowContainsDate(row: CustomRateRow, date: string): boolean {
  const start = rowDate(row, "start_date");
  const end = rowDate(row, "end_date");
  if (start === null || end === null) return false;
  return start <= date && date <= end;
}

/** Extract the row's price for the date: its DOW field, then generic fallbacks. */
function rowPriceForDate(row: CustomRateRow, date: string): number | null {
  const dow = DOW_FIELDS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const direct = toFiniteNumber(row[dow]);
  if (direct !== null) return direct;
  for (const field of DOW_FIELDS) {
    const value = toFiniteNumber(row[field]);
    if (value !== null) return value;
  }
  return toFiniteNumber(row.rate ?? row.amount ?? row.price);
}

export function createWheelhousePushAdapter(
  options: WheelhousePushAdapterOptions
): RecsEnginePushAdapter & RecsSelfTestReads {
  const baseUrl = (options.baseUrl ?? WHEELHOUSE_BASE_URL).replace(/\/+$/, "");
  const channel = options.channel ?? "hostaway";
  const authHeaders = { [READ_HEADER]: options.readKey, [WRITE_HEADER]: options.writeKey };
  const fetchImpl = options.fetchImpl;
  const sleepImpl = options.sleepImpl;

  function customRatesUrl(engineListingId: string, extraQuery = ""): string {
    return (
      `${baseUrl}/listings/${encodeURIComponent(engineListingId)}/custom_rates` +
      `?channel=${encodeURIComponent(channel)}${extraQuery}`
    );
  }

  async function fetchCustomRates(engineListingId: string): Promise<CustomRateRow[]> {
    const payload = await recsEngineFetch<unknown>({
      url: customRatesUrl(engineListingId),
      method: "GET",
      authHeaders,
      baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
      fetchImpl,
      sleepImpl
    });
    const arr = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { custom_rates?: unknown })?.custom_rates)
        ? ((payload as { custom_rates: unknown[] }).custom_rates)
        : Array.isArray((payload as { data?: unknown })?.data)
          ? ((payload as { data: unknown[] }).data)
          : [];
    return arr.filter((row): row is CustomRateRow => row !== null && typeof row === "object");
  }

  return {
    engine: "wheelhouse",

    async preview(target: RecsPushTarget): Promise<{ ok: boolean; blockedReason?: string }> {
      const rows = await fetchCustomRates(target.engineListingId);
      const ownerConflict = rows.some(
        (row) => rowContainsDate(row, target.date) && !isExactSingleDayRow(row, target.date)
      );
      if (ownerConflict) return { ok: false, blockedReason: "owner_custom_rate_conflict" };
      return { ok: true };
    },

    async execute(target: RecsPushTarget): Promise<EngineWriteResult> {
      const price = target.price;
      const body: Record<string, unknown> = {
        start_date: target.date,
        end_date: target.date,
        rate_type: "fixed",
        currency: target.currency || "GBP"
      };
      for (const field of DOW_FIELDS) body[field] = price;
      await recsEngineFetch<unknown>({
        url: customRatesUrl(target.engineListingId),
        method: "PUT",
        authHeaders,
        body,
        retryOn409: true,
        maxAttempts: WRITE_MAX_ATTEMPTS,
        baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
        fetchImpl,
        sleepImpl
      });
      return { ok: true };
    },

    async verify(target: RecsPushTarget): Promise<RecsVerifyResult> {
      const rows = await fetchCustomRates(target.engineListingId);
      const ours = rows.find((row) => isExactSingleDayRow(row, target.date));
      if (!ours) return { attempted: true, verified: false, observedPrice: null };
      const observedPrice = rowPriceForDate(ours, target.date);
      const verified =
        observedPrice !== null && Math.abs(observedPrice - target.price) <= VERIFY_TOLERANCE;
      return { attempted: true, verified, observedPrice };
    },

    async revert(target: RecsPushTarget): Promise<EngineWriteResult> {
      // DELETE returns 204 no-body; recsEngineFetch yields null for that.
      await recsEngineFetch<unknown>({
        url: customRatesUrl(
          target.engineListingId,
          `&start_date=${target.date}&end_date=${target.date}`
        ),
        method: "DELETE",
        authHeaders,
        retryOn409: true,
        maxAttempts: WRITE_MAX_ATTEMPTS,
        baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
        fetchImpl,
        sleepImpl
      });
      return { ok: true };
    },

    async verifyReverted(target: RecsPushTarget): Promise<RecsVerifyResult> {
      const rows = await fetchCustomRates(target.engineListingId);
      const stillThere = rows.find((row) => isExactSingleDayRow(row, target.date));
      if (!stillThere) return { attempted: true, verified: true, observedPrice: null };
      return {
        attempted: true,
        verified: false,
        observedPrice: rowPriceForDate(stillThere, target.date)
      };
    },

    /** Self-test only: current calendar price via GET price_calendar (days: 1). */
    async readCurrentPrice(engineListingId: string, date: string): Promise<number | null> {
      const payload = await recsEngineFetch<unknown>({
        url:
          `${baseUrl}/listings/${encodeURIComponent(engineListingId)}/price_calendar` +
          `?channel=${encodeURIComponent(channel)}&start_date=${date}&days=1`,
        method: "GET",
        authHeaders,
        baseDelayMs: WHEELHOUSE_BASE_DELAY_MS,
        fetchImpl,
        sleepImpl
      });
      const arr = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { price_calendar?: unknown })?.price_calendar)
          ? ((payload as { price_calendar: unknown[] }).price_calendar)
          : Array.isArray((payload as { data?: unknown })?.data)
            ? ((payload as { data: unknown[] }).data)
            : [];
      const day = arr.find((row) => {
        if (!row || typeof row !== "object") return false;
        const raw = (row as Record<string, unknown>).date;
        return typeof raw === "string" && raw.slice(0, 10) === date;
      });
      if (!day || typeof day !== "object") return null;
      const rec = day as Record<string, unknown>;
      return toFiniteNumber(rec.price ?? rec.recommended_price ?? rec.posted_price);
    }
  };
}
