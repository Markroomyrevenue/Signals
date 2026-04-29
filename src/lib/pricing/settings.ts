import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const CUSTOM_GROUP_TAG_PREFIX = "group:";

const PRICING_SCOPE_VALUES = ["portfolio", "group", "property"] as const;
const QUALITY_TIER_VALUES = ["low_scale", "mid_scale", "upscale"] as const;
const SENSITIVITY_MODE_VALUES = ["less_sensitive", "recommended", "more_sensitive"] as const;
const OCCUPANCY_SCOPE_VALUES = ["portfolio", "group", "property"] as const;
const OCCUPANCY_PRESSURE_MODE_VALUES = ["conservative", "recommended", "aggressive"] as const;
const PRICING_MODE_VALUES = ["standard", "rate_copy"] as const;

export type PricingSettingsScope = (typeof PRICING_SCOPE_VALUES)[number];
export type PricingQualityTier = (typeof QUALITY_TIER_VALUES)[number];
export type PricingSensitivityMode = (typeof SENSITIVITY_MODE_VALUES)[number];
export type PricingMode = (typeof PRICING_MODE_VALUES)[number];
export type PricingOccupancyScope = (typeof OCCUPANCY_SCOPE_VALUES)[number];
export type PricingOccupancyPressureMode = (typeof OCCUPANCY_PRESSURE_MODE_VALUES)[number];
export type PricingDemandTier = "very_low" | "low" | "normal" | "high" | "very_high";
export type PricingSettingSource = PricingSettingsScope | "default" | "local_market";
export type PricingSeasonalityAdjustment = {
  month: number;
  adjustmentPct: number;
};
export type PricingDayOfWeekAdjustment = {
  weekday: number;
  adjustmentPct: number;
};

/**
 * One row of the multi-unit lead-time × occupancy adjustment matrix.
 * `occupancyMaxPct` is the upper bound of the occupancy bucket (inclusive
 * with respect to the previous row's max). The `leadTimeAdjustmentsPct`
 * map keys are the upper-bound days of each lead-time bucket. Values are
 * percentage deltas off the base price (e.g. -8 means base × 0.92).
 *
 * The full matrix is an array of these rows in ascending occupancy order.
 * For occupancy and lead-time values that fall above the highest defined
 * bucket, the topmost / rightmost cell is used (carry-on-edge semantics).
 */
export type MultiUnitOccupancyLeadTimeRow = {
  occupancyMaxPct: number;
  leadTimeAdjustmentsPct: Record<string, number>;
};

export type MultiUnitOccupancyLeadTimeMatrix = {
  /** Lead-time bucket upper bounds in days, ascending. */
  leadTimeBuckets: number[];
  /** Adjustment rows in ascending occupancy order. */
  rows: MultiUnitOccupancyLeadTimeRow[];
};
export type PricingLocalEvent = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  adjustmentPct: number;
  dateSelectionMode?: "range" | "multiple";
  selectedDates?: string[];
};
export type PricingLeadTimeAdjustment = {
  id: string;
  minDaysBefore: number;
  maxDaysBefore: number;
  adjustmentPct: number;
};
export type PricingGapNightAdjustment = {
  gapNights: number;
  adjustmentPct: number;
};

export type PricingSettingsListingInput = {
  listingId: string;
  tags: string[];
};

export type PricingSettingsOverride = {
  basePriceOverride?: number | null;
  minimumPriceOverride?: number | null;
  qualityTier?: PricingQualityTier;
  qualityMultipliers?: Partial<Record<PricingQualityTier, number>>;
  minimumPriceFactor?: number;
  minimumPricePreferredGapPct?: number;
  minimumPriceAbsoluteGapPct?: number;
  seasonalitySensitivityMode?: PricingSensitivityMode;
  seasonalitySensitivityFactors?: Partial<Record<PricingSensitivityMode, number>>;
  seasonalityManualAdjustmentEnabled?: boolean;
  seasonalityManualAdjustmentPct?: number;
  seasonalityMonthlyAdjustments?: PricingSeasonalityAdjustment[];
  seasonalityMultiplierFloor?: number;
  seasonalityMultiplierCeiling?: number;
  dayOfWeekSensitivityMode?: PricingSensitivityMode;
  dayOfWeekSensitivityFactors?: Partial<Record<PricingSensitivityMode, number>>;
  dayOfWeekManualAdjustmentEnabled?: boolean;
  dayOfWeekManualAdjustmentPct?: number;
  dayOfWeekAdjustments?: PricingDayOfWeekAdjustment[];
  dayOfWeekMultiplierFloor?: number;
  dayOfWeekMultiplierCeiling?: number;
  demandSensitivityMode?: PricingSensitivityMode;
  demandSensitivityLevel?: 1 | 2 | 3 | 4 | 5;
  demandSensitivityFactors?: Partial<Record<PricingSensitivityMode, number>>;
  demandManualAdjustmentEnabled?: boolean;
  demandManualAdjustmentPct?: number;
  demandMultipliers?: Partial<Record<PricingDemandTier, number>>;
  occupancyScope?: PricingOccupancyScope;
  occupancyPressureMode?: PricingOccupancyPressureMode;
  paceEnabled?: boolean;
  paceMultipliers?: Partial<{
    farBehind: number;
    slightlyBehind: number;
    onPace: number;
    ahead: number;
    farAhead: number;
  }>;
  maximumPriceMultiplier?: number | null;
  hostawayPushEnabled?: boolean;
  /**
   * Pricing mode for this scope. `'standard'` runs the existing
   * multiplier-chain recommendation pipeline. `'rate_copy'` ignores all
   * multipliers and instead copies the live Hostaway rate from a SOURCE
   * listing (configured via `rateCopySourceListingId`), then applies the
   * existing multi-unit occupancy multiplier and the user's minimum
   * floor. Default `'standard'`.
   */
  pricingMode?: PricingMode;
  /**
   * For `pricingMode === 'rate_copy'`: the internal Listing.id of the
   * source listing whose live Hostaway calendar rate this listing copies
   * from. Source must be in the same tenant. Property-scope only.
   */
  rateCopySourceListingId?: string | null;
  /**
   * Master per-property gate for the daily rate-copy push job. Default
   * false. Mark flips this ON per-listing when ready for it to start
   * pushing live to Hostaway. Property-scope only — no portfolio/group
   * inheritance, so a tenant-wide ON can't accidentally arm new listings
   * before they're configured.
   */
  rateCopyPushEnabled?: boolean;
  multiUnitOccupancyLeadTimeMatrix?: MultiUnitOccupancyLeadTimeMatrix;
  multiUnitPeerSetWindowDays?: number;
  localEvents?: PricingLocalEvent[];
  lastMinuteAdjustments?: PricingLeadTimeAdjustment[];
  gapNightAdjustments?: PricingGapNightAdjustment[];
  lastYearBenchmarkFloorPct?: number | null;
  minimumNightStay?: number | null;
  roundingIncrement?: number;
};

export type PricingResolvedSettings = {
  basePriceOverride: number | null;
  minimumPriceOverride: number | null;
  qualityTier: PricingQualityTier;
  qualityMultipliers: Record<PricingQualityTier, number>;
  minimumPriceFactor: number;
  minimumPricePreferredGapPct: number;
  minimumPriceAbsoluteGapPct: number;
  seasonalitySensitivityMode: PricingSensitivityMode;
  seasonalitySensitivityFactors: Record<PricingSensitivityMode, number>;
  seasonalitySensitivityFactor: number;
  seasonalityManualAdjustmentEnabled: boolean;
  seasonalityManualAdjustmentPct: number;
  seasonalityMonthlyAdjustments: PricingSeasonalityAdjustment[];
  seasonalityMultiplierFloor: number;
  seasonalityMultiplierCeiling: number;
  dayOfWeekSensitivityMode: PricingSensitivityMode;
  dayOfWeekSensitivityFactors: Record<PricingSensitivityMode, number>;
  dayOfWeekSensitivityFactor: number;
  dayOfWeekManualAdjustmentEnabled: boolean;
  dayOfWeekManualAdjustmentPct: number;
  dayOfWeekAdjustments: PricingDayOfWeekAdjustment[];
  dayOfWeekMultiplierFloor: number;
  dayOfWeekMultiplierCeiling: number;
  demandSensitivityMode: PricingSensitivityMode;
  demandSensitivityLevel: 1 | 2 | 3 | 4 | 5;
  demandSensitivityFactors: Record<PricingSensitivityMode, number>;
  demandSensitivityFactor: number;
  demandManualAdjustmentEnabled: boolean;
  demandManualAdjustmentPct: number;
  demandMultipliers: Record<PricingDemandTier, number>;
  occupancyScope: PricingOccupancyScope;
  occupancyPressureMode: PricingOccupancyPressureMode;
  paceEnabled: boolean;
  paceMultipliers: {
    farBehind: number;
    slightlyBehind: number;
    onPace: number;
    ahead: number;
    farAhead: number;
  };
  maximumPriceMultiplier: number | null;
  hostawayPushEnabled: boolean;
  pricingMode: PricingMode;
  rateCopySourceListingId: string | null;
  rateCopyPushEnabled: boolean;
  multiUnitOccupancyLeadTimeMatrix: MultiUnitOccupancyLeadTimeMatrix;
  multiUnitPeerSetWindowDays: number;
  localEvents: PricingLocalEvent[];
  lastMinuteAdjustments: PricingLeadTimeAdjustment[];
  gapNightAdjustments: PricingGapNightAdjustment[];
  lastYearBenchmarkFloorPct: number | null;
  minimumNightStay: number | null;
  roundingIncrement: number;
};

