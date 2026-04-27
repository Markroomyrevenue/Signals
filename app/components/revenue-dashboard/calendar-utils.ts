import type { CSSProperties } from "react";

import type { PricingCalendarMarketDataStatus, PricingCalendarResponse } from "@/lib/reports/pricing-calendar-types";

export type PricingCalendarRow = PricingCalendarResponse["rows"][number];
export type PricingCalendarCell = PricingCalendarRow["cells"][number];
export type CalendarPropertyDraft = {
  qualityTier: PricingCalendarRow["settings"]["qualityTier"];
  basePriceOverride: string;
  minimumPriceOverride: string;
};
export type CalendarAnchorFieldState = {
  recommendedLabel: string;
  currentValueLabel: string;
  manualOverrideLabel: string;
  effectiveAnchorLabel: string;
  recommendedValue: string;
  currentValue: string;
  manualValue: string | null;
  effectiveValue: string;
  sourceLabel: string;
  sourceTone: "green" | "gold" | "blue";
  isManualOverride: boolean;
  isBlendedWithMarket: boolean;
  marketMedianText: string;
  marketRangeText: string;
  comparatorSummaryText: string;
  overrideImpactText: string;
  confidenceLabel: string;
  marketContextText: string;
};

export const CALENDAR_SETTINGS_MONTH_OPTIONS = [
  { month: 1, label: "Jan" },
  { month: 2, label: "Feb" },
  { month: 3, label: "Mar" },
  { month: 4, label: "Apr" },
  { month: 5, label: "May" },
  { month: 6, label: "Jun" },
  { month: 7, label: "Jul" },
  { month: 8, label: "Aug" },
  { month: 9, label: "Sep" },
  { month: 10, label: "Oct" },
  { month: 11, label: "Nov" },
  { month: 12, label: "Dec" }
] as const;

export const CALENDAR_SETTINGS_WEEKDAY_OPTIONS = [
  { weekday: 0, label: "Sun" },
  { weekday: 1, label: "Mon" },
  { weekday: 2, label: "Tue" },
  { weekday: 3, label: "Wed" },
  { weekday: 4, label: "Thu" },
  { weekday: 5, label: "Fri" },
  { weekday: 6, label: "Sat" }
] as const;

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 0
  }).format(Math.round(value));
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(1)}%`;
}

function formatSignedPercent(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

// Multi-unit matrix deltas are stored as integer percentages (e.g. -2, 5, 15),
// so the inspector shows them without a decimal and uses the typographic
// minus "−" so the sign reads cleanly next to numbers.
function formatSignedIntegerPercent(value: number | null): string {
  if (value === null) return "—";
  const rounded = Math.round(value);
  if (rounded > 0) return `+${rounded}%`;
  if (rounded < 0) return `\u2212${Math.abs(rounded)}%`;
  return "0%";
}

function formatSignedCurrencyDelta(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatCurrency(Math.abs(value), currency)}`;
}

function multiplierDeltaPct(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return roundTo2((value - 1) * 100);
}

function isMeaningfulMultiplier(value: number | null): boolean {
  const delta = multiplierDeltaPct(value);
  return delta !== null && Math.abs(delta) >= 0.5;
}

export function calendarDemandLevelFromMode(mode: unknown): 1 | 2 | 3 | 4 | 5 {
  if (mode === "less_sensitive") return 2;
  if (mode === "more_sensitive") return 4;
  return 3;
}

export function buildCalendarMonthAdjustments(value: unknown): Array<{ month: number; adjustmentPct: number }> {
  const defaults = CALENDAR_SETTINGS_MONTH_OPTIONS.map((item) => ({
    month: item.month,
    adjustmentPct: 0
  }));
  if (!Array.isArray(value)) return defaults;

  const byMonth = new Map<number, number>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const month = Number((item as { month?: unknown }).month);
    const adjustmentPct = Number((item as { adjustmentPct?: unknown }).adjustmentPct);
    if (!Number.isFinite(month) || !Number.isFinite(adjustmentPct)) continue;
    if (month < 1 || month > 12) continue;
    byMonth.set(Math.round(month), adjustmentPct);
  }

  return defaults.map((item) => ({
    month: item.month,
    adjustmentPct: byMonth.get(item.month) ?? 0
  }));
}

