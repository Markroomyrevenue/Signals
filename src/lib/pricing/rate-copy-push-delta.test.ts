import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUnappliedMessage,
  findUnappliedRates,
  selectRatesDifferingFromLive
} from "./rate-copy-push-service";

// ---------------------------------------------------------------------------
// selectRatesDifferingFromLive — the delta filter compares against Hostaway's
// LIVE calendar (not our own push history), so silently-refused pushes stay
// "changed" and are retried every cycle until the calendar reflects them.
// ---------------------------------------------------------------------------

test("delta filter keeps only dates whose live price differs", () => {
  const rates = [
    { date: "2026-07-01", dailyPrice: 60, minStay: 2 },
    { date: "2026-07-02", dailyPrice: 65, minStay: 2 }, // live shows old price
    { date: "2026-07-03", dailyPrice: 70, minStay: 2 } // unchanged
  ];
  const live = new Map([
    ["2026-07-01", { price: 60, minStay: 2 }],
    ["2026-07-02", { price: 60, minStay: 2 }],
    ["2026-07-03", { price: 70, minStay: 2 }]
  ]);
  const changed = selectRatesDifferingFromLive(rates, live);
  assert.deepEqual(
    changed.map((r) => r.date),
    ["2026-07-02"]
  );
});

test("a date absent from the live read is treated as changed (pushed)", () => {
  const rates = [{ date: "2026-07-05", dailyPrice: 90, minStay: 2 }];
  const changed = selectRatesDifferingFromLive(rates, new Map());
  assert.equal(changed.length, 1);
});

test("a live row with a null price is treated as changed (pushed)", () => {
  const rates = [{ date: "2026-07-05", dailyPrice: 90, minStay: 2 }];
  const live = new Map([["2026-07-05", { price: null, minStay: null }]]);
  assert.equal(selectRatesDifferingFromLive(rates, live).length, 1);
});

test("the booked-date stale price keeps being re-pushed until Hostaway reflects it", () => {
  // The live 2026-07-07 case: we push 216 for a fully-booked night, Hostaway
  // 200-accepts and keeps showing 93. The live-calendar delta must keep the
  // date in every cycle's push set until the calendar reads 216.
  const rates = [{ date: "2026-08-08", dailyPrice: 216, minStay: null }];
  const live = new Map([["2026-08-08", { price: 93, minStay: null }]]);
  assert.equal(selectRatesDifferingFromLive(rates, live).length, 1);
});

test("identical live calendar produces zero pushes", () => {
  const rates = [
    { date: "2026-07-01", dailyPrice: 60, minStay: 2 },
    { date: "2026-07-02", dailyPrice: 65, minStay: null }
  ];
  const live = new Map([
    ["2026-07-01", { price: 60, minStay: 2 }],
    ["2026-07-02", { price: 65, minStay: null }]
  ]);
  assert.equal(selectRatesDifferingFromLive(rates, live).length, 0);
});

test("min-stay difference is a change only when both sides carry a min-stay", () => {
  const rates = [
    { date: "2026-07-01", dailyPrice: 60, minStay: 3 }, // live shows 2 → change
    { date: "2026-07-02", dailyPrice: 60, minStay: 3 }, // live minStay null → not a change
    { date: "2026-07-03", dailyPrice: 60, minStay: null } // we push none → not a change
  ];
  const live = new Map([
    ["2026-07-01", { price: 60, minStay: 2 }],
    ["2026-07-02", { price: 60, minStay: null }],
    ["2026-07-03", { price: 60, minStay: 2 }]
  ]);
  assert.deepEqual(
    selectRatesDifferingFromLive(rates, live).map((r) => r.date),
    ["2026-07-01"]
  );
});

test("sub-50p rounding noise is not a change", () => {
  const rates = [{ date: "2026-07-01", dailyPrice: 60, minStay: null }];
  const live = new Map([["2026-07-01", { price: 60.4, minStay: null }]]);
  assert.equal(selectRatesDifferingFromLive(rates, live).length, 0);
});

// ---------------------------------------------------------------------------
// findUnappliedRates — verify-after-push comparison with booked classification
// ---------------------------------------------------------------------------

test("verify flags pushed dates the calendar does not reflect, tagging booked ones", () => {
  const pushed = [
    { date: "2026-08-07", dailyPrice: 500, minStay: null },
    { date: "2026-08-08", dailyPrice: 216, minStay: null },
    { date: "2026-08-09", dailyPrice: 59, minStay: null }
  ];
  const observed = [
    { date: "2026-08-07", price: 455, minStay: null, available: false },
    { date: "2026-08-08", price: 93, minStay: null, available: false },
    { date: "2026-08-09", price: 59, minStay: null, available: true }
  ];
  const unapplied = findUnappliedRates(pushed, observed);
  assert.deepEqual(
    unapplied.map((u) => ({ date: u.date, targetBooked: u.targetBooked })),
    [
      { date: "2026-08-07", targetBooked: true },
      { date: "2026-08-08", targetBooked: true }
    ]
  );
});

test("verify treats a date missing from the read-back as unapplied with unknown booking state", () => {
  const pushed = [{ date: "2026-08-08", dailyPrice: 216, minStay: null }];
  const unapplied = findUnappliedRates(pushed, []);
  assert.equal(unapplied.length, 1);
  assert.equal(unapplied[0]!.observed, null);
  assert.equal(unapplied[0]!.targetBooked, null);
});

test("verify passes when every pushed date reflects within tolerance", () => {
  const pushed = [{ date: "2026-08-09", dailyPrice: 59, minStay: null }];
  const observed = [{ date: "2026-08-09", price: 59.2, minStay: null, available: true }];
  assert.equal(findUnappliedRates(pushed, observed).length, 0);
});

test("unapplied message explains booked-date refusals and the hourly retry", () => {
  const message = buildUnappliedMessage(
    [{ date: "2026-08-08", expected: 216, observed: 93, targetBooked: true }],
    3
  );
  assert.match(message, /did not apply 1 of 3 dates/);
  assert.match(message, /fully booked/);
  assert.match(message, /retried every hour/);
  assert.match(message, /2026-08-08: sent 216 → Hostaway shows 93 \(fully booked\)/);
});
