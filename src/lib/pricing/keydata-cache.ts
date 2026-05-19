/**
 * KeyData response cache. Backed by the `keydata_cache_entries` table.
 *
 * The trial budget is ~250 calls over 14 days; aggressive caching keeps us
 * comfortably inside that. TTLs per spec §4.3:
 *   - market benchmark (P20/P50/P80): 7 days
 *   - city seasonality / DoW indices: 14 days
 *   - forward pace: 24 hours
 *   - lookups (markets, KPI types): 30 days
 *
 * The cache is global, not tenant-scoped — the data we cache is market-level
 * (Belfast) and identical across tenants. The tenant feature flag is enforced
 * at the provider level before any cache read happens.
 */

import { prisma } from "@/lib/prisma";

export type KeyDataCachePayload = {
  payload: unknown;
  sampleSize: number | null;
  fetchedAt: Date;
  expiresAt: Date;
};

export type KeyDataCacheTTL = "benchmark" | "seasonality" | "dow" | "forward-pace" | "lookups" | "listing-kpis";

const TTL_MS: Record<KeyDataCacheTTL, number> = {
  benchmark: 7 * 24 * 60 * 60 * 1000,
  seasonality: 14 * 24 * 60 * 60 * 1000,
  dow: 14 * 24 * 60 * 60 * 1000,
  "forward-pace": 24 * 60 * 60 * 1000,
  lookups: 30 * 24 * 60 * 60 * 1000,
  // Per-listing trailing 12mo KPIs change slowly — weekly cache is
  // plenty and keeps us comfortably inside the daily call budget when
  // refreshing 50+ listings.
  "listing-kpis": 7 * 24 * 60 * 60 * 1000
};

export function ttlMs(kind: KeyDataCacheTTL): number {
  return TTL_MS[kind];
}

export async function readCache(cacheKey: string): Promise<KeyDataCachePayload | null> {
  const row = await prisma.keyDataCacheEntry.findUnique({ where: { cacheKey } });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return {
    payload: row.payload as unknown,
    sampleSize: row.sampleSize,
    fetchedAt: row.fetchedAt,
    expiresAt: row.expiresAt
  };
}

export async function writeCache(
  cacheKey: string,
  payload: unknown,
  kind: KeyDataCacheTTL,
  sampleSize: number | null
): Promise<void> {
  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + ttlMs(kind));
  await prisma.keyDataCacheEntry.upsert({
    where: { cacheKey },
    create: {
      cacheKey,
      payload: payload as never,
      fetchedAt,
      expiresAt,
      sampleSize: sampleSize ?? undefined
    },
    update: {
      payload: payload as never,
      fetchedAt,
      expiresAt,
      sampleSize: sampleSize ?? undefined
    }
  });
}

export function cacheKey(...parts: Array<string | number | boolean | null | undefined>): string {
  return parts
    .map((p) => (p === null || p === undefined ? "null" : String(p).toLowerCase().replace(/\s+/g, "_")))
    .join(":");
}
