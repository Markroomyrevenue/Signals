import assert from "node:assert/strict";
import test from "node:test";

import {
  computePortfolioPeerSetAdrFromNightFacts,
  selectPortfolioPeerSetListingIds
} from "./peer-set";

test("peer-set match: same bedroom count and same group tag are eligible", () => {
  const peers = selectPortfolioPeerSetListingIds({
    subject: {
      listingId: "subject",
      bedroomsNumber: 1,
      tags: ["group:Camden"]
    },
    candidates: [
      { listingId: "peer-1", bedroomsNumber: 1, tags: ["group:Camden"] },
      { listingId: "peer-2", bedroomsNumber: 2, tags: ["group:Camden"] },
      { listingId: "peer-3", bedroomsNumber: 1, tags: ["group:Shoreditch"] },
      { listingId: "peer-4", bedroomsNumber: 1, tags: [] }
    ]
  });
  assert.deepStrictEqual(peers, ["peer-1"]);
});

test("peer-set match: when neither side has a group tag, fall back to portfolio (same bedrooms)", () => {
  const peers = selectPortfolioPeerSetListingIds({
    subject: {
      listingId: "subject",
      bedroomsNumber: 2,
      tags: []
    },
    candidates: [
      { listingId: "peer-1", bedroomsNumber: 2, tags: [] },
      { listingId: "peer-2", bedroomsNumber: 1, tags: [] },
      { listingId: "peer-3", bedroomsNumber: 2, tags: [] }
    ]
  });
  assert.deepStrictEqual(peers.sort(), ["peer-1", "peer-3"]);
});

test("peer-set match: subject excluded from its own peer set", () => {
  const peers = selectPortfolioPeerSetListingIds({
    subject: { listingId: "subject", bedroomsNumber: 1, tags: [] },
    candidates: [
      { listingId: "subject", bedroomsNumber: 1, tags: [] },
      { listingId: "peer-1", bedroomsNumber: 1, tags: [] }
    ]
  });
  assert.deepStrictEqual(peers, ["peer-1"]);
});

test("peer-set match: null bedroom count never matches", () => {
  const peers = selectPortfolioPeerSetListingIds({
    subject: { listingId: "subject", bedroomsNumber: null, tags: [] },
    candidates: [{ listingId: "peer-1", bedroomsNumber: null, tags: [] }]
  });
  assert.deepStrictEqual(peers, []);
});

test("peer-set match: subject has group, candidate without group is excluded", () => {
  const peers = selectPortfolioPeerSetListingIds({
    subject: { listingId: "subject", bedroomsNumber: 1, tags: ["group:Camden"] },
    candidates: [
      { listingId: "peer-1", bedroomsNumber: 1, tags: ["group:Camden"] },
      { listingId: "peer-2", bedroomsNumber: 1, tags: [] }
    ]
  });
  assert.deepStrictEqual(peers, ["peer-1"]);
});

test("peer-set ADR: averages qualifying revenue, excludes long stays and cancelled", () => {
  const adr = computePortfolioPeerSetAdrFromNightFacts({
    nights: [
      { revenueAllocated: 200, losNights: 3, status: "confirmed" },
      { revenueAllocated: 220, losNights: 2, status: "confirmed" },
      { revenueAllocated: 180, losNights: 4, status: "modified" },
      { revenueAllocated: 500, losNights: 30, status: "confirmed" }, // long stay → excluded
      { revenueAllocated: 999, losNights: 3, status: "cancelled" }, // cancelled → excluded
      { revenueAllocated: 0, losNights: 3, status: "confirmed" }, // zero rev → excluded
      ...Array.from({ length: 11 }, () => ({ revenueAllocated: 200, losNights: 3, status: "confirmed" }))
    ]
  });
  // qualifying nights: 200, 220, 180, plus 11 × 200 → totalNights 14, total
  // revenue = 200+220+180+11*200 = 200+220+180+2200 = 2800. ADR = 200.
  assert.equal(adr, 200);
});

test("peer-set ADR: returns null when fewer than 14 qualifying nights", () => {
  const adr = computePortfolioPeerSetAdrFromNightFacts({
    nights: [
      { revenueAllocated: 200, losNights: 3, status: "confirmed" },
      { revenueAllocated: 220, losNights: 2, status: "confirmed" },
      { revenueAllocated: 180, losNights: 4, status: "confirmed" }
    ]
  });
  assert.equal(adr, null);
});

test("peer-set ADR: minQualifyingNights is configurable", () => {
  const adr = computePortfolioPeerSetAdrFromNightFacts({
    nights: [
      { revenueAllocated: 200, losNights: 3, status: "confirmed" },
      { revenueAllocated: 220, losNights: 2, status: "confirmed" }
    ],
    minQualifyingNights: 2
  });
  assert.equal(adr, 210);
});
