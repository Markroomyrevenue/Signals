/**
 * Prisma-backed default stores for the oversight runner.
 *
 * TENANT ISOLATION IS NON-NEGOTIABLE HERE: every query and every update in
 * this file carries a `tenantId` filter (the sole exception is
 * `global_methodology`, which is a single anonymised cross-client doc with no
 * tenant column by design). The `Suggestion.detail` write is a read-spread-
 * write merge via `mergeOversightIntoDetail` — existing detail keys
 * (floor / score / curveCohort / …) are never dropped, and the update itself
 * is an `updateMany` with the tenantId filter repeated.
 */

import { GLOBAL_METHODOLOGY_ID } from "@/lib/observe/global-methodology";
import { prisma } from "@/lib/prisma";

import { mergeOversightIntoDetail, type OversightRunWrite, type OversightStores, type PendingSuggestionRow } from "./run";
import type { OversightDetailAnnotation, OversightRecentDecision } from "./types";

const SUGGESTION_ROW_SELECT = {
  id: true,
  clientKey: true,
  listingId: true,
  dateFrom: true,
  oldValue: true,
  proposedValue: true,
  revenueAtRisk: true,
  reason: true,
  confidence: true,
  provenance: true,
  provisional: true,
  detail: true
} as const;

type RawSuggestionRow = {
  id: string;
  clientKey: string | null;
  listingId: string | null;
  dateFrom: Date;
  oldValue: { toNumber(): number } | null;
  proposedValue: { toNumber(): number } | null;
  revenueAtRisk: { toNumber(): number } | null;
  reason: string;
  confidence: { toNumber(): number } | null;
  provenance: string | null;
  provisional: boolean;
  detail: unknown;
};

function toNumberOrNull(value: { toNumber(): number } | null): number | null {
  if (value === null) return null;
  const n = value.toNumber();
  return Number.isFinite(n) ? n : null;
}

function flattenRow(row: RawSuggestionRow): PendingSuggestionRow {
  return {
    id: row.id,
    clientKey: row.clientKey,
    listingId: row.listingId,
    dateFrom: row.dateFrom,
    oldValue: toNumberOrNull(row.oldValue),
    proposedValue: toNumberOrNull(row.proposedValue),
    revenueAtRisk: toNumberOrNull(row.revenueAtRisk),
    reason: row.reason,
    confidence: toNumberOrNull(row.confidence),
    provenance: row.provenance,
    provisional: row.provisional,
    detail: row.detail
  };
}

async function loadListingNames(tenantId: string, listingIds: string[]): Promise<Record<string, string>> {
  if (listingIds.length === 0) return {};
  const listings = await prisma.listing.findMany({
    where: { tenantId, id: { in: listingIds } },
    select: { id: true, name: true }
  });
  return Object.fromEntries(listings.map((l) => [l.id, l.name]));
}

export const prismaOversightStores: OversightStores = {
  async countPendingSuggestions(tenantId: string, clientKey: string): Promise<number> {
    // Cheap approximation for the disabled-path audit row: status filter only
    // (the detail.recsPage refinement is a JS-side filter, skipped here).
    return prisma.suggestion.count({ where: { tenantId, clientKey, status: "pending" } });
  },

  async loadPendingSuggestions(tenantId: string, clientKey: string): Promise<PendingSuggestionRow[]> {
    const rows = await prisma.suggestion.findMany({
      where: { tenantId, clientKey, status: "pending" },
      select: SUGGESTION_ROW_SELECT,
      orderBy: { dateFrom: "asc" }
    });
    return (rows as RawSuggestionRow[]).map(flattenRow);
  },

  async loadSuggestionById(tenantId: string, suggestionId: string): Promise<PendingSuggestionRow | null> {
    const row = await prisma.suggestion.findFirst({
      where: { tenantId, id: suggestionId },
      select: SUGGESTION_ROW_SELECT
    });
    return row ? flattenRow(row as RawSuggestionRow) : null;
  },

  loadListingNames,

  async loadTenantName(tenantId: string): Promise<string | null> {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    return tenant?.name ?? null;
  },

  async loadClientProfile(tenantId: string, clientKey: string): Promise<unknown | null> {
    const row = await prisma.clientProfile.findUnique({
      where: { tenantId_clientKey: { tenantId, clientKey } },
      select: { profile: true }
    });
    return row?.profile ?? null;
  },

  async loadEvidence(tenantId: string, clientKey: string) {
    const rows = await prisma.recsEvidence.findMany({
      where: { tenantId, clientKey, kind: { in: ["mark-prior", "drop-outcomes"] } },
      select: { kind: true, provenance: true, payload: true }
    });
    return rows.map((r) => ({ kind: r.kind, provenance: r.provenance, payload: r.payload as unknown }));
  },

  async loadRecentDecisions(tenantId: string, clientKey: string, since: Date): Promise<OversightRecentDecision[]> {
    const rows = await prisma.suggestion.findMany({
      where: { tenantId, clientKey, actionedAt: { gte: since } },
      select: {
        listingId: true,
        dateFrom: true,
        status: true,
        proposedValue: true,
        approvedPrice: true,
        actionedAt: true
      },
      orderBy: { actionedAt: "desc" },
      take: 50
    });
    const names = await loadListingNames(
      tenantId,
      [...new Set(rows.map((r) => r.listingId).filter((id): id is string => Boolean(id)))]
    );
    return rows.map((r) => {
      const price = r.approvedPrice ?? r.proposedValue;
      return {
        date: (r.actionedAt ?? r.dateFrom).toISOString().slice(0, 10),
        listingName: (r.listingId && names[r.listingId]) || "unknown listing",
        action: r.status,
        price: price === null ? null : Number(price)
      };
    });
  },

  async loadGlobalMethodology(): Promise<unknown | null> {
    const row = await prisma.globalMethodology.findUnique({ where: { id: GLOBAL_METHODOLOGY_ID } });
    return row?.methodology ?? null;
  },

  async createOversightRun(write: OversightRunWrite): Promise<{ id: string }> {
    const created = await prisma.oversightRun.create({
      data: {
        tenantId: write.tenantId,
        clientKey: write.clientKey,
        runAt: write.runAt,
        model: write.model,
        status: write.status,
        suggestionCount: write.suggestionCount ?? null,
        flagCount: write.flagCount ?? null,
        inputTokens: write.inputTokens ?? null,
        outputTokens: write.outputTokens ?? null,
        costUsd: write.costUsd ?? null,
        error: write.error ?? null,
        ...(write.clientRead ? { clientRead: write.clientRead } : {})
      },
      select: { id: true }
    });
    return created;
  },

  async mergeSuggestionOversight(
    tenantId: string,
    suggestionId: string,
    annotation: OversightDetailAnnotation
  ): Promise<void> {
    const row = await prisma.suggestion.findFirst({
      where: { tenantId, id: suggestionId },
      select: { detail: true }
    });
    if (!row) {
      throw new Error(`suggestion ${suggestionId} not found for tenant`);
    }
    const merged = mergeOversightIntoDetail(row.detail, annotation);
    await prisma.suggestion.updateMany({
      where: { tenantId, id: suggestionId },
      data: { detail: merged as object }
    });
  }
};
