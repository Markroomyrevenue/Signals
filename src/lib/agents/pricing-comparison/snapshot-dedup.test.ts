import assert from "node:assert/strict";
import test from "node:test";

import { dedupSnapshotRows } from "./snapshot-dedup";

// ---------------------------------------------------------------------------
// 2026-05-27 PM trial-report fix — dedup by latest createdAt per
// (tenantId, listingId, targetDate, snapshotDate) tuple
// ---------------------------------------------------------------------------

type Row = {
  tenantId: string;
  listingId: string;
  targetDate: Date;
  snapshotDate: Date;
  createdAt: Date;
  ourRate: number;
  // Stand-in for the JSON payload (e.g. troughDiagnostic).
  ourBreakdown: { demand: { floorHit: boolean; finalMultiplier: number } };
};

const TENANT = "tenantA";
const LISTING = "listingX";
const TARGET = new Date("2026-08-08T00:00:00Z");
const SNAPSHOT = new Date("2026-05-27T00:00:00Z");

function mkRow(args: Partial<Row> & { createdAt: Date; ourRate: number; demandMultiplier: number; floorHit?: boolean }): Row {
  return {
    tenantId: args.tenantId ?? TENANT,
    listingId: args.listingId ?? LISTING,
    targetDate: args.targetDate ?? TARGET,
    snapshotDate: args.snapshotDate ?? SNAPSHOT,
    createdAt: args.createdAt,
    ourRate: args.ourRate,
    ourBreakdown: { demand: { floorHit: args.floorHit ?? false, finalMultiplier: args.demandMultiplier } }
  };
}

test("dedup — single row in returns single row out (no-op)", () => {
  const rows = [mkRow({ createdAt: new Date("2026-05-27T12:00:00Z"), ourRate: 200, demandMultiplier: 1.1 })];
  const result = dedupSnapshotRows(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].ourRate, 200);
});

test("dedup — two rows same tuple, different createdAt → latest wins (the canonical bug)", () => {
  // Simulates the exact bug we hit today: two manual reruns of
  // `npx tsx scripts/run-comparison.ts` for snapshotDate 2026-05-27
  // wrote two rows for the same (tenant, listing, target, snapshot)
  // tuple. The pre-fix aggregator counted both — older row had
  // demand floored at 0.80 (pre-floor-removal), newer row had demand
  // at 1.05 (post-floor-removal). Report needs to use ONLY the newer.
  const older = mkRow({
    createdAt: new Date("2026-05-27T10:00:00Z"),
    ourRate: 180,
    demandMultiplier: 0.80,
    floorHit: true
  });
  const newer = mkRow({
    createdAt: new Date("2026-05-27T13:46:00Z"),
    ourRate: 225,
    demandMultiplier: 1.05,
    floorHit: false
  });
  const result = dedupSnapshotRows([older, newer]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ourRate, 225, "must keep the row from the later run");
  assert.equal(result[0].ourBreakdown.demand.floorHit, false, "must reflect the latest breakdown");
  assert.equal(result[0].ourBreakdown.demand.finalMultiplier, 1.05);
});

test("dedup — order-independent (newer first, older second produces same result)", () => {
  const older = mkRow({ createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 180, demandMultiplier: 0.80 });
  const newer = mkRow({ createdAt: new Date("2026-05-27T13:46:00Z"), ourRate: 225, demandMultiplier: 1.05 });
  const r1 = dedupSnapshotRows([older, newer]);
  const r2 = dedupSnapshotRows([newer, older]);
  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);
  assert.equal(r1[0].ourRate, 225);
  assert.equal(r2[0].ourRate, 225);
});

test("dedup — different tuples preserved (tenant, listing, target, snapshot are the key)", () => {
  const a = mkRow({ tenantId: "tenantA", listingId: "L1", createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 100, demandMultiplier: 1.0 });
  const b = mkRow({ tenantId: "tenantB", listingId: "L1", createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 200, demandMultiplier: 1.0 });
  const c = mkRow({ tenantId: "tenantA", listingId: "L2", createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 300, demandMultiplier: 1.0 });
  const d = mkRow({ tenantId: "tenantA", listingId: "L1", targetDate: new Date("2026-08-09T00:00:00Z"), createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 400, demandMultiplier: 1.0 });
  const e = mkRow({ tenantId: "tenantA", listingId: "L1", snapshotDate: new Date("2026-05-26T00:00:00Z"), createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 500, demandMultiplier: 1.0 });
  const result = dedupSnapshotRows([a, b, c, d, e]);
  assert.equal(result.length, 5, "all 5 differ on at least one key field, none should dedup");
});

test("dedup — three runs same tuple, middle createdAt does NOT win", () => {
  const r1 = mkRow({ createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 100, demandMultiplier: 1.0 });
  const r2 = mkRow({ createdAt: new Date("2026-05-27T12:00:00Z"), ourRate: 200, demandMultiplier: 1.1 });
  const r3 = mkRow({ createdAt: new Date("2026-05-27T14:00:00Z"), ourRate: 300, demandMultiplier: 1.2 });
  const result = dedupSnapshotRows([r1, r2, r3]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ourRate, 300, "latest createdAt across all 3");
});

test("dedup — empty input returns empty array", () => {
  assert.deepEqual(dedupSnapshotRows([]), []);
});

test("dedup — ties on createdAt are stable (last-seen-wins among equal createdAt)", () => {
  // In practice createdAt has ms precision; ties are negligible. But
  // pinned for predictability: when two rows have identical
  // createdAt, the later-iterated one wins (the >= in the comparator
  // means the second insert overwrites). This matches how postgres
  // would behave if we used ORDER BY created_at DESC, NULLS LAST and
  // took the first.
  const a = mkRow({ createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 100, demandMultiplier: 1.0 });
  const b = mkRow({ createdAt: new Date("2026-05-27T10:00:00Z"), ourRate: 200, demandMultiplier: 1.0 });
  const result = dedupSnapshotRows([a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0].ourRate, 200, "later-iterated wins on tie");
});
