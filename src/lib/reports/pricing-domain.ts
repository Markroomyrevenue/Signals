import type {
  PricingCalendarBaseSource,
  PricingCalendarMarketDataStatus,
  PricingConfidence
} from "@/lib/reports/pricing-calendar-types";

export type PricingAnchorSource =
  | "listing_history"
  | "group_peer_set"
  | "area_peer_set"
  | "portfolio_peer_set"
  | "live_rate_fallback"
  | "insufficient_data";

export type PricingAnchorCandidate = {
  listingId: string;
  tags: string[];
  areaKey: string;
  bedroomCount: number | null;
  historyAdr: number | null;
  historyNights: number;
};

type ListingForPricingDomain = {
  name: string;
  city: string | null;
  address: string | null;
  publicAddress: string | null;
  tags?: string[];
  timezone?: string;
  bedroomsNumber: number | null;
};

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function isCustomGroupTag(tag: string): boolean {
  return normalizeTag(tag).startsWith("group:");
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundTo2((sorted[midpoint - 1] + sorted[midpoint]) / 2);
  }

  return roundTo2(sorted[midpoint] ?? 0);
}

function tagOverlapCount(subjectTags: string[], candidateTags: string[], customOnly: boolean): number {
  const subjectSet = new Set(
    subjectTags
      .map(normalizeTag)
      .filter((tag) => (customOnly ? isCustomGroupTag(tag) : tag.length > 0))
  );
  if (subjectSet.size === 0) return 0;

  let overlap = 0;
  for (const tag of candidateTags.map(normalizeTag)) {
    if (customOnly && !isCustomGroupTag(tag)) continue;
    if (subjectSet.has(tag)) {
      overlap += 1;
    }
  }

  return overlap;
}

function sizeDifferenceScore(subjectBedrooms: number | null, candidateBedrooms: number | null): number {
  if (subjectBedrooms === null || candidateBedrooms === null) return 0;
  const difference = Math.abs(subjectBedrooms - candidateBedrooms);
  if (difference === 0) return 6;
  if (difference === 1) return 3;
  if (difference === 2) return 1;
  return 0;
}

function areaMatchScore(subjectAreaKey: string, candidateAreaKey: string): number {
  if (!subjectAreaKey || subjectAreaKey === "unknown" || !candidateAreaKey || candidateAreaKey === "unknown") {
    return 0;
  }
  return subjectAreaKey === candidateAreaKey ? 8 : 0;
}

function scorePricingCandidate(params: {
  listingTags: string[];
  listingAreaKey: string;
  listingBedroomCount: number | null;
  candidate: PricingAnchorCandidate;
}): number {
  const sharedCustomGroups = tagOverlapCount(params.listingTags, params.candidate.tags, true);
  const sharedTags = tagOverlapCount(params.listingTags, params.candidate.tags, false);

  return (
    sharedCustomGroups * 6 +
    sharedTags * 2 +
    areaMatchScore(params.listingAreaKey, params.candidate.areaKey) +
    sizeDifferenceScore(params.listingBedroomCount, params.candidate.bedroomCount)
  );
}

export function resolvePricingCalendarCellState(
  bookedRate: number | null,
  available: boolean | null
): "booked" | "available" | "unavailable" | "unknown" {
  if (bookedRate !== null) return "booked";
  if (available === false) return "unavailable";
  if (available === true) return "available";
  return "unknown";
}

export function pricingConfidenceFromMarketContext(
  comparableCount: number,
  baseSource: PricingCalendarBaseSource
): PricingConfidence {
  if (baseSource === "manual_override") return "high";
  if (baseSource === "market_comparable_daily" && comparableCount >= 4) return "high";
  if (baseSource === "market_comparable_daily" || baseSource === "market_comparable_summary") return "medium";
  return "low";
}

export function resolvePricingCalendarMarketData(params: {
  hasMarketContext: boolean;
  hasResolvableLocation: boolean;
  basePriceValue: number | null;
}): { status: PricingCalendarMarketDataStatus; message: string } {
  if (params.hasMarketContext) {
    return {
      status: "cached_market_data",
      message: "Using the stored market snapshot with comparable pricing context for this listing."
    };
  }

  if (params.basePriceValue !== null) {
    return {
      status: "fallback_pricing",
      message: params.hasResolvableLocation
        ? "No stored market snapshot is available for this listing yet, so the recommendation falls back to overrides, listing history, and live-rate context where possible."
        : "This listing is using fallback pricing from overrides or listing history because a resolvable market location is not available yet."
    };
  }

  return {
    status: "needs_setup",
    message: params.hasResolvableLocation
      ? "No stored market snapshot or historical fallback is available for this listing yet. Add a manual base price to guide recommendations while the cache catches up."
      : "Add a resolvable location or a manual base price before relying on future recommendations for this listing."
  };
}

