/**
 * PMS routing for the sync engine.
 *
 * `getGatewayForTenant` decides — based on the tenant's `pmsType` —
 * whether to return the existing Hostaway gateway or a fresh Avantio
 * gateway. The downstream engine only ever sees `HostawayGateway`
 * (the normalized contract from `src/lib/hostaway/types.ts`), so this
 * is the only place that needs to know which PMS is wired up.
 *
 * `getConnectionMeta` and `touchLastSync` give the engine the same
 * `lastSyncAt` plumbing it has today, but routed by `pmsType` so an
 * Avantio tenant gets its own delta window and post-sync watermark.
 *
 * Multi-tenant isolation: every Prisma query here filters by
 * `tenantId`. Hostaway tenants keep the exact behaviour they had
 * before (default `pmsType` is "HOSTAWAY").
 */

import { decryptText } from "@/lib/crypto";
import { createAvantioGateway } from "@/lib/avantio/gateway";
import { createGuestyGateway } from "@/lib/guesty/gateway";
import { createDbGuestyTokenProvider } from "@/lib/guesty/token";
import { getHostawayGatewayForTenant } from "@/lib/hostaway";
import type { HostawayGateway } from "@/lib/hostaway/types";
import { prisma } from "@/lib/prisma";

export type PmsType = "HOSTAWAY" | "AVANTIO" | "GUESTY";

export type ConnectionMeta = {
  lastSyncAt: Date | null;
};

export async function readPmsType(tenantId: string): Promise<PmsType> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { pmsType: true }
  });
  if (!tenant) {
    throw new Error(`pms.getGatewayForTenant: tenant ${tenantId} not found`);
  }
  if (tenant.pmsType === "AVANTIO") return "AVANTIO";
  if (tenant.pmsType === "GUESTY") return "GUESTY";
  return "HOSTAWAY";
}

export async function getGatewayForTenant(tenantId: string): Promise<HostawayGateway> {
  const pmsType = await readPmsType(tenantId);

  if (pmsType === "AVANTIO") {
    const connection = await prisma.avantioConnection.findUnique({
      where: { tenantId },
      select: { apiKeyEncrypted: true, baseUrl: true }
    });
    if (!connection) {
      throw new Error(
        `pms.getGatewayForTenant: tenant ${tenantId} has pmsType=AVANTIO but no AvantioConnection row`
      );
    }
    if (!connection.apiKeyEncrypted) {
      throw new Error(
        `pms.getGatewayForTenant: tenant ${tenantId} AvantioConnection is missing apiKeyEncrypted`
      );
    }

    const apiKey = decryptText(connection.apiKeyEncrypted);
    return createAvantioGateway({ baseUrl: connection.baseUrl, apiKey });
  }

  if (pmsType === "GUESTY") {
    const connection = await prisma.guestyConnection.findUnique({
      where: { tenantId },
      select: { clientIdEncrypted: true, clientSecretEncrypted: true }
    });
    if (!connection) {
      throw new Error(
        `pms.getGatewayForTenant: tenant ${tenantId} has pmsType=GUESTY but no GuestyConnection row`
      );
    }
    if (!connection.clientIdEncrypted || !connection.clientSecretEncrypted) {
      throw new Error(
        `pms.getGatewayForTenant: tenant ${tenantId} GuestyConnection is missing credentials`
      );
    }
    // Token lifecycle lives in the DB-backed provider (5-token/24h quota).
    return createGuestyGateway({ tokenProvider: createDbGuestyTokenProvider(tenantId) });
  }

  return getHostawayGatewayForTenant(tenantId);
}

export async function getConnectionMeta(tenantId: string): Promise<ConnectionMeta> {
  const pmsType = await readPmsType(tenantId);
  if (pmsType === "AVANTIO") {
    const row = await prisma.avantioConnection.findUnique({
      where: { tenantId },
      select: { lastSyncAt: true }
    });
    return { lastSyncAt: row?.lastSyncAt ?? null };
  }
  if (pmsType === "GUESTY") {
    const row = await prisma.guestyConnection.findUnique({
      where: { tenantId },
      select: { lastSyncAt: true }
    });
    return { lastSyncAt: row?.lastSyncAt ?? null };
  }
  const row = await prisma.hostawayConnection.findUnique({
    where: { tenantId },
    select: { lastSyncAt: true }
  });
  return { lastSyncAt: row?.lastSyncAt ?? null };
}

export async function touchLastSync(tenantId: string): Promise<void> {
  const pmsType = await readPmsType(tenantId);
  const now = new Date();
  if (pmsType === "AVANTIO") {
    await prisma.avantioConnection.update({
      where: { tenantId },
      data: { lastSyncAt: now, status: "active" }
    });
    return;
  }
  if (pmsType === "GUESTY") {
    await prisma.guestyConnection.update({
      where: { tenantId },
      data: { lastSyncAt: now, status: "active" }
    });
    return;
  }
  await prisma.hostawayConnection.update({
    where: { tenantId },
    data: { lastSyncAt: now, status: "active" }
  });
}
