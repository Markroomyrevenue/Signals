import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptText } from "@/lib/crypto";
import { enqueueTenantSync } from "@/lib/queue/enqueue";

function parseBasicAuth(request: Request): { user: string; pass: string } | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const match = header.match(/^basic\s+(.+)$/i);
  if (!match) return null;

  const encoded = match[1] ?? "";
  const decoded = (() => {
    try {
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return "";
    }
  })();

  const separator = decoded.indexOf(":");
  if (separator < 1) return null;

  return {
    user: decoded.slice(0, separator),
    pass: decoded.slice(separator + 1)
  };
}

function credentialsMatch(requestAuth: { user: string; pass: string } | null, expectedUser: string, expectedPass: string): boolean {
  if (!requestAuth) return false;
  return requestAuth.user === expectedUser && requestAuth.pass === expectedPass;
}

async function resolveTenantId(payload: unknown): Promise<string | null> {
  const body = isRecord(payload) ? payload : null;
  const tenantId =
    (typeof body?.tenantId === "string" ? body.tenantId : "") || (typeof body?.tenant_id === "string" ? body.tenant_id : "");
  if (tenantId) return tenantId;

  const hostawayAccountId =
    typeof body?.hostawayAccountId === "string" ? body.hostawayAccountId : typeof body?.hostaway_account_id === "string"
      ? body.hostaway_account_id
      : "";
  if (hostawayAccountId) {
    const connectionByAccount = await prisma.hostawayConnection.findFirst({
      where: { hostawayAccountId },
      select: { tenantId: true }
    });
    if (connectionByAccount?.tenantId) return connectionByAccount.tenantId;
  }

  const hostawayClientId = typeof body?.hostawayClientId === "string" ? body.hostawayClientId : "";
  if (hostawayClientId) {
    const connectionByClientId = await prisma.hostawayConnection.findFirst({
      where: { hostawayClientId },
      select: { tenantId: true }
    });
    if (connectionByClientId?.tenantId) return connectionByClientId.tenantId;
  }

  // Fallback: if only one tenant exists, use it (common single-tenant setup)
  const allConnections = await prisma.hostawayConnection.findMany({
    select: { tenantId: true },
    take: 2
  });
  if (allConnections.length === 1) {
    return allConnections[0].tenantId;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }

  const tenantId = await resolveTenantId(payload);
  if (!tenantId) {
    return NextResponse.json({ error: "Unable to resolve tenant" }, { status: 400 });
  }

  const connection = await prisma.hostawayConnection.findUnique({
    where: { tenantId },
    select: {
      webhookBasicUser: true,
      webhookBasicPassEncrypted: true
    }
  });

  const tenantCredsUser = connection?.webhookBasicUser;
  const tenantCredsPass =
    connection?.webhookBasicPassEncrypted ?
      (() => {
        try {
          return decryptText(connection.webhookBasicPassEncrypted);
        } catch {
          return "";
        }
      })()
      : "";

  const envCredsUser = env.webhookBasicUser;
  const envCredsPass = env.webhookBasicPass;

  const expectedUser = tenantCredsUser || envCredsUser;
  const expectedPass = tenantCredsPass || envCredsPass;

  if (expectedUser && expectedPass) {
    const basicAuth = parseBasicAuth(request);
    if (!credentialsMatch(basicAuth, expectedUser, expectedPass)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const job = await enqueueTenantSync({
    tenantId,
    reason: "webhook_reservation_incremental"
  });

  return NextResponse.json({
    accepted: true,
    reason: "webhook_reservation_incremental",
    jobId: job.id
  });
}
