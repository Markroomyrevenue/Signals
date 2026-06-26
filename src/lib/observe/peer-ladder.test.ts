import assert from "node:assert/strict";
import test from "node:test";

import { buildPeerControl, withinBand, type LadderListing } from "./peer-ladder";

test("withinBand handles band, out-of-band, and nulls", () => {
  assert.equal(withinBand(160, 180, 0.2), true); // +12.5%
  assert.equal(withinBand(160, 200, 0.2), false); // +25%
  assert.equal(withinBand(160, null, 0.2), false);
  assert.equal(withinBand(null, 160, 0.2), false);
  assert.equal(withinBand(0, 0, 0.2), true);
});

function L(id: string, beds: number, base: number, min: number, tags: string[] = []): LadderListing {
  return { listingId: id, bedroomsNumber: beds, tags, base, min };
}

const SUBJECT = L("S", 1, 160, 112);

test("rung 1 when ≥3 same-size in-band peers did not move", () => {
  const candidates = [SUBJECT, L("P1", 1, 165, 115), L("P2", 1, 155, 110), L("P3", 1, 170, 118)];
  const r = buildPeerControl({ subject: SUBJECT, candidates, movers: new Set() });
  assert.equal(r.rung, 1);
  assert.equal(r.confidence, 0.8);
  assert.deepEqual(r.controlListingIds.sort(), ["P1", "P2", "P3"]);
});

test("rung 2 (thin) when only 1–2 in-band peers remain", () => {
  const candidates = [SUBJECT, L("P1", 1, 165, 115), L("P2", 1, 158, 111)];
  const r = buildPeerControl({ subject: SUBJECT, candidates, movers: new Set() });
  assert.equal(r.rung, 2);
  assert.equal(r.confidence, 0.5);
  assert.ok(r.controlListingIds.length >= 1 && r.controlListingIds.length <= 2);
});

test("movers are excluded from the control set", () => {
  const candidates = [SUBJECT, L("P1", 1, 165, 115), L("P2", 1, 155, 110), L("P3", 1, 170, 118)];
  // P2 and P3 also moved ⇒ only P1 left ⇒ thin rung 2.
  const r = buildPeerControl({ subject: SUBJECT, candidates, movers: new Set(["P2", "P3"]) });
  assert.equal(r.rung, 2);
  assert.deepEqual(r.controlListingIds, ["P1"]);
});

test("out-of-band peers don't count toward rung 1", () => {
  // All same size but base far from subject ⇒ none within band ⇒ rung 3.
  const candidates = [SUBJECT, L("P1", 1, 260, 200), L("P2", 1, 90, 60), L("P3", 1, 300, 210)];
  const r = buildPeerControl({ subject: SUBJECT, candidates, movers: new Set() });
  assert.equal(r.rung, 3);
  assert.deepEqual(r.controlListingIds, []);
});

test("rung 3 (base-to-base elasticity) when there is no comparable size peer", () => {
  const candidates = [SUBJECT, L("P1", 2, 220, 160), L("P2", 3, 300, 220)];
  const r = buildPeerControl({ subject: SUBJECT, candidates, movers: new Set() });
  assert.equal(r.rung, 3);
  assert.equal(r.confidence, 0.3);
  assert.deepEqual(r.controlListingIds, []);
});
