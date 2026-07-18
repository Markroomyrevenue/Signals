import assert from "node:assert/strict";
import test from "node:test";

import { buildMarketContext, londonDayOf, type BuildMarketContextArgs } from "./context";
import type { TrimmedNeighborhood } from "./map";
import type {
  EngineOccSnapshot,
  MarketSnapshotKey,
  MarketSnapshotRow,
  MarketStores
} from "./stores";

const NOW = new Date("2026-07-18T09:00:00.000Z");
const DAY = "2026-07-18";
/** 14h before NOW. */
const CAPTURED_AT = new Date("2026-07-17T19:00:00.000Z");

/** EngineSnapshot occ fields as the 05:30 capture stores them (PL percent). */
function snapshot(overrides: Partial<EngineOccSnapshot> = {}): EngineOccSnapshot {
  return {
    occNext7: null,
    occNext30: 61,
    occNext60: null,
    marketOccNext7: null,
    marketOccNext30: 62,
    marketOccNext60: null,
    capturedAt: CAPTURED_AT,
    ...overrides
  };
}

type FakeStores = {
  stores: MarketStores;
  upserts: Array<{ key: MarketSnapshotKey; payload: unknown }>;
  snapshotReads: Array<{ tenantId: string; engine: string; engineListingId: string }>;
  seed: (key: MarketSnapshotKey, payload: unknown, createdAt?: Date) => void;
};

function fakeStores(engineSnapshot: EngineOccSnapshot | null): FakeStores {
  const rows = new Map<string, MarketSnapshotRow>();
  const upserts: FakeStores["upserts"] = [];
  const snapshotReads: FakeStores["snapshotReads"] = [];
  const keyOf = (k: MarketSnapshotKey): string =>
    [k.tenantId, k.engine, k.kind, k.engineListingId, k.day].join("|");
  return {
    upserts,
    snapshotReads,
    seed: (key, payload, createdAt = NOW) => rows.set(keyOf(key), { payload, createdAt }),
    stores: {
      snapshots: {
        async get(key) {
          return rows.get(keyOf(key)) ?? null;
        },
        async upsert(key, payload) {
          upserts.push({ key, payload });
          rows.set(keyOf(key), { payload, createdAt: NOW });
        }
      },
      engineSnapshots: {
        async newest(args) {
          snapshotReads.push(args);
          return engineSnapshot;
        }
      }
    }
  };
}

function args(overrides: Partial<BuildMarketContextArgs> = {}): BuildMarketContextArgs {
  return {
    tenantId: "t1",
    engine: "pricelabs",
    engineListingId: "pl-1",
    pms: "hostaway",
    myRateByDate: new Map<string, number>(),
    day: DAY,
    bedrooms: 2,
    now: NOW,
    ...overrides
  };
}

const PL_KEY: MarketSnapshotKey = {
  tenantId: "t1",
  engine: "pricelabs",
  kind: "pl_neighborhood",
  engineListingId: "pl-1",
  day: DAY
};

/** In-window trimmed series: occ mean 0.7 (n=2); 2026-09-01 is outside next30. */
const TRIMMED: TrimmedNeighborhood = {
  days: [
    { date: "2026-07-20", medianPrice: 100, marketOcc: 0.6 },
    { date: "2026-07-21", medianPrice: 100, marketOcc: null },
    { date: "2026-07-22", medianPrice: 100, marketOcc: null },
    { date: "2026-07-25", medianPrice: null, marketOcc: 0.8 },
    { date: "2026-09-01", medianPrice: 50, marketOcc: 0.1 }
  ]
};

/** A raw PL payload whose trim equals two in-window days. */
const PL_RAW = {
  data: {
    "Future Percentile Prices": {
      Labels: ["25th Percentile", "50th Percentile"],
      Category: { "2": { X_values: ["2026-07-20", "2026-07-21"], Y_values: [[80, 82], [98, 100]] } }
    },
    "Future Occ/New/Canc": {
      Labels: ["Occupancy"],
      Category: { "2": { X_values: ["2026-07-20", "2026-07-21"], Y_values: [[62, 70]] } }
    }
  }
};

// ---- cache hit --------------------------------------------------------------

test("cache hit: reader never called, context built from the cached trim", async () => {
  const fakes = fakeStores(null);
  fakes.seed(PL_KEY, TRIMMED, new Date("2026-07-18T07:00:00.000Z")); // 2h before NOW
  let readerCalls = 0;
  const ctx = await buildMarketContext(
    args({
      stores: fakes.stores,
      readers: {
        fetchPlNeighborhood: async () => {
          readerCalls += 1;
          return PL_RAW;
        }
      }
    })
  );
  assert.equal(readerCalls, 0);
  assert.equal(fakes.upserts.length, 0);
  assert.equal(ctx.source, "pl_neighborhood");
  assert.deepEqual(ctx.marketOccNext30, { value: 0.7, window: "next30", source: "pl_neighborhood", n: 2 });
  assert.equal(ctx.dataAgeHours, 2);
  assert.equal(ctx.asOf, NOW.toISOString());
});

