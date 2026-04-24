import { NextResponse } from "next/server";

import { encryptText } from "@/lib/crypto";
import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function sanitize(value: string | undefined): string | null {
  const next = value?.trim() ?? "";
  if (!next) return null;
  if (next.includes("[")) return null;
  return next;
}

export async function POST() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = auth.tenantId;
  const hostawayClientId = sanitize(process.env.HOSTAWAY_CLIENT_ID);
  const hostawayClientSecret = sanitize(process.env.HOSTAWAY_CLIENT_SECRET);
  const webhookBasicUser = sanitize(process.env.WEBHOOK_BASIC_USER);
  const webhookBasicPass = sanitize(process.env.WEBHOOK_BASIC_PASS);

  const shouldWriteHostaway = Boolean(hostawayClientId && hostawayClientSecret);
  const shouldWriteWebhookUser = Boolean(webhookBasicUser);
  const shouldWriteWebhookPass = Boolean(webhookBasicPass);

  if (!shouldWriteHostaway && !shouldWriteWebhookUser && !shouldWriteWebhookPass) {
    return NextResponse.json(
      { error: "No usable HOSTAWAY_*/WEBHOOK_* environment values to load" },
      { status: 400 }
    );
  }

  const updateData: Record<string, unknown> = {};

  if (shouldWriteHostaway && hostawayClientId && hostawayClientSecret) {
    updateData.hostawayClientId = hostawayClientId;
    updateData.hostawayClientSecretEncrypted = encryptText(hostawayClientSecret);
    updateData.hostawayAccessTokenEncrypted = null;
    updateData.hostawayAccessTokenExpiresAt = null;
  }

  if (shouldWriteWebhookUser && webhookBasicUser !== null) {
    updateData.webhookBasicUser = webhookBasicUser;
  }

  if (shouldWriteWebhookPass && webhookBasicPass !== null) {
    updateData.webhookBasicPassEncrypted = encryptText(webhookBasicPass);
  }

  try {
    await prisma.hostawayConnection.upsert({
      where: { tenantId },
      create: {
        tenantId,
        status: "active",
        ...updateData
      },
      update: updateData
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load credentials" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