export function buildCalendarDayOfWeekAdjustments(value: unknown): Array<{ weekday: number; adjustmentPct: number }> {
  const defaults = CALENDAR_SETTINGS_WEEKDAY_OPTIONS.map((item) => ({
    weekday: item.weekday,
    adjustmentPct: 0
  }));
  if (!Array.isArray(value)) return defaults;

  const byWeekday = new Map<number, number>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const weekday = Number((item as { weekday?: unknown }).weekday);
    const adjustmentPct = Number((item as { adjustmentPct?: unknown }).adjustmentPct);
    if (!Number.isFinite(weekday) || !Number.isFinite(adjustmentPct)) continue;
    if (weekday < 0 || weekday > 6) continue;
    byWeekday.set(Math.round(weekday), adjustmentPct);
  }

  return defaults.map((item) => ({
    weekday: item.weekday,
    adjustmentPct: byWeekday.get(item.weekday) ?? 0
  }));
}

export function normalizeCalendarSettingsForm(value: Record<string, any>): Record<string, any> {
  const next = { ...value };
  const parsedDemandSensitivityLevel =
    next.demandSensitivityLevel === null || next.demandSensitivityLevel === undefined || next.demandSensitivityLevel === ""
      ? null
      : Number(next.demandSensitivityLevel);
  delete next.maximumPriceMultiplier;
  if (next.basePriceOverride === null || next.basePriceOverride === "") {
    delete next.basePriceOverride;
  }
  if (next.minimumPriceOverride === null || next.minimumPriceOverride === "") {
    delete next.minimumPriceOverride;
  }
  next.qualityTier =
    next.qualityTier === "low_scale" || next.qualityTier === "upscale" || next.qualityTier === "mid_scale"
      ? next.qualityTier
      : "mid_scale";
  next.occupancyPressureMode =
    next.occupancyPressureMode === "conservative" ||
    next.occupancyPressureMode === "aggressive" ||
    next.occupancyPressureMode === "recommended"
      ? next.occupancyPressureMode
      : "recommended";
  next.occupancyScope = next.occupancyScope === "portfolio" ? "portfolio" : "group";
  next.demandSensitivityLevel =
    parsedDemandSensitivityLevel !== null && Number.isFinite(parsedDemandSensitivityLevel)
      ? Math.max(1, Math.min(5, Math.round(parsedDemandSensitivityLevel)))
      : calendarDemandLevelFromMode(next.demandSensitivityMode);
  next.seasonalityMonthlyAdjustments = buildCalendarMonthAdjustments(next.seasonalityMonthlyAdjustments);
  next.dayOfWeekAdjustments = buildCalendarDayOfWeekAdjustments(next.dayOfWeekAdjustments);
  return next;
}

export function pricingMarketDataStatusLabel(value: PricingCalendarMarketDataStatus): string {
  switch (value) {
    case "cached_market_data":
      return "Ready";
    case "fallback_pricing":
      return "Using backup pricing";
    case "needs_setup":
      return "Setup needed";
  }
}

export function pricingMarketDataStatusTone(value: PricingCalendarMarketDataStatus): CSSProperties {
  switch (value) {
    case "cached_market_data":
      return {
        background: "rgba(31,122,77,0.1)",
        border: "1px solid rgba(22,71,51,0.14)",
        color: "var(--green-dark)"
      };
    case "fallback_pricing":
      return {
        background: "rgba(176,122,25,0.1)",
        border: "1px solid rgba(176,122,25,0.18)",
        color: "var(--mustard-dark)"
      };
    case "needs_setup":
      return {
        background: "rgba(187,75,82,0.08)",
        border: "1px solid rgba(187,75,82,0.18)",
        color: "var(--delta-negative)"
      };
  }
}

