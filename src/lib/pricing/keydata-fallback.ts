/**
 * KeyData last-known-good fallback cache (2026-05-27 PM).
 *
 * ## Why
 *
 * After the 2026-05-27 PM demand-signal consolidation, the KD
 * `forwardAdrUnbooked` series is the SOLE demand input to the trial
 * pricing chain. Own-pace was removed; events lever was removed. A
 * KD outage today (network blip, OTA-key expiry, KD downtime) would
 * leave every cell at demand multiplier 1.0 — a meaningful regression
 * for the run.
 *
 * This module wraps `KeyDataProvider.getForwardPace` with a three-step
 * lookup:
 *   1. Live KD call — if it returns non-null, use it AND write to the
 *      fallback cache.
 *   2. If live returned null, read the per-tenant fallback file. If
 *      the cached entry for (market, bedrooms) is within
 *      `KD_FALLBACK_TTL_HOURS = 48`, use it and log a hygiene-warn
 *      `KD_FALLBACK_USED`.
 *   3. If no fallback / cache expired, return null AND log
 *      `KD_FALLBACK_EXPIRED`. Demand multiplier will fall through to
 *      neutral (1.0) for cells in this market/bedroom band.
 *
 * ## Cache shape
 *
 * One JSON file per tenant at `cache/keydata-fallback/{tenant-slug}.json`
 * (per Mark's 2026-05-27 PM clarification). File contains a list of
 * (market, bedrooms) entries — KD data is technically per-market, so
 * the per-tenant split is duplicative across tenants in the same
 * market but makes the cache easy to inspect/wipe per tenant and
 * matches the way Mark thinks about the data.
 *
 * Cache eviction: overwrite the matching entry on each successful
 * pull. No growth, no stale entries (other than the legitimate TTL-
 * bounded last-known-good).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { KeyDataForwardPace, KeyDataProvider } from "@/lib/pricing/keydata-provider";

/**
 * Maximum age of a cached fallback entry before we give up on it and
 * return null. Two days covers a weekend outage / transient KD
 * downtime; beyond that the data is too stale to trust as a
 * "competitive baseline" and falling through to neutral 1.0 is the
 * right call (the hygiene warn flags the gap).
 */
export const KD_FALLBACK_TTL_HOURS = 48;

const FALLBACK_DIR = path.resolve(
  "/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8/cache/keydata-fallback"
);

type CachedEntry = {
  market: "belfast";
  bedrooms: number;
  forwardPace: KeyDataForwardPace;
  cachedAt: string; // ISO timestamp
};

type FallbackFile = {
  tenant: string;
  entries: CachedEntry[];
};

function slugify(tenantId: string): string {
  // Trial-scale: tenant IDs are CUIDs (cmng...). Use the last 8 chars
  // for a stable, short filename component. Falls back to the full
  // ID if too short.
  if (tenantId.length <= 8) return tenantId;
  return tenantId.slice(-8);
}

function fallbackPathFor(tenantId: string): string {
  return path.join(FALLBACK_DIR, `${slugify(tenantId)}.json`);
}

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(FALLBACK_DIR, { recursive: true });
  } catch {
    // ignore — write will surface the real error
  }
}

async function readFallbackFile(tenantId: string): Promise<FallbackFile | null> {
  try {
    const raw = await fs.readFile(fallbackPathFor(tenantId), "utf-8");
    const parsed = JSON.parse(raw) as FallbackFile;
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeFallbackFile(tenantId: string, file: FallbackFile): Promise<void> {
  await ensureDir();
  await fs.writeFile(fallbackPathFor(tenantId), JSON.stringify(file, null, 2), "utf-8");
}

function ageHours(cachedAt: string): number {
  const t = new Date(cachedAt).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / (1000 * 60 * 60);
}

export type ForwardPaceWithProvenance = {
  forwardPace: KeyDataForwardPace | null;
  /** "live" | "fallback-cache" | "neutral". */
  source: "live" | "fallback-cache" | "neutral";
  /** Age of the cache entry in hours when source = fallback-cache. */
  fallbackAgeHours: number | null;
};

/**
 * Wrap `provider.getForwardPace` with a per-tenant last-known-good
 * cache.
 *
 * Side effects:
 *   - On a successful live pull, writes the result to the per-tenant
 *     fallback cache (overwrites any prior matching entry).
 *   - Logs `KD_FALLBACK_USED` or `KD_FALLBACK_EXPIRED` to stderr when
 *     the live pull fails and a fallback path is taken.
 *
 * The wrapper is intentionally NOT a method on `KeyDataProvider` —
 * `getForwardPace` itself is unaware of the tenant. The wrapper is
 * imported by `agent.ts` (the only legitimate caller in the trial
 * path) and threaded through with the tenant ID.
 */
export async function getForwardPaceWithFallback(args: {
  tenantId: string;
  provider: KeyDataProvider;
  marketKey: "belfast";
  bedrooms: number;
  horizonDays: number;
}): Promise<ForwardPaceWithProvenance> {
  const { tenantId, provider, marketKey, bedrooms, horizonDays } = args;
  const live = await provider.getForwardPace({ marketKey, bedrooms, horizonDays });
  if (live !== null && live.perDate.length > 0) {
    // Write-through to fallback cache for the next outage.
    const existing = (await readFallbackFile(tenantId)) ?? { tenant: tenantId, entries: [] };
    const idx = existing.entries.findIndex((e) => e.market === marketKey && e.bedrooms === bedrooms);
    const entry: CachedEntry = {
      market: marketKey,
      bedrooms,
      forwardPace: live,
      cachedAt: new Date().toISOString()
    };
    if (idx >= 0) existing.entries[idx] = entry;
    else existing.entries.push(entry);
    await writeFallbackFile(tenantId, existing);
    return { forwardPace: live, source: "live", fallbackAgeHours: null };
  }

  // Live failed (or returned empty). Try the fallback cache.
  const file = await readFallbackFile(tenantId);
  const entry = file?.entries.find((e) => e.market === marketKey && e.bedrooms === bedrooms);
  if (!entry) {
    console.warn(
      `[keydata] KD_FALLBACK_EXPIRED: no fallback entry for tenant=${slugify(tenantId)} market=${marketKey} bedrooms=${bedrooms} — demand multiplier defaults to neutral 1.0`
    );
    return { forwardPace: null, source: "neutral", fallbackAgeHours: null };
  }
  const age = ageHours(entry.cachedAt);
  if (age > KD_FALLBACK_TTL_HOURS) {
    console.warn(
      `[keydata] KD_FALLBACK_EXPIRED: tenant=${slugify(tenantId)} market=${marketKey} bedrooms=${bedrooms} age=${age.toFixed(1)}h > ttl=${KD_FALLBACK_TTL_HOURS}h — demand multiplier defaults to neutral 1.0`
    );
    return { forwardPace: null, source: "neutral", fallbackAgeHours: age };
  }
  console.warn(
    `[keydata] KD_FALLBACK_USED: tenant=${slugify(tenantId)} market=${marketKey} bedrooms=${bedrooms} age=${age.toFixed(1)}h — using cached forward pace`
  );
  return { forwardPace: entry.forwardPace, source: "fallback-cache", fallbackAgeHours: age };
}
