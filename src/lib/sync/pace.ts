import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fromDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function writeSnapshotForDate(tenantId: string, snapshotDate: Date): Promise<void> {
  const snapshotDateOnly = fromDateOnly(toDateOnly(snapshotDate));

  await prisma.$transaction([
    prisma.paceSnapshot.deleteMany({
      where: {
        tenantId,
        snapshotDate: snapshotDateOnly
      }
    }),
    prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO pace_snapshots (
          tenant_id,
          snapshot_date,
          listing_id,
          stay_date,
          nights_on_books,
          revenue_on_books,
          currency,
          created_at
        )
        SELECT
          nf.tenant_id,
          ${snapshotDateOnly}::date AS snapshot_date,
          nf.listing_id,
          nf.date AS stay_date,
          COUNT(*) AS nights_on_books,
          COALESCE(SUM(
            CASE
              WHEN nf.is_occupied = false AND COALESCE(nf.los_nights, 0) > 0
                THEN COALESCE(r.accommodation_fare, 0) / nf.los_nights
              ELSE nf.revenue_allocated
            END
          ), 0)::numeric(18, 6) AS revenue_on_books,
          MIN(nf.currency) AS currency,
          NOW() AS created_at
        FROM night_facts nf
        LEFT JOIN reservations r ON r.id = nf.reservation_id
        WHERE nf.tenant_id = ${tenantId}
          AND (nf.booking_created_at IS NULL OR DATE(nf.booking_created_at) <= ${snapshotDateOnly}::date)
          AND (
            nf.is_occupied = true
            OR (
              COALESCE(nf.status, '') IN ('cancelled', 'canceled')
              AND r.cancelled_at IS NOT NULL
              AND r.cancelled_at > ${snapshotDateOnly}::date
            )
          )
        GROUP BY nf.tenant_id, nf.listing_id, nf.date
      `
    )
  ]);
}

export async function runPaceSnapshotForTenant(
  tenantId: string,
  snapshotDate: Date,
  backfillDays = 0
): Promise<void> {
  const anchor = fromDateOnly(toDateOnly(snapshotDate));
  const start = addUtcDays(anchor, -Math.max(0, backfillDays));

  for (let cursor = new Date(start); cursor <= anchor; cursor = addUtcDays(cursor, 1)) {
    await writeSnapshotForDate(tenantId, cursor);
  }
}

export async function runPaceSnapshotForAllTenants(snapshotDate = new Date(), backfillDays = 0): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    select: { id: true }
  });

  for (const tenant of tenants) {
    await runPaceSnapshotForTenant(tenant.id, snapshotDate, backfillDays);
  }
}