export function pricingBaseSourceLabel(value: PricingCalendarRow["basePriceSuggestion"]["source"]): string {
  switch (value) {
    case "manual_override":
      return "Manual override";
    case "market_comparable_daily":
      return "Similar homes";
    case "market_comparable_summary":
      return "Market summary";
    case "market_adr_fallback":
      return "Market ADR";
    case "listing_history_fallback":
      return "Listing history";
    case "live_rate_fallback":
      return "Live rate";
    case "insufficient_data":
      return "Not enough data";
  }
}

export function qualityTierLabel(value: PricingCalendarRow["settings"]["qualityTier"]): string {
  switch (value) {
    case "low_scale":
      return "Value";
    case "mid_scale":
      return "Standard";
    case "upscale":
      return "Premium";
  }
}

export function pricingConfidenceTone(value: PricingCalendarCell["confidence"]): "green" | "gold" | "blue" {
  if (value === "high") return "green";
  if (value === "medium") return "gold";
  return "blue";
}

export function pricingCalendarCoverageMessage(report: PricingCalendarResponse | null): {
  tone: "positive" | "warning" | "critical";
  message: string;
} | null {
  if (!report) return null;

  const { totalRows, rowsNeedingSetup, rowsUsingFallbackPricing } = report.meta.marketData;
  if (totalRows === 0) return null;

  if (rowsNeedingSetup > 0) {
    return {
      tone: "critical",
      message: `${formatInteger(rowsNeedingSetup)} listing${rowsNeedingSetup === 1 ? "" : "s"} still need a manual base price or a resolvable location before future recommendations are dependable.`
    };
  }

  if (rowsUsingFallbackPricing > 0) {
    return {
      tone: "warning",
      message: `${formatInteger(rowsUsingFallbackPricing)} listing${rowsUsingFallbackPricing === 1 ? "" : "s"} are using backup pricing because local market context is not ready yet.`
    };
  }

  return {
    tone: "positive",
    message: `Every visible listing has market context ready for pricing recommendations.`
  };
}

export function calendarDemandSignal(demandBand: 1 | 2 | 3 | 4 | 5 = 3): {
  label: string;
  background: string;
  border: string;
  accent: string;
} {
  if (demandBand <= 1) {
    return {
      label: "Low demand",
      background: "rgba(246, 216, 120, 0.38)",
      border: "rgba(191, 145, 28, 0.42)",
      accent: "#7c5d12"
    };
  }
  if (demandBand === 2) {
    return {
      label: "Soft demand",
      background: "rgba(227, 220, 129, 0.34)",
      border: "rgba(166, 151, 36, 0.38)",
      accent: "#6b6414"
    };
  }
  if (demandBand === 3) {
    return {
      label: "Steady demand",
      background: "rgba(204, 218, 132, 0.34)",
      border: "rgba(122, 147, 46, 0.36)",
      accent: "#556a1b"
    };
  }
  if (demandBand === 4) {
    return {
      label: "Firm demand",
      background: "rgba(171, 214, 150, 0.34)",
      border: "rgba(71, 140, 74, 0.34)",
      accent: "#2b6a34"
    };
  }
  return {
    label: "High demand",
    background: "rgba(54, 143, 84, 0.34)",
    border: "rgba(18, 86, 42, 0.38)",
    accent: "#123e23"
  };
}

export function calendarCellCopy(state: "booked" | "available" | "unavailable" | "unknown", demandBand: 1 | 2 | 3 | 4 | 5 = 3): {
  label: string;
  summary: string;
  background: string;
  border: string;
  accent: string;
} {
  switch (state) {
    case "booked":
      return {
        label: "Booked",
        summary: "Booked rate",
        background: "rgba(221, 226, 232, 0.72)",
        border: "rgba(128, 139, 152, 0.34)",
        accent: "#44515f"
      };
    case "available": {
      const palette = calendarDemandSignal(demandBand);
      return {
        label: "Available",
        summary: palette.label,
        background: palette.background,
        border: palette.border,
        accent: palette.accent
      };
    }
    case "unavailable":
      return {
        label: "Unavailable",
        summary: "Blocked night",
        background: "rgba(247, 231, 176, 0.34)",
        border: "rgba(180, 143, 54, 0.3)",
        accent: "#9a7318"
      };
    case "unknown":
      return {
        label: "No sync",
        summary: "Waiting for data",
        background: "rgba(211, 221, 231, 0.32)",
        border: "rgba(53, 78, 104, 0.2)",
        accent: "var(--navy-dark)"
      };
  }
}

