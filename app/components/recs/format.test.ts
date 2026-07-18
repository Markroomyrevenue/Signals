import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currencySymbol,
  formatDateShort,
  formatDateTime,
  formatHoursOld,
  formatMoney,
  formatPct,
  formatRanking
} from "./format";

test("currencySymbol: GBP → £, EUR → €, other codes render as the code", () => {
  assert.equal(currencySymbol("GBP"), "£");
  assert.equal(currencySymbol("gbp"), "£");
  assert.equal(currencySymbol("EUR"), "€");
  assert.equal(currencySymbol("USD"), "USD ");
  assert.equal(currencySymbol(null), "£");
});

test("formatMoney: whole units, no decimals, thousands separated", () => {
  assert.equal(formatMoney(85, "GBP"), "£85");
  assert.equal(formatMoney(1249.6, "GBP"), "£1,250");
  assert.equal(formatMoney(120, "EUR"), "€120");
  assert.equal(formatMoney(99, "USD"), "USD 99");
  assert.equal(formatMoney(-42.4, "GBP"), "-£42");
  assert.equal(formatMoney(null, "GBP"), "—");
  assert.equal(formatMoney(Number.NaN, "GBP"), "—");
});

test("formatPct: fraction in, signed whole percent out", () => {
  assert.equal(formatPct(-0.12), "-12%");
  assert.equal(formatPct(0.054), "+5%");
  assert.equal(formatPct(0), "0%");
  assert.equal(formatPct(null), "—");
});

test("formatRanking: two decimals, null passes through", () => {
  assert.equal(formatRanking(0.72), "ranking 0.72");
  assert.equal(formatRanking(1), "ranking 1.00");
  assert.equal(formatRanking(null), null);
});

test("formatHoursOld: hours or the no-data fallback", () => {
  assert.equal(formatHoursOld(3.2), "calendar 3.2h old");
  assert.equal(formatHoursOld(null), "no calendar data");
});

test("formatDateShort: date-only string → day + short month", () => {
  assert.equal(formatDateShort("2026-07-19"), "19 Jul");
  assert.equal(formatDateShort("2026-12-01"), "1 Dec");
  assert.equal(formatDateShort("not-a-date"), "not-a-date");
});

test("formatDateTime: ISO timestamp renders in Europe/London", () => {
  // 2026-07-18T13:02:00Z is 14:02 in London (BST, UTC+1).
  assert.equal(formatDateTime("2026-07-18T13:02:00.000Z"), "18 Jul, 14:02");
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime("garbage"), "—");
});
