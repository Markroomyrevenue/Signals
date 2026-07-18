/**
 * Per-listing market-context assembly for the Pricing Recommendations page.
 *
 * Fallback ladder (owner design 2026-07-18):
 *  1. Today's `recs_market_snapshots` cache row for the engine's neighborhood
 *     kind. On a cache miss, call the INJECTED reader (if wired), trim via the
 *     pure mappers, and upsert the trimmed payload — the cache is both the
 *     per-day rate-limit guard and the reproducibility snapshot (what the UI
 *     showed for a rec must be re-derivable later). Reader errors degrade
 *     silently to the next source with an honest note (status code only —
 *     never keys or URLs).
 *  2. The newest `engine_snapshots` occ/marketOcc fields from the daily 05:30
 *     capture (dataAgeHours recorded from capturedAt).
 *  3. Nothing available → source "none", null fields.
 *
 * MY occupancy always comes from the engine snapshot (neighborhood payloads
 * describe the market, not this listing). Wheelhouse pricing + occupancy are
 * two reads trimmed into ONE combined series cached under "wh_neighborhood".
 *
 * No live API calls happen here — readers and stores are injected.
 */

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";

import {
  coerceTrimmedNeighborhood,
  trimPlNeighborhood,
  trimWhNeighborhood,
  normalizeOccFraction,
  type TrimmedNeighborhood
} from "./map";
import { DEFAULT_MARKET_STORES, type MarketStores } from "./stores";
import type {
  MarketContext,
  MarketContextSource,
  MarketMetric,
  MarketReaders,
  PricePosition,
  RecsEngine
} from "./types";

/** The occupancy/price-position aggregation window, in days from `day`. */
export const MARKET_WINDOW_DAYS = 30;

/** Today's Europe/London calendar day (yyyy-mm-dd) — for wiring convenience. */
export function londonDayOf(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export type BuildMarketContextArgs = {
  tenantId: string;
  engine: RecsEngine;
  engineListingId: string;
  /** The PMS the engine has the listing connected to (PriceLabs reads need it). */
  pms: string;
  /** The listing's currently advertised nightly rate per yyyy-mm-dd (GBP). */
  myRateByDate: ReadonlyMap<string, number>;
  /** Europe/London calendar day the context is built for (the cache key day). */
  day: string;
  /** Listing bedrooms — picks the right PriceLabs neighborhood category. */
  bedrooms?: number | null;
  readers?: MarketReaders;
  stores?: MarketStores;
  now?: Date;
};

/** HTTP-ish status from a reader error, or null. Never exposes internals. */
function errorStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  for (const key of ["status", "statusCode"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number" && value >= 100 && value <= 599) return value;
  }
  return null;
}

function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 10) / 10);
}

type NeighborhoodResult = {
  trimmed: TrimmedNeighborhood;
  fetchedAt: Date;
  kind: "pl_neighborhood" | "wh_neighborhood";
};

/**
 * Cache-first neighborhood load. One upsert per (tenant, engine, kind,
 * listing, day) — a second build the same day is a pure cache hit and never
 * touches the reader again.
 */
async function loadNeighborhood(
  args: BuildMarketContextArgs,
  stores: MarketStores,
  now: Date,
  notes: string[]
): Promise<NeighborhoodResult | null> {
  const kind = args.engine === "pricelabs" ? ("pl_neighborhood" as const) : ("wh_neighborhood" as const);
  const key = {
    tenantId: args.tenantId,
    engine: args.engine,
    kind,
    engineListingId: args.engineListingId,
    day: args.day
  };

  const cached = await stores.snapshots.get(key);
  if (cached) {
    const trimmed = coerceTrimmedNeighborhood(cached.payload);
    if (trimmed) return { trimmed, fetchedAt: cached.createdAt, kind };
    notes.push("cached neighborhood payload unreadable — ignored");
    return null;
  }

  let trimmed: TrimmedNeighborhood | null = null;
  if (args.engine === "pricelabs") {
    const reader = args.readers?.fetchPlNeighborhood;
    if (!reader) return null; // not wired — silent, expected
    try {
      trimmed = trimPlNeighborhood(await reader(args.engineListingId, args.pms), args.bedrooms);
    } catch (error) {
      const status = errorStatus(error);
      notes.push(`neighborhood data unavailable (${status ?? "error"})`);
      return null;
    }
  } else {
    const priceReader = args.readers?.fetchWhNeighborhoodPricing;
    const occReader = args.readers?.fetchWhNeighborhoodOccupancy;
    if (!priceReader && !occReader) return null;
    let rawPricing: unknown;
    let rawOccupancy: unknown;
    let failures = 0;
    let attempts = 0;
    let lastStatus: number | null = null;
    if (priceReader) {
      attempts += 1;
      try {
        rawPricing = await priceReader(args.engineListingId);
      } catch (error) {
        failures += 1;
        lastStatus = errorStatus(error);
      }
    }
    if (occReader) {
      attempts += 1;
      try {
        rawOccupancy = await occReader(args.engineListingId);
      } catch (error) {
        failures += 1;
        lastStatus = errorStatus(error);
      }
    }
    if (failures === attempts) {
      notes.push(`neighborhood data unavailable (${lastStatus ?? "error"})`);
      return null;
    }
    if (failures > 0) notes.push(`partial neighborhood read (${lastStatus ?? "error"})`);
    trimmed = trimWhNeighborhood(rawPricing, rawOccupancy);
  }

  // Cache even an empty trim: the day's read happened; do not re-hit the
  // engine for the same listing today. (Reader ERRORS are transient and are
  // deliberately NOT cached — a later run may succeed.)
  const toCache = trimmed ?? { days: [] };
  await stores.snapshots.upsert(key, toCache);
  return { trimmed: toCache, fetchedAt: now, kind };
}