export function buildCalendarImpactSummary(cell: PricingCalendarCell, currency: string): string[] {
  if (cell.recommendedRate === null) {
    if (cell.state === "booked") {
      return [`Booked ${cell.bookedRate !== null ? formatCurrency(cell.bookedRate, currency) : "rate unavailable"}`];
    }
    return ["Recommendation unavailable until a base price or market location is set."];
  }

  const lines: string[] = [];
  if (cell.recommendedBaseRate !== null) {
    lines.push(`Base ${formatCurrency(cell.recommendedBaseRate, currency)}`);
  }

  if (isMeaningfulMultiplier(cell.seasonalityMultiplier)) {
    lines.push(`${formatSignedPercent(multiplierDeltaPct(cell.seasonalityMultiplier))} seasonality`);
  }
  if (isMeaningfulMultiplier(cell.dayOfWeekMultiplier)) {
    lines.push(`${formatSignedPercent(multiplierDeltaPct(cell.dayOfWeekMultiplier))} day of week`);
  }
  if (isMeaningfulMultiplier(cell.marketDemandMultiplier)) {
    lines.push(`${formatSignedPercent(multiplierDeltaPct(cell.marketDemandMultiplier))} demand`);
  }

  const customLabels = new Set(["Base", "Seasonality", "DOW", "Demand", "Occupancy", "Occ mult", "Pace", "Min", "Max", "Final", "LY floor"]);
  for (const item of cell.breakdown) {
    if (item.unit !== "multiplier") continue;
    if (customLabels.has(item.label)) continue;
    if (!isMeaningfulMultiplier(item.amount)) continue;
    lines.push(`${formatSignedPercent(multiplierDeltaPct(item.amount))} ${item.label.toLowerCase()}`);
  }

  if (isMeaningfulMultiplier(cell.occupancyMultiplier)) {
    if (
      cell.multiUnitUnitsTotal !== null &&
      cell.multiUnitUnitsSold !== null &&
      cell.multiUnitOccupancyPct !== null
    ) {
      const leadDays = cell.multiUnitLeadTimeDays ?? 0;
      lines.push(
        `${formatSignedIntegerPercent(multiplierDeltaPct(cell.occupancyMultiplier))} occupancy ${Math.round(cell.multiUnitOccupancyPct)}% (${cell.multiUnitUnitsSold}/${cell.multiUnitUnitsTotal}) at ${leadDays}-day lead`
      );
    } else {
      const occupancyLabel = cell.dailyOccupancyPct !== null ? `${formatPercent(cell.dailyOccupancyPct)} occupancy` : "occupancy";
      lines.push(`${formatSignedPercent(multiplierDeltaPct(cell.occupancyMultiplier))} ${occupancyLabel}`);
    }
  }
  if (isMeaningfulMultiplier(cell.paceMultiplier)) {
    lines.push(`${formatSignedPercent(multiplierDeltaPct(cell.paceMultiplier))} pace`);
  }
  if (
    cell.historicalFloor !== null &&
    cell.recommendedRate !== null &&
    Math.abs(cell.recommendedRate - cell.historicalFloor) < 0.01 &&
    (cell.minimumSuggestedRate === null || Math.abs(cell.historicalFloor - cell.minimumSuggestedRate) > 0.01)
  ) {
    lines.push(`Held by last-year floor at ${formatCurrency(cell.historicalFloor, currency)}`);
  } else if (
    cell.minimumSuggestedRate !== null &&
    cell.recommendedRate !== null &&
    Math.abs(cell.recommendedRate - cell.minimumSuggestedRate) < 0.01
  ) {
    lines.push(`Held by minimum price at ${formatCurrency(cell.minimumSuggestedRate, currency)}`);
  }
  if (cell.maximumPrice !== null && cell.recommendedRate !== null && Math.abs(cell.recommendedRate - cell.maximumPrice) < 0.01) {
    lines.push(`Capped at ${formatCurrency(cell.maximumPrice, currency)}`);
  }

  return lines;
}

