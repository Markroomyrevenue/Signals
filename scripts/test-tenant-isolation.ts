import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createSession, getAuthContextFromSessionToken } from "@/lib/auth";
import { encryptText } from "@/lib/crypto";
import { getConnectionMeta, readPmsType } from "@/lib/pms";
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

      // Tenant B is a GUESTY tenant with an encrypted connection row so the
      // multi-PMS routing + connection-table isolation get exercised too.
      const tenantB = await tx.tenant.create({
        data: {
          name: `Isolation B ${runId}`,
          defaultCurrency: "GBP",
          timezone: "Europe/London",
          pmsType: "GUESTY"
        }
      });

      await tx.guestyConnection.create({
        data: {
          tenantId: tenantB.id,
          clientIdEncrypted: encryptText(`isolation-client-${runId}`),
          clientSecretEncrypted: encryptText(`isolation-secret-${runId}`)
        }
      });

      await tx.avantioConnection.create({
        data: {
          tenantId: tenantA.id,
          apiKeyEncrypted: null
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
      includeVat: true,
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

    // Multi-PMS routing + connection isolation: each tenant resolves its
    // own pmsType, and one tenant's connection rows are invisible to the
    // other (connection tables are keyed by tenantId).
    assert.equal(await readPmsType(seeded.tenantA.id), "HOSTAWAY");
    assert.equal(await readPmsType(seeded.tenantB.id), "GUESTY");

    const guestyForA = await prisma.guestyConnection.findUnique({
      where: { tenantId: seeded.tenantA.id }
    });
    assert.equal(guestyForA, null, "Tenant A must not see tenant B's Guesty connection.");

    const avantioForB = await prisma.avantioConnection.findUnique({
      where: { tenantId: seeded.tenantB.id }
    });
    assert.equal(avantioForB, null, "Tenant B must not see tenant A's Avantio connection.");

    const metaB = await getConnectionMeta(seeded.tenantB.id);
    assert.equal(metaB.lastSyncAt, null, "Fresh Guesty connection should have no watermark.");

    // Tenant deletion must clean up a non-Hostaway tenant completely —
    // connection rows cascade with the tenant.
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    const leftoverGuesty = await prisma.guestyConnection.findUnique({
      where: { tenantId: seeded.tenantB.id }
    });
    const leftoverAvantio = await prisma.avantioConnection.findUnique({
      where: { tenantId: seeded.tenantA.id }
    });
    assert.equal(leftoverGuesty, null, "Guesty connection must cascade-delete with its tenant.");
    assert.equal(leftoverAvantio, null, "Avantio connection must cascade-delete with its tenant.");

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
