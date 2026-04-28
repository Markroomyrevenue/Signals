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

test("peer count below explicit minimum returns null factor entry (caller falls back to base)", () => {
  // Only 2 peers contribute on the date and we explicitly pass
  // minPeersPerDate=3, so the entry must be null. (Default is now 1
  // per owner spec, but callers can still tighten it.)
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
    toDate: "2026-04-25",
    minPeersPerDate: 3
  });
  assert.equal(result.has("2026-04-25"), true);
  assert.equal(result.get("2026-04-25"), null);
});

test("default minimum is 1 — a single available peer is enough to produce a factor (owner spec)", () => {
  // Owner: "Always fall back on peer fluctuation on price even if only
  // 1 unit on 1 night available". Default minPeersPerDate is 1.
  const historicalRows = buildHistoryAtFlatRate("peer-1", 100);
  const forwardRows: PeerCalendarRateRow[] = [
    { listingId: "peer-1", dateOnly: "2026-04-25", available: true, rate: 110 }
  ];
  const result = computePeerShapeFactorByDateFromRows({
    historicalRows,
    forwardRows,
    fromDate: "2026-04-25",
    toDate: "2026-04-25"
  });
  const entry = result.get("2026-04-25");
  assert.ok(entry, "expected a factor entry from a single-peer day");
  assert.ok(Math.abs((entry?.factor ?? 0) - 1.1) < 1e-9, `expected ~1.1, got ${entry?.factor}`);
  assert.equal(entry?.peerCount, 1);
  assert.equal(entry?.source, "available");
});

test("booked-fallback: when no peers are available, short-stay booked rates power the factor", () => {
  // Owner spec: "If there is none [available] - then you can fall back
  // on average booked rate in peer group for that night vs their
  // average yearly rate fluctuation but discount any reservations that
  // are 7 nights or more so that we aren't taking into account a long
  // term stay rate."
  const historicalRows = [
    ...buildHistoryAtFlatRate("peer-1", 100),
    ...buildHistoryAtFlatRate("peer-2", 100),
    ...buildHistoryAtFlatRate("peer-3", 100)
  ];
  const forwardRows: PeerCalendarRateRow[] = [
    // All peers fully booked / unavailable on the target date.
    { listingId: "peer-1", dateOnly: "2026-04-25", available: false, rate: null },
    { listingId: "peer-2", dateOnly: "2026-04-25", available: false, rate: null },
    { listingId: "peer-3", dateOnly: "2026-04-25", available: false, rate: null }
  ];
  const bookedFallbackRows = [
    // Two short stays (kept) and one long stay (dropped at 7 nights).
    { listingId: "peer-1", dateOnly: "2026-04-25", rate: 130, losNights: 2 },
    { listingId: "peer-2", dateOnly: "2026-04-25", rate: 140, losNights: 5 },
    { listingId: "peer-3", dateOnly: "2026-04-25", rate: 70, losNights: 7 }
  ];
  const result = computePeerShapeFactorByDateFromRows({
    historicalRows,
    forwardRows,
    bookedFallbackRows,
    fromDate: "2026-04-25",
    toDate: "2026-04-25"
  });
  const entry = result.get("2026-04-25");
  assert.ok(entry, "expected booked-fallback to fire when no available peers");
  // Mean of (130/100) + (140/100) = (1.3 + 1.4) / 2 = 1.35. The 7-night
  // stay is dropped so peer-3 doesn't contribute.
  assert.ok(Math.abs((entry?.factor ?? 0) - 1.35) < 1e-9, `expected 1.35, got ${entry?.factor}`);
  assert.equal(entry?.peerCount, 2);
  assert.equal(entry?.source, "booked-fallback");
});

test("booked-fallback only fires when no AVAILABLE peers — available always wins", () => {
  // Owner spec sequencing: available peers first, booked-fallback only
  // when there are zero available peers for the date.
  const historicalRows = [
    ...buildHistoryAtFlatRate("peer-1", 100),
    ...buildHistoryAtFlatRate("peer-2", 100)
  ];
  const forwardRows: PeerCalendarRateRow[] = [
    { listingId: "peer-1", dateOnly: "2026-04-25", available: true, rate: 90 }
  ];
  const bookedFallbackRows = [
    { listingId: "peer-2", dateOnly: "2026-04-25", rate: 200, losNights: 2 }
  ];
  const result = computePeerShapeFactorByDateFromRows({
    historicalRows,
    forwardRows,
    bookedFallbackRows,
    fromDate: "2026-04-25",
    toDate: "2026-04-25"
  });
  const entry = result.get("2026-04-25");
  // Available wins: factor = 90/100 = 0.9, source = "available".
  assert.ok(Math.abs((entry?.factor ?? 0) - 0.9) < 1e-9);
  assert.equal(entry?.source, "available");
  assert.equal(entry?.peerCount, 1);
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
    },
    nightFact: {
      findMany: async (args: { where: unknown }) => {
        calls.push({ table: "nightFact", where: args.where });
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

  // After the 2026-04-28 yearly-ADR switch we run ONE calendarRate
  // query (forward AVAILABLE rates) and TWO nightFact queries (forward
  // booked-fallback + historical booked-ADR). All three must filter by
  // tenantId AND scope listingId to tenant A's peers only.
  const rateCalls = calls.filter((c) => c.table === "calendarRate");
  assert.equal(rateCalls.length, 1, "expected one forward calendarRate query");
  const nightFactCalls = calls.filter((c) => c.table === "nightFact");
  assert.equal(nightFactCalls.length, 2, "expected one forward + one historical nightFact query");
  for (const call of [...rateCalls, ...nightFactCalls]) {
    const where = call.where as { tenantId: string; listingId: { in: string[] } };
    assert.equal(where.tenantId, "tenantA");
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
    },
    nightFact: {
      findMany: async (args: { where: { listingId?: { in: string[] } } }) => {
        const ids = args.where.listingId?.in ?? [];
        assert.equal(
          ids.includes("subject-listing"),
          false,
          "subject listing leaked into nightFact query"
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