export type PricingResolvedSettingsSources = {
  basePriceOverride: PricingSettingSource;
  minimumPriceOverride: PricingSettingSource;
  qualityTier: PricingSettingSource;
  qualityMultipliers: PricingSettingSource;
  minimumPriceFactor: PricingSettingSource;
  minimumPriceGap: PricingSettingSource;
  seasonalitySensitivityMode: PricingSettingSource;
  seasonalitySensitivityFactors: PricingSettingSource;
  seasonalityManualAdjustment: PricingSettingSource;
  seasonalityMonthlyAdjustments: PricingSettingSource;
  seasonalityBounds: PricingSettingSource;
  dayOfWeekSensitivityMode: PricingSettingSource;
  dayOfWeekSensitivityFactors: PricingSettingSource;
  dayOfWeekManualAdjustment: PricingSettingSource;
  dayOfWeekAdjustments: PricingSettingSource;
  dayOfWeekBounds: PricingSettingSource;
  demandSensitivityMode: PricingSettingSource;
  demandSensitivityLevel: PricingSettingSource;
  demandSensitivityFactors: PricingSettingSource;
  demandManualAdjustment: PricingSettingSource;
  demandMultipliers: PricingSettingSource;
  occupancyScope: PricingSettingSource;
  occupancyPressureMode: PricingSettingSource;
  paceEnabled: PricingSettingSource;
  paceMultipliers: PricingSettingSource;
  maximumPriceMultiplier: PricingSettingSource;
  pricingMode: PricingSettingSource;
  rateCopySourceListingId: PricingSettingSource;
  rateCopyPushEnabled: PricingSettingSource;
  localEvents: PricingSettingSource;
  lastMinuteAdjustments: PricingSettingSource;
  gapNightAdjustments: PricingSettingSource;
  lastYearBenchmarkFloorPct: PricingSettingSource;
  minimumNightStay: PricingSettingSource;
  roundingIncrement: PricingSettingSource;
};

export type PricingResolvedSettingsContext = {
  listingId: string;
  resolvedGroupName: string | null;
  resolvedGroupKey: string | null;
  settings: PricingResolvedSettings;
  sources: PricingResolvedSettingsSources;
};

function defaultSeasonalityMonthlyAdjustments(): PricingSeasonalityAdjustment[] {
  return Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    adjustmentPct: 0
  }));
}

function defaultDayOfWeekAdjustments(): PricingDayOfWeekAdjustment[] {
  return Array.from({ length: 7 }, (_, index) => ({
    weekday: index,
    adjustmentPct: 0
  }));
}

export const DEFAULT_PRICING_SETTINGS: PricingResolvedSettings = {
  basePriceOverride: null,
  minimumPriceOverride: null,
  qualityTier: "mid_scale",
  qualityMultipliers: {
    low_scale: 0.95,
    mid_scale: 1,
    upscale: 1.1
  },
  minimumPriceFactor: 0.7,
  minimumPricePreferredGapPct: 30,
  minimumPriceAbsoluteGapPct: 20,
  seasonalitySensitivityMode: "recommended",
  seasonalitySensitivityFactors: {
    less_sensitive: 0.5,
    recommended: 1,
    more_sensitive: 1.5
  },
  seasonalitySensitivityFactor: 1,
  seasonalityManualAdjustmentEnabled: false,
  seasonalityManualAdjustmentPct: 0,
  seasonalityMonthlyAdjustments: defaultSeasonalityMonthlyAdjustments(),
  seasonalityMultiplierFloor: 0.75,
  seasonalityMultiplierCeiling: 1.5,
  dayOfWeekSensitivityMode: "recommended",
  dayOfWeekSensitivityFactors: {
    less_sensitive: 0.5,
    recommended: 1,
    more_sensitive: 1.5
  },
  dayOfWeekSensitivityFactor: 1,
  dayOfWeekManualAdjustmentEnabled: false,
  dayOfWeekManualAdjustmentPct: 0,
  dayOfWeekAdjustments: defaultDayOfWeekAdjustments(),
  dayOfWeekMultiplierFloor: 0.85,
  dayOfWeekMultiplierCeiling: 1.2,
  demandSensitivityMode: "recommended",
  demandSensitivityLevel: 3,
  demandSensitivityFactors: {
    less_sensitive: 0.5,
    recommended: 1,
    more_sensitive: 1.5
  },
  demandSensitivityFactor: 1,
  demandManualAdjustmentEnabled: false,
  demandManualAdjustmentPct: 0,
  demandMultipliers: {
    very_low: 0.9,
    low: 0.95,
    normal: 1,
    high: 1.08,
    very_high: 1.15
  },
  occupancyScope: "group",
  occupancyPressureMode: "recommended",
  paceEnabled: false,
  paceMultipliers: {
    farBehind: 0.95,
    slightlyBehind: 0.98,
    onPace: 1,
    ahead: 1.03,
    farAhead: 1.06
  },
  maximumPriceMultiplier: null,
  hostawayPushEnabled: false,
  pricingMode: "standard",
  rateCopySourceListingId: null,
  rateCopyPushEnabled: false,
  multiUnitOccupancyLeadTimeMatrix: defaultMultiUnitOccupancyLeadTimeMatrix(),
  multiUnitPeerSetWindowDays: 90,
  localEvents: [],
  lastMinuteAdjustments: [],
  gapNightAdjustments: [],
  lastYearBenchmarkFloorPct: 95,
  minimumNightStay: null,
  roundingIncrement: 1
};

/**
 * Seeded matrix from owner's PriceLabs migration table (2026-04-27).
 *
 * Lookup contract used by the multi-unit pricing path:
 *  - Pick the row whose `occupancyMaxPct` is the smallest value >= the
 *    listing's current occupancy %. (Carry-on-edge: occupancies above 100
 *    use the topmost row.)
 *  - Within that row, pick the smallest `leadTimeBucket` >= lead-time days.
 *    (Carry-on-edge: lead times beyond the topmost bucket use it too.)
 *  - Apply the resulting integer as a percentage (e.g. -8 → ×0.92).
 */
export function defaultMultiUnitOccupancyLeadTimeMatrix(): MultiUnitOccupancyLeadTimeMatrix {
  const buckets = ["14", "30", "60", "90", "120", "150", "180"] as const;
  const rows: Array<[number, [number, number, number, number, number, number, number]]> = [
    [10,  [-15, -15, -13, -10, -10, -10, 0]],
    [20,  [-15, -15, -12, -10, -10, -5,  0]],
    [30,  [-10, -10, -10, -8,  -8,  -5,  0]],
    [40,  [-8,  -8,  -8,  -8,  -6,  0,   0]],
    [50,  [-8,  -8,  -6,  -6,  -5,  0,   10]],
    [60,  [-8,  -8,  -6,  -4,  0,   5,   15]],
    [70,  [-5,  -3,  -2,  -2,  0,   10,  20]],
    [80,  [-5,  -3,  0,   0,   10,  10,  20]],
    [90,  [0,   0,   0,   5,   15,  20,  25]],
    // 91-100 / 151-180 was blank in the source; we carry the previous +25
    // forward so a fully-booked listing pushes hardest as lead time grows.
    [100, [0,   0,   0,   5,   20,  25,  25]]
  ];
  return {
    leadTimeBuckets: buckets.map((bucket) => Number.parseInt(bucket, 10)),
    rows: rows.map(([occMax, deltas]) => ({
      occupancyMaxPct: occMax,
      leadTimeAdjustmentsPct: Object.fromEntries(buckets.map((bucket, idx) => [bucket, deltas[idx]]))
    }))
  };
}

export const PRICING_OCCUPANCY_LADDER = [
  { maxOccupancyPct: 10, multiplier: 0.9 },
  { maxOccupancyPct: 20, multiplier: 0.92 },
  { maxOccupancyPct: 30, multiplier: 0.94 },
  { maxOccupancyPct: 40, multiplier: 0.96 },
  { maxOccupancyPct: 50, multiplier: 0.98 },
  { maxOccupancyPct: 60, multiplier: 1 },
  { maxOccupancyPct: 70, multiplier: 1.02 },
  { maxOccupancyPct: 80, multiplier: 1.04 },
  { maxOccupancyPct: 90, multiplier: 1.06 },
  { maxOccupancyPct: 100, multiplier: 1.1 }
] as const;

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value instanceof Prisma.Decimal) {
    return value.toNumber();
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return undefined;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return allowed.find((candidate) => candidate === normalized);
}

