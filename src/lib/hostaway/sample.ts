import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { env } from "@/lib/env";
import {
  FetchReservationsArgs,
  HostawayCalendarRate,
  HostawayGateway,
  HostawayListing,
  HostawayPageResult,
  HostawayReservation
} from "@/lib/hostaway/types";

type SampleHostawayGatewayConfig = {
  csvPath: string;
  pageSize?: number;
};

type ParsedCsv = {
  rows: string[][];
  listings: HostawayListing[];
  reservations: HostawayReservation[];
};

type ColumnKey =
  | "listingId"
  | "listingName"
  | "reservationId"
  | "status"
  | "channel"
  | "bookingCreatedDate"
  | "updatedDate"
  | "arrival"
  | "departure"
  | "nights"
  | "currency"
  | "accommodationFare"
  | "cleaningFee"
  | "guestFee"
  | "total";

const PAGE_SIZE = 200;
const parsedCsvCache = new Map<string, Promise<ParsedCsv>>();
const latestCacheKeyByPath = new Map<string, string>();

const FIELD_ALIASES: Record<ColumnKey, string[]> = {
  listingId: ["listingid", "listingmapid", "propertyid", "unitid", "listing"],
  listingName: ["listingname", "listing", "propertyname", "property", "unitname"],
  reservationId: ["reservationid", "bookingid", "bookingreference", "reservationnumber", "confirmationcode"],
  status: ["status", "bookingstatus"],
  channel: ["channel", "source", "ota"],
  bookingCreatedDate: ["insertedon", "createdat", "bookdate", "bookingdate", "reservationdate"],
  updatedDate: ["updatedon", "updatedat", "modifiedat"],
  arrival: ["arrivaldate", "checkindate", "staystart", "arrival", "checkin"],
  departure: ["departuredate", "checkoutdate", "stayend", "departure", "checkout"],
  nights: ["nights", "lengthofstay", "los"],
  currency: ["currency"],
  accommodationFare: [
    "accommodationfare",
    "roomrevenue",
    "accommodation",
    "rent",
    "rentalrevenue"
  ],
  cleaningFee: [
    "cleaningfee",
    "cleaningfees",
    "totalcleaningfee",
    "cleaning",
    "housekeepingfee",
    "housekeeping",
    "cleaningcharge"
  ],
  guestFee: [
    "totalguestfees",
    "guestfees",
    "guestfee",
    "guestservicefee",
    "servicefee",
    "totalservicefees",
    "guestcharge"
  ],
  total: ["totalprice", "total", "grossrevenue", "revenue", "rentalrevenue"]
};

