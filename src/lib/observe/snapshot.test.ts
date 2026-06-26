import assert from "node:assert/strict";
import test from "node:test";

import { diffEngineSnapshots, inferEngineChangeSource } from "./snapshot";

test("diffEngineSnapshots emits one draft per moved lever", () => {
  const drafts = diffEngineSnapshots(
    { base: 160, min: 112, max: 480, minStay: 2 },
    { base: 180, min: 112, max: 520, minStay: 3 }
  );
  const byLever = Object.fromEntries(drafts.map((d) => [d.lever, d]));
  assert.equal(drafts.length, 3);
  assert.equal(byLever.base_price.oldValue, 160);
  assert.equal(byLever.base_price.newValue, 180);
  assert.ok(Math.abs((byLever.base_price.changePct ?? 0) - 0.125) < 1e-9);
  assert.equal(byLever.max.newValue, 520);
  assert.equal(byLever.min_stay.oldValue, 2);
  assert.equal(byLever.min_stay.newValue, 3);
  assert.equal(byLever.min_stay.changePct, null);
  assert.equal(byLever.min, undefined); // min unchanged
});

test("diffEngineSnapshots ignores sub-epsilon float dust", () => {
  const drafts = diffEngineSnapshots(
    { base: 160, min: 112, max: 480, minStay: null },
    { base: 160.005, min: 112, max: 480, minStay: null }
  );
  assert.equal(drafts.length, 0);
});

test("diffEngineSnapshots skips levers null on either side", () => {
  const drafts = diffEngineSnapshots(
    { base: null, min: 100, max: null, minStay: null },
    { base: 150, min: 120, max: 400, minStay: 2 }
  );
  // base (null→150) skipped; max (null→400) skipped; min_stay (null→2) skipped; only min moves.
  assert.deepEqual(drafts.map((d) => d.lever), ["min"]);
});

test("inferEngineChangeSource: engine when timing matches last_refreshed_at", () => {
  const now = new Date("2026-06-26T06:00:00Z");
  const src = inferEngineChangeSource({
    detectedAt: now,
    lastRefreshedAt: new Date("2026-06-26T05:30:00Z"),
    recentChanges: [],
    isRateCopyTarget: false
  });
  assert.equal(src, "engine");
});

test("inferEngineChangeSource: engine when a recent_changes event is within the window", () => {
  const now = new Date("2026-06-26T06:00:00Z");
  const src = inferEngineChangeSource({
    detectedAt: now,
    lastRefreshedAt: null,
    recentChanges: [{ at: new Date("2026-06-25T20:00:00Z"), lever: "base_price" }],
    isRateCopyTarget: false
  });
  assert.equal(src, "engine");
});

test("inferEngineChangeSource: mark for a rate-copy target with no engine-timing match", () => {
  const now = new Date("2026-06-26T06:00:00Z");
  const src = inferEngineChangeSource({
    detectedAt: now,
    lastRefreshedAt: new Date("2026-06-20T00:00:00Z"), // far outside window
    recentChanges: [],
    isRateCopyTarget: true
  });
  assert.equal(src, "mark");
});

test("inferEngineChangeSource: owner is the default human move", () => {
  const now = new Date("2026-06-26T06:00:00Z");
  const src = inferEngineChangeSource({
    detectedAt: now,
    lastRefreshedAt: new Date("2026-06-01T00:00:00Z"),
    recentChanges: [],
    isRateCopyTarget: false
  });
  assert.equal(src, "owner");
});