function normalizeCurrencyAmount(value: number | undefined | null): number | null | undefined {
  if (value === null) return null;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return roundTo2(value);
}

function normalizeMultiplier(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return roundTo2(Math.min(max, Math.max(min, value)));
}

function normalizePercent(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return roundTo2(Math.min(max, Math.max(min, value)));
}

function normalizeDateOnly(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function normalizeDateOnlyList(value: unknown): string[] | undefined {
  const parsed = normalizeArray(value, (item) => normalizeDateOnly(item) ?? null);
  if (!parsed || parsed.length === 0) return undefined;
  return [...new Set(parsed)].sort((left, right) => left.localeCompare(right));
}

function normalizeArray<T>(value: unknown, mapper: (item: unknown, index: number) => T | null): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item, index) => mapper(item, index))
    .filter((item): item is T => item !== null);
}

function normalizeDemandSensitivityLevel(value: unknown): 1 | 2 | 3 | 4 | 5 | undefined {
  const parsed = asNumber(value);
  if (parsed === undefined) return undefined;
  return Math.max(1, Math.min(5, Math.round(parsed))) as 1 | 2 | 3 | 4 | 5;
}

function normalizeSeasonalityMonthlyAdjustments(value: unknown): PricingSeasonalityAdjustment[] | undefined {
  const parsed = normalizeArray(value, (item) => {
    if (!isRecord(item)) return null;
    const month = asNumber(item.month);
    const adjustmentPct = normalizePercent(asNumber(item.adjustmentPct), -100, 200);
    if (month === undefined || adjustmentPct === undefined) return null;
    const normalizedMonth = Math.round(month);
    if (normalizedMonth < 1 || normalizedMonth > 12) return null;
    return {
      month: normalizedMonth,
      adjustmentPct
    } satisfies PricingSeasonalityAdjustment;
  });

  if (!parsed) return undefined;

  const deduped = new Map<number, PricingSeasonalityAdjustment>();
  for (const item of parsed) deduped.set(item.month, item);
  return [...deduped.values()].sort((left, right) => left.month - right.month);
}

function normalizeDayOfWeekAdjustments(value: unknown): PricingDayOfWeekAdjustment[] | undefined {
  const parsed = normalizeArray(value, (item) => {
    if (!isRecord(item)) return null;
    const weekday = asNumber(item.weekday);
    const adjustmentPct = normalizePercent(asNumber(item.adjustmentPct), -100, 200);
    if (weekday === undefined || adjustmentPct === undefined) return null;
    const normalizedWeekday = Math.round(weekday);
    if (normalizedWeekday < 0 || normalizedWeekday > 6) return null;
    return {
      weekday: normalizedWeekday,
      adjustmentPct
    } satisfies PricingDayOfWeekAdjustment;
  });

  if (!parsed) return undefined;

  const deduped = new Map<number, PricingDayOfWeekAdjustment>();
  for (const item of parsed) deduped.set(item.weekday, item);
  return [...deduped.values()].sort((left, right) => left.weekday - right.weekday);
}

function completeSeasonalityMonthlyAdjustments(
  value: PricingSeasonalityAdjustment[] | undefined
): PricingSeasonalityAdjustment[] {
  const completed = defaultSeasonalityMonthlyAdjustments();
  for (const item of value ?? []) {
    completed[item.month - 1] = item;
  }
  return completed;
}

function completeDayOfWeekAdjustments(value: PricingDayOfWeekAdjustment[] | undefined): PricingDayOfWeekAdjustment[] {
  const completed = defaultDayOfWeekAdjustments();
  for (const item of value ?? []) {
    completed[item.weekday] = item;
  }
  return completed;
}

function demandSensitivityLevelFromMode(mode: PricingSensitivityMode): 1 | 2 | 3 | 4 | 5 {
  switch (mode) {
    case "less_sensitive":
      return 2;
    case "more_sensitive":
      return 4;
    default:
      return 3;
  }
}

function demandSensitivityFactorFromLevel(level: 1 | 2 | 3 | 4 | 5): number {
  switch (level) {
    case 1:
      return 0.4;
    case 2:
      return 0.7;
    case 4:
      return 1.35;
    case 5:
      return 1.7;
    default:
      return 1;
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.round(value));
}

/**
 * Validate and clean a stored multi-unit occupancy × lead-time matrix. We
 * don't return a fallback here — undefined means "no override at this scope",
 * which lets the scope resolver fall through to the next layer / default.
 */
function normalizeMultiUnitMatrix(value: unknown): MultiUnitOccupancyLeadTimeMatrix | undefined {
  if (!isRecord(value)) return undefined;
  const buckets = Array.isArray(value.leadTimeBuckets)
    ? value.leadTimeBuckets.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry) && entry > 0)
    : [];
  const rows = Array.isArray(value.rows)
    ? value.rows
        .filter(isRecord)
        .map((row): MultiUnitOccupancyLeadTimeRow | null => {
          const occupancyMaxPct = asNumber(row.occupancyMaxPct);
          if (occupancyMaxPct === undefined || !Number.isFinite(occupancyMaxPct)) return null;
          const adjustments = isRecord(row.leadTimeAdjustmentsPct) ? row.leadTimeAdjustmentsPct : null;
          if (!adjustments) return null;
          const cleaned: Record<string, number> = {};
          for (const [bucketKey, raw] of Object.entries(adjustments)) {
            const numeric = asNumber(raw);
            if (numeric === undefined || !Number.isFinite(numeric)) continue;
            cleaned[bucketKey] = numeric;
          }
          return { occupancyMaxPct, leadTimeAdjustmentsPct: cleaned };
        })
        .filter((row): row is MultiUnitOccupancyLeadTimeRow => row !== null)
    : [];
  if (buckets.length === 0 || rows.length === 0) return undefined;
  return { leadTimeBuckets: buckets, rows };
}

function normalizeGroupName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function customGroupKey(value: string): string {
  return normalizeGroupName(value).toLowerCase();
}

function customGroupLabel(tag: string): string {
  return normalizeGroupName(tag.slice(CUSTOM_GROUP_TAG_PREFIX.length));
}

function isCustomGroupTag(tag: string): boolean {
  return tag.trim().toLowerCase().startsWith(CUSTOM_GROUP_TAG_PREFIX);
}

export function customGroupNamesFromTags(tags: string[]): string[] {
  const unique = new Map<string, string>();

  for (const tag of tags) {
    if (!isCustomGroupTag(tag)) continue;
    const label = customGroupLabel(tag);
    if (!label) continue;
    unique.set(customGroupKey(label), label);
  }

  return [...unique.entries()]
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map((entry) => entry[1]);
}

export function resolveListingPricingGroupName(tags: string[], preferredGroupName?: string | null): string | null {
  const availableGroups = customGroupNamesFromTags(tags);
  if (availableGroups.length === 0) return null;

  const normalizedPreferred = preferredGroupName ? customGroupKey(preferredGroupName) : null;
  if (normalizedPreferred) {
    const preferredMatch = availableGroups.find((groupName) => customGroupKey(groupName) === normalizedPreferred);
    if (preferredMatch) return preferredMatch;
  }

  return availableGroups[0] ?? null;
}

function readNestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  return isRecord(value) ? value : {};
}

