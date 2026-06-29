import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_OPTIONS, londonTodayDateOnly, resolvePreset } from "./date-range-picker";

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

test("resolvePreset: UI-9 added presets match AUDIT-UI.md worked values", () => {
  const cases: Record<string, { from: string; to: string }> = {
    last_90_days: { from: "2026-04-01", to: "2026-06-29" },
    mtd: { from: "2026-06-01", to: "2026-06-29" },
    last_month: { from: "2026-05-01", to: "2026-05-31" },
    qtd: { from: "2026-04-01", to: "2026-06-29" }, // Q2 = 1 Apr (Q3 starts 1 Jul)
    ytd: { from: "2026-01-01", to: "2026-06-29" },
    trailing_12_months: { from: "2025-06-30", to: "2026-06-29" },
    next_30_days: { from: "2026-06-29", to: "2026-07-28" },
    next_60_days: { from: "2026-06-29", to: "2026-08-27" },
    next_90_days: { from: "2026-06-29", to: "2026-09-26" }
  };
  for (const [preset, expected] of Object.entries(cases)) {
    assert.deepEqual(resolvePreset(preset as never, ANCHOR), expected, `preset ${preset}`);
  }
});

test("resolvePreset: every non-custom DEFAULT_OPTION resolves to inclusive bounds", () => {
  for (const option of DEFAULT_OPTIONS) {
    if (option.id === "custom") continue;
    const range = resolvePreset(option.id, ANCHOR);
    assert.ok(range, `preset ${option.id} should resolve`);
    assert.ok(range!.from <= range!.to, `preset ${option.id} from<=to`);
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
