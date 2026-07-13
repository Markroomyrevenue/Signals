/**
 * Guesty → Signals normalization.
 *
 * Converts Guesty Open API listing/reservation objects into the
 * HostawayListing / HostawayReservation shapes the sync engine already
 * understands, so NightFact, Pace, YoY, occupancy and reports work
 * unchanged.
 *
 * MONEY MAPPING (like-for-like with the Hostaway sync — see
 * `parseReservationFinancials` in src/lib/hostaway/client.ts and the
 * Guesty "Property Financials" / "Syncing Reservation Financials"
 * guides). Guesty nests all financials under `money`:
 *
 *   accommodationFare = money.fareAccommodationAdjusted  (rent-only, after
 *                       adjustments + discounts; falls back to
 *                       money.fareAccommodation when the adjusted figure is
 *                       absent/zero). This is the basis for ADR / RevPAR /
 *                       stay revenue, matching Hostaway's rent-only fare.
 *   cleaningFee       = money.fareCleaning
 *   taxes             = money.totalTaxes
 *   commission        = money.hostServiceFee (channel/platform commission
 *                       charged to the host; falls back to money.commission)
 *   guestFee          = money.subTotalPrice − accommodationFare − cleaning
 *                       (Guesty has no single guest-fee field; subTotalPrice
 *                       is the pre-tax guest charge total, so the remainder
 *                       after rent + cleaning is the fee bucket). Clamped ≥0.
 *   totalPrice        = money.subTotalPrice + money.totalTaxes when
 *                       subTotalPrice is present (guest-paid revenue,
 *                       matching Hostaway's deposit-free total), otherwise
 *                       reconstructed as fare + cleaning + guestFee + taxes.
 *
 * STATUS MAPPING: the engine's booked/non-booked split lives in
 * nightfact.ts (NON_BOOKED_STATUSES) and its cancellation set in
 * engine.ts (CANCELLED_STATUSES = cancelled/canceled/no-show/no_show).
 * Guesty statuses map so cancelled bookings carry a cancellation
 * timestamp (canceledAt) and inquiry-family statuses never occupy nights.
 */

