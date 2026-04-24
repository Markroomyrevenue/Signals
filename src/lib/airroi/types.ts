export type AirRoiCurrencyMode = "native" | string;

export type AirRoiMarket = {
  country: string;
  region?: string;
  locality?: string;
  district?: string;
  fullName?: string;
};

export type AirRoiMarketFilter = Record<string, unknown>;

export type AirRoiMarketQueryRequest = {
  market: {
    country: string;
    region?: string;
    locality?: string;
    district?: string;
  };
  filter?: AirRoiMarketFilter;
  num_months?: number;
  currency?: AirRoiCurrencyMode;
};

export type AirRoiMetricSeriesPoint = {
  date: string;
  avg: number;
  p25?: number;
  p50?: number;
  p75?: number;
  p90?: number;
};

export type AirRoiMarketSummary = {
  market: AirRoiMarket;
  occupancy: number | null;
  averageDailyRate: number | null;
  revPar: number | null;
  revenue: number | null;
  bookingLeadTime: number | null;
  lengthOfStay: number | null;
  minNights: number | null;
  activeListingsCount: number | null;
};

export type AirRoiComparableListing = {
  listingId: string;
  listingName: string;
  roomType: string | null;
  location: {
    latitude: number | null;
    longitude: number | null;
    country: string | null;
    region: string | null;
    locality: string | null;
    district: string | null;
    exactLocation: boolean | null;
  };
  propertyDetails: {
    guests: number | null;
    bedrooms: number | null;
    beds: number | null;
    baths: number | null;
  };
  bookingSettings: {
    instantBook: boolean | null;
    minNights: number | null;
    cancellationPolicy: string | null;
  };
  pricingInfo: {
    currency: string | null;
    cleaningFee: number | null;
    extraGuestFee: number | null;
    singleFeeStructure: boolean | null;
  };
  ratings: {
    ratingOverall: number | null;
    numReviews: number | null;
  };
  performanceMetrics: {
    ttmAvgRate: number | null;
    ttmOccupancy: number | null;
    l90dAvgRate: number | null;
    l90dOccupancy: number | null;
    ttmAvgMinNights: number | null;
    l90dAvgMinNights: number | null;
  };
};

export type AirRoiFutureRate = {
  date: string;
  available: boolean;
  rate: number | null;
  minNights: number | null;
};

export type AirRoiComparableQuery = {
  latitude?: number;
  longitude?: number;
  address?: string;
  bedrooms?: number;
  baths?: number;
  guests?: number;
  currency?: AirRoiCurrencyMode;
};

export type AirRoiClient = {
  lookupMarket: (params: { latitude: number; longitude: number }) => Promise<AirRoiMarket | null>;
  getMarketSummary: (request: AirRoiMarketQueryRequest) => Promise<AirRoiMarketSummary | null>;
  getMarketOccupancy: (request: AirRoiMarketQueryRequest) => Promise<AirRoiMetricSeriesPoint[]>;
  getMarketAverageDailyRate: (request: AirRoiMarketQueryRequest) => Promise<AirRoiMetricSeriesPoint[]>;
  getMarketFuturePacing: (request: AirRoiMarketQueryRequest) => Promise<AirRoiMetricSeriesPoint[]>;
  getComparableListings: (query: AirRoiComparableQuery) => Promise<AirRoiComparableListing[]>;
  getListingFutureRates: (listingId: string, currency?: AirRoiCurrencyMode) => Promise<AirRoiFutureRate[]>;
};