export type CalendarRationaleLine = {
  /** the existing terse line e.g. "+9% occupancy" */
  primary: string;
  /** plain-English rationale, e.g. "47% booked on this date — pulling price up" */
  rationale: string | null;
};

/**
 * Builds the same multiplier breakdown as `buildCalendarImpactSummary` but
 * pairs each line with a plain-English rationale derived from the same cell
 * fields. No external API calls — everything comes from data already loaded.
 *
 * Read-only by design: the returned strings are for display only. There is no
 * Apply button anywhere on the calendar.
 */
export function buildCalendarRationaleLines(cell: PricingCalendarCell, currency: string): CalendarRationaleLine[] {
  if (cell.recommendedRate === null) {
    if (cell.state === "booked") {
      return [
        {
          primary: `Booked ${cell.bookedRate !== null ? formatCurrency(cell.bookedRate, currency) : "rate unavailable"}`,
          rationale: "Already locked in by an existing reservation."
        }
      ];
    }
    return [
      {
        primary: "Recommendation unavailable until a base price or market location is set.",
        rationale: null
      }
    ];
  }

  const lines: CalendarRationaleLine[] = [];

  if (cell.recommendedBaseRate !== null) {
    lines.push({
      primary: `Base ${formatCurrency(cell.recommendedBaseRate, currency)}`,
      rationale: "The anchor we start from before applying market and demand factors."
    });
  }

  if (isMeaningfulMultiplier(cell.seasonalityMultiplier)) {
    const delta = multiplierDeltaPct(cell.seasonalityMultiplier);
    lines.push({
      primary: `${formatSignedPercent(delta)} seasonality`,
      rationale:
        delta !== null && delta > 0
          ? "Seasonal demand for this month historically runs above your portfolio average."
          : "Seasonal demand for this month historically runs below your portfolio average."
    });
  }

  if (isMeaningfulMultiplier(cell.dayOfWeekMultiplier)) {
    const delta = multiplierDeltaPct(cell.dayOfWeekMultiplier);
    lines.push({
      primary: `${formatSignedPercent(delta)} day of week`,
      rationale:
        delta !== null && delta > 0
          ? "Bookings on this weekday historically clear at higher rates."
          : "Bookings on this weekday historically clear at softer rates."
    });
  }

  if (isMeaningfulMultiplier(cell.marketDemandMultiplier)) {
    const delta = multiplierDeltaPct(cell.marketDemandMultiplier);
    const tier = cell.marketDemandTier;
    lines.push({
      primary: `${formatSignedPercent(delta)} demand`,
      rationale: `Local market is in the ${tier.replaceAll("_", " ")} demand band for this date.`
    });
  }

  const customLabels = new Set(["Base", "Seasonality", "DOW", "Demand", "Occupancy", "Occ mult", "Pace", "Min", "Max", "Final", "LY floor"]);
  for (const item of cell.breakdown) {
    if (item.unit !== "multiplier") continue;
    if (customLabels.has(item.label)) continue;
    if (!isMeaningfulMultiplier(item.amount)) continue;
    lines.push({
      primary: `${formatSignedPercent(multiplierDeltaPct(item.amount))} ${item.label.toLowerCase()}`,
      rationale: null
    });
  }

  if (isMeaningfulMultiplier(cell.occupancyMultiplier)) {
    const delta = multiplierDeltaPct(cell.occupancyMultiplier);
    // Multi-unit cells use a more specific rationale: the matrix lookup
    // is a 2D table so we want the user to see BOTH the occupancy AND
    // the lead-time bucket that drove the adjustment.
    if (
      cell.multiUnitUnitsTotal !== null &&
      cell.multiUnitUnitsSold !== null &&
      cell.multiUnitOccupancyPct !== null
    ) {
      const leadDays = cell.multiUnitLeadTimeDays ?? 0;
      const sold = cell.multiUnitUnitsSold;
      const total = cell.multiUnitUnitsTotal;
      const pct = Math.round(cell.multiUnitOccupancyPct);
      lines.push({
        primary: `Occupancy ${pct}% (${sold}/${total}) at ${leadDays}-day lead → ${formatSignedIntegerPercent(delta)}`,
        rationale:
          delta !== null && delta > 0
            ? `${sold} of ${total} rooms are sold for this date — pulling price up.`
            : `Only ${sold} of ${total} rooms are sold for this date — pulling price down.`
      });
    } else {
      const occPct = cell.dailyOccupancyPct;
      const occLabel = occPct !== null ? `${formatPercent(occPct)} occupancy` : "occupancy";
      let rationale: string;
      if (occPct !== null) {
        rationale =
          delta !== null && delta > 0
            ? `Based on ${formatPercent(occPct)} of comparable nights already booked — pulling price up.`
            : `Based on ${formatPercent(occPct)} of comparable nights already booked — pulling price down.`;
      } else {
        rationale =
          delta !== null && delta > 0
            ? "Comparable nights are filling — pulling price up."
            : "Comparable nights are still soft — pulling price down.";
      }
      lines.push({
        primary: `${formatSignedPercent(delta)} ${occLabel}`,
        rationale
      });
    }
  }

  if (isMeaningfulMultiplier(cell.paceMultiplier)) {
    const delta = multiplierDeltaPct(cell.paceMultiplier);
    lines.push({
      primary: `${formatSignedPercent(delta)} pace`,
      rationale:
        delta !== null && delta > 0
          ? "Bookings on this date are arriving faster than similar dates."
          : "Bookings on this date are arriving slower than similar dates."
    });
  }

  if (
    cell.historicalFloor !== null &&
    cell.recommendedRate !== null &&
    Math.abs(cell.recommendedRate - cell.historicalFloor) < 0.01 &&
    (cell.minimumSuggestedRate === null || Math.abs(cell.historicalFloor - cell.minimumSuggestedRate) > 0.01)
  ) {
    lines.push({
      primary: `Held by last-year floor at ${formatCurrency(cell.historicalFloor, currency)}`,
      rationale: "Price won't drop below what this date earned last year."
    });
  } else if (
    cell.minimumSuggestedRate !== null &&
    cell.recommendedRate !== null &&
    Math.abs(cell.recommendedRate - cell.minimumSuggestedRate) < 0.01
  ) {
    lines.push({
      primary: `Held by minimum price at ${formatCurrency(cell.minimumSuggestedRate, currency)}`,
      rationale: "The minimum-price floor is doing the work — softer factors would have pushed this lower."
    });
  }

  if (cell.maximumPrice !== null && cell.recommendedRate !== null && Math.abs(cell.recommendedRate - cell.maximumPrice) < 0.01) {
    lines.push({
      primary: `Capped at ${formatCurrency(cell.maximumPrice, currency)}`,
      rationale: "We won't recommend going higher than the cap you set."
    });
  }

  return lines;
}

