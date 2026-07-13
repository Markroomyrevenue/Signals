import assert from "node:assert/strict";
import test from "node:test";

import {
  guestyListingToHostawayListing,
  guestyReservationToHostawayReservation,
  normalizeGuestyChannel,
  normalizeGuestyStatus
} from "./normalize";

test("normalizeGuestyStatus maps cancellation + inquiry families into the engine vocabulary", () => {
  assert.equal(normalizeGuestyStatus("canceled"), "cancelled");
  assert.equal(normalizeGuestyStatus("CANCELED"), "cancelled");
  assert.equal(normalizeGuestyStatus("cancelled"), "cancelled");
  assert.equal(normalizeGuestyStatus("inquiry"), "inquiry");
  // A closed inquiry never occupied a night — must land in NON_BOOKED.
  assert.equal(normalizeGuestyStatus("closed"), "inquiry");
  assert.equal(normalizeGuestyStatus("declined"), "declined");
  assert.equal(normalizeGuestyStatus("expired"), "expired");
});

test("normalizeGuestyStatus passes booked statuses through lowercased", () => {
  assert.equal(normalizeGuestyStatus("confirmed"), "confirmed");
  assert.equal(normalizeGuestyStatus("reserved"), "reserved");
  assert.equal(normalizeGuestyStatus("checked_in"), "checked_in");
  assert.equal(normalizeGuestyStatus(""), "unknown");
  assert.equal(normalizeGuestyStatus(null), "unknown");
});

test("normalizeGuestyChannel canonicalises common sources", () => {
  assert.equal(normalizeGuestyChannel("airbnb2"), "airbnb");
  assert.equal(normalizeGuestyChannel("airbnbOfficial"), "airbnb");
  assert.equal(normalizeGuestyChannel("bookingCom"), "booking.com");
  assert.equal(normalizeGuestyChannel("Website"), "direct");
  assert.equal(normalizeGuestyChannel("manual"), "direct");
  assert.equal(normalizeGuestyChannel("SomeNewChannel"), "somenewchannel");
  assert.equal(normalizeGuestyChannel(undefined), undefined);
});

const LISTING_FIXTURE: Record<string, unknown> = {
  _id: "5f2a111122223333aaaabbbb",
  title: "Cityscape Central Apartment",
  nickname: "CSC-01",
  active: true,
  isListed: true,
  type: "SINGLE",
  address: {
    full: "1 Example Street, Belfast, BT1 1AA, United Kingdom",
    street: "1 Example Street",
    city: "Belfast",
    country: "United Kingdom",
    zipcode: "BT1 1AA",
    lat: 54.5973,
    lng: -5.9301
  },
  propertyType: "Apartment",
  roomType: "Entire home/apt",
  bedrooms: 2,
  bathrooms: 1,
  beds: 3,
  accommodates: 4,
  prices: { basePrice: 120, currency: "GBP", cleaningFee: 45 },
  terms: { minNights: 2, maxNights: 30 },
  picture: { thumbnail: "https://img.example/t.jpg" }
};

test("guestyListingToHostawayListing extracts the fields the engine stores", () => {
  const listing = guestyListingToHostawayListing(LISTING_FIXTURE);
  assert.equal(listing.id, "5f2a111122223333aaaabbbb");
  assert.equal(listing.name, "CSC-01"); // nickname preferred
  assert.equal(listing.externalName, "Cityscape Central Apartment");
  assert.equal(listing.status, "active");
  assert.equal(listing.city, "Belfast");
  assert.equal(listing.country, "United Kingdom");
  assert.equal(listing.postalCode, "BT1 1AA");
  assert.equal(listing.latitude, 54.5973);
  assert.equal(listing.longitude, -5.9301);
  assert.equal(listing.roomType, "Entire home/apt");
  assert.equal(listing.bedroomsNumber, 2);
  assert.equal(listing.bathroomsNumber, 1);
  assert.equal(listing.personCapacity, 4);
  assert.equal(listing.minNights, 2);
  assert.equal(listing.cleaningFee, 45);
  assert.equal(listing.currencyCode, "GBP");
  assert.equal(listing.unitCount, null);
  assert.equal(listing.raw, LISTING_FIXTURE);
});

test("guestyListingToHostawayListing marks inactive listings and injects unitCount", () => {
  const inactive = guestyListingToHostawayListing({ ...LISTING_FIXTURE, active: false });
  assert.equal(inactive.status, "inactive");

  const multi = guestyListingToHostawayListing({ ...LISTING_FIXTURE, type: "MTL" }, { unitCount: 12 });
  assert.equal(multi.unitCount, 12);
});

test("guestyListingToHostawayListing throws without an id", () => {
  assert.throws(() => guestyListingToHostawayListing({ title: "no id" }));
});

