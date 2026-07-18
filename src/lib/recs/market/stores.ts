/**
 * Injectable store interfaces for the recs market module + their DEFAULT_
 * Prisma implementations. All pure logic lives in map.ts/factor.ts/context.ts
 * and takes these as typed deps, so tests run on in-memory fakes with no DB.
 *
 * Tenant isolation: EVERY query here filters by tenantId (non-negotiable —
 * see CLAUDE.md "Multi-tenant isolation").
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import type { RecsEngine, RecsMarketSnapshotKind } from "./types";

// ---------------------------------------------------------------------------
// recs_market_snapshots — per-day cache + reproducibility snapshot
// ---------------------------------------------------------------------------

/** The unique key of one cache row (matches the DB unique constraint). */
export type MarketSnapshotKey = {
  tenantId: string;
  engine: RecsEngine;
  kind: RecsMarketSnapshotKind;
  /** "" (not null) for market-level rows, per the schema comment. */
  engineListingId: string;
  /** Europe/London calendar day, yyyy-mm-dd. */
  day: string;
};

export type MarketSnapshotRow = {
  payload: unknown;
  createdAt: Date;
};

export type MarketSnapshotStore = {
  get(key: MarketSnapshotKey): Promise<MarketSnapshotRow | null>;
  upsert(key: MarketSnapshotKey, payload: unknown): Promise<void>;
};

/** yyyy-mm-dd → the UTC-midnight Date Prisma stores in a `@db.Date` column. */
function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export const DEFAULT_MARKET_SNAPSHOT_STORE: MarketSnapshotStore = {
  async get(key) {
    const row = await prisma.recsMarketSnapshot.findUnique({
      where: {
        tenantId_engine_kind_engineListingId_day: {
          tenantId: key.tenantId,
          engine: key.engine,
          kind: key.kind,
          engineListingId: key.engineListingId,
          day: dayToDate(key.day)
        }
      },
      select: { payload: true, createdAt: true }
    });
    return row ? { payload: row.payload, createdAt: row.createdAt } : null;
  },

  async upsert(key, payload) {
    const json = payload as Prisma.InputJsonValue;
    await prisma.recsMarketSnapshot.upsert({
      where: {
        tenantId_engine_kind_engineListingId_day: {
          tenantId: key.tenantId,
          engine: key.engine,
          kind: key.kind,
          engineListingId: key.engineListingId,
          day: dayToDate(key.day)
        }
      },
      create: {
        tenantId: key.tenantId,
        engine: key.engine,
        kind: key.kind,
        engineListingId: key.engineListingId,
        day: dayToDate(key.day),
        payload: json
      },
      update: { payload: json }
    });
  }
};

// ---------------------------------------------------------------------------
// engine_snapshots — newest occ/marketOcc per listing (the 05:30 capture)
// ---------------------------------------------------------------------------

/** The occupancy fields of the newest engine snapshot, as plain numbers. */
export type EngineOccSnapshot = {
  occNext7: number | null;
  occNext30: number | null;
  occNext60: number | null;
  marketOccNext7: number | null;
  marketOccNext30: number | null;
  marketOccNext60: number | null;
  capturedAt: Date;
};

export type EngineSnapshotReader = {
  newest(args: {
    tenantId: string;
    engine: RecsEngine;
    engineListingId: string;
  }): Promise<EngineOccSnapshot | null>;
};

/** Prisma Decimal | null → number | null. */
function decToNum(value: { toNumber(): number } | null): number | null {
  if (value === null) return null;
  const n = value.toNumber();
  return Number.isFinite(n) ? n : null;
}

export const DEFAULT_ENGINE_SNAPSHOT_READER: EngineSnapshotReader = {
  async newest(args) {
    const row = await prisma.engineSnapshot.findFirst({
      where: {
        tenantId: args.tenantId,
        engine: args.engine,
        engineListingId: args.engineListingId
      },
      orderBy: { capturedAt: "desc" },
      select: {
        occNext7: true,
        occNext30: true,
        occNext60: true,
        marketOccNext7: true,
        marketOccNext30: true,
        marketOccNext60: true,
        capturedAt: true
      }
    });
    if (!row) return null;
    return {
      occNext7: decToNum(row.occNext7),
      occNext30: decToNum(row.occNext30),
      occNext60: decToNum(row.occNext60),
      marketOccNext7: decToNum(row.marketOccNext7),
      marketOccNext30: decToNum(row.marketOccNext30),
      marketOccNext60: decToNum(row.marketOccNext60),
      capturedAt: row.capturedAt
    };
  }
};

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export type MarketStores = {
  snapshots: MarketSnapshotStore;
  engineSnapshots: EngineSnapshotReader;
};

export const DEFAULT_MARKET_STORES: MarketStores = {
  snapshots: DEFAULT_MARKET_SNAPSHOT_STORE,
  engineSnapshots: DEFAULT_ENGINE_SNAPSHOT_READER
};
