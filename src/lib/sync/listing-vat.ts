/**
 * Derive a listing's mandatory percent VAT rate from its Hostaway
 * `listingFeeSetting` array (carried on the raw listing JSON).
 *
 * Why this exists: Hostaway stores fees on a listing as a list of objects like
 *   { feeTitle: "VAT", amountType: "percent", amount: 20,
 *     feeAppliedPer: "base_rate", isMandatory: 1, displayInRent: 1 }
 * Some listings (e.g. the Cambridge Apartments) charge a mandatory 20% VAT;
 * most do not. Stored booking revenue is always VAT-inclusive (gross), so the
 * reports need the per-listing rate to impute and optionally strip the VAT
 * portion for the Inc/Ex-VAT toggle.
 *
 * Matching rules (deliberately conservative so a non-VAT percent fee such as a
 * service charge is never mistaken for VAT):
 *   - amountType is a percentage ("percent" / "percentage")
 *   - the fee is mandatory (always applies)
 *   - the title looks like a tax/VAT line (contains "vat" or "tax")
 * When a listing lists the VAT line more than once (Hostaway sometimes
 * duplicates it) we take the MAX rate rather than summing, so duplicates can
 * never inflate the rate (two 20% rows stay 20%, not 40%).
 *
 * Returns the rate as a number in percent (e.g. 20), or null when the listing
 * has no qualifying mandatory percent VAT fee.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPercentAmountType(value: unknown): boolean {
  return typeof value === "string" && /^perc/i.test(value.trim());
}

function isMandatory(value: unknown): boolean {
  return value === 1 || value === "1" || value === true || value === "true";
}

function looksLikeVatTitle(value: unknown): boolean {
  return typeof value === "string" && /(vat|tax)/i.test(value);
}

function toRate(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  // A VAT rate is a sane percentage. Guard against junk / 0 / out-of-range.
  if (numeric <= 0 || numeric > 100) return null;
  return numeric;
}

export function extractListingVatRatePct(rawListing: unknown): number | null {
  if (!isRecord(rawListing)) return null;
  const fees = rawListing.listingFeeSetting;
  if (!Array.isArray(fees)) return null;

  let best: number | null = null;
  for (const fee of fees) {
    if (!isRecord(fee)) continue;
    if (!isPercentAmountType(fee.amountType)) continue;
    if (!isMandatory(fee.isMandatory)) continue;
    if (!looksLikeVatTitle(fee.feeTitle)) continue;

    const rate = toRate(fee.amount);
    if (rate === null) continue;
    if (best === null || rate > best) {
      best = rate;
    }
  }

  return best;
}
