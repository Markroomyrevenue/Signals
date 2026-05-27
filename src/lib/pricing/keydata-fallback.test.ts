import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getForwardPaceWithFallback, KD_FALLBACK_TTL_HOURS } from "./keydata-fallback";
import type { KeyDataForwardPace, KeyDataProvider } from "./keydata-provider";

// ---------------------------------------------------------------------------
// 2026-05-27 PM — KD fallback (48h last-known-good cache)
//
// Three-step lookup: live → cached (<48h, warn) → neutral (warn).
// Cache is per-tenant rolled-up JSON at cache/keydata-fallback/{slug}.json.
// ---------------------------------------------------------------------------

const FALLBACK_DIR = path.resolve(
  "/Users/markmccracken/Documents/signals/.claude/worktrees/strange-spence-7704a8/cache/keydata-fallback"
);

function makeForwardPace(adrUnbooked: number): KeyDataForwardPace {
  return {
    perDate: [
      {
        date: "2026-08-22",
        forwardOccupancy: 0.6,
        forwardADR: 200,
        forwardRevparAdj: 120,
        forwardAdrUnbooked: adrUnbooked,
        forwardBookingWindow: 60,
        marketSupplyCount: 200,
        sampleSize: 1
      }
    ],
    lastYearComparison: [],
    forwardBookingWindowMedian: 60
  };
}

function makeProvider(forwardPaceResult: KeyDataForwardPace | null): KeyDataProvider {
  return {
    getBelfastMarketUuid: async () => "test-uuid",
    getMarketBenchmark: async () => null,
    getCitySeasonalityIndex: async () => null,
    getCityDayOfWeekIndex: async () => null,
    getForwardPace: async () => forwardPaceResult,
    getTrailingMarketKpis: async () => null,
    getListingKpiSummary: async () => null
  };
}

async function cleanTenantCache(tenantId: string): Promise<void> {
  const slug = tenantId.length > 8 ? tenantId.slice(-8) : tenantId;
  try {
    await fs.unlink(path.join(FALLBACK_DIR, `${slug}.json`));
  } catch {
    // file may not exist — fine.
  }
}

test("KD fallback — pin KD_FALLBACK_TTL_HOURS = 48 per spec", () => {
  assert.equal(KD_FALLBACK_TTL_HOURS, 48);
});

test("KD fallback — live success writes to cache + returns source='live'", async () => {
  const tenantId = "test-tenant-fallback-live-xx";
  await cleanTenantCache(tenantId);
  const live = makeForwardPace(250);
  const provider = makeProvider(live);

  const result = await getForwardPaceWithFallback({
    tenantId,
    provider,
    marketKey: "belfast",
    bedrooms: 1,
    horizonDays: 270
  });

  assert.equal(result.source, "live");
  assert.equal(result.fallbackAgeHours, null);
  assert.deepEqual(result.forwardPace, live);

  // Confirm the cache was written.
  const slug = tenantId.slice(-8);
  const filePath = path.join(FALLBACK_DIR, `${slug}.json`);
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.tenant, tenantId);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].market, "belfast");
  assert.equal(parsed.entries[0].bedrooms, 1);
  assert.equal(parsed.entries[0].forwardPace.perDate[0].forwardAdrUnbooked, 250);

  await cleanTenantCache(tenantId);
});

test("KD fallback — live failure + fresh cache → source='fallback-cache' + warn logged", async () => {
  const tenantId = "test-tenant-fallback-cache-x";
  await cleanTenantCache(tenantId);
  const cachedValue = makeForwardPace(220);
  const liveProvider = makeProvider(cachedValue);
  // First call populates the cache.
  await getForwardPaceWithFallback({
    tenantId,
    provider: liveProvider,
    marketKey: "belfast",
    bedrooms: 1,
    horizonDays: 270
  });

  // Second call: provider returns null → must fall back to cache.
  const failingProvider = makeProvider(null);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => { warnings.push(String(msg)); };

  try {
    const result = await getForwardPaceWithFallback({
      tenantId,
      provider: failingProvider,
      marketKey: "belfast",
      bedrooms: 1,
      horizonDays: 270
    });
    assert.equal(result.source, "fallback-cache");
    assert.ok(result.fallbackAgeHours !== null);
    assert.ok(result.fallbackAgeHours! < 1, `expected fresh cache (<1h old), got ${result.fallbackAgeHours}h`);
    assert.equal(result.forwardPace?.perDate[0].forwardAdrUnbooked, 220);
    // Verify warn was logged.
    const usedWarns = warnings.filter((w) => w.includes("KD_FALLBACK_USED"));
    assert.ok(usedWarns.length === 1, `expected one KD_FALLBACK_USED warn, got ${usedWarns.length}`);
  } finally {
    console.warn = originalWarn;
    await cleanTenantCache(tenantId);
  }
});

