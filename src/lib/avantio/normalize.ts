/**
 * Pure normalizers that turn raw Avantio v2 payloads into the
 * Hostaway-shaped objects the rest of Signals already understands
 * (`HostawayListing`, `HostawayReservation`). No I/O, no Prisma —
 * the gateway calls these on already-fetched JSON.
 *
 * Avantio facts (verified against the live sandbox 2026-06-24):
 *   - money fields are integers scaled by `10**decimalPlaces` on the
 *     booking response (decimalPlaces=3 in sandbox), so 2_177_058 = 2177.058.
 *   - status enums are upper-case; mapping table below maps to the lower-case
 *     vocabulary the engine expects (`cancelled`, `no-show`, `confirmed`, …).
 *   - channel is `salesChannel.name` free text — normalized to canonical
 *     `airbnb` / `booking` / `vrbo` / `direct` / `website` where recognized.
 *
 * Phase 0 uses GROSS figures (net + vat) — VAT toggle is a Phase-1 follow-up
 * (the AvantioConnection table grows a `vatMode` field then).
 */

import type {
  HostawayListing,
  HostawayReservation
} from "@/lib/hostaway/types";

// ---------- money ----------

/**
 * Avantio scales every money amount by `10**decimalPlaces`. Returns 0 for
 * null/undefined/NaN to keep the downstream NightFact path simple — every
 * money field on HostawayReservation is required-numeric.
 */
export function money(amount: number | null | undefined, decimalPlaces: number): number {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return 0;
  const divisor = 10 ** decimalPlaces;
  if (!Number.isFinite(divisor) || divisor <= 0) return 0;
  return amount / divisor;
}

// ---------- status ----------

/**
 * Engine vocabulary (see `src/lib/sync/nightfact.ts` CANCELLED_STATUSES +
 * NON_BOOKED_STATUSES): cancelled / canceled / no-show / no_show are
 * cancelled; declined / expired / inquiry / inquirypreapproved /
 * inquirynotpossible are non-booked. Everything else counts as booked.
 *
 * Exported so adding a new Avantio status later is a one-line PR.
 *
 * TPV_REQUEST + UNAVAILABLE (owner blocks) need a product decision in
 * Phase 1 before they're trusted in occupancy. TPV is mid-payment — does
 * a half-paid booking occupy a night? UNAVAILABLE rows look like owner-
 * blocked dates that DO occupy supply but generate no revenue (similar
 * to Hostaway "ownerStay") — Signals currently has no equivalent. Keep
 * them as their own lowercase passthrough labels until Mark + the
 * pricing team agree on how to fold them into NightFact accounting.
 *
 * TODO Phase 1: confirm the full Avantio status enum against production
 * data (sandbox surfaced 8 values; spec lists 6) and add any quote/option
 * statuses to the non-booked set above.
 */
export const AVANTIO_STATUS_MAP: Record<string, string> = {
  CANCELLED: "cancelled",
  NO_SHOW: "no-show",
  CONFIRMED: "confirmed",
  UNPAID: "unpaid",
  TPV_REQUEST: "tpv_request",
  REQUEST: "inquiry",
  // Information / availability requests are exploratory probes — no
  // booking obligation, no occupancy. Map both to the engine's "inquiry"
  // bucket so they fall through NON_BOOKED_STATUSES and don't allocate
  // nights or revenue.
  INFORMATION_REQUEST: "inquiry",
  AVAILABILITY_REQUEST: "inquiry"
};

export function normalizeStatus(avantioStatus: string | null | undefined): string {
  if (typeof avantioStatus !== "string") return "unknown";
  const trimmed = avantioStatus.trim();
  if (trimmed.length === 0) return "unknown";
  const mapped = AVANTIO_STATUS_MAP[trimmed.toUpperCase()];
  return mapped ?? trimmed.toLowerCase();
}

// ---------- channel ----------

/**
 * Map Avantio `salesChannel.name` free text to the canonical Signals
 * channel slugs the reporting code already groups by. Real production
 * channel names get appended as we observe them (this is the "extensible
 * one-line lookup" the AVANTIO-PHASE0-BUILD.md called out).
 */
