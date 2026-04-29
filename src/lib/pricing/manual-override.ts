/**
 * Manual price overrides on the pricing calendar.
 *
 * Two override types:
 *   - `'fixed'`: replaces the rate entirely for the date range. Min floor
 *     does NOT apply — the user has explicitly accepted floor risk.
 *   - `'percentage_delta'`: applied multiplicatively on top of the dynamic
 *     recommendation. Allowed range -50% to +100%. Min floor still applies.
 *
 * Auto-supersede invariant (enforced in `createOverrideWithSupersede` /
 * `editOverrideWithSupersede` transactions): no two ACTIVE overrides for
 * the same (tenantId, listingId) may overlap in date range. New overrides
 * trim, split, or soft-delete older ones to maintain this. The auditing
 * trail (`removedAt`, `removedBy`) preserves deleted history.
 *
 * See BUILD-LOG.md (2026-04-29) for the design notes (decisions #4–#6).
 */
import type { PrismaClient, Prisma } from "@prisma/client";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";

export const OVERRIDE_TYPE_VALUES = ["fixed", "percentage_delta"] as const;
export type OverrideType = (typeof OVERRIDE_TYPE_VALUES)[number];

/** Spec B.7: percentage_delta is allowed in [-0.5, +1.0]. */
export const PERCENTAGE_OVERRIDE_MIN = -0.5;
export const PERCENTAGE_OVERRIDE_MAX = 1.0;

export type PricingManualOverrideDto = {
  id: string;
  tenantId: string;
  listingId: string;
  startDate: string; // dateOnly (YYYY-MM-DD)
  endDate: string; // dateOnly (YYYY-MM-DD)
  overrideType: OverrideType;
  overrideValue: number;
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
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    removedAt: row.removedAt ? row.removedAt.toISOString() : null,
    removedBy: row.removedBy
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Resolution: applyManualOverride
 *
 * Pure helper used by `buildPricingCalendarRows` to apply an override to
 * a single (listing × date) cell. Takes the active override (if any) and
 * the dynamic recommendation, returns the final pushable rate.
 *
 * Spec B.4 logic, faithfully reproduced.
 * ────────────────────────────────────────────────────────────────────── */

export function roundToIncrement(value: number, increment: number): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(increment) || increment <= 1) return Math.round(value);
  return Math.round(value / increment) * increment;
}

export type ApplyManualOverrideResult = {
  finalRate: number | null;
  overrideApplied: {
    id: string;
    type: OverrideType;
    value: number;
  } | null;
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
    return {
      finalRate: input.dynamicRate,
      overrideApplied: null,
      reason: "no override"
    };
  }
  const o = input.override;
  if (o.overrideType === "fixed") {
    // No minimum enforcement. User explicit choice (Spec B.4 + UI helper text).
    const finalRate = roundToIncrement(o.overrideValue, input.roundingIncrement);
    return {
      finalRate,
      overrideApplied: { id: o.id, type: "fixed", value: o.overrideValue },
      reason: "fixed override"
    };
  }
  // percentage_delta — apply on top of the dynamic recommendation.
  if (input.dynamicRate === null) {
    // No dynamic rate to multiply against; we can't apply the delta.
    // Surface the override metadata in the result so the UI can still
    // explain why the cell looks empty.
    return {
      finalRate: null,
      overrideApplied: { id: o.id, type: "percentage_delta", value: o.overrideValue },
      reason: "percentage override (no dynamic rate to apply against)"
    };
  }
  const raw = input.dynamicRate * (1 + o.overrideValue);
  const effectiveMin = Math.max(
    input.recommendedMinimum ?? 0,
    input.userMinimumOverride ?? 0
  );
  const floored = effectiveMin > 0 ? Math.max(raw, effectiveMin) : raw;
  const finalRate = roundToIncrement(floored, input.roundingIncrement);
  return {
    finalRate,
    overrideApplied: { id: o.id, type: "percentage_delta", value: o.overrideValue },
    reason: "percentage override (floored at min)"
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Auto-supersede algorithm (pure, testable).
 *
 * Input: existing active overrides for a (tenant, listing) and the new
 * range. Output: a list of mutations to perform in the transaction:
 *   - { kind: "soft-delete", id }                 — fully contained
 *   - { kind: "trim-end",     id, newEndDate }    — partial overlap at start
 *   - { kind: "trim-start",   id, newStartDate }  — partial overlap at end
 *   - { kind: "split",        id, leftEndDate,
 *                             rightStartDate, rightEndDate, type, value, notes,
 *                             originalStartDate }   — fully contains the new range
 *
 * The split mutation needs the original start so the left wing's trim is a
 * no-op (no row update required) when leftEndDate == originalStartDate - 1
 * — but realistically there's always at least one day on the left, else
 * this would be a "trim-start" or "soft-delete" instead.
 *
 * Date math is INCLUSIVE on both ends. Contiguity uses ±1 day offsets.
 * ────────────────────────────────────────────────────────────────────── */

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
      rightNotes: string | null;
    };