/**
 * Read-only "what this means" sentence for the inspector. Always one line; no
 * action button anywhere — this is information only.
 */
export function buildCalendarSuggestedActionText(cell: PricingCalendarCell, currency: string): string | null {
  if (cell.state === "booked") {
    return "Already booked — no recommendation needed.";
  }
  if (cell.state === "unavailable" || cell.state === "unknown") {
    return null;
  }
  if (cell.recommendedRate === null) {
    return null;
  }
  if (cell.recommendedBaseRate === null) {
    return null;
  }

  const delta = cell.recommendedRate - cell.recommendedBaseRate;
  const pct = cell.adjustmentPct ?? (cell.recommendedBaseRate > 0 ? (delta / cell.recommendedBaseRate) * 100 : 0);
  const occLabel = cell.dailyOccupancyPct !== null ? `${formatPercent(cell.dailyOccupancyPct)} occupancy` : null;

  if (cell.minimumSuggestedRate !== null && Math.abs(cell.recommendedRate - cell.minimumSuggestedRate) < 0.01) {
    return `Recommendation sits at your Minimum Price (${formatCurrency(cell.minimumSuggestedRate, currency)}) — soft demand pushed it to the floor.`;
  }

  if (Math.abs(pct) < 1) {
    return `Recommendation matches your Base Price${occLabel ? ` — ${occLabel} on this date is around your typical level.` : "."}`;
  }

  if (pct >= 1) {
    return `Recommendation is ${formatSignedPercent(pct)} above Base — strong demand on this date.${occLabel ? ` (Currently ${occLabel}.)` : ""}`;
  }

  return `Recommendation is ${formatSignedPercent(pct)} below Base — softer demand on this date.${occLabel ? ` (Currently ${occLabel}.)` : ""}`;
}

