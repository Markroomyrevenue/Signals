/**
 * Per-listing DATA-QUALITY check (NOT a recommendation comparison).
 *
 * The trial pricing model anchors 55% of the base price on per-listing
 * trailing 12-month ADR pulled from NightFact (see `computeTrialBase`
 * in trial-pricing.ts: `(ownAdr × 0.55) + (KD_marketP50 × 0.30) +
 * (size × 0.15)`). If that internal NightFact ADR is materially wrong
 * vs the listing's actual transacted history, every downstream
 * recommendation compounds the error.
 *
 * This module compares our internal trailing 365-day ADR + occupancy
 * (from NightFact, via the shared trailing-ADR helper) against
 * KeyData's view of the same listing's last year. Same listing, both
 * sides — apples-to-apples on data, not on pricing intent.
 *
 * IMPORTANT METHODOLOGY NOTE (cleaning fees):
 *   - Our model + PriceLabs both price the nightly rate WITHOUT the
 *     cleaning fee. A £50 cleaning fee on a 2-night stay would otherwise
 *     halve into £25/night on a 4-night stay — the per-night number is
 *     not useful as a pricing anchor.
 *   - KeyData includes cleaning fees in their reported ADR (they see
 *     the gross booking, with cleaning rolled in).
 *   - So to compare apples-to-apples we estimate per-night cleaning fee
 *     impact as `listing.cleaningFee / kdAvgStayLength` and subtract it
 *     from KD's ADR before computing the delta.
 *
 * Future feature: per-tenant / per-portfolio toggle for cleaning-fee-
 * inclusive vs exclusive pricing mode. Today the assumption is hard-
 * coded to exclusive (PL-aligned), so the adjusted KD ADR is the
 * primary comparison.
 *
 * Coverage varies by listing — KeyData only has data on listings they
 * actively track. ~50% of LF and ~100% of Stay Belfast at build time.
 * Uncovered listings drop out gracefully with `kdCoverage: false`.
 *
 * Cached at the provider layer for 7 days per listing so daily runs
 * don't blow the KeyData call budget.
 */

import type { KeyDataProvider } from "@/lib/pricing/keydata-provider";
import { loadTrailingPerListing } from "@/lib/agents/pricing-comparison/trailing-adr";

export type ListingCalibrationRow = {
  listingId: string;
  listingName: string;
  kdListingId: string | null;
  kdCoverage: boolean;
  ourAdr: number | null;
  /** KD trailing 12mo ADR as returned by the API — INCLUDES cleaning fee. */
  kdAdrRaw: number | null;
  /**
   * KD ADR with the estimated per-night cleaning fee subtracted —
   * apples-to-apples vs our (and PL's) cleaning-fee-EXCLUSIVE pricing.
   * Falls back to kdAdrRaw when cleaningFee or stayLength is missing.
   */
  kdAdrExclCleaning: number | null;
  /** Estimated per-night cleaning fee on KD's view (cleaningFee / kdAvgStayLength). */
  perNightCleaningFee: number | null;
  /** Average stay length (nights) from KD's trailing 12mo data. */
  kdAvgStayLength: number | null;
  /** Cleaning fee actually used for the adjustment (per-stay £). */
  cleaningFeeUsed: number | null;
  /**
   * Source of the cleaning fee:
   *   - "listing": Listing.cleaningFee > 0 (Stay Belfast pattern)
   *   - "portfolio_median": fell back to the tenant's portfolio median
   *     because this listing's cleaningFee was zero or null
   *     (Little Feather pattern — they don't sync cleaning fees)
   *   - null: no cleaning fee available, no adjustment applied
   */
  cleaningFeeSource: "listing" | "portfolio_median" | null;
  /**
   * (ourAdr - kdAdrExclCleaning) / kdAdrExclCleaning. The primary delta
   * surfaced in the report. Highlighted red when |delta| > 10%.
   */
  adrDeltaPct: number | null;
  /** Raw delta (no cleaning fee adjustment) — surfaced for transparency. */
  adrDeltaPctRaw: number | null;
  ourOccupancy: number | null;
  kdOccupancy: number | null;
  occDeltaPp: number | null;
  kdSampleMonths: number;
};

function extractAirbnbId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/airbnb\.com\/rooms\/(\d+)/);
  return m ? m[1] : null;
}

