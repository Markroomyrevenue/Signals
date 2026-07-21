/**
 * Unit tests for the PURE range-expansion helper behind the engine-override
 * calendar markers. Wheelhouse custom_rate rows may be multi-day ranges and may
 * carry timestamp-formatted dates, so the expansion + window-intersection is the
 * only place a marker can be silently wrong. No DB / no network — the helper is
 * pure, and `loadEngineOverrides` (which does the sequential engine walk) is
 * exercised live, not here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { customRateDatesInWindow } from "./push/wheelhouse";

const WINDOW_START = "2026-07-21";
const WINDOW_END = "2026-07-30";

test("no rows → no dates", () => {
  assert.deepEqual(customRateDatesInWindow([], WINDOW_START, WINDOW_END), []);
});

test("single-day row inside the window → that one date", () => {
  const rows = [{ start_date: "2026-07-23", end_date: "2026-07-23" }];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), ["2026-07-23"]);
});

test("multi-day range → every covered night", () => {
  const rows = [{ start_date: "2026-07-22", end_date: "2026-07-25" }];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), [
    "2026-07-22",
    "2026-07-23",
    "2026-07-24",
    "2026-07-25"
  ]);
});

test("timestamp-formatted dates are sliced to the date part", () => {
  const rows = [{ start_date: "2026-07-26T00:00:00Z", end_date: "2026-07-27T12:34:56Z" }];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), [
    "2026-07-26",
    "2026-07-27"
  ]);
});

test("a range straddling the window start is clamped to the window", () => {
  const rows = [{ start_date: "2026-07-19", end_date: "2026-07-22" }];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), [
    "2026-07-21",
    "2026-07-22"
  ]);
});

test("a range straddling the window end is clamped to the window", () => {
  const rows = [{ start_date: "2026-07-29", end_date: "2026-08-03" }];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), [
    "2026-07-29",
    "2026-07-30"
  ]);
});

test("a range entirely outside the window contributes nothing", () => {
  const rows = [{ start_date: "2026-08-01", end_date: "2026-08-05" }];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), []);
});

test("a row with only start_date is treated as a single night", () => {
  const rows = [{ start_date: "2026-07-24" }];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), ["2026-07-24"]);
});

test("rows with no usable start_date are ignored", () => {
  const rows = [{ end_date: "2026-07-24" }, { start_date: "" }, { start_date: null }];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), []);
});

test("overlapping rows are de-duplicated and sorted", () => {
  const rows = [
    { start_date: "2026-07-25", end_date: "2026-07-27" },
    { start_date: "2026-07-26", end_date: "2026-07-28" },
    { start_date: "2026-07-22", end_date: "2026-07-22" }
  ];
  assert.deepEqual(customRateDatesInWindow(rows, WINDOW_START, WINDOW_END), [
    "2026-07-22",
    "2026-07-25",
    "2026-07-26",
    "2026-07-27",
    "2026-07-28"
  ]);
});
