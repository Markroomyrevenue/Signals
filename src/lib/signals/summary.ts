/**
 * Signals rate scanner — read-only monthly roll-up.
 *
 * Powers the key-gated `/api/signals/monthly-summary` endpoint that a Cowork
 * scheduled task fetches mid-month. SELECT-only across the four signals tables
 * (+ tenant names); it never writes and never calls an existing service.
 *
 * Each tenant's queries are filtered by `tenantId`; the "across all tenants"
 * portfolio view is assembled by iterating tenants and rolling up the per-tenant
 * results, so the tenant-isolation rule (every signals query filters by
 * `tenantId`) still holds.
 */

import { toDateOnly } from "@/lib/metrics/helpers";
import { prisma } from "@/lib/prisma";

import { computeMedian } from "./baseline";
import { LEVERS, type Lever } from "./config";

export type LeverBreakdown = Record<Lever, number>;

export type PriceMoveStats = {
  count: number;
  median: number | null;
  min: number | null;
  max: number | null;
};

export type ConvertedMove = {
  listingId: string;
  stayDate: string;
  oldValue: number | null;
  newValue: number | null;
  changePct: number | null;
  pctOfYearlyAdr: number | null;
};

export type TenantSummary = {
  tenantId: string;
  tenantName: string;
  scansRun: number;
  totalChanges: number;
  leverBreakdown: LeverBreakdown;
  priceChangePct: PriceMoveStats;
  convertedWithin48h: number;
  topConvertedMoves: ConvertedMove[];
};

export type PortfolioSummary = {
  tenantCount: number;
  scansRun: number;
  totalChanges: number;
  leverBreakdown: LeverBreakdown;
  priceChangePct: PriceMoveStats;
  convertedWithin48h: number;
};

export type MonthlySignalsSummary = {
  month: string; // YYYY-MM
  rangeStart: string; // ISO
  rangeEnd: string; // ISO (exclusive)
  tenants: TenantSummary[];
  portfolio: PortfolioSummary;
};

/** A `RateChange` row reduced to the fields the roll-up needs. DB-free shape. */
export type ChangeRow = {
  id: string;
  listingId: string;
  lever: string;
  date: string; // yyyy-mm-dd (stay date)
  oldValue: number | null;
  newValue: number | null;
  changePct: number | null;
  pctOfYearlyAdr: number | null;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TOP_CONVERTED_MOVES = 3;

/**
 * Max ids per `IN (...)` lookup. Postgres caps a single statement at 32767 bind
 * parameters; chunking the id list well under that keeps the converted-changes
 * lookup safe no matter how many changes a tenant logs in a month. (A tenant
 * crossing ~32.7k changes in one month previously crashed the whole summary.)
 */
const ID_LOOKUP_CHUNK = 1000;

/** Split an array into fixed-size chunks. Pure. */
function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function emptyLeverBreakdown(): LeverBreakdown {
  return LEVERS.reduce((acc, lever) => {
    acc[lever] = 0;
    return acc;
  }, {} as LeverBreakdown);
}

/**
 * Resolve the calendar month to summarise into a half-open UTC range
 * `[start, end)`. Pure. Defaults to the month that just ended relative to `now`.
 */
export function resolveMonthRange(month: string | undefined, now: Date): { month: string; start: Date; end: Date } {
  let year: number;
  let monthIndex: number; // 0-based
  if (month && MONTH_RE.test(month)) {
    const [y, m] = month.split("-").map(Number);
    year = y;
    monthIndex = m - 1;
  } else {
    // The month that just ended: step back one month from the current month.
    year = now.getUTCFullYear();
    monthIndex = now.getUTCMonth() - 1;
  }
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { month: label, start, end };
}

/** Median / min / max of a set of price `changePct` ratios. Pure. */
export function summarizePriceChangePcts(values: number[]): PriceMoveStats {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) {
    return { count: 0, median: null, min: null, max: null };
  }
  return {
    count: usable.length,
    median: computeMedian(usable),
    min: Math.min(...usable),
    max: Math.max(...usable)
  };
}

/**
 * Build one tenant's summary from its month of changes + the set of change ids
 * that converted (had a booking land within 48h). Pure — the DB wrapper feeds it.
 */