export function parsePricingSettingsOverride(raw: Prisma.JsonValue | null | undefined): PricingSettingsOverride {
  if (!isRecord(raw)) return {};

  const qualityMultipliersRecord = readNestedRecord(raw, "qualityMultipliers");
  const seasonalityFactorsRecord = readNestedRecord(raw, "seasonalitySensitivityFactors");
  const dayOfWeekFactorsRecord = readNestedRecord(raw, "dayOfWeekSensitivityFactors");
  const demandFactorsRecord = readNestedRecord(raw, "demandSensitivityFactors");
  const demandMultipliersRecord = readNestedRecord(raw, "demandMultipliers");
  const paceMultipliersRecord = readNestedRecord(raw, "paceMultipliers");

  return {
    basePriceOverride: normalizeCurrencyAmount(asNumber(raw.basePriceOverride)),
    minimumPriceOverride: normalizeCurrencyAmount(asNumber(raw.minimumPriceOverride)),
    qualityTier: asEnum(raw.qualityTier, QUALITY_TIER_VALUES),
    qualityMultipliers: {
      low_scale: normalizeMultiplier(
        asNumber(qualityMultipliersRecord.low_scale ?? qualityMultipliersRecord.lowScale ?? raw.qualityMultiplierLowScale),
        0.5,
        2
      ),
      mid_scale: normalizeMultiplier(
        asNumber(qualityMultipliersRecord.mid_scale ?? qualityMultipliersRecord.midScale ?? raw.qualityMultiplierMidScale),
        0.5,
        2
      ),
      upscale: normalizeMultiplier(
        asNumber(qualityMultipliersRecord.upscale ?? qualityMultipliersRecord.upScale ?? raw.qualityMultiplierUpscale),
        0.5,
        2
      )
    },
    minimumPriceFactor: normalizeMultiplier(asNumber(raw.minimumPriceFactor), 0.1, 0.95),
    minimumPricePreferredGapPct: normalizePercent(asNumber(raw.minimumPricePreferredGapPct), 0, 95),
    minimumPriceAbsoluteGapPct: normalizePercent(asNumber(raw.minimumPriceAbsoluteGapPct), 0, 95),
    seasonalitySensitivityMode: asEnum(raw.seasonalitySensitivityMode, SENSITIVITY_MODE_VALUES),
    seasonalitySensitivityFactors: {
      less_sensitive: normalizeMultiplier(
        asNumber(seasonalityFactorsRecord.less_sensitive ?? seasonalityFactorsRecord.lessSensitive),
        0,
        3
      ),
      recommended: normalizeMultiplier(asNumber(seasonalityFactorsRecord.recommended), 0, 3),
      more_sensitive: normalizeMultiplier(
        asNumber(seasonalityFactorsRecord.more_sensitive ?? seasonalityFactorsRecord.moreSensitive),
        0,
        3
      )
    },
    seasonalityManualAdjustmentEnabled: asBoolean(raw.seasonalityManualAdjustmentEnabled),
    seasonalityManualAdjustmentPct: normalizePercent(asNumber(raw.seasonalityManualAdjustmentPct), -100, 100),
    seasonalityMonthlyAdjustments: normalizeSeasonalityMonthlyAdjustments(raw.seasonalityMonthlyAdjustments),
    seasonalityMultiplierFloor: normalizeMultiplier(asNumber(raw.seasonalityMultiplierFloor), 0.25, 2),
    seasonalityMultiplierCeiling: normalizeMultiplier(asNumber(raw.seasonalityMultiplierCeiling), 0.25, 3),
    dayOfWeekSensitivityMode: asEnum(raw.dayOfWeekSensitivityMode, SENSITIVITY_MODE_VALUES),
    dayOfWeekSensitivityFactors: {
      less_sensitive: normalizeMultiplier(
        asNumber(dayOfWeekFactorsRecord.less_sensitive ?? dayOfWeekFactorsRecord.lessSensitive),
        0,
        3
      ),
      recommended: normalizeMultiplier(asNumber(dayOfWeekFactorsRecord.recommended), 0, 3),
      more_sensitive: normalizeMultiplier(
        asNumber(dayOfWeekFactorsRecord.more_sensitive ?? dayOfWeekFactorsRecord.moreSensitive),
        0,
        3
      )
    },
    dayOfWeekManualAdjustmentEnabled: asBoolean(raw.dayOfWeekManualAdjustmentEnabled),
    dayOfWeekManualAdjustmentPct: normalizePercent(asNumber(raw.dayOfWeekManualAdjustmentPct), -100, 100),
    dayOfWeekAdjustments: normalizeDayOfWeekAdjustments(raw.dayOfWeekAdjustments),
    dayOfWeekMultiplierFloor: normalizeMultiplier(asNumber(raw.dayOfWeekMultiplierFloor), 0.25, 2),
    dayOfWeekMultiplierCeiling: normalizeMultiplier(asNumber(raw.dayOfWeekMultiplierCeiling), 0.25, 3),
    demandSensitivityMode: asEnum(raw.demandSensitivityMode, SENSITIVITY_MODE_VALUES),
    demandSensitivityLevel: normalizeDemandSensitivityLevel(raw.demandSensitivityLevel),
    demandSensitivityFactors: {
      less_sensitive: normalizeMultiplier(
        asNumber(demandFactorsRecord.less_sensitive ?? demandFactorsRecord.lessSensitive),
        0,
        3
      ),
      recommended: normalizeMultiplier(asNumber(demandFactorsRecord.recommended), 0, 3),
      more_sensitive: normalizeMultiplier(
        asNumber(demandFactorsRecord.more_sensitive ?? demandFactorsRecord.moreSensitive),
        0,
        3
      )
    },
    demandManualAdjustmentEnabled: asBoolean(raw.demandManualAdjustmentEnabled),
    demandManualAdjustmentPct: normalizePercent(asNumber(raw.demandManualAdjustmentPct), -100, 100),
    demandMultipliers: {
      very_low: normalizeMultiplier(asNumber(demandMultipliersRecord.very_low ?? demandMultipliersRecord.veryLow), 0.5, 2),
      low: normalizeMultiplier(asNumber(demandMultipliersRecord.low), 0.5, 2),
      normal: normalizeMultiplier(asNumber(demandMultipliersRecord.normal), 0.5, 2),
      high: normalizeMultiplier(asNumber(demandMultipliersRecord.high), 0.5, 2),
      very_high: normalizeMultiplier(asNumber(demandMultipliersRecord.very_high ?? demandMultipliersRecord.veryHigh), 0.5, 2)
    },
    occupancyScope: asEnum(raw.occupancyScope, OCCUPANCY_SCOPE_VALUES),
    occupancyPressureMode: asEnum(raw.occupancyPressureMode, OCCUPANCY_PRESSURE_MODE_VALUES),
    paceEnabled: asBoolean(raw.paceEnabled),
    paceMultipliers: {
      farBehind: normalizeMultiplier(asNumber(paceMultipliersRecord.farBehind), 0.5, 2),
      slightlyBehind: normalizeMultiplier(asNumber(paceMultipliersRecord.slightlyBehind), 0.5, 2),
      onPace: normalizeMultiplier(asNumber(paceMultipliersRecord.onPace), 0.5, 2),
      ahead: normalizeMultiplier(asNumber(paceMultipliersRecord.ahead), 0.5, 2),
      farAhead: normalizeMultiplier(asNumber(paceMultipliersRecord.farAhead), 0.5, 2)
    },
    maximumPriceMultiplier: normalizeCurrencyAmount(asNumber(raw.maximumPriceMultiplier)),
    hostawayPushEnabled: typeof raw.hostawayPushEnabled === "boolean" ? raw.hostawayPushEnabled : undefined,
    multiUnitOccupancyLeadTimeMatrix: normalizeMultiUnitMatrix(raw.multiUnitOccupancyLeadTimeMatrix),
    multiUnitPeerSetWindowDays: ((): number | undefined => {
      const value = asNumber(raw.multiUnitPeerSetWindowDays);
      if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
      return Math.max(1, Math.round(value));
    })(),
    localEvents: normalizeArray(raw.localEvents, (item, index) => {
      if (!isRecord(item)) return null;
      const selectedDates = normalizeDateOnlyList(item.selectedDates);
      const startDate = normalizeDateOnly(item.startDate) ?? selectedDates?.[0];
      const endDate = normalizeDateOnly(item.endDate) ?? selectedDates?.[selectedDates.length - 1];
      const adjustmentPct = normalizePercent(asNumber(item.adjustmentPct), -100, 300);
      if (!startDate || !endDate || adjustmentPct === undefined) return null;
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `event-${index}`,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `Event ${index + 1}`,
        startDate,
        endDate,
        adjustmentPct,
        dateSelectionMode: item.dateSelectionMode === "multiple" ? "multiple" : "range",
        ...(selectedDates && selectedDates.length > 0 ? { selectedDates } : {})
      } satisfies PricingLocalEvent;
    }),
    lastMinuteAdjustments: normalizeArray(raw.lastMinuteAdjustments, (item, index) => {
      if (!isRecord(item)) return null;
      const minDaysBefore = asNumber(item.minDaysBefore);
      const maxDaysBefore = asNumber(item.maxDaysBefore);
      const adjustmentPct = normalizePercent(asNumber(item.adjustmentPct), -100, 100);
      if (minDaysBefore === undefined || maxDaysBefore === undefined || adjustmentPct === undefined) return null;
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `lead-${index}`,
        minDaysBefore: Math.max(0, Math.round(minDaysBefore)),
        maxDaysBefore: Math.max(0, Math.round(maxDaysBefore)),
        adjustmentPct
      } satisfies PricingLeadTimeAdjustment;
    }),
    gapNightAdjustments: normalizeArray(raw.gapNightAdjustments, (item) => {
      if (!isRecord(item)) return null;
      const gapNights = asNumber(item.gapNights);
      const adjustmentPct = normalizePercent(asNumber(item.adjustmentPct), -100, 100);
      if (gapNights === undefined || adjustmentPct === undefined) return null;
      return {
        gapNights: Math.max(1, Math.round(gapNights)),
        adjustmentPct
      } satisfies PricingGapNightAdjustment;
    }),
    lastYearBenchmarkFloorPct: normalizePercent(asNumber(raw.lastYearBenchmarkFloorPct), 0, 200),
    minimumNightStay: asNumber(raw.minimumNightStay) !== undefined ? Math.max(1, Math.round(asNumber(raw.minimumNightStay) ?? 1)) : undefined,
    roundingIncrement: asNumber(raw.roundingIncrement),
    pricingMode:
      raw.pricingMode === "standard" || raw.pricingMode === "rate_copy"
        ? raw.pricingMode
        : undefined,
    rateCopySourceListingId:
      typeof raw.rateCopySourceListingId === "string" && raw.rateCopySourceListingId.trim().length > 0
        ? raw.rateCopySourceListingId.trim()
        : raw.rateCopySourceListingId === null
          ? null
          : undefined,
    rateCopyPushEnabled:
      typeof raw.rateCopyPushEnabled === "boolean" ? raw.rateCopyPushEnabled : undefined
  };
}

