import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createSession, getAuthContextFromSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildBookedReport } from "@/lib/reports/service";

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

async function main() {
  const runId = crypto.randomUUID().slice(0, 8);
  const sharedEmail = `tenant-isolation-${runId}@roomy.test`;
  const tenantIds: string[] = [];

  try {
    const seeded = await prisma.$transaction(async (tx) => {
      const tenantA = await tx.tenant.create({
        data: {
          name: `Isolation A ${runId}`,
          defaultCurrency: "GBP",
          timezone: "Europe/London"
        }
      });

      const tenantB = await tx.tenant.create({
        data: {
          name: `Isolation B ${runId}`,
          defaultCurrency: "GBP",
          timezone: "Europe/London"
        }
      });

      const userA = await tx.user.create({
        data: {
          tenantId: tenantA.id,
          email: sharedEmail,
          passwordHash: "tenant-isolation-hash"
        }
      });

      const userB = await tx.user.create({
        data: {
          tenantId: tenantB.id,
          email: sharedEmail,
          passwordHash: "tenant-isolation-hash"
        }
      });

      const listingA = await tx.listing.create({
        data: {
          tenantId: tenantA.id,
          hostawayId: `hostaway-a-${runId}`,
          name: `Alpha ${runId}`,
          status: "active",
          timezone: "Europe/London"
        }
      });

      const listingB = await tx.listing.create({
        data: {
          tenantId: tenantB.id,
          hostawayId: `hostaway-b-${runId}`,
          name: `Bravo ${runId}`,
          status: "active",
          timezone: "Europe/London"
        }
      });

      const bookingDate = utcDate(2026, 2, 15);

      await tx.reservation.create({
        data: {
          tenantId: tenantA.id,
          hostawayId: `reservation-a-${runId}`,
          listingId: listingA.id,
          channel: "airbnb",
          status: "confirmed",
          createdAt: bookingDate,
          confirmedAt: bookingDate,
          arrival: utcDate(2026, 5, 10),
          departure: utcDate(2026, 5, 12),
          nights: 2,
          guests: 2,
          currency: "GBP",
          total: 110,
          accommodationFare: 100,
          cleaningFee: 10,
          guestFee: 0,
          taxes: 0,
          commission: 0,
          cancelledAt: null,
          sourceUpdatedAt: bookingDate,
          rawJson: {
            createdAt: bookingDate.toISOString()
          }
        }
      });

      await tx.reservation.create({
        data: {
          tenantId: tenantB.id,
          hostawayId: `reservation-b-${runId}`,
          listingId: listingB.id,
          channel: "booking.com",
          status: "confirmed",
          createdAt: bookingDate,
          confirmedAt: bookingDate,
          arrival: utcDate(2026, 5, 15),
          departure: utcDate(2026, 5, 18),
          nights: 3,
          guests: 2,
          currency: "GBP",
          total: 260,
          accommodationFare: 240,
          cleaningFee: 20,
          guestFee: 0,
          taxes: 0,
          commission: 0,
          cancelledAt: null,
          sourceUpdatedAt: bookingDate,
          rawJson: {
            createdAt: bookingDate.toISOString()
          }
        }
      });

      return {
        tenantA,
        tenantB,
        userA,
        userB,
        listingA,
        listingB
      };
    });

    tenantIds.push(seeded.tenantA.id, seeded.tenantB.id);

    const [sessionTokenA, sessionTokenB] = await Promise.all([
      createSession(seeded.userA.id, seeded.tenantA.id),
      createSession(seeded.userB.id, seeded.tenantB.id)
    ]);

    const [authA, authB] = await Promise.all([
      getAuthContextFromSessionToken(sessionTokenA),
      getAuthContextFromSessionToken(sessionTokenB)
    ]);

    assert(authA, "Expected session A to resolve an auth context.");
    assert(authB, "Expected session B to resolve an auth context.");
    assert.equal(authA.email, sharedEmail);
    assert.equal(authB.email, sharedEmail);
    assert.equal(authA.tenantId, seeded.tenantA.id);
    assert.equal(authB.tenantId, seeded.tenantB.id);

    const request = {
      stayDateFrom: "2026-03-15",
      stayDateTo: "2026-03-15",
      granularity: "day" as const,
      listingIds: [seeded.listingA.id, seeded.listingB.id],
      channels: [],
      statuses: [],
      includeFees: true,
      barMetric: "revenue" as const,
      compareMode: "yoy_otb" as const
    };

    const [reportA, reportB] = await Promise.all([
      buildBookedReport({
        tenantId: authA.tenantId,
        request,
        displayCurrency: "GBP"
      }),
      buildBookedReport({
        tenantId: authB.tenantId,
        request,
        displayCurrency: "GBP"
      })
    ]);

    const revenueA = reportA.current.revenue.reduce((sum, value) => sum + value, 0);
    const revenueB = reportB.current.revenue.reduce((sum, value) => sum + value, 0);

    assert.equal(revenueA, 110);
    assert.equal(revenueB, 260);
    assert.equal(reportA.meta.comparisonScope?.totalListings, 1);
    assert.equal(reportA.meta.comparisonScope?.appliedListings, 1);
    assert.equal(reportB.meta.comparisonScope?.totalListings, 1);
    assert.equal(reportB.meta.comparisonScope?.appliedListings, 1);

    console.log("Tenant isolation check passed.");
  } finally {
    if (tenantIds.length > 0) {
      await prisma.tenant.deleteMany({
        where: {
          id: { in: tenantIds }
        }
      });
    }

    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Tenant isolation check failed.");
  process.exitCode = 1;
});
