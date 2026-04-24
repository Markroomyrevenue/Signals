import { prisma } from "@/lib/prisma";

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

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
}