function resolveValue<T>(
  sources: Array<{ scope: PricingSettingSource; value: T | undefined }>
): { value: T; source: PricingSettingSource } {
  for (const source of sources) {
    if (source.value !== undefined) {
      return { value: source.value, source: source.scope };
    }
  }

  throw new Error("Expected a defined pricing setting value.");
}

function resolveNullableValue<T>(
  sources: Array<{ scope: PricingSettingSource; value: T | null | undefined }>
): { value: T | null; source: PricingSettingSource } {
  for (const source of sources) {
    if (source.value !== undefined) {
      return { value: source.value ?? null, source: source.scope };
    }
  }

  return { value: null, source: "default" };
}

function mergeListValues<T>(
  sources: Array<{ scope: PricingSettingSource; value: T[] | undefined }>
): { value: T[]; source: PricingSettingSource } {
  const merged: T[] = [];
  let source: PricingSettingSource = "default";

  for (const current of [...sources].reverse()) {
    if (!current.value || current.value.length === 0) continue;
    merged.unshift(...current.value);
    source = current.scope;
  }

  return { value: merged, source };
}

export function qualityMultiplierForTier(settings: PricingResolvedSettings): number {
  return settings.qualityMultipliers[settings.qualityTier] ?? 1;
}

export function resolveDemandMultiplier(
  settings: PricingResolvedSettings,
  demandTier: PricingDemandTier
): number {
  const baseMultiplier = settings.demandMultipliers[demandTier] ?? 1;
  return roundTo2(1 + (baseMultiplier - 1) * settings.demandSensitivityFactor);
}

export function resolveSeasonalitySensitivityFactor(settings: PricingResolvedSettings): number {
  return settings.seasonalitySensitivityFactors[settings.seasonalitySensitivityMode] ?? 1;
}

export function resolveDayOfWeekSensitivityFactor(settings: PricingResolvedSettings): number {
  return settings.dayOfWeekSensitivityFactors[settings.dayOfWeekSensitivityMode] ?? 1;
}

export function resolvePaceMultiplierFromVariance(
  settings: PricingResolvedSettings,
  varianceRatio: number | null
): number {
  if (!settings.paceEnabled || varianceRatio === null || !Number.isFinite(varianceRatio)) {
    return 1;
  }

  if (varianceRatio <= 0.85) return settings.paceMultipliers.farBehind;
  if (varianceRatio <= 0.95) return settings.paceMultipliers.slightlyBehind;
  if (varianceRatio >= 1.2) return settings.paceMultipliers.farAhead;
  if (varianceRatio >= 1.1) return settings.paceMultipliers.ahead;
  return settings.paceMultipliers.onPace;
}

