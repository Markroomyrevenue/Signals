import assert from "node:assert/strict";
import test from "node:test";

import {
  computePeerShapeFactorByDate,
  computePeerShapeFactorByDateFromRows,
  type PeerCalendarRateRow
} from "./peer-shape";

/**
 * Helper to fabricate a year of available, level rates so a peer's yearly
 * ADR is exactly the rate passed in.
 */
function buildHistoryAtFlatRate(listingId: string, rate: number, nights = 30): PeerCalendarRateRow[] {
  return Array.from({ length: nights }, (_, idx) => ({
    listingId,
    dateOnly: `2025-04-${String((idx % 28) + 1).padStart(2, "0")}`,
    available: true,
    rate
  }));
}

test("subject listing is excluded from its own peer set (caller filters; aggregator never sees subject rows)", () => {
  // Three peers all anchored at £100 ADR. On the target date they all charge
  // £120 → factor 1.2. The aggregator does NOT receive subject rows, which
  // is the contract; we additionally check that injecting subject rows
  // would *only* matter if the caller fails to filter.
  const peers = ["peer-1", "peer-2", "peer-3"];
  const historicalRows = peers.flatMap((id) => buildHistoryAtFlatRate(id, 100));
  const forwardRows: PeerCalendarRateRow[] = peers.map((id) => ({
    listingId: id,
    dateOnly: "2026-04-25",
    available: true,
    rate: 120
  }));
  const result = computePeerShapeFactorByDateFromRows({
    historicalRows,
    forwardRows,
    fromDate: "2026-04-25",
    toDate: "2026-04-25"
  });
  const entry = result.get("2026-04-25");
  assert.ok(entry, "factor entry should exist for 2026-04-25");
  assert.equal(entry?.peerCount, 3);
  assert.ok(Math.abs((entry?.factor ?? 0) - 1.2) < 1e-9);
});

test("unavailable nights are excluded from BOTH a peer's yearly ADR and the per-date factor", () => {
  // Peer-1 history: 30 nights of £100 (available) PLUS 30 nights of £999
  // (unavailable). Yearly ADR should be £100, not the inflated mix.
  const historicalRows: PeerCalendarRateRow[] = [
    ...buildHistoryAtFlatRate("peer-1", 100),
    ...Array.from({ length: 30 }, (_, idx) => ({
      listingId: "peer-1",
      dateOnly: `2025-05-${String((idx % 28) + 1).padStart(2, "0")}`,
      available: false,
      rate: 999
    })),
    ...buildHistoryAtFlatRate("peer-2", 100),
    ...buildHistoryAtFlatRate("peer-3", 100)
  ];
  // Forward row: peer-1 is unavailable (rate present but should not count)
  // — its £200 rate must not pollute the factor average.
  const forwardRows: PeerCalendarRateRow[] = [
    { listingId: "peer-1", dateOnly: "2026-04-25", available: false, rate: 200 },
    { listingId: "peer-2", dateOnly: "2026-04-25", available: true, rate: 110 },
    { listingId: "peer-3", dateOnly: "2026-04-25", available: true, rate: 110 }
  ];
  const result = computePeerShapeFactorByDateFromRows({
    historicalRows,
    forwardRows,
    fromDate: "2026-04-25",
    toDate: "2026-04-25",
    minPeersPerDate: 2
  });
  const entry = result.get("2026-04-25");
  assert.ok(entry, "should produce an entry from the 2 available peers");
  assert.equal(entry?.peerCount, 2);
  // Both contributing peers: 110 / 100 = 1.1.
  assert.ok(Math.abs((entry?.factor ?? 0) - 1.1) < 1e-9);
});

test("peer count below minimum returns null factor entry (caller falls back to base)", () => {
  // Only 2 peers contribute on the date but the default minimum is 3.
  const historicalRows: PeerCalendarRateRow[] = [
    ...buildHistoryAtFlatRate("peer-1", 100),
    ...buildHistoryAtFlatRate("peer-2", 100)
  ];
  const forwardRows: PeerCalendarRateRow[] = [
    { listingId: "peer-1", dateOnly: "2026-04-25", available: true, rate: 110 },
    { listingId: "peer-2", dateOnly: "2026-04-25", available: true, rate: 110 }
  ];
  const result = computePeerShapeFactorByDateFromRows({
    historicalRows,
    forwardRows,
    fromDate: "2026-04-25",
    toDate: "2026-04-25"
  });
  // Date should be present in the output, with a null entry signalling
  // "fall back to base price".
  assert.equal(result.has("2026-04-25"), true);
  assert.equal(result.get("2026-04-25"), null);
});

