import assert from "node:assert/strict";
import test from "node:test";

import { parseReservationFinancials } from "./client";

// These tests lock the money model the owner asked for:
//   - VAT stays INSIDE revenue, counted exactly once, never duplicated.
//   - The "exclude fees" toggle removes the CLEANING fee only (VAT survives it).
//   - Refundable damage/security deposits are NOT revenue and are excluded.
// They run offline (pure function, no DB / no fetch).

type Fee = { name: string; amount: number };

function raw(fees: Fee[]): Record<string, unknown> {
  return { reservationFees: fees };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;

test("direct booking: deposit excluded from revenue; VAT inside revenue exactly once", () => {
  // Cambridge Apt 5 — Robert Scaife (14 nights, Hostaway Direct):
  // base 1089.17 + cleaning 67 + refundable deposit 100 + VAT 217.83 = 1474 gross.
  const f = parseReservationFinancials(
    raw([
      { name: "Cleaning fee", amount: 67 },
      { name: "Refundable Damage Deposit", amount: 100 },
      { name: "VAT", amount: 217.83 }
    ]),
    1474,
    1089.17
  );

  // Revenue = gross minus the refundable hold -> 1374 (matches Hostaway).
  assert.ok(near(f.totalPrice, 1374), `total should be 1374, got ${f.totalPrice}`);
  // The refundable deposit must NOT have leaked into guest fees.
  assert.ok(near(f.guestFee, 0), `guestFee should be 0, got ${f.guestFee}`);
  // VAT is held as its own value...
  assert.ok(near(f.taxes, 217.83), `taxes should be 217.83, got ${f.taxes}`);
  assert.ok(near(f.cleaningFee, 67), `cleaningFee should be 67, got ${f.cleaningFee}`);
  assert.ok(near(f.accommodationFare, 1089.17), `room rate should be 1089.17, got ${f.accommodationFare}`);

  // ...and VAT is STILL inside the revenue total, counted exactly once:
  // total === base + cleaning + guest + VAT (no duplication, nothing missing).
  assert.ok(
    near(f.totalPrice, f.accommodationFare + f.cleaningFee + f.guestFee + f.taxes),
    "total must equal base + cleaning + guest + VAT (VAT counted exactly once)"
  );

  // The "exclude fees" toggle removes cleaning ONLY — VAT must survive it.
  const revenueExclFees = f.totalPrice - f.cleaningFee; // report's fees-off value
  assert.ok(near(revenueExclFees, 1307), `excl-fees revenue should be 1307, got ${revenueExclFees}`);
  assert.ok(
    near(revenueExclFees, f.accommodationFare + f.taxes),
    "VAT must remain inside revenue when fees are excluded"
  );
});

test("derived room rate nets out VAT when Hostaway sends no explicit base", () => {
  const f = parseReservationFinancials(
    raw([
      { name: "Cleaning fee", amount: 67 },
      { name: "Refundable Damage Deposit", amount: 100 },
      { name: "VAT", amount: 217.83 }
    ]),
    1474,
    0 // no explicit accommodation fare -> derive it
  );

  assert.ok(near(f.totalPrice, 1374), `total should be 1374, got ${f.totalPrice}`);
  assert.ok(near(f.taxes, 217.83), `taxes should be 217.83, got ${f.taxes}`);
  // Derived base = total - cleaning - guest - VAT = 1089.17 (NOT 1307).
  assert.ok(near(f.accommodationFare, 1089.17), `derived room rate should be 1089.17, got ${f.accommodationFare}`);
});

test("bookings without a deposit line item are unchanged (no OTA regression)", () => {
  const f = parseReservationFinancials(
    raw([
      { name: "Cleaning fee", amount: 50 },
      { name: "VAT", amount: 150 }
    ]),
    1000,
    800
  );

  assert.ok(near(f.totalPrice, 1000), `total should be unchanged at 1000, got ${f.totalPrice}`);
  assert.ok(near(f.taxes, 150), `taxes should be 150, got ${f.taxes}`);
  assert.ok(near(f.cleaningFee, 50), `cleaningFee should be 50, got ${f.cleaningFee}`);
});

test("non-refundable damage waivers stay in revenue (deposit classifier is tight)", () => {
  // base 800 + cleaning 50 + waiver 30 + VAT 150 = 1030 gross.
  const f = parseReservationFinancials(
    raw([
      { name: "Cleaning fee", amount: 50 },
      { name: "Damage Waiver", amount: 30 },
      { name: "VAT", amount: 150 }
    ]),
    1030,
    800
  );

  // A waiver is non-refundable revenue -> it must NOT be excluded.
  assert.ok(near(f.totalPrice, 1030), `waiver must remain in revenue, got ${f.totalPrice}`);
  assert.ok(near(f.guestFee, 30), `waiver should sit in guestFee, got ${f.guestFee}`);
  assert.ok(near(f.taxes, 150), `taxes should be 150, got ${f.taxes}`);
});

test("security deposit naming variant is also excluded from revenue", () => {
  // base 650 + cleaning 40 + security deposit 250 + VAT 60 = 1000 gross.
  const f = parseReservationFinancials(
    raw([
      { name: "Cleaning fee", amount: 40 },
      { name: "Security Deposit", amount: 250 },
      { name: "VAT", amount: 60 }
    ]),
    1000,
    650
  );

  assert.ok(near(f.totalPrice, 750), `security deposit should be excluded (750), got ${f.totalPrice}`);
  assert.ok(near(f.guestFee, 0), `guestFee should be 0, got ${f.guestFee}`);
  assert.ok(near(f.taxes, 60), `taxes should be 60, got ${f.taxes}`);
});