// ---- cache miss → reader → upsert ------------------------------------------

test("cache miss: reader called once, trimmed payload upserted once, reused next build", async () => {
  const fakes = fakeStores(null);
  const readerArgs: Array<[string, string]> = [];
  const readers = {
    fetchPlNeighborhood: async (engineListingId: string, pms: string) => {
      readerArgs.push([engineListingId, pms]);
      return PL_RAW;
    }
  };

  const ctx = await buildMarketContext(args({ stores: fakes.stores, readers }));
  assert.deepEqual(readerArgs, [["pl-1", "hostaway"]]);
  assert.equal(fakes.upserts.length, 1);
  assert.deepEqual(fakes.upserts[0].key, PL_KEY);
  assert.deepEqual(fakes.upserts[0].payload, {
    days: [
      { date: "2026-07-20", medianPrice: 98, marketOcc: 0.62 },
      { date: "2026-07-21", medianPrice: 100, marketOcc: 0.7 }
    ]
  });
  assert.equal(ctx.source, "pl_neighborhood");
  assert.equal(ctx.marketOccNext30?.value, 0.66); // mean(0.62, 0.70)
  assert.equal(ctx.dataAgeHours, 0); // fetched this build

  // Same day again: pure cache hit — still exactly one reader call + upsert.
  await buildMarketContext(args({ stores: fakes.stores, readers }));
  assert.equal(readerArgs.length, 1);
  assert.equal(fakes.upserts.length, 1);
});

// ---- reader error → engine snapshot fallback -------------------------------

test("reader error degrades to the engine snapshot with an honest note (status only)", async () => {
  const fakes = fakeStores(snapshot());
  const ctx = await buildMarketContext(
    args({
      stores: fakes.stores,
      readers: {
        fetchPlNeighborhood: async () => {
          const error = new Error("secret-key-do-not-leak") as Error & { status: number };
          error.status = 403;
          throw error;
        }
      }
    })
  );
  assert.deepEqual(ctx.notes, ["neighborhood data unavailable (403)"]);
  assert.ok(!ctx.notes.join(" ").includes("secret"));
  assert.equal(fakes.upserts.length, 0); // errors are transient — never cached
  assert.equal(ctx.source, "engine_snapshot");
  assert.deepEqual(ctx.marketOccNext30, { value: 0.62, window: "next30", source: "engine_snapshot" });
  assert.deepEqual(ctx.myOccNext30, { value: 0.61, window: "next30", source: "engine_snapshot" });
  assert.equal(ctx.dataAgeHours, 14);
  assert.equal(ctx.pricePosition, null);
});

test("no reader wired degrades silently (no note) to the engine snapshot", async () => {
  const fakes = fakeStores(snapshot());
  const ctx = await buildMarketContext(args({ stores: fakes.stores }));
  assert.deepEqual(ctx.notes, []);
  assert.equal(ctx.source, "engine_snapshot");
  assert.deepEqual(fakes.snapshotReads, [{ tenantId: "t1", engine: "pricelabs", engineListingId: "pl-1" }]);
});

// ---- nothing available ------------------------------------------------------

test("no reader + no snapshot → source none, null fields", async () => {
  const fakes = fakeStores(null);
  const ctx = await buildMarketContext(args({ stores: fakes.stores }));
  assert.equal(ctx.source, "none");
  assert.equal(ctx.marketOccNext30, null);
  assert.equal(ctx.myOccNext30, null);
  assert.equal(ctx.pricePosition, null);
  assert.equal(ctx.dataAgeHours, null);
});

test("engine snapshot read failure is noted, never thrown", async () => {
  const fakes = fakeStores(null);
  fakes.stores.engineSnapshots = {
    newest: async () => {
      throw new Error("db down");
    }
  };
  const ctx = await buildMarketContext(args({ stores: fakes.stores }));
  assert.equal(ctx.source, "none");
  assert.deepEqual(ctx.notes, ["engine snapshot read failed"]);
});

// ---- an empty trim is still cached (rate-limit guard) ----------------------