export function resolvePricingSettings(params: {
  portfolio: PricingSettingsOverride;
  group: PricingSettingsOverride;
  property: PricingSettingsOverride;
}): { settings: PricingResolvedSettings; sources: PricingResolvedSettingsSources } {
  const basePriceOverride = resolveNullableValue<number>([
    { scope: "property", value: params.property.basePriceOverride },
    { scope: "group", value: params.group.basePriceOverride },
    { scope: "portfolio", value: params.portfolio.basePriceOverride },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.basePriceOverride }
  ]);
  const minimumPriceOverride = resolveNullableValue<number>([
    { scope: "property", value: params.property.minimumPriceOverride },
    { scope: "group", value: params.group.minimumPriceOverride },
    { scope: "portfolio", value: params.portfolio.minimumPriceOverride },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.minimumPriceOverride }
  ]);
  const qualityTier = resolveValue<PricingQualityTier>([
    { scope: "property", value: params.property.qualityTier },
    { scope: "group", value: params.group.qualityTier },
    { scope: "portfolio", value: params.portfolio.qualityTier },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.qualityTier }
  ]);
  const qualityMultipliers = {
    low_scale: resolveValue<number>([
      { scope: "property", value: params.property.qualityMultipliers?.low_scale },
      { scope: "group", value: params.group.qualityMultipliers?.low_scale },
      { scope: "portfolio", value: params.portfolio.qualityMultipliers?.low_scale },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.qualityMultipliers.low_scale }
    ]),
    mid_scale: resolveValue<number>([
      { scope: "property", value: params.property.qualityMultipliers?.mid_scale },
      { scope: "group", value: params.group.qualityMultipliers?.mid_scale },
      { scope: "portfolio", value: params.portfolio.qualityMultipliers?.mid_scale },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.qualityMultipliers.mid_scale }
    ]),
    upscale: resolveValue<number>([
      { scope: "property", value: params.property.qualityMultipliers?.upscale },
      { scope: "group", value: params.group.qualityMultipliers?.upscale },
      { scope: "portfolio", value: params.portfolio.qualityMultipliers?.upscale },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.qualityMultipliers.upscale }
    ])
  };
  const minimumPriceFactor = resolveValue<number>([
    { scope: "property", value: params.property.minimumPriceFactor },
    { scope: "group", value: params.group.minimumPriceFactor },
    { scope: "portfolio", value: params.portfolio.minimumPriceFactor },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.minimumPriceFactor }
  ]);
  const minimumPricePreferredGapPct = resolveValue<number>([
    { scope: "property", value: params.property.minimumPricePreferredGapPct },
    { scope: "group", value: params.group.minimumPricePreferredGapPct },
    { scope: "portfolio", value: params.portfolio.minimumPricePreferredGapPct },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.minimumPricePreferredGapPct }
  ]);
  const minimumPriceAbsoluteGapPct = resolveValue<number>([
    { scope: "property", value: params.property.minimumPriceAbsoluteGapPct },
    { scope: "group", value: params.group.minimumPriceAbsoluteGapPct },
    { scope: "portfolio", value: params.portfolio.minimumPriceAbsoluteGapPct },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.minimumPriceAbsoluteGapPct }
  ]);
  const seasonalitySensitivityMode = resolveValue<PricingSensitivityMode>([
    { scope: "property", value: params.property.seasonalitySensitivityMode },
    { scope: "group", value: params.group.seasonalitySensitivityMode },
    { scope: "portfolio", value: params.portfolio.seasonalitySensitivityMode },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalitySensitivityMode }
  ]);
  const seasonalitySensitivityFactors = {
    less_sensitive: resolveValue<number>([
      { scope: "property", value: params.property.seasonalitySensitivityFactors?.less_sensitive },
      { scope: "group", value: params.group.seasonalitySensitivityFactors?.less_sensitive },
      { scope: "portfolio", value: params.portfolio.seasonalitySensitivityFactors?.less_sensitive },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalitySensitivityFactors.less_sensitive }
    ]),
    recommended: resolveValue<number>([
      { scope: "property", value: params.property.seasonalitySensitivityFactors?.recommended },
      { scope: "group", value: params.group.seasonalitySensitivityFactors?.recommended },
      { scope: "portfolio", value: params.portfolio.seasonalitySensitivityFactors?.recommended },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalitySensitivityFactors.recommended }
    ]),
    more_sensitive: resolveValue<number>([
      { scope: "property", value: params.property.seasonalitySensitivityFactors?.more_sensitive },
      { scope: "group", value: params.group.seasonalitySensitivityFactors?.more_sensitive },
      { scope: "portfolio", value: params.portfolio.seasonalitySensitivityFactors?.more_sensitive },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalitySensitivityFactors.more_sensitive }
    ])
  };
  const seasonalityManualAdjustmentEnabled = resolveValue<boolean>([
    { scope: "property", value: params.property.seasonalityManualAdjustmentEnabled },
    { scope: "group", value: params.group.seasonalityManualAdjustmentEnabled },
    { scope: "portfolio", value: params.portfolio.seasonalityManualAdjustmentEnabled },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalityManualAdjustmentEnabled }
  ]);
  const seasonalityManualAdjustmentPct = resolveValue<number>([
    { scope: "property", value: params.property.seasonalityManualAdjustmentPct },
    { scope: "group", value: params.group.seasonalityManualAdjustmentPct },
    { scope: "portfolio", value: params.portfolio.seasonalityManualAdjustmentPct },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalityManualAdjustmentPct }
  ]);
  const seasonalityMonthlyAdjustments = resolveValue<PricingSeasonalityAdjustment[]>([
    { scope: "property", value: params.property.seasonalityMonthlyAdjustments },
    { scope: "group", value: params.group.seasonalityMonthlyAdjustments },
    { scope: "portfolio", value: params.portfolio.seasonalityMonthlyAdjustments },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalityMonthlyAdjustments }
  ]);
  const seasonalityMultiplierFloor = resolveValue<number>([
    { scope: "property", value: params.property.seasonalityMultiplierFloor },
    { scope: "group", value: params.group.seasonalityMultiplierFloor },
    { scope: "portfolio", value: params.portfolio.seasonalityMultiplierFloor },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalityMultiplierFloor }
  ]);
  const seasonalityMultiplierCeiling = resolveValue<number>([
    { scope: "property", value: params.property.seasonalityMultiplierCeiling },
    { scope: "group", value: params.group.seasonalityMultiplierCeiling },
    { scope: "portfolio", value: params.portfolio.seasonalityMultiplierCeiling },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.seasonalityMultiplierCeiling }
  ]);
  const dayOfWeekSensitivityMode = resolveValue<PricingSensitivityMode>([
    { scope: "property", value: params.property.dayOfWeekSensitivityMode },
    { scope: "group", value: params.group.dayOfWeekSensitivityMode },
    { scope: "portfolio", value: params.portfolio.dayOfWeekSensitivityMode },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekSensitivityMode }
  ]);
  const dayOfWeekSensitivityFactors = {
    less_sensitive: resolveValue<number>([
      { scope: "property", value: params.property.dayOfWeekSensitivityFactors?.less_sensitive },
      { scope: "group", value: params.group.dayOfWeekSensitivityFactors?.less_sensitive },
      { scope: "portfolio", value: params.portfolio.dayOfWeekSensitivityFactors?.less_sensitive },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekSensitivityFactors.less_sensitive }
    ]),
    recommended: resolveValue<number>([
      { scope: "property", value: params.property.dayOfWeekSensitivityFactors?.recommended },
      { scope: "group", value: params.group.dayOfWeekSensitivityFactors?.recommended },
      { scope: "portfolio", value: params.portfolio.dayOfWeekSensitivityFactors?.recommended },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekSensitivityFactors.recommended }
    ]),
    more_sensitive: resolveValue<number>([
      { scope: "property", value: params.property.dayOfWeekSensitivityFactors?.more_sensitive },
      { scope: "group", value: params.group.dayOfWeekSensitivityFactors?.more_sensitive },
      { scope: "portfolio", value: params.portfolio.dayOfWeekSensitivityFactors?.more_sensitive },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekSensitivityFactors.more_sensitive }
    ])
  };
  const dayOfWeekManualAdjustmentEnabled = resolveValue<boolean>([
    { scope: "property", value: params.property.dayOfWeekManualAdjustmentEnabled },
    { scope: "group", value: params.group.dayOfWeekManualAdjustmentEnabled },
    { scope: "portfolio", value: params.portfolio.dayOfWeekManualAdjustmentEnabled },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekManualAdjustmentEnabled }
  ]);
  const dayOfWeekManualAdjustmentPct = resolveValue<number>([
    { scope: "property", value: params.property.dayOfWeekManualAdjustmentPct },
    { scope: "group", value: params.group.dayOfWeekManualAdjustmentPct },
    { scope: "portfolio", value: params.portfolio.dayOfWeekManualAdjustmentPct },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekManualAdjustmentPct }
  ]);
  const dayOfWeekAdjustments = resolveValue<PricingDayOfWeekAdjustment[]>([
    { scope: "property", value: params.property.dayOfWeekAdjustments },
    { scope: "group", value: params.group.dayOfWeekAdjustments },
    { scope: "portfolio", value: params.portfolio.dayOfWeekAdjustments },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekAdjustments }
  ]);
  const dayOfWeekMultiplierFloor = resolveValue<number>([
    { scope: "property", value: params.property.dayOfWeekMultiplierFloor },
    { scope: "group", value: params.group.dayOfWeekMultiplierFloor },
    { scope: "portfolio", value: params.portfolio.dayOfWeekMultiplierFloor },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekMultiplierFloor }
  ]);
  const dayOfWeekMultiplierCeiling = resolveValue<number>([
    { scope: "property", value: params.property.dayOfWeekMultiplierCeiling },
    { scope: "group", value: params.group.dayOfWeekMultiplierCeiling },
    { scope: "portfolio", value: params.portfolio.dayOfWeekMultiplierCeiling },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.dayOfWeekMultiplierCeiling }
  ]);
  const demandSensitivityMode = resolveValue<PricingSensitivityMode>([
    { scope: "property", value: params.property.demandSensitivityMode },
    { scope: "group", value: params.group.demandSensitivityMode },
    { scope: "portfolio", value: params.portfolio.demandSensitivityMode },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandSensitivityMode }
  ]);
  const demandSensitivityLevel = resolveValue<1 | 2 | 3 | 4 | 5>([
    { scope: "property", value: params.property.demandSensitivityLevel },
    { scope: "group", value: params.group.demandSensitivityLevel },
    { scope: "portfolio", value: params.portfolio.demandSensitivityLevel },
    { scope: demandSensitivityMode.source, value: demandSensitivityLevelFromMode(demandSensitivityMode.value) },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandSensitivityLevel }
  ]);
  const demandSensitivityFactors = {
    less_sensitive: resolveValue<number>([
      { scope: "property", value: params.property.demandSensitivityFactors?.less_sensitive },
      { scope: "group", value: params.group.demandSensitivityFactors?.less_sensitive },
      { scope: "portfolio", value: params.portfolio.demandSensitivityFactors?.less_sensitive },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandSensitivityFactors.less_sensitive }
    ]),
    recommended: resolveValue<number>([
      { scope: "property", value: params.property.demandSensitivityFactors?.recommended },
      { scope: "group", value: params.group.demandSensitivityFactors?.recommended },
      { scope: "portfolio", value: params.portfolio.demandSensitivityFactors?.recommended },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandSensitivityFactors.recommended }
    ]),
    more_sensitive: resolveValue<number>([
      { scope: "property", value: params.property.demandSensitivityFactors?.more_sensitive },
      { scope: "group", value: params.group.demandSensitivityFactors?.more_sensitive },
      { scope: "portfolio", value: params.portfolio.demandSensitivityFactors?.more_sensitive },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandSensitivityFactors.more_sensitive }
    ])
  };
  const demandManualAdjustmentEnabled = resolveValue<boolean>([
    { scope: "property", value: params.property.demandManualAdjustmentEnabled },
    { scope: "group", value: params.group.demandManualAdjustmentEnabled },
    { scope: "portfolio", value: params.portfolio.demandManualAdjustmentEnabled },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandManualAdjustmentEnabled }
  ]);
  const demandManualAdjustmentPct = resolveValue<number>([
    { scope: "property", value: params.property.demandManualAdjustmentPct },
    { scope: "group", value: params.group.demandManualAdjustmentPct },
    { scope: "portfolio", value: params.portfolio.demandManualAdjustmentPct },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandManualAdjustmentPct }
  ]);
  const demandMultipliers = {
    very_low: resolveValue<number>([
      { scope: "property", value: params.property.demandMultipliers?.very_low },
      { scope: "group", value: params.group.demandMultipliers?.very_low },
      { scope: "portfolio", value: params.portfolio.demandMultipliers?.very_low },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandMultipliers.very_low }
    ]),
    low: resolveValue<number>([
      { scope: "property", value: params.property.demandMultipliers?.low },
      { scope: "group", value: params.group.demandMultipliers?.low },
      { scope: "portfolio", value: params.portfolio.demandMultipliers?.low },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandMultipliers.low }
    ]),
    normal: resolveValue<number>([
      { scope: "property", value: params.property.demandMultipliers?.normal },
      { scope: "group", value: params.group.demandMultipliers?.normal },
      { scope: "portfolio", value: params.portfolio.demandMultipliers?.normal },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandMultipliers.normal }
    ]),
    high: resolveValue<number>([
      { scope: "property", value: params.property.demandMultipliers?.high },
      { scope: "group", value: params.group.demandMultipliers?.high },
      { scope: "portfolio", value: params.portfolio.demandMultipliers?.high },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandMultipliers.high }
    ]),
    very_high: resolveValue<number>([
      { scope: "property", value: params.property.demandMultipliers?.very_high },
      { scope: "group", value: params.group.demandMultipliers?.very_high },
      { scope: "portfolio", value: params.portfolio.demandMultipliers?.very_high },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.demandMultipliers.very_high }
    ])
  };
  const occupancyScope = resolveValue<PricingOccupancyScope>([
    { scope: "property", value: params.property.occupancyScope },
    { scope: "group", value: params.group.occupancyScope },
    { scope: "portfolio", value: params.portfolio.occupancyScope },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.occupancyScope }
  ]);
  const occupancyPressureMode = resolveValue<PricingOccupancyPressureMode>([
    { scope: "property", value: params.property.occupancyPressureMode },
    { scope: "group", value: params.group.occupancyPressureMode },
    { scope: "portfolio", value: params.portfolio.occupancyPressureMode },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.occupancyPressureMode }
  ]);
  const paceEnabled = resolveValue<boolean>([
    { scope: "property", value: params.property.paceEnabled },
    { scope: "group", value: params.group.paceEnabled },
    { scope: "portfolio", value: params.portfolio.paceEnabled },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.paceEnabled }
  ]);
  const paceMultipliers = {
    farBehind: resolveValue<number>([
      { scope: "property", value: params.property.paceMultipliers?.farBehind },
      { scope: "group", value: params.group.paceMultipliers?.farBehind },
      { scope: "portfolio", value: params.portfolio.paceMultipliers?.farBehind },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.paceMultipliers.farBehind }
    ]),
    slightlyBehind: resolveValue<number>([
      { scope: "property", value: params.property.paceMultipliers?.slightlyBehind },
      { scope: "group", value: params.group.paceMultipliers?.slightlyBehind },
      { scope: "portfolio", value: params.portfolio.paceMultipliers?.slightlyBehind },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.paceMultipliers.slightlyBehind }
    ]),
    onPace: resolveValue<number>([
      { scope: "property", value: params.property.paceMultipliers?.onPace },
      { scope: "group", value: params.group.paceMultipliers?.onPace },
      { scope: "portfolio", value: params.portfolio.paceMultipliers?.onPace },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.paceMultipliers.onPace }
    ]),
    ahead: resolveValue<number>([
      { scope: "property", value: params.property.paceMultipliers?.ahead },
      { scope: "group", value: params.group.paceMultipliers?.ahead },
      { scope: "portfolio", value: params.portfolio.paceMultipliers?.ahead },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.paceMultipliers.ahead }
    ]),
    farAhead: resolveValue<number>([
      { scope: "property", value: params.property.paceMultipliers?.farAhead },
      { scope: "group", value: params.group.paceMultipliers?.farAhead },
      { scope: "portfolio", value: params.portfolio.paceMultipliers?.farAhead },
      { scope: "default", value: DEFAULT_PRICING_SETTINGS.paceMultipliers.farAhead }
    ])
  };
  const maximumPriceMultiplier = resolveNullableValue<number>([
    { scope: "property", value: params.property.maximumPriceMultiplier },
    { scope: "group", value: params.group.maximumPriceMultiplier },
    { scope: "portfolio", value: params.portfolio.maximumPriceMultiplier },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.maximumPriceMultiplier }
  ]);
  const hostawayPushEnabled = resolveValue<boolean>([
    { scope: "property", value: params.property.hostawayPushEnabled },
    { scope: "group", value: params.group.hostawayPushEnabled },
    { scope: "portfolio", value: params.portfolio.hostawayPushEnabled },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.hostawayPushEnabled }
  ]);
  // pricingMode inherits portfolio→group→property like everything else.
  const pricingMode = resolveValue<PricingMode>([
    { scope: "property", value: params.property.pricingMode },
    { scope: "group", value: params.group.pricingMode },
    { scope: "portfolio", value: params.portfolio.pricingMode },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.pricingMode }
  ]);
  // rateCopySourceListingId + rateCopyPushEnabled are PROPERTY-SCOPE ONLY by
  // design: a portfolio default would auto-arm any new listing before its
  // source listing is configured.
  const rateCopySourceListingId = resolveNullableValue<string>([
    { scope: "property", value: params.property.rateCopySourceListingId },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.rateCopySourceListingId }
  ]);
  const rateCopyPushEnabled = resolveValue<boolean>([
    { scope: "property", value: params.property.rateCopyPushEnabled },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.rateCopyPushEnabled }
  ]);
  const multiUnitOccupancyLeadTimeMatrix = resolveValue<MultiUnitOccupancyLeadTimeMatrix>([
    { scope: "property", value: params.property.multiUnitOccupancyLeadTimeMatrix },
    { scope: "group", value: params.group.multiUnitOccupancyLeadTimeMatrix },
    { scope: "portfolio", value: params.portfolio.multiUnitOccupancyLeadTimeMatrix },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.multiUnitOccupancyLeadTimeMatrix }
  ]);
  const multiUnitPeerSetWindowDays = resolveValue<number>([
    { scope: "property", value: params.property.multiUnitPeerSetWindowDays },
    { scope: "group", value: params.group.multiUnitPeerSetWindowDays },
    { scope: "portfolio", value: params.portfolio.multiUnitPeerSetWindowDays },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.multiUnitPeerSetWindowDays }
  ]);
  const localEvents = mergeListValues<PricingLocalEvent>([
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.localEvents },
    { scope: "portfolio", value: params.portfolio.localEvents },
    { scope: "group", value: params.group.localEvents },
    { scope: "property", value: params.property.localEvents }
  ]);
  const lastMinuteAdjustments = mergeListValues<PricingLeadTimeAdjustment>([
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.lastMinuteAdjustments },
    { scope: "portfolio", value: params.portfolio.lastMinuteAdjustments },
    { scope: "group", value: params.group.lastMinuteAdjustments },
    { scope: "property", value: params.property.lastMinuteAdjustments }
  ]);
  const gapNightAdjustments = mergeListValues<PricingGapNightAdjustment>([
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.gapNightAdjustments },
    { scope: "portfolio", value: params.portfolio.gapNightAdjustments },
    { scope: "group", value: params.group.gapNightAdjustments },
    { scope: "property", value: params.property.gapNightAdjustments }
  ]);
  const lastYearBenchmarkFloorPct = resolveNullableValue<number>([
    { scope: "property", value: params.property.lastYearBenchmarkFloorPct },
    { scope: "group", value: params.group.lastYearBenchmarkFloorPct },
    { scope: "portfolio", value: params.portfolio.lastYearBenchmarkFloorPct },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.lastYearBenchmarkFloorPct }
  ]);
  const minimumNightStay = resolveNullableValue<number>([
    { scope: "property", value: params.property.minimumNightStay },
    { scope: "group", value: params.group.minimumNightStay },
    { scope: "portfolio", value: params.portfolio.minimumNightStay },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.minimumNightStay }
  ]);
  const roundingIncrement = resolveValue<number>([
    { scope: "property", value: params.property.roundingIncrement },
    { scope: "group", value: params.group.roundingIncrement },
    { scope: "portfolio", value: params.portfolio.roundingIncrement },
    { scope: "default", value: DEFAULT_PRICING_SETTINGS.roundingIncrement }
  ]);

  const settings: PricingResolvedSettings = {
    basePriceOverride: basePriceOverride.value,
    minimumPriceOverride: minimumPriceOverride.value,
    qualityTier: qualityTier.value,
    qualityMultipliers: {
      low_scale: qualityMultipliers.low_scale.value,
      mid_scale: qualityMultipliers.mid_scale.value,
      upscale: qualityMultipliers.upscale.value
    },
    minimumPriceFactor: minimumPriceFactor.value,
    minimumPricePreferredGapPct: minimumPricePreferredGapPct.value,
    minimumPriceAbsoluteGapPct: minimumPriceAbsoluteGapPct.value,
    seasonalitySensitivityMode: seasonalitySensitivityMode.value,
    seasonalitySensitivityFactors: {
      less_sensitive: seasonalitySensitivityFactors.less_sensitive.value,
      recommended: seasonalitySensitivityFactors.recommended.value,
      more_sensitive: seasonalitySensitivityFactors.more_sensitive.value
    },
    seasonalitySensitivityFactor:
      seasonalitySensitivityFactors[seasonalitySensitivityMode.value].value,
    seasonalityManualAdjustmentEnabled: seasonalityManualAdjustmentEnabled.value,
    seasonalityManualAdjustmentPct: seasonalityManualAdjustmentPct.value,
    seasonalityMonthlyAdjustments: completeSeasonalityMonthlyAdjustments(seasonalityMonthlyAdjustments.value),
    seasonalityMultiplierFloor: seasonalityMultiplierFloor.value,
    seasonalityMultiplierCeiling: seasonalityMultiplierCeiling.value,
    dayOfWeekSensitivityMode: dayOfWeekSensitivityMode.value,
    dayOfWeekSensitivityFactors: {
      less_sensitive: dayOfWeekSensitivityFactors.less_sensitive.value,
      recommended: dayOfWeekSensitivityFactors.recommended.value,
      more_sensitive: dayOfWeekSensitivityFactors.more_sensitive.value
    },
    dayOfWeekSensitivityFactor: dayOfWeekSensitivityFactors[dayOfWeekSensitivityMode.value].value,
    dayOfWeekManualAdjustmentEnabled: dayOfWeekManualAdjustmentEnabled.value,
    dayOfWeekManualAdjustmentPct: dayOfWeekManualAdjustmentPct.value,
    dayOfWeekAdjustments: completeDayOfWeekAdjustments(dayOfWeekAdjustments.value),
    dayOfWeekMultiplierFloor: dayOfWeekMultiplierFloor.value,
    dayOfWeekMultiplierCeiling: dayOfWeekMultiplierCeiling.value,
    demandSensitivityMode: demandSensitivityMode.value,
    demandSensitivityLevel: demandSensitivityLevel.value,
    demandSensitivityFactors: {
      less_sensitive: demandSensitivityFactors.less_sensitive.value,
      recommended: demandSensitivityFactors.recommended.value,
      more_sensitive: demandSensitivityFactors.more_sensitive.value
    },
    demandSensitivityFactor: demandSensitivityFactorFromLevel(demandSensitivityLevel.value),
    demandManualAdjustmentEnabled: demandManualAdjustmentEnabled.value,
    demandManualAdjustmentPct: demandManualAdjustmentPct.value,
    demandMultipliers: {
      very_low: demandMultipliers.very_low.value,
      low: demandMultipliers.low.value,
      normal: demandMultipliers.normal.value,
      high: demandMultipliers.high.value,
      very_high: demandMultipliers.very_high.value
    },
    occupancyScope: occupancyScope.value,
    occupancyPressureMode: occupancyPressureMode.value,
    paceEnabled: paceEnabled.value,
    paceMultipliers: {
      farBehind: paceMultipliers.farBehind.value,
      slightlyBehind: paceMultipliers.slightlyBehind.value,
      onPace: paceMultipliers.onPace.value,
      ahead: paceMultipliers.ahead.value,
      farAhead: paceMultipliers.farAhead.value
    },
    maximumPriceMultiplier: maximumPriceMultiplier.value,
    hostawayPushEnabled: hostawayPushEnabled.value,
    pricingMode: pricingMode.value,
    rateCopySourceListingId: rateCopySourceListingId.value,
    rateCopyPushEnabled: rateCopyPushEnabled.value,
    multiUnitOccupancyLeadTimeMatrix: multiUnitOccupancyLeadTimeMatrix.value,
    multiUnitPeerSetWindowDays: multiUnitPeerSetWindowDays.value,
    localEvents: localEvents.value,
    lastMinuteAdjustments: lastMinuteAdjustments.value,
    gapNightAdjustments: gapNightAdjustments.value,
    lastYearBenchmarkFloorPct: lastYearBenchmarkFloorPct.value,
    minimumNightStay: minimumNightStay.value,
    roundingIncrement: normalizePositiveInteger(roundingIncrement.value, DEFAULT_PRICING_SETTINGS.roundingIncrement)
  };

  return {
    settings,
    sources: {
      basePriceOverride: basePriceOverride.source,
      minimumPriceOverride: minimumPriceOverride.source,
      qualityTier: qualityTier.source,
      qualityMultipliers: qualityMultipliers[qualityTier.value].source,
      minimumPriceFactor: minimumPriceFactor.source,
      minimumPriceGap:
        minimumPriceAbsoluteGapPct.source !== "default" ? minimumPriceAbsoluteGapPct.source : minimumPricePreferredGapPct.source,
      seasonalitySensitivityMode: seasonalitySensitivityMode.source,
      seasonalitySensitivityFactors: seasonalitySensitivityFactors[seasonalitySensitivityMode.value].source,
      seasonalityManualAdjustment:
        seasonalityManualAdjustmentEnabled.source !== "default" ? seasonalityManualAdjustmentEnabled.source : seasonalityManualAdjustmentPct.source,
      seasonalityMonthlyAdjustments: seasonalityMonthlyAdjustments.source,
      seasonalityBounds:
        seasonalityMultiplierFloor.source !== "default" ? seasonalityMultiplierFloor.source : seasonalityMultiplierCeiling.source,
      dayOfWeekSensitivityMode: dayOfWeekSensitivityMode.source,
      dayOfWeekSensitivityFactors: dayOfWeekSensitivityFactors[dayOfWeekSensitivityMode.value].source,
      dayOfWeekManualAdjustment:
        dayOfWeekManualAdjustmentEnabled.source !== "default" ? dayOfWeekManualAdjustmentEnabled.source : dayOfWeekManualAdjustmentPct.source,
      dayOfWeekAdjustments: dayOfWeekAdjustments.source,
      dayOfWeekBounds:
        dayOfWeekMultiplierFloor.source !== "default" ? dayOfWeekMultiplierFloor.source : dayOfWeekMultiplierCeiling.source,
      demandSensitivityMode: demandSensitivityMode.source,
      demandSensitivityLevel: demandSensitivityLevel.source,
      demandSensitivityFactors: demandSensitivityFactors[demandSensitivityMode.value].source,
      demandManualAdjustment:
        demandManualAdjustmentEnabled.source !== "default" ? demandManualAdjustmentEnabled.source : demandManualAdjustmentPct.source,
      demandMultipliers: demandMultipliers.normal.source,
      occupancyScope: occupancyScope.source,
      occupancyPressureMode: occupancyPressureMode.source,
      paceEnabled: paceEnabled.source,
      paceMultipliers: paceMultipliers.onPace.source,
      maximumPriceMultiplier: maximumPriceMultiplier.source,
      pricingMode: pricingMode.source,
      rateCopySourceListingId: rateCopySourceListingId.source,
      rateCopyPushEnabled: rateCopyPushEnabled.source,
      localEvents: localEvents.source,
      lastMinuteAdjustments: lastMinuteAdjustments.source,
      gapNightAdjustments: gapNightAdjustments.source,
      lastYearBenchmarkFloorPct: lastYearBenchmarkFloorPct.source,
      minimumNightStay: minimumNightStay.source,
      roundingIncrement: roundingIncrement.source
    }
  };
}

