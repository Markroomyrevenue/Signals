/**
 * Pure, defensive mappers: raw engine payloads → trimmed per-date neighborhood
 * series. Engine JSON is loosely typed and drifts between API versions, so
 * every read coerces through small helpers and any missing level yields null —
 * these mappers NEVER throw on malformed input.
 *
 * The trimmed shape is also what gets cached in `recs_market_snapshots`
 * (small, reproducible, engine-agnostic), so `coerceTrimmedNeighborhood`
 * re-validates payloads coming back OUT of the cache too.
 *
 * Coercion helpers are deliberately re-implemented here rather than imported
 * from `src/lib/observe/engine/coerce.ts` — the recs module stays decoupled
 * from the observe engine by design (2026-07-18 build spec).
 */

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/** Read a property from an unknown record, or undefined. */
function pick(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

/** First present (non-undefined, non-null) value among several keys. */
function pickFirst(obj: unknown, keys: string[]): unknown {
  for (const key of keys) {
    const value = pick(obj, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Coerce to a finite number, or null. Strips currency symbols / commas. */
function toNum(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.+-]/g, "");
    if (cleaned === "" || cleaned === "+" || cleaned === "-" || cleaned === ".") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Coerce to a `yyyy-mm-dd` date-only string, or null. Accepts ISO prefixes. */
function toDateOnlyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const head = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null;
}

/**
 * Normalise an occupancy reading to a fraction in [0, 1], or null.
 * Engines are inconsistent: PriceLabs reports percent (e.g. 62), Wheelhouse
 * mostly fractions. Values in (1, 100] are treated as percent and scaled;
 * values above 100 or below 0 are nonsense and become null. Exactly 1 is
 * treated as a fraction (fully booked), not 1%.
 */
export function normalizeOccFraction(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return null;
}

// ---------------------------------------------------------------------------
// Trimmed shape
// ---------------------------------------------------------------------------

/** One neighborhood date: median comp price (GBP) + market occupancy (0–1). */
export type NeighborhoodDay = {
  date: string; // yyyy-mm-dd
  medianPrice: number | null;
  marketOcc: number | null;
};

/** The trimmed neighborhood series (what the cache stores). */
export type TrimmedNeighborhood = {
  days: NeighborhoodDay[];
};

/**
 * Re-validate a payload coming back out of the `recs_market_snapshots` cache.
 * Anything that is not the trimmed shape → null (a poisoned cache row can
 * never crash a rec build).
 */
export function coerceTrimmedNeighborhood(payload: unknown): TrimmedNeighborhood | null {
  const rawDays = pick(payload, "days");
  if (!Array.isArray(rawDays)) return null;
  const days: NeighborhoodDay[] = [];
  for (const entry of rawDays) {
    const date = toDateOnlyString(pick(entry, "date"));
    if (date === null) continue;
    days.push({
      date,
      medianPrice: toNum(pick(entry, "medianPrice")),
      marketOcc: normalizeOccFraction(toNum(pick(entry, "marketOcc")))
    });
  }
  return { days };
}

// ---------------------------------------------------------------------------
// PriceLabs neighborhood
// ---------------------------------------------------------------------------

/**
 * Pick the bedroom category from a PL `Category` map:
 * exact bedrooms match → the only category → an "all"-style key → the first
 * key in sorted order. Null when the map is unusable.
 */
function choosePlCategory(category: unknown, bedrooms: number | null | undefined): unknown {
  if (category === null || typeof category !== "object" || Array.isArray(category)) return null;
  const keys = Object.keys(category as Record<string, unknown>);
  if (keys.length === 0) return null;
  if (bedrooms !== null && bedrooms !== undefined) {
    const exact = keys.find((k) => toNum(k) === bedrooms);
    if (exact !== undefined) return pick(category, exact);
  }
  if (keys.length === 1) return pick(category, keys[0]);
  const all = keys.find((k) => k.toLowerCase() === "all" || k === "0");
  if (all !== undefined) return pick(category, all);
  return pick(category, [...keys].sort()[0]);
}

/** X_values (dates) + the Y_values series matching a label pattern. */
function plSeries(
  section: unknown,
  bedrooms: number | null | undefined,
  labelPattern: RegExp
): Map<string, number> {
  const out = new Map<string, number>();
  const cat = choosePlCategory(pick(section, "Category"), bedrooms);
  const xRaw = pick(cat, "X_values");
  const yRaw = pick(cat, "Y_values");
  if (!Array.isArray(xRaw) || !Array.isArray(yRaw)) return out;

  // Labels live beside Category at section level; each label names one
  // Y_values series. Fall back to a flat Y_values array when there is only
  // one un-labelled series.
  let series: unknown[] | null = null;
  const labels = pick(section, "Labels");
  if (Array.isArray(labels)) {
    const idx = labels.findIndex((l) => typeof l === "string" && labelPattern.test(l));
    if (idx >= 0 && Array.isArray(yRaw[idx])) series = yRaw[idx] as unknown[];
  }
  if (series === null && yRaw.length > 0 && !Array.isArray(yRaw[0])) series = yRaw;
  if (series === null) return out;

  for (let i = 0; i < xRaw.length && i < series.length; i++) {
    const date = toDateOnlyString(xRaw[i]);
    const value = toNum(series[i]);
    if (date !== null && value !== null) out.set(date, value);
  }
  return out;
}

/**
 * Trim the documented PriceLabs neighborhood payload:
 * `{ data: { "Future Percentile Prices": { Category: { <bedroom>: { X_values,
 * Y_values } }, Labels }, "Future Occ/New/Canc": {...}, "Market KPI": {...} } }`
 * → per-date 50th-percentile price + market occupancy where present.
 * Defensive throughout: any missing level → that side null; a payload with no
 * `data` object at all → null. Never throws.
 */
export function trimPlNeighborhood(
  raw: unknown,
  bedrooms?: number | null
): TrimmedNeighborhood | null {
  const data = pick(raw, "data");
  if (data === null || typeof data !== "object") return null;

  const prices = plSeries(pick(data, "Future Percentile Prices"), bedrooms, /50/);
  const occs = plSeries(pick(data, "Future Occ/New/Canc"), bedrooms, /occ/i);

  return mergeSeries(prices, occs);
}

// ---------------------------------------------------------------------------
// Wheelhouse neighborhood
// ---------------------------------------------------------------------------

/** Find the per-date row array inside a WH payload (several shapes seen). */
function whRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  for (const key of ["data", "days", "dates", "results"]) {
    const nested = pick(raw, key);
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function whSeries(raw: unknown, valueKeys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of whRows(raw)) {
    const date = toDateOnlyString(pickFirst(row, ["date", "day", "stay_date", "ds"]));
    const value = toNum(pickFirst(row, valueKeys));
    if (date !== null && value !== null) out.set(date, value);
  }
  return out;
}

/**
 * Trim the Wheelhouse nearby-comps payloads (nightly pricing + occupancy are
 * separate reads) into the same trimmed shape. Row arrays may sit at the top
 * level or under data/days/dates/results; key names are probed defensively.
 * Both sides empty → null. Never throws.
 */
export function trimWhNeighborhood(
  rawPricing: unknown,
  rawOccupancy: unknown
): TrimmedNeighborhood | null {
  const prices = whSeries(rawPricing, [
    "median",
    "median_price",
    "price_50",
    "p50",
    "percentile_50",
    "price"
  ]);
  const occs = whSeries(rawOccupancy, ["occupancy", "occ", "occupancy_rate", "rate", "value"]);
  if (prices.size === 0 && occs.size === 0) return null;
  return mergeSeries(prices, occs);
}

// ---------------------------------------------------------------------------
// Shared merge
// ---------------------------------------------------------------------------

/**
 * Merge price + occupancy maps into sorted per-date rows (occ normalised).
 * A date left with neither a price nor an occupancy carries no information
 * and is dropped.
 */
function mergeSeries(
  prices: Map<string, number>,
  occs: Map<string, number>
): TrimmedNeighborhood {
  const dates = new Set<string>([...prices.keys(), ...occs.keys()]);
  const days: NeighborhoodDay[] = [...dates]
    .sort()
    .map((date) => ({
      date,
      medianPrice: prices.get(date) ?? null,
      marketOcc: normalizeOccFraction(occs.get(date) ?? null)
    }))
    .filter((d) => d.medianPrice !== null || d.marketOcc !== null);
  return { days };
}
