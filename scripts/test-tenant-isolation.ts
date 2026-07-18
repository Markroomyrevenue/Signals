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

    // --- Recs-page tables (2026-07-18): every read path is tenant-scoped ----
    await prisma.recsEvidence.create({
      data: {
        tenantId: seeded.tenantA.id,
        clientKey: seeded.tenantA.id,
        kind: "mark-prior",
        payload: { bands: [{ leadBucket: "4-7", medianDropPct: 0.08, p25: 0.05, p75: 0.12, n: 30 }], window: "test" }
      }
    });
    await prisma.recsMarketSnapshot.create({
      data: {
        tenantId: seeded.tenantA.id,
        engine: "pricelabs",
        kind: "pl_neighborhood",
        engineListingId: "iso-a",
        day: utcDate(2026, 6, 1),
        payload: { days: [] }
      }
    });
    await prisma.oversightRun.create({
      data: {
        tenantId: seeded.tenantA.id,
        clientKey: seeded.tenantA.id,
        model: "test-model",
        status: "ok",
        suggestionCount: 0
      }
    });
    await prisma.suggestion.create({
      data: {
        tenantId: seeded.tenantA.id,
        clientKey: seeded.tenantA.id,
        listingId: seeded.listingA.id,
        dateFrom: utcDate(2026, 7, 1),
        dateTo: utcDate(2026, 7, 1),
        lever: "price",
        type: "recs-night",
        reason: "isolation-test",
        status: "pending",
        oldValue: 100,
        proposedValue: 90,
        provenance: "warm-start",
        provisional: true,
        detail: { recsPage: true }
      }
    });

    // Cross-tenant reads must come back empty for tenant B.
    const evidenceForB = await prisma.recsEvidence.findMany({ where: { tenantId: seeded.tenantB.id } });
    assert.equal(evidenceForB.length, 0, "Tenant B must not see tenant A's recs evidence.");
    const snapshotsForB = await prisma.recsMarketSnapshot.findMany({ where: { tenantId: seeded.tenantB.id } });
    assert.equal(snapshotsForB.length, 0, "Tenant B must not see tenant A's market snapshots.");
    const oversightForB = await prisma.oversightRun.findMany({ where: { tenantId: seeded.tenantB.id } });
    assert.equal(oversightForB.length, 0, "Tenant B must not see tenant A's oversight runs.");

    // The recs client view is tenant-scoped end-to-end: tenant B's view never
    // contains tenant A's listings/nights, even though A has pending rows.
    const { loadRecsClientView } = await import("@/lib/recs/data");
    const viewB = await loadRecsClientView(seeded.tenantB.id);
    assert(viewB, "Tenant B recs view should resolve.");
    assert.equal(viewB.listings.length, 0, "Tenant B's recs view must not contain tenant A's nights.");
    const viewA = await loadRecsClientView(seeded.tenantA.id);
    assert(viewA, "Tenant A recs view should resolve.");
    assert.equal(viewA.listings.length, 1, "Tenant A's recs view should contain its own night.");
    assert.equal(viewA.listings[0]?.listingId, seeded.listingA.id);

    // The internal-recs gate is closed by default in this environment (no
    // RECS_PAGE_ENABLED / INTERNAL_RECS_EMAILS set): even an admin session
    // must NOT pass — client-tenant admins can never reach the page.
    const { isInternalRecsUser } = await import("@/lib/recs/auth");
    assert.equal(
      isInternalRecsUser({ role: "admin", email: sharedEmail }),
      false,
      "A client-tenant admin must never pass the internal recs gate."
    );

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
    const leftoverRecs = await Promise.all([
      prisma.recsEvidence.count({ where: { tenantId: seeded.tenantA.id } }),
      prisma.recsMarketSnapshot.count({ where: { tenantId: seeded.tenantA.id } }),
      prisma.oversightRun.count({ where: { tenantId: seeded.tenantA.id } })
    ]);
    assert.deepEqual(leftoverRecs, [0, 0, 0], "Recs tables must cascade-delete with their tenant.");

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
