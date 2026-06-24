import assert from "node:assert/strict";
import test from "node:test";

import {
  AVANTIO_STATUS_MAP,
  accommodationToListing,
  bookingToReservation,
  money,
  normalizeChannel,
  normalizeStatus
} from "./normalize";

test("money divides by 10^decimalPlaces (sandbox uses 3)", () => {
  assert.equal(money(2_177_058, 3), 2177.058);
  assert.equal(money(0, 3), 0);
  assert.equal(money(null, 3), 0);
  assert.equal(money(undefined, 3), 0);
  assert.equal(money(123, 0), 123);
  assert.equal(money(12_345, 2), 123.45);
});

test("money guards Number.NaN and non-positive decimalPlaces", () => {
  assert.equal(money(Number.NaN, 3), 0);
  // decimalPlaces<=0 still divides by 1 — Avantio never sends negative
  // but the function should not silently flip the sign of the amount.
  assert.equal(money(500, 0), 500);
});

test("normalizeStatus maps the full enum from the spec", () => {
  assert.equal(normalizeStatus("CANCELLED"), "cancelled");
  assert.equal(normalizeStatus("NO_SHOW"), "no-show");
  assert.equal(normalizeStatus("CONFIRMED"), "confirmed");
  assert.equal(normalizeStatus("UNPAID"), "unpaid");
  assert.equal(normalizeStatus("TPV_REQUEST"), "tpv_request");
  assert.equal(normalizeStatus("REQUEST"), "inquiry");
  assert.equal(normalizeStatus("INFORMATION_REQUEST"), "inquiry");
  assert.equal(normalizeStatus("AVAILABILITY_REQUEST"), "inquiry");
});

test("normalizeStatus lower-cases unknown enum values (forward-compatible)", () => {
  assert.equal(normalizeStatus("OWNER_BLOCK"), "owner_block");
  assert.equal(normalizeStatus(""), "unknown");
  assert.equal(normalizeStatus(null), "unknown");
  assert.equal(normalizeStatus(undefined), "unknown");
});

test("normalizeStatus uses the exported map (extensible)", () => {
  // If a future PR adds OPTION → option, the mapping should still be the
  // source of truth and not re-implemented somewhere downstream.
  assert.ok(AVANTIO_STATUS_MAP.CANCELLED === "cancelled");
});

test("normalizeChannel canonicalises common Avantio salesChannel names", () => {
  assert.equal(normalizeChannel("Airbnb"), "airbnb");
  assert.equal(normalizeChannel("Booking.com"), "booking");
  assert.equal(normalizeChannel("vrbo"), "vrbo");
  assert.equal(normalizeChannel("HomeAway"), "vrbo");
  assert.equal(normalizeChannel("Direct"), "direct");
  assert.equal(normalizeChannel("Own Website"), "website");
});

test("normalizeChannel passes unknown channels through lowercased", () => {
  assert.equal(normalizeChannel("SomeNewChannel"), "somenewchannel");
  assert.equal(normalizeChannel(""), undefined);
  assert.equal(normalizeChannel(undefined), undefined);
});

test("accommodationToListing extracts bedrooms, capacity, location", () => {
  const listing = accommodationToListing({
    id: "acc-1",
    name: "Test Apartment",
    status: "ENABLED",
    type: "APARTMENT",
    distribution: { bedrooms: [{ type: "double" }, { type: "twin" }] },
    capacity: { maxAdults: 4, maxChildren: 2 },
    location: {
      cityName: "Belfast",
      admin1: "Antrim",
      admin2: "Northern Ireland",
      countryCode: "GB",
      coordinates: { lat: 54.5973, lon: -5.9301 }
    },
    units: 1
  });

  assert.equal(listing.id, "acc-1");
  assert.equal(listing.name, "Test Apartment");
  assert.equal(listing.status, "active");
  assert.equal(listing.roomType, "APARTMENT");
  assert.equal(listing.bedroomsNumber, 2);
  assert.equal(listing.personCapacity, 6);
  assert.equal(listing.city, "Belfast");
  assert.equal(listing.countryCode, "GB");
  assert.equal(listing.latitude, 54.5973);
  assert.equal(listing.longitude, -5.9301);
});

test("accommodationToListing maps DISABLED → inactive, DELETED → removed", () => {
  const disabled = accommodationToListing({ id: "x", name: "X", status: "DISABLED" });
  assert.equal(disabled.status, "inactive");
  const deleted = accommodationToListing({ id: "y", name: "Y", status: "DELETED" });
  assert.equal(deleted.status, "removed");
});

test("bookingToReservation reads money from amounts.breakdown.* (real Avantio shape)", () => {
  // Real Avantio v2 booking detail nests money under `amounts.breakdown`,
  // not at the top level. decimalPlaces stays top-level on the booking.
  // Fixture mirrors sandbox booking 32768981 (verified live 2026-06-24).
  const reservation = bookingToReservation({
    id: "bk-cancel-1",
    status: "CANCELLED",
    decimalPlaces: 3,
    accommodation: { id: "acc-1" },
    salesChannel: { name: "Airbnb" },
    stayDates: { arrival: "2026-07-01", departure: "2026-07-04" },
    occupancy: { adults: 2, children: [] },
    currency: "EUR",
    createdAt: "2026-06-01T10:00:00Z",
    updatedAt: "2026-06-15T12:00:00Z",
    amounts: {
      total: { net: 200_000, vat: 21_000 },
      breakdown: {
        base: { net: 200_000, vat: 21_000 },
        extras: { net: 0, vat: 0 },
        taxes: { tourism: { net: 0, vat: 0 } }
      },
      commission: { portal: 30_000 }
    }
  });

  assert.equal(reservation.id, "bk-cancel-1");
  assert.equal(reservation.status, "cancelled");
  assert.equal(reservation.listingMapId, "acc-1");
  assert.equal(reservation.channel, "airbnb");
  assert.equal(reservation.nights, 3);
  assert.equal(reservation.guests, 2);
  assert.equal(reservation.accommodationFare, 221);
  assert.equal(reservation.totalPrice, 221);
  assert.equal(reservation.commission, 30);
  assert.equal(reservation.currency, "EUR");
});