/**
 * Canonical money fixture. Mirrors the documented Guesty money object:
 * rent £900 adjusted to £855 after a discount, £60 cleaning, subTotal
 * £940 (so £25 of other fees), £47 taxes, £28.20 host service fee.
 */
const RESERVATION_FIXTURE: Record<string, unknown> = {
  _id: "63aa000011112222deadbeef",
  listingId: "5f2a111122223333aaaabbbb",
  status: "confirmed",
  source: "airbnb2",
  confirmationCode: "HMABCDEFGH",
  checkIn: "2026-08-07T15:00:00.000Z",
  checkOut: "2026-08-10T10:00:00.000Z",
  checkInDateLocalized: "2026-08-07",
  checkOutDateLocalized: "2026-08-10",
  nightsCount: 3,
  guestsCount: 2,
  createdAt: "2026-06-01T09:30:00.000Z",
  confirmedAt: "2026-06-01T09:31:00.000Z",
  lastUpdatedAt: "2026-06-02T12:00:00.000Z",
  money: {
    currency: "GBP",
    fareAccommodation: 900,
    fareAccommodationAdjusted: 855,
    fareCleaning: 60,
    subTotalPrice: 940,
    totalTaxes: 47,
    hostServiceFee: 28.2
  }
};

test("guestyReservationToHostawayReservation maps money like-for-like with Hostaway", () => {
  const reservation = guestyReservationToHostawayReservation(RESERVATION_FIXTURE);
  assert.equal(reservation.id, "63aa000011112222deadbeef");
  assert.equal(reservation.listingMapId, "5f2a111122223333aaaabbbb");
  assert.equal(reservation.status, "confirmed");
  assert.equal(reservation.channel, "airbnb");
  assert.equal(reservation.arrivalDate, "2026-08-07"); // localized preferred
  assert.equal(reservation.departureDate, "2026-08-10");
  assert.equal(reservation.nights, 3);
  assert.equal(reservation.guests, 2);
  assert.equal(reservation.currency, "GBP");
  // Rent-only fare, post-adjustment.
  assert.equal(reservation.accommodationFare, 855);
  assert.equal(reservation.cleaningFee, 60);
  // subTotal 940 − 855 rent − 60 cleaning = 25 of fees.
  assert.equal(reservation.guestFee, 25);
  assert.equal(reservation.taxes, 47);
  assert.equal(reservation.commission, 28.2);
  // Guest total = subTotal + taxes.
  assert.equal(reservation.totalPrice, 987);
  assert.equal(reservation.insertedOn, "2026-06-01T09:30:00.000Z");
  assert.equal(reservation.confirmedOn, "2026-06-01T09:31:00.000Z");
  assert.equal(reservation.updatedOn, "2026-06-02T12:00:00.000Z");
  assert.equal(reservation.cancelledOn, undefined);
  assert.equal(reservation.raw, RESERVATION_FIXTURE);
});

test("cancelled reservations carry the PMS canceledAt as cancelledOn", () => {
  const cancelled = guestyReservationToHostawayReservation({
    ...RESERVATION_FIXTURE,
    status: "canceled",
    canceledAt: "2026-07-01T08:00:00.000Z"
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelledOn, "2026-07-01T08:00:00.000Z");
});

test("cancelled reservations fall back to lastUpdatedAt when canceledAt is missing", () => {
  const cancelled = guestyReservationToHostawayReservation({
    ...RESERVATION_FIXTURE,
    status: "canceled"
  });
  assert.equal(cancelled.cancelledOn, "2026-06-02T12:00:00.000Z");
});

test("money mapping falls back when adjusted fare or subTotal are absent", () => {
  const sparse = guestyReservationToHostawayReservation({
    ...RESERVATION_FIXTURE,
    money: {
      currency: "GBP",
      fareAccommodation: 500,
      fareCleaning: 40,
      totalTaxes: 20
    }
  });
  assert.equal(sparse.accommodationFare, 500); // fareAccommodation fallback
  assert.equal(sparse.guestFee, 0); // no subTotal → no fee bucket
  // Reconstructed: 500 + 40 + 0 + 20.
  assert.equal(sparse.totalPrice, 560);
});

test("zero-adjusted fare falls back to the base fare (adjusted=0 means unset upstream)", () => {
  const zeroAdjusted = guestyReservationToHostawayReservation({
    ...RESERVATION_FIXTURE,
    money: {
      currency: "GBP",
      fareAccommodation: 300,
      fareAccommodationAdjusted: 0,
      fareCleaning: 0,
      subTotalPrice: 300,
      totalTaxes: 0
    }
  });
  assert.equal(zeroAdjusted.accommodationFare, 300);
  assert.equal(zeroAdjusted.totalPrice, 300);
});

test("guestyReservationToHostawayReservation throws without id or listingId", () => {
  assert.throws(() => guestyReservationToHostawayReservation({ listingId: "x" }));
  assert.throws(() => guestyReservationToHostawayReservation({ _id: "y" }));
});
