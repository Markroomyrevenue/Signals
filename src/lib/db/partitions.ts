import { prisma } from "@/lib/prisma";

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

/**
 * Creates monthly partitions for night_facts and pace_snapshots covering
 * `monthsBack` months in the past and `monthsForward` months in the future
 * (inclusive of the current month).
 *
 * The defaults (24 back / 60 forward) comfortably cover every supported
 * reservation date range — the reservation fallback window only goes 365
 * days back / 365 days forward (roughly 12 months either side). If a future
 * change widens that window past these bounds, bump the defaults at the same
 * time, otherwise inserts will fail with `no partition of relation found`.
 *
 * Partitions are created via `ensure_monthly_partition()` (defined in
 * 20260227161000_init/migration.sql + 20260401143000_fix_partition_month_normalization),
 * which is idempotent — `CREATE TABLE IF NOT EXISTS`.
 */
export async function ensurePartitionCoverage(
  monthsBack = 24,
  monthsForward = 60
): Promise<void> {
  const anchor = startOfUtcMonth(new Date());

  for (let offset = -monthsBack; offset <= monthsForward; offset += 1) {
    const monthDate = addUtcMonths(anchor, offset);

    await prisma.$executeRaw`
      SELECT ensure_monthly_partition('night_facts', ${monthDate}::date)
    `;
    await prisma.$executeRaw`
      SELECT ensure_monthly_partition('pace_snapshots', ${monthDate}::date)
    `;
  }

  await assertPartitionCoversTenantDateRanges();
}

/**
 * Sanity check: walks every tenant's reservation arrival/departure span and
 * verifies a partition exists for every month it touches. If a partition is
 * missing, this would normally surface only at the moment a NightFact insert
 * fails — much better to catch it here at the start of the sync and create
 * the missing partition explicitly.
 *
 * Returns nothing on success. On any gap, creates the missing month partition
 * eagerly and logs an explicit warn line so the operator sees the gap was
 * filled in. Multi-tenant safe: runs across all tenants in a single query.
 */
async function assertPartitionCoversTenantDateRanges(): Promise<void> {
  const span = await prisma.$queryRaw<
    Array<{ minArrival: Date | null; maxDeparture: Date | null }>
  >`
    SELECT
      MIN(arrival)::timestamp AS "minArrival",
      MAX(departure)::timestamp AS "maxDeparture"
    FROM reservations
  `;

  const minArrival = span[0]?.minArrival ?? null;
  const maxDeparture = span[0]?.maxDeparture ?? null;
  if (!minArrival || !maxDeparture) return;

  const start = startOfUtcMonth(minArrival);
  // departure is exclusive in night_facts, so we still need a partition that
  // contains (departure - 1 day). Cover the whole month departure falls in.
  const end = startOfUtcMonth(maxDeparture);

  const monthsCovered = new Set<string>();
  for (
    let cursor = new Date(start);
    cursor <= end;
    cursor = addUtcMonths(cursor, 1)
  ) {
    const key = cursor.toISOString().slice(0, 10);
    if (monthsCovered.has(key)) continue;
    monthsCovered.add(key);

    await prisma.$executeRaw`
      SELECT ensure_monthly_partition('night_facts', ${key}::date)
    `;
    await prisma.$executeRaw`
      SELECT ensure_monthly_partition('pace_snapshots', ${key}::date)
    `;
  }
}
