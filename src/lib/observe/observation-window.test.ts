import assert from "node:assert/strict";
import test from "node:test";

import { daysObserved, hasGraduated } from "./observation-window";

test("daysObserved counts whole UTC days from start", () => {
  const start = new Date("2026-06-01T08:00:00Z");
  assert.equal(daysObserved(start, new Date("2026-06-01T23:59:00Z")), 0);
  assert.equal(daysObserved(start, new Date("2026-06-02T00:01:00Z")), 1);
  assert.equal(daysObserved(start, new Date("2026-07-01T08:00:00Z")), 30);
});

test("daysObserved never goes negative for a future start", () => {
  const start = new Date("2026-06-10T00:00:00Z");
  assert.equal(daysObserved(start, new Date("2026-06-01T00:00:00Z")), 0);
});

test("hasGraduated flips at exactly 30 days", () => {
  const start = new Date("2026-06-01T00:00:00Z");
  assert.equal(hasGraduated(start, new Date("2026-06-30T12:00:00Z")), false); // day 29
  assert.equal(hasGraduated(start, new Date("2026-07-01T00:00:00Z")), true); // day 30
  assert.equal(hasGraduated(start, new Date("2026-08-01T00:00:00Z")), true);
});

test("hasGraduated respects a custom window length", () => {
  const start = new Date("2026-06-01T00:00:00Z");
  assert.equal(hasGraduated(start, new Date("2026-06-08T00:00:00Z"), 7), true);
  assert.equal(hasGraduated(start, new Date("2026-06-06T00:00:00Z"), 7), false);
});