export type SupersedeSummary = {
  mutations: SupersedeMutation[];
  /** Plain-English summary for the confirmation modal: e.g.
   *  "This will replace 2 existing overrides on overlapping dates: 14 May – 18 May (-10%); 22 May (FIXED £85)." */
  summary: string;
};

function describeOverride(o: { startDate: string; endDate: string; overrideType: string; overrideValue: number }): string {
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
    "id" | "startDate" | "endDate" | "overrideType" | "overrideValue" | "notes"
  >[];
  newStartDate: string;
  newEndDate: string;
}): SupersedeSummary {
  const mutations: SupersedeMutation[] = [];
  const overlapping: typeof params.existing = [];

  for (const existing of params.existing) {
    // Overlap if existing.endDate >= newStart AND existing.startDate <= newEnd.
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
    // (overlapsAtEnd would be: existing.endDate >= newStart && existing.endDate <= newEnd)

    if (fullyContained) {
      mutations.push({ kind: "soft-delete", id: existing.id });
      continue;
    }
    if (fullyContains) {
      // Split into left wing [existing.start, newStart-1] and right wing
      // [newEnd+1, existing.end]. Trim the existing row to the left wing
      // (via trim-end), then create a fresh row for the right wing
      // carrying the existing override's type/value/notes.
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
        rightNotes: existing.notes
      });
      continue;
    }
    if (overlapsAtStart) {
      // existing starts inside the new range; trim its start to newEnd+1.
      const newStart = toDateOnly(addUtcDays(fromDateOnly(params.newEndDate), 1));
      mutations.push({ kind: "trim-start", id: existing.id, newStartDate: newStart });
      continue;
    }
    // overlapsAtEnd: existing ends inside the new range; trim its end to newStart-1.
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

/* ─────────────────────────────────────────────────────────────────────────
 * DB write paths (run inside a Prisma transaction)
 * ────────────────────────────────────────────────────────────────────── */

export async function findActiveOverrideForCell(args: {
  tenantId: string;
  listingId: string;
  date: string; // dateOnly
  prisma: PrismaClient;
}): Promise<PricingManualOverrideDto | null> {
  const dateAsDate = fromDateOnly(args.date);
  const row = await args.prisma.pricingManualOverride.findFirst({
    where: {
      tenantId: args.tenantId,
      listingId: args.listingId,
      removedAt: null,
      startDate: { lte: dateAsDate },
      endDate: { gte: dateAsDate }
    },
    orderBy: { createdAt: "desc" }
  });
  return row ? rowToDto(row) : null;
}

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

/**
 * Build a per-date map of active overrides for a (tenant, listing) over
 * the calendar window. Used by `buildPricingCalendarRows` so it can apply
 * overrides cell-by-cell without N queries per cell.
 *
 * Invariant: the supersede algorithm guarantees at most one active
 * override per (listing × date), so the returned map always has a single
 * dto per dateKey.
 */
export function buildActiveOverrideByDate(
  overrides: PricingManualOverrideDto[]
): Map<string, PricingManualOverrideDto> {
  const out = new Map<string, PricingManualOverrideDto>();
  for (const o of overrides) {
    let cursor = fromDateOnly(o.startDate);
    const end = fromDateOnly(o.endDate);
    while (cursor <= end) {
      const key = toDateOnly(cursor);
      // Defence-in-depth: if two rows somehow claim the same date, prefer
      // the most recently created (surfaces the user's latest intent).
      const existing = out.get(key);
      if (!existing || existing.createdAt < o.createdAt) {
        out.set(key, o);
      }
      cursor = addUtcDays(cursor, 1);
    }
  }
  return out;
}

