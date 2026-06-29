import assert from "node:assert/strict";
import test from "node:test";

import { londonTodayDateOnly, resolvePreset } from "./date-range-picker";

// Fixed anchor used across the audit (AUDIT-UI.md UI-9 worked column).
const ANCHOR = "2026-06-29"; // Monday

test("resolvePreset: existing presets keep their inclusive bounds (UI-6 anchor)", () => {
  const cases: Record<string, { from: string; to: string }> = {
    today: { from: "2026-06-29", to: "2026-06-29" },
    yesterday: { from: "2026-06-28", to: "2026-06-28" },
    last_7_days: { from: "2026-06-23", to: "2026-06-29" },
    last_30_days: { from: "2026-05-31", to: "2026-06-29" },
    this_week: { from: "2026-06-29", to: "2026-06-29" }, // anchor is a Monday → week-to-date = 1 day
    this_month: { from: "2026-06-01", to: "2026-06-29" },
    this_year: { from: "2026-01-01", to: "2026-06-29" },
    last_year: { from: "2025-06-30", to: "2026-06-29" }
  };
  for (const [preset, expected] of Object.entries(cases)) {
    assert.deepEqual(resolvePreset(preset as never, ANCHOR), expected, `preset ${preset}`);
  }
});

test("resolvePreset: custom and unknown presets return null", () => {
  assert.equal(resolvePreset("custom", ANCHOR), null);
  assert.equal(resolvePreset("not_a_preset" as never, ANCHOR), null);
});

test("londonTodayDateOnly: anchors on Europe/London, not UTC (BST early-hours)", () => {
  // 2026-06-29 00:30 UTC is during BST (UTC+1) → 01:30 London, still 29th.
  assert.equal(londonTodayDateOnly(new Date("2026-06-29T00:30:00Z")), "2026-06-29");
  // 2026-06-28 23:30 UTC → 00:30 London on the 29th: UTC says 28th, London says 29th.
  // This is the exact early-hours bug UI-6 fixes.
  assert.equal(londonTodayDateOnly(new Date("2026-06-28T23:30:00Z")), "2026-06-29");
  // Midday is unambiguous.
  assert.equal(londonTodayDateOnly(new Date("2026-06-29T12:00:00Z")), "2026-06-29");
});

test("londonTodayDateOnly: returns an ISO YYYY-MM-DD shape", () => {
  assert.match(londonTodayDateOnly(), /^\d{4}-\d{2}-\d{2}$/);
});
