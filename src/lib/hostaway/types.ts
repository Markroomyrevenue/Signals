export type HostawayListing = {
  id: string;
  name: string;
  status: string;
  externalName?: string;
  timezone?: string;
  tags?: string[];
  country?: string;
  countryCode?: string;
  state?: string;
  city?: string;
  street?: string;
  address?: string;
  publicAddress?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  roomType?: string;
  propertyTypeId?: number;
  bedroomsNumber?: number;
  bathroomsNumber?: number;
  bedsNumber?: number;
  personCapacity?: number;
  guestsIncluded?: number;
  minNights?: number;
  maxNights?: number;
  cleaningFee?: number;
  currencyCode?: string;
  averageReviewRating?: number;
  thumbnailUrl?: string;
  airbnbListingUrl?: string;
  vrboListingUrl?: string;
  raw?: unknown;
};

export type HostawayReservation = {
  id: string;
  listingMapId: string;
  channel?: string;
  status: string;
  insertedOn?: string;
  confirmedOn?: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  guests?: number;
  currency: string;
  totalPrice: number;
  accommodationFare: number;
  cleaningFee?: number;
  guestFee?: number;
  taxes?: number;
  commission?: number;
  updatedOn?: string;
  raw: unknown;
};

export type HostawayCalendarRate = {
  date: string;
  available: boolean;
  minStay?: number;
  maxStay?: number;
  rate: number;
  currency: string;
  raw: unknown;
};

export type HostawayDateRange = {
  from: string;
  to: string;
};

export type FetchReservationsArgs = {
  updatedSince?: string;
  latestActivityStart?: string;
  latestActivityEnd?: string;
  afterId?: string;
  dateRange?: HostawayDateRange;
  page?: number;
};

export type HostawayPageResult<T> = {
  items: T[];
  page: number;
  hasMore: boolean;
};

export type HostawayGateway = {
  fetchListings: (page?: number) => Promise<HostawayPageResult<HostawayListing>>;
  fetchReservations: (args?: FetchReservationsArgs) => Promise<HostawayPageResult<HostawayReservation>>;
  fetchCalendarRates: (
    listingId: string,
    dateFrom: string,
    dateTo: string
  ) => Promise<HostawayCalendarRate[]>;
  fetchAccountName?: () => Promise<string | null>;
};