export async function createOverrideWithSupersede(args: {
  tenantId: string;
  listingId: string;
  startDate: string;
  endDate: string;
  overrideType: OverrideType;
  overrideValue: number;
  notes?: string | null;
  createdBy: string;
  prisma: PrismaClient;
}): Promise<{ created: PricingManualOverrideDto; superseded: SupersedeSummary }> {
  validateOverrideInputs(args);

  return args.prisma.$transaction(async (tx) => {
    // Reload existing inside the transaction to get a consistent view.
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
            notes: m.rightNotes,
            createdBy: args.createdBy
          }
        });
      }
    }

    const createdRow = await tx.pricingManualOverride.create({
      data: {
        tenantId: args.tenantId,
        listingId: args.listingId,
        startDate: fromDateOnly(args.startDate),
        endDate: fromDateOnly(args.endDate),
        overrideType: args.overrideType,
        overrideValue: args.overrideValue,
        notes: args.notes ?? null,
        createdBy: args.createdBy
      }
    });

    return { created: rowToDto(createdRow), superseded: supersede };
  });
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

export async function editOverrideWithSupersede(args: {
  tenantId: string;
  id: string;
  startDate?: string;
  endDate?: string;
  overrideType?: OverrideType;
  overrideValue?: number;
  notes?: string | null;
  editedBy: string;
  prisma: PrismaClient;
}): Promise<{ updated: PricingManualOverrideDto; superseded: SupersedeSummary } | null> {
  return args.prisma.$transaction(async (tx) => {
    const existing = await tx.pricingManualOverride.findFirst({
      where: { id: args.id, tenantId: args.tenantId, removedAt: null }
    });
    if (!existing) return null;

    const startDate = args.startDate ?? toDateOnly(existing.startDate);
    const endDate = args.endDate ?? toDateOnly(existing.endDate);
    const overrideType = (args.overrideType ?? existing.overrideType) as OverrideType;
    const overrideValue = args.overrideValue ?? existing.overrideValue;
    validateOverrideInputs({
      startDate,
      endDate,
      overrideType,
      overrideValue
    });

    // Find OTHER overlapping overrides (exclude the one we're editing).
    const otherRows = await tx.pricingManualOverride.findMany({
      where: {
        tenantId: args.tenantId,
        listingId: existing.listingId,
        id: { not: args.id },
        removedAt: null,
        startDate: { lte: fromDateOnly(endDate) },
        endDate: { gte: fromDateOnly(startDate) }
      }
    });
    const supersede = planSupersedeForOverlap({
      existing: otherRows.map(rowToDto),
      newStartDate: startDate,
      newEndDate: endDate
    });

    const now = new Date();
    for (const m of supersede.mutations) {
      if (m.kind === "soft-delete") {
        await tx.pricingManualOverride.update({
          where: { id: m.id },
          data: { removedAt: now, removedBy: args.editedBy }
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
        await tx.pricingManualOverride.update({
          where: { id: m.id },
          data: { endDate: fromDateOnly(m.leftEndDate) }
        });
        await tx.pricingManualOverride.create({
          data: {
            tenantId: args.tenantId,
            listingId: existing.listingId,
            startDate: fromDateOnly(m.rightStartDate),
            endDate: fromDateOnly(m.rightEndDate),
            overrideType: m.rightOverrideType,
            overrideValue: m.rightOverrideValue,
            notes: m.rightNotes,
            createdBy: args.editedBy
          }
        });
      }
    }

    const updateData: Prisma.PricingManualOverrideUpdateInput = {};
    if (args.startDate !== undefined) updateData.startDate = fromDateOnly(args.startDate);
    if (args.endDate !== undefined) updateData.endDate = fromDateOnly(args.endDate);
    if (args.overrideType !== undefined) updateData.overrideType = args.overrideType;
    if (args.overrideValue !== undefined) updateData.overrideValue = args.overrideValue;
    if (args.notes !== undefined) updateData.notes = args.notes;

    const updated = await tx.pricingManualOverride.update({
      where: { id: args.id },
      data: updateData
    });

    return { updated: rowToDto(updated), superseded: supersede };
  });
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