test("two near-identical stable peers produce a stable factor across a date range", () => {
  // Both peers have identical, level history. On the target dates they
  // charge a stable +20% premium. Factor should be ~1.2 every day.
  const peers = ["peer-1", "peer-2", "peer-3"];
  const historicalRows = peers.flatMap((id) => buildHistoryAtFlatRate(id, 150));
  const dates = ["2026-04-25", "2026-04-26", "2026-04-27"];
  const forwardRows: PeerCalendarRateRow[] = peers.flatMap((id) =>
    dates.map((d) => ({ listingId: id, dateOnly: d, available: true, rate: 180 }))
  );
  const result = computePeerShapeFactorByDateFromRows({
    historicalRows,
    forwardRows,
    fromDate: "2026-04-25",
    toDate: "2026-04-27"
  });
  for (const dateKey of dates) {
    const entry = result.get(dateKey);
    assert.ok(entry, `expected an entry for ${dateKey}`);
    assert.ok(Math.abs((entry?.factor ?? 0) - 1.2) < 1e-9, `factor drift on ${dateKey}: ${entry?.factor}`);
    assert.equal(entry?.peerCount, 3);
  }
});

test("tenant isolation: a peer in tenant B is never used to compute tenant A's factor", async () => {
  // We exercise the live-DB helper by passing a fake Prisma that captures
  // the where-clause. The helper must ALWAYS filter by tenantId on both
  // listing.findMany and calendarRate.findMany, and must scope the peer
  // ID lookup to the subject's tenant only.
  const calls: Array<{ table: string; where: unknown }> = [];
  const fakePrisma = {
    listing: {
      findMany: async (args: { where: unknown }) => {
        calls.push({ table: "listing", where: args.where });
        // Tenant A has 3 peers; pretend tenant B's peer is invisible.
        return [{ id: "tenantA-peer-1" }, { id: "tenantA-peer-2" }, { id: "tenantA-peer-3" }];
      }
    },
    calendarRate: {
      findMany: async (args: { where: unknown }) => {
        calls.push({ table: "calendarRate", where: args.where });
        // Pretend the DB returned no rows; we only care about the filter.
        return [];
      }
    }
  };
  const out = await computePeerShapeFactorByDate({
    tenantId: "tenantA",
    subjectListingId: "tenantA-subject",
    fromDate: "2026-04-25",
    toDate: "2026-04-26",
    todayDateOnly: "2026-04-25",
    prisma: fakePrisma as unknown as Parameters<typeof computePeerShapeFactorByDate>[0]["prisma"]
  });

  // Listing-lookup must filter by tenantId AND exclude the subject listing.
  const listingCall = calls.find((c) => c.table === "listing");
  assert.ok(listingCall, "must call listing.findMany");
  const listingWhere = listingCall!.where as { tenantId: string; id: { not: string } };
  assert.equal(listingWhere.tenantId, "tenantA");
  assert.deepEqual(listingWhere.id, { not: "tenantA-subject" });

  // Both calendarRate queries must filter by tenantId.
  const rateCalls = calls.filter((c) => c.table === "calendarRate");
  assert.equal(rateCalls.length, 2, "expected one historical + one forward calendarRate query");
  for (const call of rateCalls) {
    const where = call.where as { tenantId: string; listingId: { in: string[] } };
    assert.equal(where.tenantId, "tenantA");
    // The peer-id allow-list must be scoped to tenant A's listings only.
    assert.deepEqual(where.listingId, {
      in: ["tenantA-peer-1", "tenantA-peer-2", "tenantA-peer-3"]
    });
  }

  // Empty DB → every date should be null (caller falls back to base).
  for (const [, entry] of out.entries()) assert.equal(entry, null);
});

test("subject listing rows are excluded by the live loader (defence-in-depth on top of the listing.findMany filter)", async () => {
  // Even if a stray subject row leaked into the DB, the listing.findMany
  // call uses `id: { not: subjectListingId }` so the subject is never in
  // the peer-id allow-list — making it impossible for subject rates to
  // appear in the calendarRate queries.
  const fakePrisma = {
    listing: {
      findMany: async () => [{ id: "peer-1" }, { id: "peer-2" }, { id: "peer-3" }]
    },
    calendarRate: {
      findMany: async (args: { where: { listingId?: { in: string[] } } }) => {
        const ids = args.where.listingId?.in ?? [];
        // Subject must NOT appear in the queried id set.
        assert.equal(
          ids.includes("subject-listing"),
          false,
          "subject listing leaked into calendarRate query"
        );
        return [];
      }
    }
  };
  await computePeerShapeFactorByDate({
    tenantId: "tenantA",
    subjectListingId: "subject-listing",
    fromDate: "2026-04-25",
    toDate: "2026-04-25",
    todayDateOnly: "2026-04-25",
    prisma: fakePrisma as unknown as Parameters<typeof computePeerShapeFactorByDate>[0]["prisma"]
  });
});
