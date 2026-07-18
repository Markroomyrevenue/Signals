/**
 * Market-data enrichment for the Pricing Recommendations page (owner design
 * 2026-07-18).
 *
 * Market/neighborhood occupancy and price position are an ACTIVE INPUT to
 * drop sizing — they inform both the direction and the depth of a
 * recommendation — but NEVER the sole decider: floors and the anti-ratchet
 * cap always bind elsewhere. This module only produces a bounded depth
 * modifier plus honest, human-readable contribution text. Every number it
 * emits carries {value, window, source/n} — never a bare percentage.
 *
 * No live API calls happen here: every engine read is behind an injected
 * `MarketReaders` function (the adapters are built separately), and every DB
 * touch is behind an injectable store (`stores.ts`).
 */

/** The two engines the recs page enriches from. */
export type RecsEngine = "pricelabs" | "wheelhouse";

/** Cache-row kinds in `recs_market_snapshots` (one per engine read). */
export type RecsMarketSnapshotKind =
  | "pl_listing_signals"
  | "pl_neighborhood"
  | "wh_neighborhood"
  | "wh_market";

/**
 * Injected raw-read functions. All optional: an absent reader means "this
 * engine read is not wired for this client" and the context builder degrades
 * silently to the next source. Each returns the engine's raw payload
 * (`unknown`); the pure mappers in `map.ts` trim it.
 */
export type MarketReaders = {
  /** PriceLabs neighborhood data for one listing (needs the PMS name). */
  fetchPlNeighborhood?: (engineListingId: string, pms: string) => Promise<unknown>;
  /** Wheelhouse nearby-comps nightly pricing for one listing. */
  fetchWhNeighborhoodPricing?: (engineListingId: string) => Promise<unknown>;
  /** Wheelhouse nearby-comps occupancy for one listing. */
  fetchWhNeighborhoodOccupancy?: (engineListingId: string) => Promise<unknown>;
};

/** Where a listing's market context ultimately came from. */
export type MarketContextSource =
  | "engine_snapshot"
  | "pl_neighborhood"
  | "wh_neighborhood"
  | "none";

/**
 * One occupancy reading with its provenance. `value` is a FRACTION (0–1);
 * `n` is the number of per-date observations behind a neighborhood
 * aggregate (absent for single-value engine-snapshot reads, where `source`
 * is the provenance).
 */
export type MarketMetric = {
  value: number;
  window: "next30";
  source: string;
  n?: number;
};

/**
 * Where my advertised rate sits against the neighborhood median on one
 * representative date (the median-ratio date of the next-30 window, so one
 * spiked event night cannot represent the whole month).
 */
export type PricePosition = {
  myRate: number;
  neighborhoodMedian: number;
  /** myRate / neighborhoodMedian; > 1 means priced above the market. */
  ratio: number;
  /** yyyy-mm-dd the compared rates belong to. */
  date: string;
  source: string;
};

/** Per-listing market context, built once per (listing, day) by `context.ts`. */
export type MarketContext = {
  engine: RecsEngine;
  /** ISO instant the context was assembled. */
  asOf: string;
  source: MarketContextSource;
  /** Market occupancy over the next 30 days (fraction), or null. */
  marketOccNext30: MarketMetric | null;
  /** MY occupancy over the next 30 days (engine snapshot), or null. */
  myOccNext30: MarketMetric | null;
  pricePosition: PricePosition | null;
  /** Hours since the `source` data was captured; null when source is none. */
  dataAgeHours: number | null;
  /** Human-readable degradation notes ("neighborhood data unavailable (403)"). */
  notes: string[];
};

/**
 * The bounded market modifier for one night. `depthMultiplier` scales a drop
 * that the rest of the recs engine already decided to make (1 = no market
 * effect); it never creates a drop on its own and floors/caps bind after it.
 */
export type MarketFactor = {
  /** Bounded to [0.6, 1.4] — see DEPTH_MULTIPLIER_MIN/MAX in factor.ts. */
  depthMultiplier: number;
  /** True when the market is hot enough that holding beats dropping. */
  holdBias: boolean;
  /** Plain-English text that ALWAYS states the numbers + windows used. */
  contribution: string;
  /** The verbatim numbers the rules consumed (for the UI + reproducibility). */
  inputs: Record<string, number | boolean | string | null>;
  source: MarketContextSource;
};

/** The no-signal factor: multiplier 1, no hold bias, honest empty text. */
export function neutralMarketFactor(source: MarketContextSource = "none"): MarketFactor {
  return {
    depthMultiplier: 1,
    holdBias: false,
    contribution: "no market signal available",
    inputs: {},
    source
  };
}
