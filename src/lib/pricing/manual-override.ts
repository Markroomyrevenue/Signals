/**
 * Manual price overrides on the pricing calendar.
 *
 * Two override types:
 *   - `'fixed'`: replaces the rate entirely for the date range. Min floor
 *     does NOT apply (user's explicit choice — see UI helper text).
 *   - `'percentage_delta'`: applied multiplicatively on top of the dynamic
 *     recommendation. Allowed range -50% to +100%. Min floor still applies.
 *
 * Optional `minStay` overrides the listing's default min-stay for the
 * pushed dates (only honoured for listings that push to Hostaway).
 *
 * Auto-supersede invariant: no two ACTIVE overrides for the same
 * (tenantId, listingId) may overlap in date range. New overrides trim,
 * split, or soft-delete older ones to maintain this. The audit trail
 * (`removedAt`, `removedBy`) preserves deleted history.
 *
 * Bulk creation: createBulkOverrides accepts an array of listingIds and
 * applies the supersede transaction independently for each. Used by the
 * "Bulk edit overrides" modal at the top of the pricing calendar.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";

export const OVERRIDE_TYPE_VALUES = ["fixed", "percentage_delta"] as const;
export type OverrideType = (typeof OVERRIDE_TYPE_VALUES)[number];

export const PERCENTAGE_OVERRIDE_MIN = -0.5;
export const PERCENTAGE_OVERRIDE_MAX = 1.0;

export type PricingManualOverrideDto = {
  id: string;
  tenantId: string;
  listingId: string;
  startDate: string;
  endDate: string;
  overrideType: OverrideType;
  overrideValue: number;
  minStay: number | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
  removedBy: string | null;
};

function rowToDto(row: {
  id: string;
  tenantId: string;
  listingId: string;
  startDate: Date;
  endDate: Date;
  overrideType: string;
  overrideValue: number;
  minStay: number | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
  removedBy: string | null;
}): PricingManualOverrideDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    listingId: row.listingId,
    startDate: toDateOnly(row.startDate),
    endDate: toDateOnly(row.endDate),
    overrideType: row.overrideType as OverrideType,
    overrideValue: row.overrideValue,
    minStay: row.minStay,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
    removedBy: row.removedBy
  };
}

// ---------------------------------------------------------------------------
// Cell-level resolver
// ---------------------------------------------------------------------------
export function roundToIncrement(value: number, increment: number): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(increment) || increment <= 1) return Math.round(value);
  return Math.round(value / increment) * increment;
}

export type ApplyManualOverrideResult = {
  finalRate: number | null;
  overrideApplied: { id: string; type: OverrideType; value: number; minStay: number | null } | null;
  reason: string;
};

export function applyManualOverride(input: {
  override: PricingManualOverrideDto | null;
  dynamicRate: number | null;
  recommendedMinimum: number | null;
  userMinimumOverride: number | null;
  roundingIncrement: number;
}): ApplyManualOverrideResult {
  if (input.override === null) {
    return { finalRate: input.dynamicRate, overrideApplied: null, reason: "no override" };
  }
  const o = input.override;
  if (o.overrideType === "fixed") {
    const finalRate = roundToIncrement(o.overrideValue, input.roundingIncrement);
    return {
      finalRate,
      overrideApplied: { id: o.id, type: "fixed", value: o.overrideValue, minStay: o.minStay },
      reason: "fixed override (min floor bypassed)"
    };
  }
  if (input.dynamicRate === null) {
    return {
      finalRate: null,
      overrideApplied: { id: o.id, type: "percentage_delta", value: o.overrideValue, minStay: o.minStay },
      reason: "percentage override (no dynamic rate to apply against)"
    };
  }
  const raw = input.dynamicRate * (1 + o.overrideValue);
  const effectiveMin = Math.max(input.recommendedMinimum ?? 0, input.userMinimumOverride ?? 0);
  const floored = effectiveMin > 0 ? Math.max(raw, effectiveMin) : raw;
  const finalRate = roundToIncrement(floored, input.roundingIncrement);
  return {
    finalRate,
    overrideApplied: { id: o.id, type: "percentage_delta", value: o.overrideValue, minStay: o.minStay },
    reason: "percentage override (floored at min)"
  };
}

// ---------------------------------------------------------------------------
// Auto-supersede on overlap
// ---------------------------------------------------------------------------
export type SupersedeMutation =
  | { kind: "soft-delete"; id: string }
  | { kind: "trim-end"; id: string; newEndDate: string }
  | { kind: "trim-start"; id: string; newStartDate: string }
  | {
      kind: "split";
      id: string;
      leftEndDate: string;
      rightStartDate: string;
      rightEndDate: string;
      rightOverrideType: OverrideType;
      rightOverrideValue: number;
      rightMinStay: number | null;
      rightNotes: string | null;
    };

export type SupersedeSummary = {
  mutations: SupersedeMutation[];
  summary: string;
};

function describeOverride(o: {
  startDate: string;
  endDate: string;
  overrideType: string;
  overrideValue: number;
}): string {
  const range = o.startDate === o.endDate ? o.startDate : `${o.startDate} – ${o.endDate}`;
  const tag =
    o.overrideType === "fixed"
      ? `FIXED £${o.overrideValue.toFixed(2)}`
      : `${o.overrideValue >= 0 ? "+" : ""}${(o.overrideValue * 100).toFixed(0)}%`;
  return `${range} (${tag})`;
}

export function planSupersedeForOverlap(params: {
  existing: Pick<
    PricingManualOverrideDto,
    "id" | "startDate" | "endDate" | "overrideType" | "overrideValue" | "minStay" | "notes"
  >[];
  newStartDate: string;
  newEndDate: string;
}): SupersedeSummary {
  const mutations: SupersedeMutation[] = [];
  const overlapping: typeof params.existing = [];

  for (const existing of params.existing) {
    if (existing.endDate < params.newStartDate || existing.startDate > params.newEndDate) {
      continue;
    }
    overlapping.push(existing);

    const fullyContained =
      existing.startDate >= params.newStartDate && existing.endDate <= params.newEndDate;
    const fullyContains =
      existing.startDate < params.newStartDate && existing.endDate > params.newEndDate;
    const overlapsAtStart =
      existing.startDate >= params.newStartDate && existing.startDate <= params.newEndDate;

    if (fullyContained) {
      mutations.push({ kind: "soft-delete", id: existing.id });
      continue;
    }
    if (fullyContains) {
      const leftEndDate = toDateOnly(addUtcDays(fromDateOnly(params.newStartDate), -1));
      const rightStartDate = toDateOnly(addUtcDays(fromDateOnly(params.newEndDate), 1));
      mutations.push({
        kind: "split",
        id: existing.id,
        leftEndDate,
        rightStartDate,
        rightEndDate: existing.endDate,
        rightOverrideType: existing.overrideType as OverrideType,
        rightOverrideValue: existing.overrideValue,
        rightMinStay: existing.minStay,
        rightNotes: existing.notes
      });
      continue;
    }
    if (overlapsAtStart) {
      const newStart = toDateOnly(addUtcDays(fromDateOnly(params.newEndDate), 1));
      mutations.push({ kind: "trim-start", id: existing.id, newStartDate: newStart });
      continue;
    }
    const newEnd = toDateOnly(addUtcDays(fromDateOnly(params.newStartDate), -1));
    mutations.push({ kind: "trim-end", id: existing.id, newEndDate: newEnd });
  }

  const summaryHead =
    overlapping.length === 0
      ? ""
      : `This will replace ${overlapping.length} existing override${overlapping.length === 1 ? "" : "s"} on overlapping dates: ` +
        overlapping.map((o) => describeOverride(o)).join("; ") +
        ".";

  return { mutations, summary: summaryHead };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
export async function findActiveOverridesInRange(args: {
  tenantId: string;
  listingId: string;
  fromDate: string;
  toDate: string;
  prisma: PrismaClient;
}): Promise<PricingManualOverrideDto[]> {
  const rows = await args.prisma.pricingManualOverride.findMany({
    where: {
      tenantId: args.tenantId,
      listingId: args.listingId,
      removedAt: null,
      startDate: { lte: fromDateOnly(args.toDate) },
      endDate: { gte: fromDateOnly(args.fromDate) }
    },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }]
  });
  return rows.map(rowToDto);
}

export async function findActiveOverridesForListings(args: {
  tenantId: string;
  listingIds: string[];
  fromDate: string;
  toDate: string;
  prisma: PrismaClient;
}): Promise<PricingManualOverrideDto[]> {
  if (args.listingIds.length === 0) return [];
  const rows = await args.prisma.pricingManualOverride.findMany({
    where: {
      tenantId: args.tenantId,
      listingId: { in: args.listingIds },
      removedAt: null,
      startDate: { lte: fromDateOnly(args.toDate) },
      endDate: { gte: fromDateOnly(args.fromDate) }
    },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }]
  });
  return rows.map(rowToDto);
}

export function buildActiveOverrideByDate(
  overrides: PricingManualOverrideDto[]
): Map<string, PricingManualOverrideDto> {
  const out = new Map<string, PricingManualOverrideDto>();
  for (const o of overrides) {
    let cursor = fromDateOnly(o.startDate);
    const end = fromDateOnly(o.endDate);
    while (cursor <= end) {
      const key = toDateOnly(cursor);
      const existing = out.get(key);
      if (!existing || existing.createdAt < o.createdAt) out.set(key, o);
      cursor = addUtcDays(cursor, 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutations: create / bulk create / edit / soft-delete
// ---------------------------------------------------------------------------

async function applyMutationsAndCreate(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    listingId: string;
    startDate: string;
    endDate: string;
    overrideType: OverrideType;
    overrideValue: number;
    minStay: number | null;
    notes: string | null;
    createdBy: string;
  },
  supersede: SupersedeSummary
): Promise<PricingManualOverrideDto> {
  const now = new Date();
  for (const m of supersede.mutations) {
    if (m.kind === "soft-delete") {
      await tx.pricingManualOverride.update({
        where: { id: m.id },
        data: { removedAt: now, removedBy: args.createdBy }
      });
    } else if (m.kind === "trim-end") {
      await tx.pricingManualOverride.update({
        where: { id: m.id },
        data: { endDate: fromDateOnly(m.newEndDate) }
      });
    } else if (m.kind === "trim-start") {
      await tx.pricingManualOverride.update({
        where: { id: m.id },
        data: { startDate: fromDateOnly(m.newStartDate) }
      });
    } else {
      // split: trim original (left wing) AND create a fresh row (right wing).
      await tx.pricingManualOverride.update({
        where: { id: m.id },
        data: { endDate: fromDateOnly(m.leftEndDate) }
      });
      await tx.pricingManualOverride.create({
        data: {
          tenantId: args.tenantId,
          listingId: args.listingId,
          startDate: fromDateOnly(m.rightStartDate),
          endDate: fromDateOnly(m.rightEndDate),
          overrideType: m.rightOverrideType,
          overrideValue: m.rightOverrideValue,
          minStay: m.rightMinStay,
          notes: m.rightNotes,
          createdBy: args.createdBy
        }
      });
    }
  }
  const created = await tx.pricingManualOverride.create({
    data: {
      tenantId: args.tenantId,
      listingId: args.listingId,
      startDate: fromDateOnly(args.startDate),
      endDate: fromDateOnly(args.endDate),
      overrideType: args.overrideType,
      overrideValue: args.overrideValue,
      minStay: args.minStay,
      notes: args.notes,
      createdBy: args.createdBy
    }
  });
  return rowToDto(created);
}

export async function createOverrideWithSupersede(args: {
  tenantId: string;
  listingId: string;
  startDate: string;
  endDate: string;
  overrideType: OverrideType;
  overrideValue: number;
  minStay?: number | null;
  notes?: string | null;
  createdBy: string;
  prisma: PrismaClient;
}): Promise<{ created: PricingManualOverrideDto; superseded: SupersedeSummary }> {
  validateOverrideInputs(args);

  return args.prisma.$transaction(async (tx) => {
    const existingRows = await tx.pricingManualOverride.findMany({
      where: {
        tenantId: args.tenantId,
        listingId: args.listingId,
        removedAt: null,
        startDate: { lte: fromDateOnly(args.endDate) },
        endDate: { gte: fromDateOnly(args.startDate) }
      }
    });
    const supersede = planSupersedeForOverlap({
      existing: existingRows.map(rowToDto),
      newStartDate: args.startDate,
      newEndDate: args.endDate
    });
    const created = await applyMutationsAndCreate(
      tx,
      {
        tenantId: args.tenantId,
        listingId: args.listingId,
        startDate: args.startDate,
        endDate: args.endDate,
        overrideType: args.overrideType,
        overrideValue: args.overrideValue,
        minStay: args.minStay ?? null,
        notes: args.notes ?? null,
        createdBy: args.createdBy
      },
      supersede
    );
    return { created, superseded: supersede };
  });
}

/**
 * Bulk create: apply the same override to N listings. Each listing gets
 * its own supersede transaction independently. Returns one result per
 * listing (success or failure isolated to that listing).
 */
