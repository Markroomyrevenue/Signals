import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { encryptText } from "@/lib/crypto";
import {
  assertUniqueHostawayConnection,
  HostawayConnectionConflictError,
  HostawayConnectionValidationError,
  validateHostawayCredentials
} from "@/lib/hostaway/hardening";
import { prisma } from "@/lib/prisma";

const createClientSchema = z.object({
  clientName: z.string().trim().min(2).max(120),
  apiKey: z.string().trim().min(1),
  apiPin: z.string().trim().min(1),
  accountPin: z.string().trim().optional()
});

const renameClientSchema = z.object({
  tenantId: z.string().trim().min(1),
  clientName: z.string().trim().min(2).max(120)
});

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const users = await prisma.user.findMany({
    where: {
      email: auth.email.toLowerCase().trim()
    },
    select: {
      tenant: {
        select: {
          id: true,
          name: true,
          hostaway: {
            select: {
              hostawayAccountId: true
            }
          }
        }
      }
    }
  });

  const seen = new Set<string>();
  const clientsRaw = users
    .map((row) => ({
      id: row.tenant.id,
      name: row.tenant.name,
      hostawayAccountId: row.tenant.hostaway?.hostawayAccountId ?? null
    }))
    .filter((client) => {
      if (seen.has(client.id)) return false;
      seen.add(client.id);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    currentTenantId: auth.tenantId,
    clients: clientsRaw
  });
}

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = createClientSchema.parse(await request.json());

    const [sourceUser, sourceTenant] = await Promise.all([
      prisma.user.findUnique({
        where: { id: auth.userId },
        select: {
          email: true,
          passwordHash: true,
          role: true,
          displayName: true
        }
      }),
      prisma.tenant.findUnique({
        where: { id: auth.tenantId },
        select: {
          defaultCurrency: true,
          timezone: true
        }
      })
    ]);

    if (!sourceUser || !sourceTenant) {
      return NextResponse.json({ error: "Current user context not found" }, { status: 404 });
    }

    await assertUniqueHostawayConnection({
      hostawayClientId: payload.apiKey,
      hostawayAccountId: payload.accountPin
    });

    await validateHostawayCredentials({
      hostawayClientId: payload.apiKey,
      hostawayClientSecret: payload.apiPin,
      hostawayAccountId: payload.accountPin
    });

    const created = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: payload.clientName,
          defaultCurrency: sourceTenant.defaultCurrency,
          timezone: sourceTenant.timezone
        },
        select: {
          id: true,
          name: true
        }
      });

      await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: sourceUser.email,
          passwordHash: sourceUser.passwordHash,
          role: sourceUser.role,
          displayName: sourceUser.displayName
        }
      });

      await tx.hostawayConnection.create({
        data: {
          tenantId: tenant.id,
          status: "active",
          hostawayClientId: payload.apiKey,
          hostawayClientSecretEncrypted: encryptText(payload.apiPin),
          hostawayAccountId: payload.accountPin?.trim() || null,
          hostawayAccessTokenEncrypted: null,
          hostawayAccessTokenExpiresAt: null
        }
      });

      return tenant;
    });

    return NextResponse.json({
      success: true,
      requiresProvisioning: true,
      client: created
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    if (error instanceof HostawayConnectionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }

    if (error instanceof HostawayConnectionValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create client" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = renameClientSchema.parse(await request.json());
    const email = auth.email.toLowerCase().trim();

    const membership = await prisma.user.findFirst({
      where: {
        tenantId: payload.tenantId,
        email
      },
      select: {
        tenantId: true
      }
    });

    if (!membership) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const updated = await prisma.tenant.update({
      where: { id: payload.tenantId },
      data: { name: payload.clientName },
      select: { id: true, name: true }
    });

    return NextResponse.json({
      success: true,
      client: updated
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to rename client" },
      { status: 500 }
    );
  }
}