export function resolvePricingAdjustmentPct(params: {
  daysUntilPeriodStart: number;
  currentOccupancy: number | null;
  referenceOccupancy: number | null;
}): number | null {
  if (params.currentOccupancy === null || params.referenceOccupancy === null) {
    return null;
  }

  const occupancyGap = params.currentOccupancy - params.referenceOccupancy;
  let adjustmentPct = 0;

  if (occupancyGap <= -20) adjustmentPct -= 10;
  else if (occupancyGap <= -10) adjustmentPct -= 5;
  else if (occupancyGap >= 20) adjustmentPct += 10;
  else if (occupancyGap >= 10) adjustmentPct += 5;

  if (params.daysUntilPeriodStart <= 14 && occupancyGap < -5) {
    adjustmentPct -= 5;
  }

  if (params.daysUntilPeriodStart >= 60 && occupancyGap > 5) {
    adjustmentPct += 5;
  }

  return clamp(adjustmentPct, -15, 15);
}

export function resolvePricingAnchor(params: {
  listingId: string;
  listingTags: string[];
  listingAreaKey: string;
  listingBedroomCount: number | null;
  ownHistoryAdr: number | null;
  ownHistoryNights: number;
  liveRate: number | null;
  candidates: PricingAnchorCandidate[];
}): {
  anchorRate: number | null;
  areaAverageRate: number | null;
  historicalFloor: number | null;
  anchorSource: PricingAnchorSource;
  confidence: PricingConfidence;
  notePrefix: string;
} {
  if (params.ownHistoryAdr !== null && params.ownHistoryNights >= 7) {
    return {
      anchorRate: roundTo2(params.ownHistoryAdr),
      areaAverageRate: roundTo2(params.ownHistoryAdr),
      historicalFloor: roundTo2(params.ownHistoryAdr),
      anchorSource: "listing_history",
      confidence: params.ownHistoryNights >= 14 ? "high" : "medium",
      notePrefix: "Using this listing's short-stay ADR from last year as the anchor."
    };
  }

  const comparableCandidates = params.candidates
    .filter((candidate) => candidate.listingId !== params.listingId && candidate.historyAdr !== null && candidate.historyNights >= 3)
    .map((candidate) => ({
      ...candidate,
      score: scorePricingCandidate({
        listingTags: params.listingTags,
        listingAreaKey: params.listingAreaKey,
        listingBedroomCount: params.listingBedroomCount,
        candidate
      })
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.historyNights !== left.historyNights) return right.historyNights - left.historyNights;
      return (right.historyAdr ?? 0) - (left.historyAdr ?? 0);
    });

  const groupedCandidates = comparableCandidates.filter((candidate) => {
    const sharedCustomGroups = tagOverlapCount(params.listingTags, candidate.tags, true);
    if (sharedCustomGroups > 0) return true;
    return tagOverlapCount(params.listingTags, candidate.tags, false) > 0;
  });

  const groupedMedian = median(groupedCandidates.slice(0, 9).flatMap((candidate) => (candidate.historyAdr === null ? [] : [candidate.historyAdr])));
  const areaSizedCandidates = comparableCandidates.filter((candidate) => {
    if (params.listingAreaKey === "unknown" || candidate.areaKey !== params.listingAreaKey) return false;
    if (params.listingBedroomCount === null || candidate.bedroomCount === null) return true;
    return Math.abs(candidate.bedroomCount - params.listingBedroomCount) <= 1;
  });
  const areaCandidates = comparableCandidates.filter((candidate) => params.listingAreaKey !== "unknown" && candidate.areaKey === params.listingAreaKey);
  const areaAverageRate = median(
    (areaSizedCandidates.length > 0 ? areaSizedCandidates : areaCandidates)
      .slice(0, 9)
      .flatMap((candidate) => (candidate.historyAdr === null ? [] : [candidate.historyAdr]))
  );

  if (groupedMedian !== null) {
    return {
      anchorRate: groupedMedian,
      areaAverageRate,
      historicalFloor: groupedMedian,
      anchorSource: "group_peer_set",
      confidence: groupedCandidates.length >= 3 ? "medium" : "low",
      notePrefix: "No strong short-stay history yet, so the anchor falls back to similar properties in this client's grouped portfolio."
    };
  }

  if (areaAverageRate !== null) {
    return {
      anchorRate: areaAverageRate,
      areaAverageRate,
      historicalFloor: areaAverageRate,
      anchorSource: "area_peer_set",
      confidence: areaCandidates.length >= 3 ? "medium" : "low",
      notePrefix: "No direct short-stay history yet, so the anchor uses nearby portfolio properties with a similar size profile."
    };
  }

  if (params.ownHistoryAdr !== null && params.ownHistoryNights > 0) {
    return {
      anchorRate: roundTo2(params.ownHistoryAdr),
      areaAverageRate,
      historicalFloor: roundTo2(params.ownHistoryAdr),
      anchorSource: "listing_history",
      confidence: "low",
      notePrefix: "Using limited short-stay history for this listing because there are not enough grouped peer matches yet."
    };
  }

  const portfolioMedian = median(comparableCandidates.slice(0, 9).flatMap((candidate) => (candidate.historyAdr === null ? [] : [candidate.historyAdr])));
  if (portfolioMedian !== null) {
    return {
      anchorRate: portfolioMedian,
      areaAverageRate,
      historicalFloor: portfolioMedian,
      anchorSource: "portfolio_peer_set",
      confidence: comparableCandidates.length >= 5 ? "medium" : "low",
      notePrefix: "No direct history yet, so the anchor falls back to the broader client portfolio median."
    };
  }

  if (params.liveRate !== null) {
    return {
      anchorRate: roundTo2(params.liveRate),
      areaAverageRate,
      historicalFloor: null,
      anchorSource: "live_rate_fallback",
      confidence: "low",
      notePrefix: "History is still thin, so the current live rate is acting as a temporary anchor."
    };
  }

  return {
    anchorRate: null,
    areaAverageRate,
    historicalFloor: null,
    anchorSource: "insufficient_data",
    confidence: "low",
    notePrefix: "Not enough internal history is available yet to generate a pricing anchor."
  };
}

