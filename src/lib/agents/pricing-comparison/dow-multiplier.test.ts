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

test("DoW constants — outlier cap [0.75, 1.50] per 2026-05-27 PM widening", () => {
  // Widened from [0.85, 1.35] after the AM ship showed both ends
  // binding on SB (Mon-Thu pinned at 0.85 floor; Fri/Sat pinned at
  // 1.35 cap). The wider [0.75, 1.50] bracket is the engine's outer
  // artifact guard; the listing's min/max price overrides remain the
  // customer-facing safety.
  assert.equal(DOW_LEARNED_MIN, 0.75);
  assert.equal(DOW_LEARNED_MAX, 1.50);
});

test("DoW constants — cap bracket spans Belfast Fri/Sat lift range observed in data", () => {
  // Belfast tenants showed Sat premiums above 1.35 (SB) and Mon-Thu
  // discounts that wanted to sit below 0.85. The cap MUST sit above
  // 1.50 so a genuine SB-class Sat premium isn't clipped, and the
  // floor MUST sit below 0.85 so a genuine weekday softness can land.
  assert.ok(DOW_LEARNED_MAX >= 1.50, "max cap must accommodate observed Sat premiums");
  assert.ok(DOW_LEARNED_MIN <= 0.85, "min cap must allow weekday softness through");
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