async function loadOwnTrailingAggregates(
  tenantId: string,
  listingIds: string[]
): Promise<Map<string, { adr: number | null; occupancy: number | null }>> {
  // Delegate to the shared helper so the calibration check uses the
  // exact same trailing-ADR / occupancy definition as the comparison
  // agent (owner spec 2026-05-19).
  const trailing = await loadTrailingPerListing(tenantId, listingIds);
  const out = new Map<string, { adr: number | null; occupancy: number | null }>();
  for (const [listingId, t] of trailing) {
    out.set(listingId, { adr: t.adr, occupancy: t.occupancy });
  }
  return out;
}

function toNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function computeListingCalibrationCheck(
  tenantId: string,
  listings: Array<{ id: string; name: string; airbnbListingUrl: string | null; cleaningFee?: unknown }>,
  provider: KeyDataProvider | null
): Promise<ListingCalibrationRow[]> {
  if (!provider || listings.length === 0) return [];
  const ourAggs = await loadOwnTrailingAggregates(
    tenantId,
    listings.map((l) => l.id)
  );
  // Portfolio median cleaning fee — used as a fallback for listings
  // that have cleaningFee=0 or null on their Listing row. Some PMs
  // (e.g. Little Feather at this point in the trial) don't sync
  // cleaning fees through Hostaway, so without this fallback the
  // adjustment would be a no-op and the calibration check would over-
  // state the delta for those listings.
  const sortedFees = listings
    .map((l) => toNumberOrNull(l.cleaningFee))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const portfolioMedianCleaningFee =
    sortedFees.length > 0 ? sortedFees[Math.floor(sortedFees.length / 2)] : null;

  const rows: ListingCalibrationRow[] = [];
  for (const l of listings) {
    const airbnbId = extractAirbnbId(l.airbnbListingUrl);
    const kdListingId = airbnbId ? `airbnb_${airbnbId}` : null;
    const own = ourAggs.get(l.id) ?? { adr: null, occupancy: null };
    let kdSummary: Awaited<ReturnType<KeyDataProvider["getListingKpiSummary"]>> = null;
    if (kdListingId) {
      try {
        kdSummary = await provider.getListingKpiSummary({ listingId: kdListingId });
      } catch (err) {
        console.warn(`[listing-calibration] ${l.name} (${kdListingId}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const kdAdr = kdSummary?.trailingAdr ?? null;
    const kdOcc = kdSummary?.trailingOccupancy ?? null;
    const kdStayLen = kdSummary?.trailingAvgStayLength ?? null;
    // Resolve which cleaning fee to use: per-listing > portfolio
    // median > none. Carrying the source through to the row lets the
    // report render an annotation when we had to fall back.
    const perListingCleaning = toNumberOrNull(l.cleaningFee);
    const cleaningFeeUsed = perListingCleaning ?? portfolioMedianCleaningFee;
    const cleaningFeeSource: ListingCalibrationRow["cleaningFeeSource"] =
      perListingCleaning !== null ? "listing" : portfolioMedianCleaningFee !== null ? "portfolio_median" : null;
    const perNightCleaningFee =
      cleaningFeeUsed !== null && kdStayLen !== null && kdStayLen > 0 ? cleaningFeeUsed / kdStayLen : null;
    const kdAdrExclCleaning =
      kdAdr !== null && perNightCleaningFee !== null && kdAdr - perNightCleaningFee > 0
        ? kdAdr - perNightCleaningFee
        : kdAdr;
    const adrDeltaRaw =
      own.adr !== null && own.adr > 0 && kdAdr !== null && kdAdr > 0 ? (own.adr - kdAdr) / kdAdr : null;
    const adrDeltaExcl =
      own.adr !== null && own.adr > 0 && kdAdrExclCleaning !== null && kdAdrExclCleaning > 0
        ? (own.adr - kdAdrExclCleaning) / kdAdrExclCleaning
        : null;
    const occDelta = own.occupancy !== null && kdOcc !== null ? own.occupancy - kdOcc : null;
    rows.push({
      listingId: l.id,
      listingName: l.name,
      kdListingId,
      kdCoverage: !!kdSummary && (kdSummary.sampleMonths ?? 0) > 0,
      ourAdr: own.adr,
      kdAdrRaw: kdAdr,
      kdAdrExclCleaning,
      perNightCleaningFee,
      kdAvgStayLength: kdStayLen,
      cleaningFeeUsed,
      cleaningFeeSource,
      adrDeltaPct: adrDeltaExcl,
      adrDeltaPctRaw: adrDeltaRaw,
      ourOccupancy: own.occupancy,
      kdOccupancy: kdOcc,
      occDeltaPp: occDelta,
      kdSampleMonths: kdSummary?.sampleMonths ?? 0
    });
  }
  return rows;
}