import type { HostawayListing, HostawayReservation } from "@/lib/hostaway/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Guesty reservation statuses → engine vocabulary.
 *
 *  - `canceled` → `cancelled` (CANCELLED_STATUSES; carries cancelledAt).
 *  - `inquiry` / `closed` → `inquiry` (closed = an inquiry the host shut;
 *    it never occupied a night — grouped with inquiry so it lands in
 *    NON_BOOKED_STATUSES).
 *  - `declined`, `expired` → themselves (already in NON_BOOKED_STATUSES).
 *  - `confirmed`, `reserved`, `checked_in`, `checked_out` → lowercase
 *    passthrough (booked: `reserved` holds inventory on Guesty, so it
 *    occupies, matching Hostaway's treatment of pending-confirmed stays).
 */
const GUESTY_STATUS_MAP: Record<string, string> = {
  canceled: "cancelled",
  cancelled: "cancelled",
  inquiry: "inquiry",
  closed: "inquiry",
  declined: "declined",
  expired: "expired"
};

export function normalizeGuestyStatus(status: unknown): string {
  const raw = (asString(status) ?? "unknown").toLowerCase();
  return GUESTY_STATUS_MAP[raw] ?? raw;
}

/** Canonicalise Guesty `source` values into Signals' channel vocabulary. */
const GUESTY_CHANNEL_MAP: Record<string, string> = {
  airbnb: "airbnb",
  airbnb2: "airbnb",
  airbnbofficial: "airbnb",
  bookingcom: "booking.com",
  "booking.com": "booking.com",
  expedia: "expedia",
  vrbo: "vrbo",
  homeaway: "vrbo",
  direct: "direct",
  website: "direct",
  "be-api": "direct",
  "booking engine": "direct",
  manual: "direct",
  manualreservation: "direct"
};

export function normalizeGuestyChannel(source: unknown): string | undefined {
  const raw = asString(source);
  if (!raw) return undefined;
  return GUESTY_CHANNEL_MAP[raw.toLowerCase()] ?? raw.toLowerCase();
}

/**
 * Guesty listing → HostawayListing.
 *
 * `unitCount` is injected by the gateway for MTL (multi-unit) parents —
 * the listing object itself doesn't carry a unit count; the gateway
 * derives it from the calendar allotment / child count so the occupancy
 * denominator scales (Listing.unit_count ≥ 2 triggers multi-unit
 * pricing + inventory logic downstream).
 */
export function guestyListingToHostawayListing(
  raw: Record<string, unknown>,
  options: { unitCount?: number | null } = {}
): HostawayListing {
  const id = asString(raw._id) ?? asString(raw.id);
  if (!id) {
    throw new Error("guesty.normalize: listing without _id");
  }

  const address = isRecord(raw.address) ? raw.address : {};
  const prices = isRecord(raw.prices) ? raw.prices : {};
  const terms = isRecord(raw.terms) ? raw.terms : {};
  const picture = isRecord(raw.picture) ? raw.picture : {};

  const active = raw.active === true;
  // Signals' listing lifecycle only distinguishes active from not; Guesty's
  // `active` flag is the operational switch (isListed is channel exposure).
  const status = active ? "active" : "inactive";

  return {
    id,
    name: asString(raw.nickname) ?? asString(raw.title) ?? `Guesty listing ${id}`,
    status,
    externalName: asString(raw.title),
    timezone: asString(raw.timezone),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
    country: asString(address.country),
    city: asString(address.city),
    street: asString(address.street),
    address: asString(address.full),
    postalCode: asString(address.zipcode) ?? asString(address.postalCode),
    latitude: asNumber(address.lat),
    longitude: asNumber(address.lng),
    roomType: asString(raw.roomType),
    bedroomsNumber: asNumber(raw.bedrooms),
    bathroomsNumber: asNumber(raw.bathrooms),
    bedsNumber: asNumber(raw.beds),
    personCapacity: asNumber(raw.accommodates),
    unitCount: options.unitCount ?? null,
    minNights: asNumber(terms.minNights),
    maxNights: asNumber(terms.maxNights),
    cleaningFee: asNumber(prices.cleaningFee),
    currencyCode: asString(prices.currency),
    thumbnailUrl: asString(picture.thumbnail) ?? asString(picture.regular),
    raw
  };
}

/**
 * Guesty reservation → HostawayReservation. See the money-mapping block
 * in the file header for the financial field derivations.
 */
export function guestyReservationToHostawayReservation(
  raw: Record<string, unknown>
): HostawayReservation {
  const id = asString(raw._id) ?? asString(raw.id);
  if (!id) {
    throw new Error("guesty.normalize: reservation without _id");
  }
  const listingId = asString(raw.listingId);
  if (!listingId) {
    throw new Error(`guesty.normalize: reservation ${id} without listingId`);
  }

  const money = isRecord(raw.money) ? raw.money : {};

  const fareAccommodationAdjusted = asNumber(money.fareAccommodationAdjusted);
  const fareAccommodation = asNumber(money.fareAccommodation);
  // Rent-only fare, post adjustments/discounts (see header).
  const accommodationFare =
    fareAccommodationAdjusted !== undefined && fareAccommodationAdjusted !== 0
      ? fareAccommodationAdjusted
      : fareAccommodation ?? 0;

  const cleaningFee = asNumber(money.fareCleaning) ?? 0;
  const taxes = asNumber(money.totalTaxes) ?? 0;
  const commission = asNumber(money.hostServiceFee) ?? asNumber(money.commission) ?? 0;

  const subTotalPrice = asNumber(money.subTotalPrice);
  const guestFee =
    subTotalPrice !== undefined ? Math.max(0, subTotalPrice - accommodationFare - cleaningFee) : 0;
  const totalPrice =
    subTotalPrice !== undefined
      ? subTotalPrice + taxes
      : accommodationFare + cleaningFee + guestFee + taxes;

  // Prefer the property-timezone-localized date (yyyy-MM-dd) so a late
  // check-in doesn't land on the wrong night; fall back to the ISO instant.
  const arrivalDate = asString(raw.checkInDateLocalized) ?? asString(raw.checkIn) ?? "";
  const departureDate = asString(raw.checkOutDateLocalized) ?? asString(raw.checkOut) ?? "";

  const status = normalizeGuestyStatus(raw.status);

  return {
    id,
    listingMapId: listingId,
    channel: normalizeGuestyChannel(raw.source),
    status,
    insertedOn: asString(raw.createdAt),
    confirmedOn: asString(raw.confirmedAt),
    arrivalDate,
    departureDate,
    nights: asNumber(raw.nightsCount) ?? 0,
    guests: asNumber(raw.guestsCount),
    currency: asString(money.currency) ?? asString(raw.currency) ?? "GBP",
    totalPrice,
    accommodationFare,
    cleaningFee,
    guestFee,
    taxes,
    commission,
    updatedOn: asString(raw.lastUpdatedAt),
    // Guesty records the actual cancellation instant — pass it through so
    // the engine stores the true cancelledAt (pace attribution depends on
    // WHEN a cancellation happened, not when we first synced it).
    cancelledOn: status === "cancelled" ? asString(raw.canceledAt) ?? asString(raw.lastUpdatedAt) : undefined,
    raw
  };
}
