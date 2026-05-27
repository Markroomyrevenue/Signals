import assert from "node:assert/strict";
import test from "node:test";

import {
  DOW_LEARNED_MAX,
  DOW_LEARNED_MIN,
  DOW_LEARNED_MIN_NIGHTS_PER_DOW,
  NEUTRAL_DOW_RESULT
} from "./dow-multiplier";

// ---------------------------------------------------------------------------
// 2026-05-27 — learned DoW multiplier constants + neutral fallback
//
// Function-level integration of `loadDowMultiplierForTenant` requires
// Prisma + filesystem so it's tested via the end-to-end manual run.
// This file pins the constants and the neutral-fallback contract.
// ---------------------------------------------------------------------------

test("DoW constants — sample gate at 30 nights per DoW per spec", () => {
  assert.equal(DOW_LEARNED_MIN_NIGHTS_PER_DOW, 30);
});

test("DoW constants — outlier cap [0.85, 1.35] per spec", () => {
  assert.equal(DOW_LEARNED_MIN, 0.85);
  assert.equal(DOW_LEARNED_MAX, 1.35);
});

test("DoW constants — cap bracket spans typical Fri/Sat lift range", () => {
  // Spec expectation: "Sun-Thu similar (~0.95-1.02), Fri a bit
  // (~1.05-1.10), Sat premium (~1.15-1.25)."  The cap MUST sit above
  // 1.25 so a genuine Sat premium isn't clipped, and below the floor
  // MUST sit below 0.95 so a genuine soft DoW isn't clipped upward.
  assert.ok(DOW_LEARNED_MAX >= 1.25, "max cap must accommodate Sat premium");
  assert.ok(DOW_LEARNED_MIN <= 0.95, "min cap must allow softer DoW values through");
});

test("NEUTRAL_DOW_RESULT — all 1.0, no-signal source flags", () => {
  // Fallback shape when neither own nor KD has any data. Multipliers
  // exactly 1.0 → no rate movement when the DoW path runs through it.
  assert.equal(NEUTRAL_DOW_RESULT.multipliers.length, 7);
  for (const m of NEUTRAL_DOW_RESULT.multipliers) {
    assert.equal(m, 1.0);
  }
  assert.equal(NEUTRAL_DOW_RESULT.ownWeeklyAverage, null);
  assert.equal(NEUTRAL_DOW_RESULT.kdWeeklyAverage, null);
  for (const s of NEUTRAL_DOW_RESULT.sourceByDow) {
    assert.equal(s, "neutral");
  }
});