export function summarizeTenantChanges(args: {
  tenantId: string;
  tenantName: string;
  scansRun: number;
  changes: ChangeRow[];
  convertedChangeIds: Set<string>;
}): TenantSummary {
  const { tenantId, tenantName, scansRun, changes, convertedChangeIds } = args;

  const leverBreakdown = emptyLeverBreakdown();
  for (const change of changes) {
    if ((LEVERS as readonly string[]).includes(change.lever)) {
      leverBreakdown[change.lever as Lever] += 1;
    }
  }

  const priceChangePcts = changes
    .filter((change) => change.lever === "price" && change.changePct !== null)
    .map((change) => change.changePct as number);

  const topConvertedMoves = changes
    .filter(
      (change) =>
        change.lever === "price" && change.changePct !== null && convertedChangeIds.has(change.id)
    )
    .sort((a, b) => Math.abs(b.changePct as number) - Math.abs(a.changePct as number))
    .slice(0, TOP_CONVERTED_MOVES)
    .map((change) => ({
      listingId: change.listingId,
      stayDate: change.date,
      oldValue: change.oldValue,
      newValue: change.newValue,
      changePct: change.changePct,
      pctOfYearlyAdr: change.pctOfYearlyAdr
    }));

  const convertedWithin48h = changes.filter((change) => convertedChangeIds.has(change.id)).length;

  return {
    tenantId,
    tenantName,
    scansRun,
    totalChanges: changes.length,
    leverBreakdown,
    priceChangePct: summarizePriceChangePcts(priceChangePcts),
    convertedWithin48h,
    topConvertedMoves
  };
}

/** Roll per-tenant summaries up into a single portfolio view. Pure. */
export function rollUpPortfolio(tenants: TenantSummary[], allPriceChangePcts: number[]): PortfolioSummary {
  const leverBreakdown = emptyLeverBreakdown();
  let scansRun = 0;
  let totalChanges = 0;
  let convertedWithin48h = 0;
  for (const tenant of tenants) {
    scansRun += tenant.scansRun;
    totalChanges += tenant.totalChanges;
    convertedWithin48h += tenant.convertedWithin48h;
    for (const lever of LEVERS) {
      leverBreakdown[lever] += tenant.leverBreakdown[lever];
    }
  }
  return {
    tenantCount: tenants.length,
    scansRun,
    totalChanges,
    leverBreakdown,
    priceChangePct: summarizePriceChangePcts(allPriceChangePcts),
    convertedWithin48h
  };
}

/**
 * Assemble the trailing-month signals summary across all tenants. SELECT-only.
 *
 * For each tenant it counts scans, pulls the month's changes, finds which of
 * those changes converted (linked `BookingRateContext`), and builds the tenant
 * summary; then it rolls everything into a portfolio view.
 */
export async function buildMonthlySignalsSummary(args: {
  month?: string;
  now?: Date;
}): Promise<MonthlySignalsSummary> {
  const { month, start, end } = resolveMonthRange(args.month, args.now ?? new Date());

  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });

  const tenantSummaries: TenantSummary[] = [];
  const allPriceChangePcts: number[] = [];

  for (const tenant of tenants) {
    const scansRun = await prisma.rateScan.count({
      where: { tenantId: tenant.id, scannedAt: { gte: start, lt: end } }
    });

    const changeRows = await prisma.rateChange.findMany({
      where: { tenantId: tenant.id, detectedAt: { gte: start, lt: end } },
      select: {
        id: true,
        listingId: true,
        lever: true,
        date: true,
        oldValue: true,
        newValue: true,
        changePct: true,
        pctOfYearlyAdr: true
      }
    });

    const changes: ChangeRow[] = changeRows.map((row) => ({
      id: row.id,
      listingId: row.listingId,
      lever: row.lever,
      date: toDateOnly(row.date),
      oldValue: row.oldValue === null ? null : Number(row.oldValue),
      newValue: row.newValue === null ? null : Number(row.newValue),
      changePct: row.changePct === null ? null : Number(row.changePct),
      pctOfYearlyAdr: row.pctOfYearlyAdr === null ? null : Number(row.pctOfYearlyAdr)
    }));

    const changeIds = changes.map((change) => change.id);
    // Chunk the id list so the `IN (...)` lookup never exceeds Postgres's
    // 32767 bind-parameter cap (tenantId + ids must stay under it).
    const convertedChangeIds = new Set<string>();
    for (const idChunk of chunkArray(changeIds, ID_LOOKUP_CHUNK)) {
      const converted = await prisma.bookingRateContext.findMany({
        where: { tenantId: tenant.id, rateChangeId: { in: idChunk } },
        select: { rateChangeId: true }
      });
      for (const row of converted) {
        if (row.rateChangeId !== null) convertedChangeIds.add(row.rateChangeId);
      }
    }

    for (const change of changes) {
      if (change.lever === "price" && change.changePct !== null) allPriceChangePcts.push(change.changePct);
    }

    tenantSummaries.push(
      summarizeTenantChanges({
        tenantId: tenant.id,
        tenantName: tenant.name,
        scansRun,
        changes,
        convertedChangeIds
      })
    );
  }

  return {
    month,
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    tenants: tenantSummaries,
    portfolio: rollUpPortfolio(tenantSummaries, allPriceChangePcts)
  };
}
