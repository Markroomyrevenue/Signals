/**
 * Defensibility audit prompt — passed to Claude per listing-date sample.
 * The rubric is from spec §13.3. Output is a strict JSON object so the
 * downstream parser can persist it without surprise fields.
 */

export type DefensibilityContextBundle = {
  listing: {
    id: string;
    bedrooms: number;
    capacity: number | null;
    qualityTier: string;
    trailing365dAdr: number | null;
    area: string;
  };
  date: {
    iso: string;
    dayOfWeek: string;
    month: string;
    daysOut: number;
    localEvents: string[];
  };
  ourRec: {
    rate: number;
    breakdown: Record<string, unknown>;
  };
  hostawayRate: number | null;
  marketSignals: {
    p20: number | null;
    p50: number | null;
    p80: number | null;
    sampleSize: number | null;
    forwardOccupancy: number | null;
    seasonalityIndex: number | null;
  };
  recentBookings: Array<{
    bookedAt: string;
    rate: number;
    leadTimeDays: number;
  }>;
};

export const DEFENSIBILITY_SYSTEM_PROMPT = `You are auditing a single nightly rate recommendation for a Belfast short-term rental.

Grade defensibility on this rubric:

DEFENSIBLE if all of:
  - The recommendation sits within the IQR of relevant comparables, OR is justified by a clear signal (proven seasonal lift, weekend/event premium, sustained demand spike).
  - Multiplier breakdown attributes movement to inputs that match the date/property context (e.g. a +8% July seasonality is reasonable; a +30% Tuesday in February is not).
  - The lead-time floor is engaged only when both market and property occupancy are bottom-quartile.
  - No multiplier is fighting another (e.g. demand multiplier up 10% while occupancy multiplier down 8% on the same date is a red flag).

BORDERLINE if:
  - One input dominates the recommendation in a way that's not obviously wrong but isn't well-supported (e.g. demand multiplier near its ceiling on a date with thin KeyData sample).
  - The recommendation is at or near the minimum/maximum bound, suggesting the model wanted to go further but hit a clamp.

QUESTIONABLE if any of:
  - The recommendation diverges from the comparable IQR by >25% with no clear input-side justification.
  - Two or more multipliers fight each other.
  - Sample size for a key input is below the trial guard threshold and we proceeded anyway.
  - The rec would price the listing below its like-for-like cohort minimum.

Return STRICTLY valid JSON, no prose:
{
  "verdict": "defensible" | "borderline" | "questionable",
  "confidence": 0.0..1.0,
  "key_strengths": ["..."],
  "key_concerns": ["..."],
  "most_questionable_multiplier": "base" | "seasonality" | "dow" | "demand" | "occupancy" | "leadTimeFloor" | "events" | "pace" | "none"
}`;

export function buildDefensibilityUserMessage(bundle: DefensibilityContextBundle): string {
  return `Audit this listing-date.

Listing: ${bundle.listing.id} (${bundle.listing.bedrooms}br, capacity ${bundle.listing.capacity ?? "?"}, tier=${bundle.listing.qualityTier}, trailing365 ADR=£${bundle.listing.trailing365dAdr?.toFixed(0) ?? "n/a"}, area=${bundle.listing.area})
Date: ${bundle.date.iso} (${bundle.date.dayOfWeek}, ${bundle.date.month}, ${bundle.date.daysOut}d out, events=${bundle.date.localEvents.join("|") || "none"})

Our recommendation: £${bundle.ourRec.rate.toFixed(0)}
Multiplier breakdown:
${JSON.stringify(bundle.ourRec.breakdown, null, 2)}

PriceLabs / Hostaway live rate: ${bundle.hostawayRate ? `£${bundle.hostawayRate.toFixed(0)}` : "not available"}

Market signals (KeyData):
- P20/P50/P80 of similar comparables: ${bundle.marketSignals.p20 ?? "—"} / ${bundle.marketSignals.p50 ?? "—"} / ${bundle.marketSignals.p80 ?? "—"} (n=${bundle.marketSignals.sampleSize ?? "—"})
- Forward market occupancy: ${bundle.marketSignals.forwardOccupancy === null ? "—" : `${(bundle.marketSignals.forwardOccupancy * 100).toFixed(0)}%`}
- Seasonality index for ${bundle.date.month}: ${bundle.marketSignals.seasonalityIndex?.toFixed(2) ?? "—"}

Recent bookings on this listing (last 30d):
${bundle.recentBookings.length === 0 ? "(none)" : bundle.recentBookings.map((b) => `- booked ${b.bookedAt} at £${b.rate.toFixed(0)}, ${b.leadTimeDays}d lead time`).join("\n")}

Return strict JSON per the schema.`;
}
