/**
 * Wheelhouse write adapter — custom rates (proven live by hand, 2026-07-18,
 * against `https://api.usewheelhouse.com/ss_api/v1`).
 *
 * - Writes need BOTH headers: `X-Integration-Api-Key: <read key>` AND
 *   `X-User-Api-Key: <write key>`. Both are sent on every call here.
 * - Pre-check (preview): none needed. Wheelhouse's own PUT semantics make a
 *   single-day write safe over ANY existing custom rate — the official API
 *   splits/shortens an overlapping range so our one night wins and every OTHER
 *   night of that range keeps its original rate (owner adjustments included).
 *   Custom rates never stack; the newest write owns the overlapping date. So an
 *   approved rec always lands (Mark, 2026-07-20) — the previous owner-conflict
 *   block only skipped daily recs that were re-touching a date inside a range.
 *   The UI marks nights that already carry an override so the operator sees
 *   they are replacing one; the verify-after still confirms our price landed.
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
  RecsOverrideReads,
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

/** Every YYYY-MM-DD from `from` to `to` inclusive (both valid, zero-padded). */
function eachDateInclusive(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Pure: expand every custom_rate row's start_date..end_date range and intersect
 * it with the [startDate, endDate] window, returning the sorted set of covered
 * dates. A single Wheelhouse row may be a multi-day RANGE, so a naive
 * "does start_date fall in the window" check would miss the interior nights and
 * the tail. Dates may arrive as timestamps ("2026-12-20T00:00:00Z") — `rowDate`
 * already slices to the date part. A row with only a start_date is treated as a
 * single night. Clamping to the window FIRST bounds the day-walk to the window
 * even if a row spans months, so a stray far-future end_date can't run away.
 */
export function customRateDatesInWindow(
  rows: CustomRateRow[],
  startDate: string,
  endDate: string
): string[] {
  const dates = new Set<string>();
  for (const row of rows) {
    const rowStart = rowDate(row, "start_date");
    if (rowStart === null) continue;
    const rowEnd = rowDate(row, "end_date") ?? rowStart;
    // String compare is valid on zero-padded YYYY-MM-DD.
    const from = rowStart > startDate ? rowStart : startDate;
    const to = rowEnd < endDate ? rowEnd : endDate;
    if (from > to) continue;
    for (const date of eachDateInclusive(from, to)) dates.add(date);
  }
  return [...dates].sort();
}

export function createWheelhousePushAdapter(
  options: WheelhousePushAdapterOptions
): RecsEnginePushAdapter & RecsSelfTestReads & RecsOverrideReads {
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

    async preview(): Promise<{ ok: boolean; blockedReason?: string }> {
      // No pre-flight block: a single-day PUT splits any overlapping range and
      // wins for the one night, leaving the rest of the range intact (proven
      // against Wheelhouse's official API contract, 2026-07-20). An approved
      // rec always lands.
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

    /**
     * Overrides read (calendar-marking only): GET custom_rates ONCE, then expand
     * every row's range and intersect with the window. One GET per listing keeps
     * this within the 20 req/min limit when the caller walks listings serially.
     */
    async listOverrideDates(
      engineListingId: string,
      startDate: string,
      endDate: string
    ): Promise<string[]> {
      const rows = await fetchCustomRates(engineListingId);
      return customRateDatesInWindow(rows, startDate, endDate);
    },

    /** Self-test only: current calendar price via GET price_calendar (days: 1). */
    async readCurrentPrice(engineListingId: string, date: string): Promise<number | null> {
      // start_date + end_date (a `days` param is ignored; start_date alone
      // returns an empty array — found live 2026-07-19).
      const payload = await recsEngineFetch<unknown>({
        url:
          `${baseUrl}/listings/${encodeURIComponent(engineListingId)}/price_calendar` +
          `?channel=${encodeURIComponent(channel)}&start_date=${date}&end_date=${date}`,
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
        const rec = row as Record<string, unknown>;
        // Live rows carry `stay_date` (found 2026-07-19); accept `date` too.
        const raw = rec.stay_date ?? rec.date;
        return typeof raw === "string" && raw.slice(0, 10) === date;
      });
      if (!day || typeof day !== "object") return null;
      const rec = day as Record<string, unknown>;
      return toFiniteNumber(rec.price ?? rec.recommended_price ?? rec.posted_price);
    }
  };
}