const ORDERED_COLUMN_KEYS: ColumnKey[] = [
  "listingId",
  "listingName",
  "reservationId",
  "status",
  "channel",
  "bookingCreatedDate",
  "updatedDate",
  "arrival",
  "departure",
  "nights",
  "currency",
  "accommodationFare",
  "cleaningFee",
  "guestFee",
  "total"
];

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  const input = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inQuotes) {
      if (char === "\"") {
        if (input[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\r" || char === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];

      if (char === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function toDate(value?: string): Date | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const date = new Date(`${normalized}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(date.getTime()) && date.getUTCMonth() + 1 === month && date.getUTCDate() === day) {
      return date;
    }
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseNumber(value: string): number | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  const cleaned = normalized.replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") {
    return null;
  }

  const result = Number(cleaned);
  return Number.isFinite(result) ? result : null;
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function chooseColumnIndex(
  normalizedHeaders: string[],
  aliases: string[]
): number | null {
  for (const alias of aliases) {
    const exactMatch = normalizedHeaders.findIndex((header) => header === alias);
    if (exactMatch >= 0) return exactMatch;
  }

  for (const alias of aliases) {
    const boundaryMatch = normalizedHeaders.findIndex(
      (header) => alias.length >= 3 && (header.startsWith(alias) || header.endsWith(alias))
    );
    if (boundaryMatch >= 0) return boundaryMatch;
  }

  for (const alias of aliases) {
    if (alias.length < 4) continue;
    const containsMatch = normalizedHeaders.findIndex((header) => header.includes(alias));
    if (containsMatch >= 0) return containsMatch;
  }

  return null;
}

function formatMappingLine(key: ColumnKey, header: string | null): string {
  return `${key}=${header ?? "(missing)"}`;
}

function stableSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return slug || "unknown-listing";
}

function toPage<T>(items: T[], page = 1, pageSize = PAGE_SIZE): HostawayPageResult<T> {
  const start = Math.max(0, (page - 1) * pageSize);
  const pageItems = items.slice(start, start + pageSize);
  return {
    items: pageItems,
    page,
    hasMore: start + pageSize < items.length
  };
}

function applyReservationFilters(
  reservations: HostawayReservation[],
  args: FetchReservationsArgs
): HostawayReservation[] {
  let rows = reservations;

  const updatedSinceDate = args.updatedSince ? toDate(args.updatedSince) : null;
  const latestActivityStart = args.latestActivityStart ? toDate(args.latestActivityStart) : null;
  const latestActivityEnd = args.latestActivityEnd ? toDate(args.latestActivityEnd) : null;
  if (updatedSinceDate || latestActivityStart || latestActivityEnd) {
    rows = rows.filter((reservation) => {
      const updatedAt = toDate(reservation.updatedOn ?? reservation.insertedOn);
      if (!updatedAt) return false;
      if (updatedSinceDate && updatedAt < updatedSinceDate) return false;
      if (latestActivityStart && updatedAt < latestActivityStart) return false;
      if (latestActivityEnd && updatedAt > latestActivityEnd) return false;
      return true;
    });
  }

  if (args.dateRange) {
    const fromDate = toDate(args.dateRange.from);
    const toDateRange = toDate(args.dateRange.to);
    if (fromDate && toDateRange) {
      rows = rows.filter((reservation) => {
        const arrival = toDate(reservation.arrivalDate);
        const departure = toDate(reservation.departureDate);
        return Boolean(arrival && departure && arrival <= toDateRange && departure >= fromDate);
      });
    }
  }

  if (args.afterId) {
    const anchorIndex = rows.findIndex((reservation) => reservation.id === args.afterId);
    if (anchorIndex >= 0) {
      rows = rows.slice(anchorIndex + 1);
    }
  }

  return rows;
}

function createSummaryLogMessage(
  path: string,
  headers: string[],
  mapping: Record<ColumnKey, string | null>,
  totalRows: number,
  skippedRows: number
): string {
  const mappedColumns = ORDERED_COLUMN_KEYS.map((key) => formatMappingLine(key, mapping[key])).join(", ");

  return [
    `[sample-data] parsed CSV ${path}`,
    `[sample-data] detected columns: ${headers.join(", ")}`,
    `[sample-data] column mapping: ${mappedColumns}`,
    `[sample-data] rows processed=${totalRows}, rows skipped=${skippedRows}`
  ].join("\n");
}

function warnAboutYoYCoverage(bounds: {
  minStayDate: Date | null;
  maxStayDate: Date | null;
  minBookingDate: Date | null;
  maxBookingDate: Date | null;
}): void {
  const today = new Date();
  const thirtyDaysAgo = addDays(today, -30);
  const oneYearAgo = addDays(today, -365);

  const minStayDate = bounds.minStayDate;
  const maxStayDate = bounds.maxStayDate;

  if (!minStayDate || !maxStayDate || maxStayDate < thirtyDaysAgo || minStayDate > oneYearAgo) {
    console.warn("Sample data may not include last-year coverage; YoY will show zeros.");
  }

  const bookingCoverage = [
    bounds.minBookingDate ? dateOnly(bounds.minBookingDate) : "n/a",
    bounds.maxBookingDate ? dateOnly(bounds.maxBookingDate) : "n/a"
  ];
  const stayCoverage = [
    bounds.minStayDate ? dateOnly(bounds.minStayDate) : "n/a",
    bounds.maxStayDate ? dateOnly(bounds.maxStayDate) : "n/a"
  ];

  console.log(
    `[sample-data] coverage stay=${stayCoverage[0]}..${stayCoverage[1]} booking=${bookingCoverage[0]}..${bookingCoverage[1]}`
  );
}

async function parseSampleCsv(path: string): Promise<ParsedCsv> {
  const content = await readFile(path, "utf-8");
  const rows = parseCsv(content);

  if (rows.length === 0) {
    throw new Error(`Sample CSV is empty: ${path}`);
  }

  const headers = rows[0].map((header) => normalizeText(header));
  const normalizedHeaders = headers.map(normalizeHeader);
  const columnIndexes = {} as Record<ColumnKey, number | null>;
  const mappingSummary = {} as Record<ColumnKey, string | null>;

  for (const key of ORDERED_COLUMN_KEYS) {
    const index = chooseColumnIndex(normalizedHeaders, FIELD_ALIASES[key]);
    columnIndexes[key] = index;
    mappingSummary[key] = index === null ? null : headers[index];
  }

  const listingNamesById = new Map<string, string>();
  const reservations: HostawayReservation[] = [];
  let skippedRows = 0;
  let accommodationFareFallbackCount = 0;

  let minStayDate: Date | null = null;
  let maxStayDate: Date | null = null;
  let minBookingDate: Date | null = null;
  let maxBookingDate: Date | null = null;

  const getField = (row: string[], key: ColumnKey): string => {
    const index = columnIndexes[key];
    if (index === null || index >= row.length) return "";
    return normalizeText(row[index]);
  };

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.length === 1 && normalizeText(row[0]) === "") {
      continue;
    }

    const arrivalDateValue = getField(row, "arrival");
    const departureDateValue = getField(row, "departure");
    const arrivalDate = toDate(arrivalDateValue);
    const departureDate = toDate(departureDateValue);

    if (!arrivalDate || !departureDate || departureDate <= arrivalDate) {
      skippedRows += 1;
      continue;
    }

    const listingNameValue = normalizeWhitespace(getField(row, "listingName"));
    const listingIdValue = normalizeWhitespace(getField(row, "listingId"));
    const listingId = listingIdValue || `sample-${stableSlug(listingNameValue || `listing-${rowIndex}`)}`;
    const listingName = listingNameValue || `Listing ${listingId}`;
    listingNamesById.set(listingId, listingName);

    const bookingDateRaw = getField(row, "bookingCreatedDate");
    const updatedDateRaw = getField(row, "updatedDate");

    const bookingDate = toDate(bookingDateRaw) ?? toDate(arrivalDateValue) ?? arrivalDate;
    const updatedDate = toDate(updatedDateRaw) ?? bookingDate;
    const insertedOn = bookingDate.toISOString();
    const updatedOn = updatedDate.toISOString();

    if (!minBookingDate || bookingDate < minBookingDate) minBookingDate = bookingDate;
    if (!maxBookingDate || bookingDate > maxBookingDate) maxBookingDate = bookingDate;

    const stayStart = arrivalDate;
    const stayEndInclusive = addDays(departureDate, -1);
    if (!minStayDate || stayStart < minStayDate) minStayDate = stayStart;
    if (!maxStayDate || stayEndInclusive > maxStayDate) maxStayDate = stayEndInclusive;

    const nightsValue = parseNumber(getField(row, "nights"));
    const computedNights = daysBetween(arrivalDate, departureDate);
    const nights = nightsValue && nightsValue > 0 ? Math.round(nightsValue) : computedNights;

    let totalPrice = parseNumber(getField(row, "total"));
    let accommodationFare = parseNumber(getField(row, "accommodationFare"));
    const cleaningFee = parseNumber(getField(row, "cleaningFee")) ?? 0;
    const guestFee = parseNumber(getField(row, "guestFee")) ?? 0;

    if (totalPrice === null && accommodationFare !== null) {
      totalPrice = accommodationFare;
    }

    if (accommodationFare === null) {
      accommodationFare = totalPrice ?? 0;
      if ((totalPrice ?? 0) !== 0) {
        accommodationFareFallbackCount += 1;
      }
    }

    totalPrice = totalPrice ?? 0;

    const reservationIdValue = getField(row, "reservationId");
    const generatedReservationId = [
      "sample",
      listingId,
      dateOnly(arrivalDate),
      dateOnly(departureDate),
      dateOnly(bookingDate),
      String(rowIndex)
    ]
      .join("-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    const reservationId = reservationIdValue || generatedReservationId;

    const status = getField(row, "status") || "booked";
    const channel = getField(row, "channel") || "sample";
    const currency = getField(row, "currency") || process.env.TENANT_DEFAULT_CURRENCY || "GBP";

    reservations.push({
      id: reservationId,
      listingMapId: listingId,
      status,
      channel,
      insertedOn,
      arrivalDate: dateOnly(arrivalDate),
      departureDate: dateOnly(departureDate),
      nights: nights > 0 ? nights : computedNights,
      currency,
      totalPrice,
      accommodationFare,
      cleaningFee,
      guestFee,
      updatedOn,
      raw: {
        source: "sample_csv",
        rowNumber: rowIndex + 1,
        headers,
        row
      }
    });
  }

  const listings: HostawayListing[] = [...listingNamesById.entries()].map(([id, name]) => ({
    id,
    name,
    status: "active",
    timezone: env.defaultTimezone,
    tags: ["sample-data"]
  }));

  console.log(createSummaryLogMessage(path, headers, mappingSummary, rows.length - 1, skippedRows));
  console.log(
    `[sample-data] fee header mapping: cleaningFee=${mappingSummary.cleaningFee ?? "(missing -> 0)"}, guestFee=${mappingSummary.guestFee ?? "(missing -> 0)"}`
  );
  if (accommodationFareFallbackCount > 0) {
    console.log(
      `[sample-data] accommodationFare fallback applied from totalPrice for ${accommodationFareFallbackCount} rows`
    );
  }
  warnAboutYoYCoverage({ minStayDate, maxStayDate, minBookingDate, maxBookingDate });

  return {
    rows,
    listings,
    reservations
  };
}

function getCsvCacheKey(path: string): string {
  const stats = statSync(path);
  return `${path}:${stats.mtimeMs}`;
}

function getCachedParsedCsv(path: string): Promise<ParsedCsv> {
  const cacheKey = getCsvCacheKey(path);
  const cached = parsedCsvCache.get(cacheKey);

  if (cached) {
    console.log("[sample-data] using cached CSV parse");
    latestCacheKeyByPath.set(path, cacheKey);
    return cached;
  }

  const previousCacheKey = latestCacheKeyByPath.get(path);
  if (previousCacheKey && previousCacheKey !== cacheKey) {
    parsedCsvCache.delete(previousCacheKey);
  }

  const parsedPromise = parseSampleCsv(path).catch((error) => {
    parsedCsvCache.delete(cacheKey);
    if (latestCacheKeyByPath.get(path) === cacheKey) {
      latestCacheKeyByPath.delete(path);
    }
    throw error;
  });

  parsedCsvCache.set(cacheKey, parsedPromise);
  latestCacheKeyByPath.set(path, cacheKey);

  return parsedPromise;
}

class SampleHostawayGateway implements HostawayGateway {
  constructor(
    private readonly config: {
      csvPath: string;
      pageSize: number;
    }
  ) {}

  private async getParsed(): Promise<ParsedCsv> {
    return getCachedParsedCsv(this.config.csvPath);
  }

  async fetchListings(page = 1): Promise<HostawayPageResult<HostawayListing>> {
    const parsed = await this.getParsed();
    return toPage(parsed.listings, page, this.config.pageSize);
  }

  async fetchReservations(args: FetchReservationsArgs = {}): Promise<HostawayPageResult<HostawayReservation>> {
    const parsed = await this.getParsed();
    const page = args.page ?? 1;
    const filtered = applyReservationFilters(parsed.reservations, args);
    return toPage(filtered, page, this.config.pageSize);
  }

  async fetchCalendarRates(
    _listingId: string,
    _dateFrom: string,
    _dateTo: string
  ): Promise<HostawayCalendarRate[]> {
    return [];
  }
}

export function createSampleHostawayGateway(config: SampleHostawayGatewayConfig): HostawayGateway {
  return new SampleHostawayGateway({
    csvPath: config.csvPath,
    pageSize: config.pageSize ?? PAGE_SIZE
  });
}