function titleCaseWords(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function cityFromAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value
    .split(",")
    .map((part) => part.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, "").trim())
    .filter(Boolean);

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] ?? "";
    if (/^(uk|united kingdom|scotland|england|wales|northern ireland)$/i.test(part)) continue;
    if (!/[a-z]/i.test(part)) continue;
    if (/\d/.test(part) && part.split(" ").length <= 2) continue;
    return titleCaseWords(part);
  }

  return null;
}

function normalizeAreaKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function deriveCityFromListing(listing: ListingForPricingDomain): string {
  if (listing.city) {
    return titleCaseWords(listing.city);
  }

  const addressCity = cityFromAddress(listing.publicAddress) ?? cityFromAddress(listing.address);
  if (addressCity) {
    return addressCity;
  }

  const tags = listing.tags ?? [];
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (!tag) continue;

    const matched = tag.match(/^(city|location|market|area|region)[:=\- ]+(.+)$/i);
    if (matched && matched[2]) {
      return titleCaseWords(matched[2].replace(/[_-]+/g, " ").trim());
    }
  }

  if ((listing.timezone ?? "").includes("/")) {
    const parts = listing.timezone!.split("/");
    const cityPart = parts[parts.length - 1] ?? "";
    const normalized = cityPart.replace(/[_-]+/g, " ").trim();
    if (normalized.length > 0) {
      return titleCaseWords(normalized);
    }
  }

  return "Unknown";
}

export function parseBedroomCountFromText(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (/\bstudio\b/.test(normalized)) {
    return 0;
  }

  const numericMatch = normalized.match(/\b(\d+)\s*(?:bed|beds|bedroom|bedrooms|br)\b/);
  if (numericMatch) {
    return clamp(Number.parseInt(numericMatch[1] ?? "", 10), 0, 20);
  }

  const reversedNumericMatch = normalized.match(/\b(?:bed|beds|bedroom|bedrooms)\s*[:=\- ]?\s*(\d+)\b/);
  if (reversedNumericMatch) {
    return clamp(Number.parseInt(reversedNumericMatch[1] ?? "", 10), 0, 20);
  }

  const wordToNumber = new Map<string, number>([
    ["one", 1],
    ["two", 2],
    ["three", 3],
    ["four", 4],
    ["five", 5],
    ["six", 6]
  ]);
  for (const [word, count] of wordToNumber.entries()) {
    if (new RegExp(`\\b${word}\\s+(?:bed|beds|bedroom|bedrooms)\\b`).test(normalized)) {
      return count;
    }
  }

  return null;
}

export function inferBedroomCount(listing: ListingForPricingDomain): number | null {
  if (listing.bedroomsNumber !== null) {
    return Math.max(0, Math.round(listing.bedroomsNumber));
  }

  for (const tag of listing.tags ?? []) {
    const parsed = parseBedroomCountFromText(tag);
    if (parsed !== null) return parsed;
  }

  return parseBedroomCountFromText(listing.name);
}

export function listingAreaProfile(listing: ListingForPricingDomain): { areaKey: string; areaLabel: string } {
  const areaLabel = deriveCityFromListing(listing);
  return {
    areaKey: normalizeAreaKey(areaLabel || "unknown") || "unknown",
    areaLabel
  };
}
