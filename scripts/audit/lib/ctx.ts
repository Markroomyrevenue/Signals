/**
 * Shared audit context — READ-ONLY against PROD.
 *
 * - `prisma` is the app's client (DATABASE_URL is overridden to the prod proxy
 *   by scripts/audit/run.sh).
 * - `getReadonlyGatewayForTenant` mirrors getHostawayGatewayForTenant but uses a
 *   no-op token writeback, so pulling reservations for the audit NEVER mutates
 *   the prod HostawayConnection row.
 *
 * Every query here is parameterised by tenantId — tenant isolation is preserved.
 */
import { decryptText } from "@/lib/crypto";
import { env } from "@/lib/env";
import { createHostawayClient } from "@/lib/hostaway/client";
import type { HostawayGateway } from "@/lib/hostaway/types";
import { prisma } from "@/lib/prisma";

export { prisma };

export type LiveTenant = { id: string; name: string };

export async function getLiveTenants(): Promise<LiveTenant[]> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  const out: LiveTenant[] = [];
  for (const t of tenants) {
    const conn = await prisma.hostawayConnection.findUnique({
      where: { tenantId: t.id },
      select: { status: true, hostawayClientId: true }
    });
    const listings = await prisma.listing.count({ where: { tenantId: t.id } });
    if (conn?.status === "active" && conn.hostawayClientId && listings > 0) out.push(t);
  }
  return out;
}

/** Read-only Hostaway gateway: real creds, but token writeback is a no-op. */
export async function getReadonlyGatewayForTenant(tenantId: string): Promise<HostawayGateway> {
  const connection = await prisma.hostawayConnection.findUnique({
    where: { tenantId },
    select: {
      hostawayClientId: true,
      hostawayClientSecretEncrypted: true,
      hostawayAccessTokenEncrypted: true,
      hostawayAccessTokenExpiresAt: true,
      hostawayAccountId: true
    }
  });
  if (!connection?.hostawayClientId || !connection.hostawayClientSecretEncrypted) {
    throw new Error(`Tenant ${tenantId} has no usable Hostaway credentials`);
  }

  const clientSecret = decryptText(connection.hostawayClientSecretEncrypted);

  const tokenStore = {
    async read() {
      const enc = connection.hostawayAccessTokenEncrypted;
      const exp = connection.hostawayAccessTokenExpiresAt;
      if (!enc || !exp || exp.getTime() <= Date.now()) return { token: null, expiresAt: null };
      try {
        return { token: decryptText(enc), expiresAt: exp };
      } catch {
        return { token: null, expiresAt: null };
      }
    },
    // NO-OP: never write a refreshed token back to prod during an audit.
    async write() {
      /* read-only audit */
    }
  };

  return createHostawayClient({
    baseUrl: env.hostawayBaseUrl,
    accountId: connection.hostawayAccountId,
    clientId: connection.hostawayClientId,
    clientSecret,
    tokenStore
  });
}

/** Pull ALL reservations for a tenant (paginated), with a hard page cap. */
export async function pullAllReservations(
  tenantId: string,
  opts: { maxPages?: number } = {}
): Promise<any[]> {
  const gw = await getReadonlyGatewayForTenant(tenantId);
  const maxPages = opts.maxPages ?? 500;
  const all: any[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await gw.fetchReservations({ page });
    all.push(...res.items);
    if (!res.hasMore || res.items.length === 0) break;
  }
  return all;
}

export function pct(a: number, b: number): number {
  return b === 0 ? 0 : (a / b) * 100;
}

export function fmtDelta(displayed: number, independent: number): { delta: number; pctDelta: number | null } {
  const delta = displayed - independent;
  const pctDelta = independent === 0 ? null : (delta / independent) * 100;
  return { delta, pctDelta };
}
