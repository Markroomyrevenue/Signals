import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptText } from "@/lib/crypto";
import { enqueueTenantSync } from "@/lib/queue/enqueue";

// Hostaway webhook payloads are mostly opaque — we only care about a few
// optional identifier hints so we can resolve which tenant the event belongs
// to. Any extra fields are tolerated; a totally empty body (Hostaway sends
// these for some events) is also fine because the single-tenant fallback
// in resolveTenantId handles it.
const webhookBodySchema = z
  .object({
    tenantId: z.string().trim().min(1).optional(),
    tenant_id: z.string().trim().min(1).optional(),
    hostawayAccountId: z.string().trim().min(1).optional(),
    hostaway_account_id: z.string().trim().min(1).optional(),
    hostawayClientId: z.string().trim().min(1).optional()
  })
  .passthrough();

type WebhookBody = z.infer<typeof webhookBodySchema>;

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

async function resolveTenantId(body: WebhookBody): Promise<string | null> {
  const tenantId = (body.tenantId ?? body.tenant_id ?? "").trim();
  if (tenantId) return tenantId;

  const hostawayAccountId = (body.hostawayAccountId ?? body.hostaway_account_id ?? "").trim();
  if (hostawayAccountId) {
    const connectionByAccount = await prisma.hostawayConnection.findFirst({
      where: { hostawayAccountId },
      select: { tenantId: true }
    });
    if (connectionByAccount?.tenantId) return connectionByAccount.tenantId;
  }

  const hostawayClientId = (body.hostawayClientId ?? "").trim();
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

export async function POST(request: Request) {
  // Hostaway sometimes sends an empty body for ping events — treat that as a
  // valid (but empty) shape so the single-tenant fallback below can resolve.
  const rawPayload = await request.json().catch(() => ({}));
  const parsed = webhookBodySchema.safeParse(rawPayload);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const payload = parsed.data;

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