export function lookupOccupancyMultiplier(occupancyPct: number | null): number | null {
  if (occupancyPct === null || !Number.isFinite(occupancyPct)) return null;
  const normalized = Math.max(0, Math.min(100, occupancyPct));
  const rung = PRICING_OCCUPANCY_LADDER.find((entry) => normalized <= entry.maxOccupancyPct);
  return rung ? rung.multiplier : PRICING_OCCUPANCY_LADDER[PRICING_OCCUPANCY_LADDER.length - 1]?.multiplier ?? 1;
}

export function resolveOccupancyMultiplier(
  settings: PricingResolvedSettings,
  occupancyPct: number | null
): number | null {
  const baseMultiplier = lookupOccupancyMultiplier(occupancyPct);
  if (baseMultiplier === null) return null;

  const pressureFactor =
    settings.occupancyPressureMode === "conservative"
      ? 0.6
      : settings.occupancyPressureMode === "aggressive"
        ? 1.35
        : 1;

  return roundTo2(1 + (baseMultiplier - 1) * pressureFactor);
}

export async function loadResolvedPricingSettings(params: {
  tenantId: string;
  listings: PricingSettingsListingInput[];
  preferredGroupName?: string | null;
}): Promise<Map<string, PricingResolvedSettingsContext>> {
  if (params.listings.length === 0) {
    return new Map<string, PricingResolvedSettingsContext>();
  }

  const groupByListingId = new Map<string, { groupName: string | null; groupKey: string | null }>();
  const groupKeys = new Set<string>();
  for (const listing of params.listings) {
    const groupName = resolveListingPricingGroupName(listing.tags, params.preferredGroupName);
    const groupKey = groupName ? customGroupKey(groupName) : null;
    if (groupKey) groupKeys.add(groupKey);
    groupByListingId.set(listing.listingId, { groupName, groupKey });
  }

  const rows = await prisma.pricingSetting.findMany({
    where: {
      tenantId: params.tenantId,
      OR: [
        { scope: "portfolio" },
        ...(groupKeys.size > 0 ? [{ scope: "group", scopeRef: { in: [...groupKeys] } }] : []),
        { scope: "property", scopeRef: { in: params.listings.map((listing) => listing.listingId) } }
      ]
    },
    select: {
      scope: true,
      scopeRef: true,
      settings: true
    }
  });

  const portfolioOverride =
    parsePricingSettingsOverride(rows.find((row) => row.scope === "portfolio")?.settings);
  const groupOverrides = new Map<string, PricingSettingsOverride>();
  const propertyOverrides = new Map<string, PricingSettingsOverride>();

  for (const row of rows) {
    if (row.scope === "group" && row.scopeRef) {
      groupOverrides.set(row.scopeRef, parsePricingSettingsOverride(row.settings));
    } else if (row.scope === "property" && row.scopeRef) {
      propertyOverrides.set(row.scopeRef, parsePricingSettingsOverride(row.settings));
    }
  }

  const output = new Map<string, PricingResolvedSettingsContext>();
  for (const listing of params.listings) {
    const groupContext = groupByListingId.get(listing.listingId) ?? { groupName: null, groupKey: null };
    const groupOverride = groupContext.groupKey ? groupOverrides.get(groupContext.groupKey) ?? {} : {};
    const propertyOverride = propertyOverrides.get(listing.listingId) ?? {};
    const resolved = resolvePricingSettings({
      portfolio: portfolioOverride,
      group: groupOverride,
      property: propertyOverride
    });

    output.set(listing.listingId, {
      listingId: listing.listingId,
      resolvedGroupName: groupContext.groupName,
      resolvedGroupKey: groupContext.groupKey,
      settings: resolved.settings,
      sources: resolved.sources
    });
  }

  return output;
}
