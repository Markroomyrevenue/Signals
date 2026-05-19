/**
 * Per-listing calibration check — compares our internal trailing 365-day
 * ADR + occupancy aggregates (from NightFact) against KeyData's view of
 * the same listing via `getListingKpiSummary`. The goal of this check
 * is to surface SYSTEMIC pricing-input miscalibration — if KeyData says
 * a listing did £180 ADR / 72% occupancy and our internal aggregates
 * say £200 / 75%, our base-price recommendation will compound the
 * error and we'll persistently price above PL.
 *
 * Coverage varies by listing — KeyData only has data on listings they
 * actively track. ~50% of LF and ~100% of Stay Belfast are covered
 * at the time of this build. Uncovered listings drop out gracefully
 * with `kdCoverage: false`.
 *
 * Cached at the provider layer for 7 days per listing so daily runs
 * don't blow the KeyData call budget.
 */

import { prisma } from "@/lib/prisma";
import type { KeyDataProvider } from "@/lib/pricing/keydata-provider";

export type ListingCalibrationRow = {
  listingId: string;
  listingName: string;
  kdListingId: string | null;
  kdCoverage: boolean;
  ourAdr: number | null;
  kdAdr: number | null;
  adrDeltaPct: number | null;
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
  const out = new Map<string, { adr: number | null; occupancy: number | null }>();
  if (listingIds.length === 0) return out;
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setUTCFullYear(today.getUTCFullYear() - 1);
  const facts = await prisma.nightFact.findMany({
    where: {
      tenantId,
      listingId: { in: listingIds },
      date: { gte: oneYearAgo, lt: today }
    },
    select: { listingId: true, date: true, isOccupied: true, revenueAllocated: true }
  });
  // Aggregate per (listingId, date) so overlapping reservations don't
  // double-count revenue, then per-listing for the ADR / occupancy
  // numbers. Mirrors the logic in agent.loadOwnHistoryAggregates.
  type Cell = { occupied: boolean; revenue: number };
  const byListing = new Map<string, Map<string, Cell>>();
  for (const f of facts) {
    const iso = f.date.toISOString().slice(0, 10);
    let inner = byListing.get(f.listingId);
    if (!inner) {
      inner = new Map();
      byListing.set(f.listingId, inner);
    }
    const cur = inner.get(iso) ?? { occupied: false, revenue: 0 };
    cur.occupied = cur.occupied || f.isOccupied;
    cur.revenue += Number(f.revenueAllocated ?? 0);
    inner.set(iso, cur);
  }
  for (const [listingId, dateMap] of byListing) {
    const cells = Array.from(dateMap.values());
    const occupiedCells = cells.filter((c) => c.occupied);
    const totalRevenue = occupiedCells.reduce((s, c) => s + c.revenue, 0);
    const adr = occupiedCells.length > 0 ? totalRevenue / occupiedCells.length : null;
    const occupancy = cells.length > 0 ? occupiedCells.length / cells.length : null;
    out.set(listingId, { adr, occupancy });
  }
  return out;
}

export async function computeListingCalibrationCheck(
  tenantId: string,
  listings: Array<{ id: string; name: string; airbnbListingUrl: string | null }>,
  provider: KeyDataProvider | null
): Promise<ListingCalibrationRow[]> {
  if (!provider || listings.length === 0) return [];
  const ourAggs = await loadOwnTrailingAggregates(
    tenantId,
    listings.map((l) => l.id)
  );
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
    const adrDelta =
      own.adr !== null && own.adr > 0 && kdAdr !== null && kdAdr > 0 ? (own.adr - kdAdr) / kdAdr : null;
    const occDelta = own.occupancy !== null && kdOcc !== null ? own.occupancy - kdOcc : null;
    rows.push({
      listingId: l.id,
      listingName: l.name,
      kdListingId,
      kdCoverage: !!kdSummary && (kdSummary.sampleMonths ?? 0) > 0,
      ourAdr: own.adr,
      kdAdr,
      adrDeltaPct: adrDelta,
      ourOccupancy: own.occupancy,
      kdOccupancy: kdOcc,
      occDeltaPp: occDelta,
      kdSampleMonths: kdSummary?.sampleMonths ?? 0
    });
  }
  return rows;
}