test("bookingToReservation matches booking 32768981 exactly (sandbox spot-check)", () => {
  // Live sandbox response, verified 2026-06-24:
  //   amounts.breakdown.base = { net: 2177058, vat: 457182 } -> 2634.240
  //   amounts.total          = { net: 2192058, vat: 457182 } -> 2649.240
  //   amounts.commission.portal = 263424                    ->  263.424
  //   amounts.breakdown.taxes.tourism = { net: 15000, vat: 0 } -> 15.000
  const reservation = bookingToReservation({
    id: "32768981",
    status: "CANCELLED",
    decimalPlaces: 3,
    accommodation: { id: "55705" },
    salesChannel: { name: "USUARIO PRUEBAS VECI" },
    stayDates: { arrival: "2026-10-20", departure: "2026-10-23" },
    occupancy: { adults: 1, children: [], infants: 0 },
    currency: "EUR",
    amounts: {
      total: { net: 2_192_058, vat: 457_182 },
      breakdown: {
        base: { net: 2_177_058, vat: 457_182 },
        extras: { net: 0, vat: 0 },
        modifiers: { net: 0, vat: 0 },
        taxes: { tourism: { net: 15_000, vat: 0 } }
      },
      commission: { portal: 263_424 }
    }
  });

  assert.equal(reservation.accommodationFare, 2634.24);
  assert.equal(reservation.totalPrice, 2649.24);
  assert.equal(reservation.commission, 263.424);
  assert.equal(reservation.taxes, 15);
  assert.equal(reservation.cleaningFee, 0);
});

test("bookingToReservation applies money() to every gross field with decimalPlaces=3", () => {
  const reservation = bookingToReservation({
    id: "bk-1",
    status: "CONFIRMED",
    decimalPlaces: 3,
    accommodation: { id: "acc-1" },
    stayDates: { arrival: "2026-08-10", departure: "2026-08-15" },
    occupancy: { adults: 2, children: [{ amount: 1 }, { amount: 2 }] },
    amounts: {
      total: { net: 2_051_000, vat: 187_768 },
      breakdown: {
        base: { net: 2_000_000, vat: 177_058 },
        extras: { net: 50_000, vat: 10_500 },
        taxes: { tourism: { net: 1_000, vat: 210 } }
      },
      commission: { portal: 100_000 }
    }
  });

  assert.equal(reservation.accommodationFare, 2177.058);
  assert.equal(reservation.cleaningFee, 60.5);
  assert.equal(reservation.taxes, 1.21);
  assert.equal(reservation.commission, 100);
  assert.equal(reservation.totalPrice, 2238.768);
  assert.equal(reservation.guests, 5);
  assert.equal(reservation.nights, 5);
});

test("bookingToReservation handles NO_SHOW → no-show (cancelled-equivalent)", () => {
  const reservation = bookingToReservation({
    id: "bk-noshow",
    status: "NO_SHOW",
    decimalPlaces: 3,
    accommodation: { id: "acc-9" },
    stayDates: { arrival: "2026-05-01", departure: "2026-05-02" },
    amounts: {
      total: { net: 1_000, vat: 0 },
      breakdown: { base: { net: 1_000, vat: 0 } }
    }
  });
  assert.equal(reservation.status, "no-show");
  assert.equal(reservation.accommodationFare, 1);
});

test("bookingToReservation classifies INFORMATION_REQUEST + AVAILABILITY_REQUEST as inquiry", () => {
  const info = bookingToReservation({
    id: "bk-info",
    status: "INFORMATION_REQUEST",
    decimalPlaces: 3,
    accommodation: { id: "acc-1" },
    stayDates: { arrival: "2026-09-01", departure: "2026-09-03" },
    amounts: { total: { net: 0, vat: 0 }, breakdown: { base: { net: 0, vat: 0 } } }
  });
  const avail = bookingToReservation({
    id: "bk-avail",
    status: "AVAILABILITY_REQUEST",
    decimalPlaces: 3,
    accommodation: { id: "acc-1" },
    stayDates: { arrival: "2026-09-04", departure: "2026-09-06" },
    amounts: { total: { net: 0, vat: 0 }, breakdown: { base: { net: 0, vat: 0 } } }
  });
  assert.equal(info.status, "inquiry");
  assert.equal(avail.status, "inquiry");
});

test("bookingToReservation defaults to 0 when amounts payload is missing entirely", () => {
  // Sandbox bookings occasionally have no amounts node at all (test
  // bookings, inquiries without quotes). money() should produce 0 for
  // every field, NOT throw.
  const reservation = bookingToReservation({
    id: "bk-bare",
    status: "REQUEST",
    decimalPlaces: 3,
    accommodation: { id: "acc-x" },
    stayDates: { arrival: "2026-12-01", departure: "2026-12-02" }
  });
  assert.equal(reservation.status, "inquiry");
  assert.equal(reservation.accommodationFare, 0);
  assert.equal(reservation.totalPrice, 0);
});
