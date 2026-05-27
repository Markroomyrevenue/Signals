/**
 * Snapshot row dedup helper (2026-05-27 PM trial-report fix).
 *
 * ## Why
 *
 * `pricing_comparison_snapshots` is append-only — each agent run does
 * `prisma.pricingComparisonSnapshot.createMany(...)` with no upsert
 * key. There's no `runId` column; the only differentiator between two
 * runs writing the same `(tenantId, listingId, targetDate,
 * snapshotDate)` tuple is `createdAt`.
 *
 * Production hits this only in degenerate cases (the scheduled 06:00
 * London run is the only writer, and it runs once per day per tenant).
 * Manual reruns of `npx tsx scripts/run-comparison.ts` during the
 * trial — common while iterating — produce N copies per tuple, and
 * the report aggregations (`report-html.ts`, `summary-email.ts`)
 * blend all of them. Today's verification surfaced this when the
 * floor-hit % read 30.4% across-all-runs instead of 0% on the latest
 * run alone.
 *
 * ## Fix
 *
 * After every read of `pricing_comparison_snapshots` that aggregates
 * for the report path, pipe through `dedupSnapshotRows`: keeps only
 * the row with the largest `createdAt` for each
 * `(tenantId, listingId, targetDate, snapshotDate)` tuple. In-memory
 * dedup is fine at trial scale (~17k rows max per snapshot date today
 * across all reruns); avoids reaching for `$queryRaw` + DISTINCT ON
 * just yet. Revisit if row count grows materially.
 *
 * The schema-level fix (add `runId` column or upsert on the tuple
 * with `@@unique`) is a bigger spec — flagged for after the trial
 * decision date.
 */

type DedupKeyed = {
  tenantId: string;
  listingId: string;
  targetDate: Date;
  snapshotDate: Date;
  createdAt: Date;
};

/**
 * Keep only the row with the latest `createdAt` for each
 * `(tenantId, listingId, targetDate, snapshotDate)` tuple.
 *
 * Stable on ties (uses the iteration order, last-seen-wins among
 * rows with identical createdAt; in practice createdAt has
 * millisecond precision and ties are negligible).
 */
export function dedupSnapshotRows<T extends DedupKeyed>(rows: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.tenantId}|${row.listingId}|${row.targetDate.toISOString()}|${row.snapshotDate.toISOString()}`;
    const existing = byKey.get(key);
    if (!existing || row.createdAt.getTime() >= existing.createdAt.getTime()) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}
