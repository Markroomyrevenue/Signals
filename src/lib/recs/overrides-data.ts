/**
 * Read layer for the ENGINE-OVERRIDE calendar markers (2026-07-21).
 *
 * Tells the calendar UI which nights already carry an engine override — a
 * Wheelhouse custom_rate or a PriceLabs override — so those tiles can be marked
 * (the operator is replacing an existing override, not writing a fresh price).
 *
 * The whole point of this module is to stay UNDER the engines' rate limits:
 * Wheelhouse caps at 20 req/min. So listings are read STRICTLY SEQUENTIALLY —
 * one engine call at a time, with a small delay between them — never in
 * parallel. A parallel fan-out across a client's listings would burst straight
 * into a 429, which is exactly the failure this endpoint exists to avoid.
 *
 * Resilience over completeness: a per-listing failure (429/timeout/throw) is
 * caught and skipped, and the result is flagged `partial: true` rather than
 * throwing the whole read away. The UI shows what it can and knows the picture
 * is incomplete. Missing engine keys and the too-many-listings cap flag partial
 * the same way.
 *
 * Internal-only (the route applies the same `getInternalRecsAuth` gate every
 * /api/recs route does). Every Prisma query filters by tenantId (house rule).
 */

import { toDateOnly } from "@/lib/metrics/helpers";
import { resolveObserveSource } from "@/lib/observe/registry";
import { prisma } from "@/lib/prisma";
import { calendarWindow } from "@/lib/recs/calendar-data";
import { buildDefaultAdapterFactory } from "@/lib/recs/push/push-service";
import {
  isRecsPushEngine,
  type RecsEnginePushAdapter,
  type RecsOverrideReads
} from "@/lib/recs/push/types";

export type EngineOverridesResult = {
  /** listingId → sorted YYYY-MM-DD dates that currently carry an override. */
  overrides: Record<string, string[]>;
  /** True when the picture is incomplete (a read failed, keys missing, or capped). */
  partial: boolean;
  /** The tenant's resolved engine (pricelabs | wheelhouse | hostaway-scan). */
  engine: string;
};

/** Never read more than this many listings in one request — a serial walk of
 * more would take too long AND risk the rate limit; the overflow flags partial. */
const MAX_LISTINGS = 80;

/** Delay between consecutive engine calls, PER ENGINE. These accounts are the
 * SAME ones used to push live prices, so the walk must stay under their limits
 * or an override read would 429 the operator's actual pushing. Wheelhouse caps
 * at 20 req/min → one call every ~3s (3200ms with headroom). PriceLabs costs
 * ~1 call per listing here (the pms map is fetched once) and is looser, but is
 * still paced so a big client can't burst it. */
const PER_LISTING_DELAY_MS: Record<string, number> = { wheelhouse: 3200, pricelabs: 1200 };
const DEFAULT_DELAY_MS = 3200;

/** Abort the walk after this many CONSECUTIVE failures — a systemic problem (a
 * bad/expired key, the engine down) would otherwise fire 80 retried calls for
 * nothing. The first few failures flag partial; a run of them stops. */
const FAILFAST_CONSECUTIVE = 5;

/** ~10-minute TTL: markers only need to be roughly fresh, and the cache stops a
 * calendar re-render (or several operators) from re-walking every listing. */
const CACHE_TTL_MS = 10 * 60 * 1000;

type CacheEntry = { value: EngineOverridesResult; expires: number };
/** Keyed by `${tenantId}:${todayString}` so a new London day starts fresh. */
const cache = new Map<string, CacheEntry>();
/** In-flight walks keyed the same way — a second request for a tenant already
 * being walked joins the running promise instead of starting a parallel walk
 * (which would double the engine request rate the sequential design bounds). */
const inFlight = new Map<string, Promise<EngineOverridesResult>>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runtime narrowing: the default factory always builds adapters that carry the
 * overrides read, but the resolution type only promises `RecsEnginePushAdapter`.
 * A missing method (a future/injected adapter) degrades to partial, never a crash. */
function hasOverrideReads(
  adapter: RecsEnginePushAdapter
): adapter is RecsEnginePushAdapter & RecsOverrideReads {
  return typeof (adapter as Partial<RecsOverrideReads>).listOverrideDates === "function";
}