export async function createBulkOverrides(args: {
  tenantId: string;
  listingIds: string[];
  startDate: string;
  endDate: string;
  overrideType: OverrideType;
  overrideValue: number;
  minStay?: number | null;
  notes?: string | null;
  createdBy: string;
  prisma: PrismaClient;
}): Promise<
  Array<{
    listingId: string;
    created: PricingManualOverrideDto | null;
    superseded: SupersedeSummary | null;
    error: string | null;
  }>
> {
  validateOverrideInputs(args);
  const results: Array<{
    listingId: string;
    created: PricingManualOverrideDto | null;
    superseded: SupersedeSummary | null;
    error: string | null;
  }> = [];
  for (const listingId of args.listingIds) {
    try {
      const r = await createOverrideWithSupersede({
        tenantId: args.tenantId,
        listingId,
        startDate: args.startDate,
        endDate: args.endDate,
        overrideType: args.overrideType,
        overrideValue: args.overrideValue,
        minStay: args.minStay ?? null,
        notes: args.notes ?? null,
        createdBy: args.createdBy,
        prisma: args.prisma
      });
      results.push({ listingId, created: r.created, superseded: r.superseded, error: null });
    } catch (err) {
      results.push({
        listingId,
        created: null,
        superseded: null,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return results;
}

export async function softDeleteOverride(args: {
  tenantId: string;
  id: string;
  removedBy: string;
  prisma: PrismaClient;
}): Promise<PricingManualOverrideDto | null> {
  const row = await args.prisma.pricingManualOverride.findFirst({
    where: { id: args.id, tenantId: args.tenantId, removedAt: null }
  });
  if (!row) return null;
  const updated = await args.prisma.pricingManualOverride.update({
    where: { id: row.id },
    data: { removedAt: new Date(), removedBy: args.removedBy }
  });
  return rowToDto(updated);
}

function validateOverrideInputs(args: {
  startDate: string;
  endDate: string;
  overrideType: OverrideType;
  overrideValue: number;
}): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(args.endDate)) {
    throw new Error(`Invalid override date(s): ${args.startDate} – ${args.endDate}`);
  }
  if (args.startDate > args.endDate) {
    throw new Error(`Override startDate (${args.startDate}) must be on or before endDate (${args.endDate}).`);
  }
  if (!OVERRIDE_TYPE_VALUES.includes(args.overrideType)) {
    throw new Error(`Invalid overrideType: ${args.overrideType}`);
  }
  if (!Number.isFinite(args.overrideValue)) {
    throw new Error(`overrideValue must be finite, got ${args.overrideValue}`);
  }
  if (args.overrideType === "fixed") {
    if (args.overrideValue <= 0) {
      throw new Error(`Fixed-price overrideValue must be > 0, got ${args.overrideValue}`);
    }
  } else {
    if (args.overrideValue < PERCENTAGE_OVERRIDE_MIN || args.overrideValue > PERCENTAGE_OVERRIDE_MAX) {
      throw new Error(
        `Percentage-delta overrideValue must be between ${PERCENTAGE_OVERRIDE_MIN} and ${PERCENTAGE_OVERRIDE_MAX}, got ${args.overrideValue}`
      );
    }
  }
}