export function formatCompactCalendarPrice(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "—";

  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0
    }).format(Math.round(value));
  } catch {
    return `${currency} ${Math.round(value).toLocaleString("en-GB")}`;
  }
}

export function formatCalendarOverrideInput(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(2);
}

export function buildCalendarAnchorFieldState(
  row: PricingCalendarRow,
  field: "base" | "minimum",
  currency: string
): CalendarAnchorFieldState {
  const display = field === "base" ? row.pricingAnchors.baseDisplay : row.pricingAnchors.minimumDisplay;
  const recommendedValue = field === "base" ? row.pricingAnchors.recommendedBasePrice : row.pricingAnchors.recommendedMinimumPrice;
  const currentValue = field === "base" ? row.pricingAnchors.currentBasePrice : row.pricingAnchors.currentMinimumPrice;
  const rawUserValue = field === "base" ? row.pricingAnchors.rawUserBasePrice : row.pricingAnchors.rawUserMinimumPrice;
  const effectiveValue = field === "base" ? row.pricingAnchors.effectiveBasePrice : row.pricingAnchors.effectiveMinimumPrice;
  const isManualOverride = rawUserValue !== null;
  const isBlendedWithMarket =
    rawUserValue !== null && effectiveValue !== null && Math.abs(effectiveValue - rawUserValue) >= 0.01;

  return {
    recommendedLabel: display.recommendedLabel,
    currentValueLabel: display.currentValueLabel,
    manualOverrideLabel: display.manualOverrideLabel,
    effectiveAnchorLabel: display.effectiveAnchorLabel,
    recommendedValue: formatCompactCalendarPrice(recommendedValue, currency),
    currentValue: formatCompactCalendarPrice(currentValue, currency),
    manualValue: rawUserValue !== null ? formatCompactCalendarPrice(rawUserValue, currency) : null,
    effectiveValue: formatCompactCalendarPrice(effectiveValue, currency),
    sourceLabel: !isManualOverride ? "Roomy Recommended" : isBlendedWithMarket ? "Blended with market" : "Manual override",
    sourceTone: !isManualOverride ? "green" : isBlendedWithMarket ? "blue" : "gold",
    isManualOverride,
    isBlendedWithMarket,
    marketMedianText: display.marketMedianText,
    marketRangeText: display.marketRangeText,
    comparatorSummaryText: display.comparatorSummaryText,
    overrideImpactText: display.overrideImpactText,
    confidenceLabel: display.confidenceLabel,
    marketContextText: row.pricingAnchors.marketContextSummary
  };
}

export function buildCalendarPropertyDraft(row: PricingCalendarRow): CalendarPropertyDraft {
  return {
    qualityTier: row.settings.qualityTier,
    // The inputs preload the current saved values so the user never has to infer the current state
    // from an empty field. Clearing is still allowed explicitly via backspace/delete.
    basePriceOverride: formatCalendarOverrideInput(row.pricingAnchors.currentBasePrice),
    minimumPriceOverride: formatCalendarOverrideInput(row.pricingAnchors.currentMinimumPrice)
  };
}

