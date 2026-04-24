import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { encryptText } from "@/lib/crypto";
import {
  assertUniqueHostawayConnection,
  HostawayConnectionConflictError
} from "@/lib/hostaway/hardening";

type ConnectionStatus = {
  dataMode: string;
  liveModeEnabled: boolean;
  hostawayClientId: string | null;
  hostawayAccountId: string | null;
  webhookBasicUser: string | null;
  hasClientSecret: boolean;
  tokenPresent: boolean;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
};

const bodySchema = z.object({
  hostawayClientId: z.string().trim().optional(),
  hostawayAccountId: z.string().trim().optional(),
  hostawayClientSecret: z.string().trim().optional(),
  webhookBasicUser: z.string().trim().optional(),
  webhookBasicPass: z.string().trim().optional()
});

function connectionDataMode(): string {
  return env.dataMode;
}

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dataMode = connectionDataMode();
  const connection = await prisma.hostawayConnection.findUnique({
    where: { tenantId: auth.tenantId },
    select: {
      hostawayClientId: true,
      hostawayAccountId: true,
      hostawayClientSecretEncrypted: true,
      webhookBasicUser: true,
      hostawayAccessTokenEncrypted: true,
      hostawayAccessTokenExpiresAt: true,
      lastSyncAt: true
    }
  });

  const now = new Date();
  const tokenExpiresAt = connection?.hostawayAccessTokenExpiresAt ? connection.hostawayAccessTokenExpiresAt.toISOString() : null;
  const tokenPresent = Boolean(
    connection?.hostawayAccessTokenEncrypted &&
      (!connection.hostawayAccessTokenExpiresAt || connection.hostawayAccessTokenExpiresAt > now)
  );

  const response: ConnectionStatus = {
    dataMode,
    liveModeEnabled: dataMode === "live",
    hostawayClientId: connection?.hostawayClientId ?? null,
    hostawayAccountId: connection?.hostawayAccountId ?? null,
    webhookBasicUser: connection?.webhookBasicUser ?? null,
    hasClientSecret: Boolean(connection?.hostawayClientSecretEncrypted),
    tokenPresent,
    tokenExpiresAt,
    lastSyncAt: connection?.lastSyncAt ? connection.lastSyncAt.toISOString() : null
  };

  return NextResponse.json(response);
}

export async function POST(req: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: z.infer<typeof bodySchema> = {};

  try {
    const body = await req.json();
    payload = bodySchema.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const hasCredentials =
    (payload.hostawayClientId !== undefined || payload.hostawayClientSecret !== undefined);
  const hasWebhookChange =
    payload.webhookBasicUser !== undefined || payload.webhookBasicPass !== undefined;

  if (hasCredentials && (!payload.hostawayClientId || !payload.hostawayClientSecret)) {
    return NextResponse.json(
      { error: "hostawayClientId and hostawayClientSecret must be provided together" },
      { status: 400 }
    );
  }

  if (!hasCredentials && !hasWebhookChange) {
    return NextResponse.json({ error: "No settings provided" }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {};
  const normalizedHostawayClientId = payload.hostawayClientId?.trim() || null;
  const normalizedHostawayAccountId = payload.hostawayAccountId?.trim() || null;

  if (hasCredentials && payload.hostawayClientId && payload.hostawayClientSecret) {
    updateData.hostawayClientId = normalizedHostawayClientId;
    updateData.hostawayClientSecretEncrypted = encryptText(payload.hostawayClientSecret);
    updateData.hostawayAccessTokenEncrypted = null;
    updateData.hostawayAccessTokenExpiresAt = null;
  }

  if (payload.hostawayAccountId !== undefined) {
    updateData.hostawayAccountId = normalizedHostawayAccountId;
  }

  if (payload.webhookBasicUser !== undefined) {
    updateData.webhookBasicUser = payload.webhookBasicUser || null;
  }

  if (payload.webhookBasicPass !== undefined) {
    updateData.webhookBasicPassEncrypted = payload.webhookBasicPass
      ? encryptText(payload.webhookBasicPass)
      : null;
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: "No changes to save" }, { status: 400 });
  }

  try {
    await assertUniqueHostawayConnection({
      tenantIdToExclude: auth.tenantId,
      hostawayClientId: normalizedHostawayClientId,
      hostawayAccountId: normalizedHostawayAccountId
    });

    await prisma.hostawayConnection.upsert({
      where: { tenantId: auth.tenantId },
      create: {
        tenantId: auth.tenantId,
        status: "active",
        ...updateData
      },
      update: updateData
    });
  } catch (error) {
    if (error instanceof HostawayConnectionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save settings" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