test("unusable reader payload caches an empty trim and falls back to the snapshot", async () => {
  const fakes = fakeStores(snapshot());
  let readerCalls = 0;
  const readers = {
    fetchPlNeighborhood: async () => {
      readerCalls += 1;
      return "garbage";
    }
  };
  const first = await buildMarketContext(args({ stores: fakes.stores, readers }));
  assert.equal(fakes.upserts.length, 1);
  assert.deepEqual(fakes.upserts[0].payload, { days: [] });
  assert.equal(first.source, "engine_snapshot");

  // Second build: cache hit on the empty trim — the engine is NOT re-hit today.
  const second = await buildMarketContext(args({ stores: fakes.stores, readers }));
  assert.equal(readerCalls, 1);
  assert.equal(second.source, "engine_snapshot");
});

// ---- my occ always comes from the snapshot ---------------------------------

test("my occupancy comes from the engine snapshot even when neighborhood data is present", async () => {
  const fakes = fakeStores(snapshot());
  fakes.seed(PL_KEY, TRIMMED);
  const ctx = await buildMarketContext(args({ stores: fakes.stores }));
  assert.equal(ctx.source, "pl_neighborhood");
  assert.equal(ctx.marketOccNext30?.source, "pl_neighborhood");
  assert.deepEqual(ctx.myOccNext30, { value: 0.61, window: "next30", source: "engine_snapshot" });
});

// ---- price position ---------------------------------------------------------

test("price position picks the median-ratio date of the window", async () => {
  const fakes = fakeStores(null);
  fakes.seed(PL_KEY, TRIMMED);
  const ctx = await buildMarketContext(
    args({
      stores: fakes.stores,
      myRateByDate: new Map([
        ["2026-07-20", 100], // ratio 1.0
        ["2026-07-21", 120], // ratio 1.2  ← median
        ["2026-07-22", 150], // ratio 1.5
        ["2026-09-01", 500] // outside the window — ignored
      ])
    })
  );
  assert.deepEqual(ctx.pricePosition, {
    myRate: 120,
    neighborhoodMedian: 100,
    ratio: 1.2,
    date: "2026-07-21",
    source: "pl_neighborhood"
  });
});

// ---- wheelhouse path --------------------------------------------------------

test("wheelhouse: both reads trimmed into one wh_neighborhood cache row", async () => {
  const fakes = fakeStores(null);
  const ctx = await buildMarketContext(
    args({
      engine: "wheelhouse",
      engineListingId: "wh-9",
      stores: fakes.stores,
      readers: {
        fetchWhNeighborhoodPricing: async () => [{ date: "2026-07-20", median_price: 88 }],
        fetchWhNeighborhoodOccupancy: async () => [{ date: "2026-07-20", occupancy: 0.9 }]
      }
    })
  );
  assert.equal(fakes.upserts.length, 1);
  assert.deepEqual(fakes.upserts[0].key, {
    tenantId: "t1",
    engine: "wheelhouse",
    kind: "wh_neighborhood",
    engineListingId: "wh-9",
    day: DAY
  });
  assert.equal(ctx.source, "wh_neighborhood");
  assert.deepEqual(ctx.marketOccNext30, { value: 0.9, window: "next30", source: "wh_neighborhood", n: 1 });
});

test("wheelhouse: one read failing still uses the other, with a partial-read note", async () => {
  const fakes = fakeStores(null);
  const ctx = await buildMarketContext(
    args({
      engine: "wheelhouse",
      stores: fakes.stores,
      readers: {
        fetchWhNeighborhoodPricing: async () => {
          const error = new Error("nope") as Error & { status: number };
          error.status = 500;
          throw error;
        },
        fetchWhNeighborhoodOccupancy: async () => [{ date: "2026-07-20", occupancy: 45 }]
      }
    })
  );
  assert.deepEqual(ctx.notes, ["partial neighborhood read (500)"]);
  assert.equal(ctx.marketOccNext30?.value, 0.45);
  assert.equal(ctx.source, "wh_neighborhood");
});

// ---- tenant scoping ---------------------------------------------------------

test("every store call carries the tenantId", async () => {
  const fakes = fakeStores(snapshot());
  await buildMarketContext(
    args({ stores: fakes.stores, readers: { fetchPlNeighborhood: async () => PL_RAW } })
  );
  assert.ok(fakes.upserts.every((u) => u.key.tenantId === "t1"));
  assert.ok(fakes.snapshotReads.every((r) => r.tenantId === "t1"));
});

// ---- london day helper ------------------------------------------------------

test("londonDayOf uses the Europe/London calendar day (BST boundary)", () => {
  // 23:30 UTC on 17 July is 00:30 on 18 July in London (BST = UTC+1).
  assert.equal(londonDayOf(new Date("2026-07-17T23:30:00.000Z")), "2026-07-18");
  assert.equal(londonDayOf(new Date("2026-01-17T23:30:00.000Z")), "2026-01-17"); // GMT
});