export const AVANTIO_CHANNEL_MAP: Record<string, string> = {
  airbnb: "airbnb",
  "airbnb.com": "airbnb",
  booking: "booking",
  "booking.com": "booking",
  vrbo: "vrbo",
  "vrbo.com": "vrbo",
  homeaway: "vrbo",
  direct: "direct",
  "direct booking": "direct",
  website: "website",
  "own website": "website"
};

export function normalizeChannel(name?: string | null): string | undefined {
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  if (trimmed.length === 0) return undefined;
  const key = trimmed.toLowerCase();
  return AVANTIO_CHANNEL_MAP[key] ?? key;
}

// ---------- accommodation → HostawayListing ----------

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function avantioStatusToListingStatus(raw: unknown): string {
  if (typeof raw !== "string") return "inactive";
  switch (raw.trim().toUpperCase()) {
    case "ENABLED":
      return "active";
    case "DISABLED":
      return "inactive";
    case "DELETED":
      return "removed";
    default:
      return raw.toLowerCase();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * accommodation detail (from `GET /v2/accommodations/{id}`) → HostawayListing.
 * The list endpoint returns a slimmer summary, so the gateway is expected to
 * hydrate each via getAccommodation before calling this.
 */
export function accommodationToListing(detail: Record<string, unknown>): HostawayListing {
  const idValue = asString(detail.id);
  if (!idValue) {
    throw new Error("accommodationToListing: detail.id is required");
  }

  const distribution = isRecord(detail.distribution) ? detail.distribution : null;
  const bedroomsArray = distribution && Array.isArray(distribution.bedrooms) ? distribution.bedrooms : null;
  const bedroomsNumber = bedroomsArray ? bedroomsArray.length : undefined;

  const capacity = isRecord(detail.capacity) ? detail.capacity : null;
  const maxAdults = capacity ? asNumber(capacity.maxAdults) ?? 0 : 0;
  const maxChildren = capacity ? asNumber(capacity.maxChildren) ?? 0 : 0;
  const personCapacity = maxAdults + maxChildren > 0 ? maxAdults + maxChildren : undefined;

  const location = isRecord(detail.location) ? detail.location : null;
  const coordinates = location && isRecord(location.coordinates) ? location.coordinates : null;
  const latitude = coordinates ? asNumber(coordinates.lat) : undefined;
  const longitude = coordinates ? asNumber(coordinates.lon ?? coordinates.lng) : undefined;

  const name = asString(detail.name) ?? `Accommodation ${idValue}`;

  return {
    id: idValue,
    name,
    status: avantioStatusToListingStatus(detail.status),
    roomType: asString(detail.type),
    bedroomsNumber,
    personCapacity,
    city: location ? asString(location.cityName) : undefined,
    state: location ? asString(location.admin1) : undefined,
    country: location ? asString(location.admin2) : undefined,
    countryCode: location ? asString(location.countryCode) : undefined,
    latitude,
    longitude,
    raw: detail
    // Phase 0: averageReviewRating, minNights/maxNights, currencyCode left
    // unset — reviews + occupation-rule + whoami currency are wired in Phase 1
    // to save per-listing round-trips.
  };
}

// ---------- booking → HostawayReservation ----------

function nightsBetween(arrival: string | undefined, departure: string | undefined): number {
  if (!arrival || !departure) return 0;
  const a = Date.parse(`${arrival}T00:00:00Z`);
  const d = Date.parse(`${departure}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(d) || d <= a) return 0;
  return Math.round((d - a) / 86_400_000);
}

function sumChildren(children: unknown): number {
  if (!Array.isArray(children)) return 0;
  let total = 0;
  for (const entry of children) {
    if (!isRecord(entry)) continue;
    const amount = asNumber(entry.amount);
    if (amount) total += amount;
  }
  return total;
}

/**
 * booking detail (`GET /v2/bookings/{id}`) → HostawayReservation.
 *
 * decimalPlaces lives on the booking response itself, so every money field
 * is `money(raw, detail.decimalPlaces)`. Listing fk is `accommodation.id`
 * (matches the HostawayListing.id produced by `accommodationToListing`).
 *
 * accommodationFare / cleaningFee / taxes / totalPrice all use GROSS
 * figures (net + vat) per the Phase 0 decision in AVANTIO-PHASE0-BUILD.md.
 */
export function bookingToReservation(detail: Record<string, unknown>): HostawayReservation {
  const idValue = asString(detail.id);
  if (!idValue) {
    throw new Error("bookingToReservation: detail.id is required");
  }

  const accommodation = isRecord(detail.accommodation) ? detail.accommodation : null;
  const listingMapId = accommodation ? asString(accommodation.id) : undefined;
  if (!listingMapId) {
    throw new Error(`bookingToReservation: booking ${idValue} has no accommodation.id`);
  }

  const decimalPlaces = asNumber(detail.decimalPlaces) ?? 0;
  const salesChannel = isRecord(detail.salesChannel) ? detail.salesChannel : null;
  const channel = normalizeChannel(salesChannel ? asString(salesChannel.name) : undefined);

  const stayDates = isRecord(detail.stayDates) ? detail.stayDates : null;
  const arrivalDate = stayDates ? asString(stayDates.arrival) : undefined;
  const departureDate = stayDates ? asString(stayDates.departure) : undefined;
  if (!arrivalDate || !departureDate) {
    throw new Error(`bookingToReservation: booking ${idValue} missing stayDates`);
  }

  const occupancy = isRecord(detail.occupancy) ? detail.occupancy : null;
  const adults = occupancy ? asNumber(occupancy.adults) ?? 0 : 0;
  const children = occupancy ? sumChildren(occupancy.children) : 0;
  const guests = adults + children;

  const insertedOn = asString(detail.createdAt) ?? asString(detail.creationDate);
  const updatedOn = asString(detail.updatedAt);
  const currency = asString(detail.currency) ?? "EUR";

  // Money lives under `detail.amounts` — verified live 2026-06-24 against
  // booking 32768981. Shape:
  //   amounts: {
  //     total:    { net, vat },
  //     breakdown:{ base: {net, vat}, extras: {net, vat}, taxes: { tourism: {net, vat} } },
  //     commission:{ portal }
  //   }
  // decimalPlaces stays top-level on the booking detail.
  const amounts = isRecord(detail.amounts) ? detail.amounts : null;
  const breakdown = amounts && isRecord(amounts.breakdown) ? amounts.breakdown : null;
  const base = breakdown && isRecord(breakdown.base) ? breakdown.base : null;
  const extras = breakdown && isRecord(breakdown.extras) ? breakdown.extras : null;
  const taxesNode = breakdown && isRecord(breakdown.taxes) ? breakdown.taxes : null;
  const tourismTaxes = taxesNode && isRecord(taxesNode.tourism) ? taxesNode.tourism : null;
  const commissionNode = amounts && isRecord(amounts.commission) ? amounts.commission : null;
  const total = amounts && isRecord(amounts.total) ? amounts.total : null;

  const baseGross = (asNumber(base?.net) ?? 0) + (asNumber(base?.vat) ?? 0);
  const extrasGross = (asNumber(extras?.net) ?? 0) + (asNumber(extras?.vat) ?? 0);
  const tourismGross = (asNumber(tourismTaxes?.net) ?? 0) + (asNumber(tourismTaxes?.vat) ?? 0);
  const totalGross = (asNumber(total?.net) ?? 0) + (asNumber(total?.vat) ?? 0);
  const commissionPortal = asNumber(commissionNode?.portal) ?? 0;

  return {
    id: idValue,
    listingMapId,
    channel,
    status: normalizeStatus(asString(detail.status)),
    insertedOn,
    arrivalDate,
    departureDate,
    nights: nightsBetween(arrivalDate, departureDate),
    guests: guests > 0 ? guests : undefined,
    currency,
    accommodationFare: money(baseGross, decimalPlaces),
    cleaningFee: money(extrasGross, decimalPlaces),
    taxes: money(tourismGross, decimalPlaces),
    commission: money(commissionPortal, decimalPlaces),
    totalPrice: money(totalGross, decimalPlaces),
    guestFee: 0,
    updatedOn,
    raw: detail
  };
}