export async function loadEngineOverrides(
  tenantId: string,
  now: Date = new Date()
): Promise<EngineOverridesResult> {
  const window = calendarWindow(now);
  const cacheKey = `${tenantId}:${window.today}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  // Join an already-running walk for the same tenant+day instead of starting a
  // parallel one (rapid client switches, two operators) — else the sequential
  // pacing is defeated by N concurrent walks all hitting the same account.
  const running = inFlight.get(cacheKey);
  if (running) return running;
  const promise = walkOverrides(tenantId, now, cacheKey).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, promise);
  return promise;
}

async function walkOverrides(
  tenantId: string,
  now: Date,
  cacheKey: string
): Promise<EngineOverridesResult> {
  const window = calendarWindow(now);

  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: { id: true, name: true }
  });
  // Unknown tenant → nothing to mark. Not partial (there is genuinely no data),
  // and not cached (a tenant that appears later must not be masked by a miss).
  if (!tenant) return { overrides: {}, partial: false, engine: "hostaway-scan" };

  const engine = resolveObserveSource({ id: tenant.id, name: tenant.name }).kind;

  const finish = (result: EngineOverridesResult): EngineOverridesResult => {
    cache.set(cacheKey, { value: result, expires: Date.now() + CACHE_TTL_MS });
    return result;
  };

  // Only pricelabs/wheelhouse tenants have overrides to read; a hostaway-scan
  // tenant has no engine account to query.
  if (!isRecsPushEngine(engine)) return finish({ overrides: {}, partial: false, engine });

  // Resolve the per-tenant adapter (keys from env). Missing keys → we can't read,
  // so mark partial rather than falsely reporting "no overrides".
  const factory = buildDefaultAdapterFactory({});
  const resolution = await factory({ engine, tenantName: tenant.name });
  if (!resolution.ok || !hasOverrideReads(resolution.adapter)) {
    return finish({ overrides: {}, partial: true, engine });
  }
  const adapter = resolution.adapter;

  const listings = await prisma.listing.findMany({
    where: { tenantId, removedAt: null },
    select: { id: true, hostawayId: true },
    orderBy: { name: "asc" }
  });

  const startDate = window.today;
  const endDate = toDateOnly(window.end);

  const overrides: Record<string, string[]> = {};
  let partial = false;

  const capped = listings.slice(0, MAX_LISTINGS);
  if (listings.length > capped.length) {
    partial = true;
    console.warn(
      `[recs-overrides] tenant ${tenantId}: ${listings.length} listings, capped at ${MAX_LISTINGS} (skipped ${listings.length - capped.length})`
    );
  }

  // SEQUENTIAL walk — one engine call at a time, delayed by the engine's own
  // safe cadence. Never parallelise: a burst would hit the engine rate limit
  // (the whole point), and this is the account that also pushes live prices.
  const delayMs = PER_LISTING_DELAY_MS[engine] ?? DEFAULT_DELAY_MS;
  let madeCall = false;
  let consecutiveFailures = 0;
  for (const listing of capped) {
    const engineListingId = listing.hostawayId ? String(listing.hostawayId) : null;
    if (!engineListingId) continue;
    if (madeCall) await sleep(delayMs);
    madeCall = true;
    try {
      const dates = await adapter.listOverrideDates(engineListingId, startDate, endDate);
      if (dates.length > 0) overrides[listing.id] = dates;
      consecutiveFailures = 0;
    } catch (error) {
      // One listing's failure must never sink the whole read — skip it and tell
      // the UI the picture is incomplete.
      partial = true;
      consecutiveFailures += 1;
      console.warn(
        `[recs-overrides] tenant ${tenantId} listing ${listing.id}: override read failed — skipping:`,
        error instanceof Error ? error.message : String(error)
      );
      // A run of failures is systemic (bad key, engine down) — stop rather than
      // fire dozens more doomed, retried, rate-limit-burning calls.
      if (consecutiveFailures >= FAILFAST_CONSECUTIVE) {
        console.warn(
          `[recs-overrides] tenant ${tenantId}: ${consecutiveFailures} consecutive failures — aborting walk`
        );
        break;
      }
    }
  }

  return finish({ overrides, partial, engine });
}