export function isCalendarPropertyDraftDirty(row: PricingCalendarRow, draft: CalendarPropertyDraft): boolean {
  return (
    draft.qualityTier !== row.settings.qualityTier ||
    draft.basePriceOverride.trim() !== formatCalendarOverrideInput(row.pricingAnchors.currentBasePrice) ||
    draft.minimumPriceOverride.trim() !== formatCalendarOverrideInput(row.pricingAnchors.currentMinimumPrice)
  );
}

export function calendarCellSelectionKey(listingId: string, date: string): string {
  return `${listingId}::${date}`;
}

/**
 * Group visible cells into Monday-anchored weeks for the mobile day list.
 * Returns 7-slot rows so weekday columns line up, with `null` placeholders
 * for days that fall outside the visible window (e.g. before today on the
 * first week, or beyond the end of the month).
 */
export function buildCalendarMobileWeeks(
  cells: PricingCalendarCell[],
  days: PricingCalendarResponse["days"]
): Array<{ key: string; label: string; slots: Array<{ cell: PricingCalendarCell; day: PricingCalendarResponse["days"][number] } | null> }> {
  if (!cells.length || !days.length) return [];

  const cellByDate = new Map<string, PricingCalendarCell>();
  for (const cell of cells) cellByDate.set(cell.date, cell);

  // Walk the visible days and bucket by Monday-anchored ISO week.
  const buckets = new Map<string, { weekStart: Date; entries: Array<{ cell: PricingCalendarCell; day: PricingCalendarResponse["days"][number] }> }>();
  for (const day of days) {
    const cell = cellByDate.get(day.date);
    if (!cell) continue;
    const date = new Date(`${day.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) continue;
    const utcDay = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const offsetToMonday = (utcDay + 6) % 7; // shift Sun to last
    const weekStart = new Date(date);
    weekStart.setUTCDate(date.getUTCDate() - offsetToMonday);
    const key = weekStart.toISOString().slice(0, 10);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { weekStart, entries: [] };
      buckets.set(key, bucket);
    }
    bucket.entries.push({ cell, day });
  }

  const monthFormatter = new Intl.DateTimeFormat("en-GB", { month: "short" });
  const result: Array<{ key: string; label: string; slots: Array<{ cell: PricingCalendarCell; day: PricingCalendarResponse["days"][number] } | null> }> = [];
  const sortedKeys = Array.from(buckets.keys()).sort();
  for (const key of sortedKeys) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    // 7-slot week aligned Mon..Sun
    const slots: Array<{ cell: PricingCalendarCell; day: PricingCalendarResponse["days"][number] } | null> = [null, null, null, null, null, null, null];
    for (const entry of bucket.entries) {
      const date = new Date(`${entry.day.date}T00:00:00Z`);
      const utcDay = date.getUTCDay();
      const slotIndex = (utcDay + 6) % 7; // Mon=0, Sun=6
      slots[slotIndex] = entry;
    }
    const weekEnd = new Date(bucket.weekStart);
    weekEnd.setUTCDate(bucket.weekStart.getUTCDate() + 6);
    const startMonth = monthFormatter.format(bucket.weekStart);
    const endMonth = monthFormatter.format(weekEnd);
    const label =
      startMonth === endMonth
        ? `${startMonth} ${bucket.weekStart.getUTCDate()}–${weekEnd.getUTCDate()}`
        : `${startMonth} ${bucket.weekStart.getUTCDate()} – ${endMonth} ${weekEnd.getUTCDate()}`;
    result.push({ key, label, slots });
  }
  return result;
}

export function buildCachedCalendarReportReloadOptions(
  suppressLoadingState = true
): { ignoreClientCache: true; suppressLoadingState: boolean } {
  return {
    ignoreClientCache: true,
    suppressLoadingState
  };
}