/** The yyyy-mm-dd dates of [day, day + MARKET_WINDOW_DAYS). */
function windowDates(day: string): Set<string> {
  const start = fromDateOnly(day);
  const dates = new Set<string>();
  for (let i = 0; i < MARKET_WINDOW_DAYS; i++) dates.add(toDateOnly(addUtcDays(start, i)));
  return dates;
}

/** Mean market occupancy over the window, with its n. */
function neighborhoodOcc(trimmed: TrimmedNeighborhood, day: string, source: string): MarketMetric | null {
  const window = windowDates(day);
  const values = trimmed.days
    .filter((d) => window.has(d.date) && d.marketOcc !== null)
    .map((d) => d.marketOcc as number);
  if (values.length === 0) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { value: Math.round(mean * 10_000) / 10_000, window: "next30", source, n: values.length };
}

/**
 * Price position on the MEDIAN-ratio date of the window (so one spiked event
 * night cannot represent the whole month). Needs both my rate and the
 * neighborhood median on at least one shared date.
 */
function neighborhoodPricePosition(
  trimmed: TrimmedNeighborhood,
  day: string,
  myRateByDate: ReadonlyMap<string, number>,
  source: string
): PricePosition | null {
  const window = windowDates(day);
  const pairs: PricePosition[] = [];
  for (const d of trimmed.days) {
    if (!window.has(d.date) || d.medianPrice === null || d.medianPrice <= 0) continue;
    const myRate = myRateByDate.get(d.date);
    if (myRate === undefined || !Number.isFinite(myRate) || myRate <= 0) continue;
    pairs.push({
      myRate,
      neighborhoodMedian: d.medianPrice,
      ratio: Math.round((myRate / d.medianPrice) * 10_000) / 10_000,
      date: d.date,
      source
    });
  }
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => a.ratio - b.ratio || a.date.localeCompare(b.date));
  return pairs[Math.floor((pairs.length - 1) / 2)];
}

/** Build one listing's market context via the fallback ladder above. */
export async function buildMarketContext(args: BuildMarketContextArgs): Promise<MarketContext> {
  const now = args.now ?? new Date();
  const stores = args.stores ?? DEFAULT_MARKET_STORES;
  const notes: string[] = [];

  // 1. Neighborhood (cache → reader).
  const neighborhood = await loadNeighborhood(args, stores, now, notes);
  const nbOcc = neighborhood ? neighborhoodOcc(neighborhood.trimmed, args.day, neighborhood.kind) : null;
  const nbPrice = neighborhood
    ? neighborhoodPricePosition(neighborhood.trimmed, args.day, args.myRateByDate, neighborhood.kind)
    : null;

  // 2. Engine snapshot (my occ always; market occ only when neighborhood gave none).
  let snapMarketOcc: MarketMetric | null = null;
  let myOcc: MarketMetric | null = null;
  let snapAgeHours: number | null = null;
  try {
    const snap = await stores.engineSnapshots.newest({
      tenantId: args.tenantId,
      engine: args.engine,
      engineListingId: args.engineListingId
    });
    if (snap) {
      snapAgeHours = hoursBetween(snap.capturedAt, now);
      const my = normalizeOccFraction(snap.occNext30);
      if (my !== null) myOcc = { value: my, window: "next30", source: "engine_snapshot" };
      const market = normalizeOccFraction(snap.marketOccNext30);
      if (market !== null) {
        snapMarketOcc = { value: market, window: "next30", source: "engine_snapshot" };
      }
    }
  } catch {
    notes.push("engine snapshot read failed");
  }

  const marketOccNext30 = nbOcc ?? snapMarketOcc;
  const neighborhoodContributed = nbOcc !== null || nbPrice !== null;
  const snapshotContributed = snapMarketOcc !== null || myOcc !== null;

  let source: MarketContextSource = "none";
  let dataAgeHours: number | null = null;
  if (neighborhood && neighborhoodContributed) {
    source = neighborhood.kind;
    dataAgeHours = hoursBetween(neighborhood.fetchedAt, now);
  } else if (snapshotContributed) {
    source = "engine_snapshot";
    dataAgeHours = snapAgeHours;
  }

  return {
    engine: args.engine,
    asOf: now.toISOString(),
    source,
    marketOccNext30,
    myOccNext30: myOcc,
    pricePosition: nbPrice,
    dataAgeHours,
    notes
  };
}