test("KD fallback — live failure + no cache → source='neutral' + EXPIRED warn", async () => {
  const tenantId = "test-tenant-fallback-none-x";
  await cleanTenantCache(tenantId);
  const failingProvider = makeProvider(null);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => { warnings.push(String(msg)); };

  try {
    const result = await getForwardPaceWithFallback({
      tenantId,
      provider: failingProvider,
      marketKey: "belfast",
      bedrooms: 1,
      horizonDays: 270
    });
    assert.equal(result.source, "neutral");
    assert.equal(result.forwardPace, null);
    assert.equal(result.fallbackAgeHours, null);
    const expiredWarns = warnings.filter((w) => w.includes("KD_FALLBACK_EXPIRED"));
    assert.ok(expiredWarns.length === 1, `expected one KD_FALLBACK_EXPIRED warn, got ${expiredWarns.length}`);
  } finally {
    console.warn = originalWarn;
    await cleanTenantCache(tenantId);
  }
});

test("KD fallback — live failure + stale cache (>48h) → source='neutral' + EXPIRED warn", async () => {
  const tenantId = "test-tenant-fallback-stale";
  await cleanTenantCache(tenantId);
  // Manually write a stale cache entry (cachedAt 72h ago).
  const slug = tenantId.slice(-8);
  await fs.mkdir(FALLBACK_DIR, { recursive: true });
  const staleAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(
    path.join(FALLBACK_DIR, `${slug}.json`),
    JSON.stringify({
      tenant: tenantId,
      entries: [
        {
          market: "belfast",
          bedrooms: 1,
          forwardPace: makeForwardPace(200),
          cachedAt: staleAt
        }
      ]
    }, null, 2),
    "utf-8"
  );

  const failingProvider = makeProvider(null);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => { warnings.push(String(msg)); };

  try {
    const result = await getForwardPaceWithFallback({
      tenantId,
      provider: failingProvider,
      marketKey: "belfast",
      bedrooms: 1,
      horizonDays: 270
    });
    assert.equal(result.source, "neutral", "stale cache (>48h) must NOT be used");
    assert.equal(result.forwardPace, null);
    assert.ok(result.fallbackAgeHours !== null && result.fallbackAgeHours > KD_FALLBACK_TTL_HOURS);
    const expiredWarns = warnings.filter((w) => w.includes("KD_FALLBACK_EXPIRED"));
    assert.ok(expiredWarns.length === 1);
  } finally {
    console.warn = originalWarn;
    await cleanTenantCache(tenantId);
  }
});

test("KD fallback — write-through overwrites prior entry (no growth)", async () => {
  const tenantId = "test-tenant-fallback-overwrite";
  await cleanTenantCache(tenantId);
  // First write
  await getForwardPaceWithFallback({
    tenantId,
    provider: makeProvider(makeForwardPace(100)),
    marketKey: "belfast",
    bedrooms: 1,
    horizonDays: 270
  });
  // Second write — same (market, bedrooms), different value
  await getForwardPaceWithFallback({
    tenantId,
    provider: makeProvider(makeForwardPace(300)),
    marketKey: "belfast",
    bedrooms: 1,
    horizonDays: 270
  });

  const slug = tenantId.slice(-8);
  const raw = await fs.readFile(path.join(FALLBACK_DIR, `${slug}.json`), "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.entries.length, 1, "no growth — single entry per (market, bedrooms)");
  assert.equal(parsed.entries[0].forwardPace.perDate[0].forwardAdrUnbooked, 300, "latest value persisted");

  await cleanTenantCache(tenantId);
});
