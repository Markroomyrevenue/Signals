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
import { listClientsForUserEmail } from "@/lib/tenants/clients";

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

  const clients = await listClientsForUserEmail(auth.email);

  return NextResponse.json({
    currentTenantId: auth.tenantId,
    clients
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

    // Auto-clean orphan tenants the admin can't see anymore.
    // If a previous create or delete left a HostawayConnection record using
    // this API key but the tenant has no user record for the current admin,
    // they have no way to remove it from the UI. We safely cascade-delete
    // those orphans here so the new add can proceed.
    const trimmedApiKey = payload.apiKey.trim();
    const trimmedAccountId = payload.accountPin?.trim() || null;
    const orFilters: Array<Record<string, string>> = [];
    if (trimmedApiKey) orFilters.push({ hostawayClientId: trimmedApiKey });
    if (trimmedAccountId) orFilters.push({ hostawayAccountId: trimmedAccountId });

    if (orFilters.length > 0) {
      const conflicting = await prisma.hostawayConnection.findMany({
        where: { OR: orFilters },
        select: { tenantId: true }
      });

      const callerEmail = sourceUser.email.toLowerCase().trim();
      for (const candidate of conflicting) {
        const adminMembership = await prisma.user.findFirst({
          where: {
            tenantId: candidate.tenantId,
            email: callerEmail
          },
          select: { id: true }
        });

        if (!adminMembership) {
          // Orphan from this admin's perspective — safe to remove.
          await prisma.tenant.delete({ where: { id: candidate.tenantId } });
        }
      }
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
        tenantId: true,
        role: true
      }
    });

    if (!membership) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    if (membership.role !== "admin") {
      return NextResponse.json({ error: "Only admins can rename a client." }, { status: 403 });
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

export async function DELETE(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenantId = new URL(request.url).searchParams.get("tenantId")?.trim();
  if (!tenantId) {
    return NextResponse.json({ error: "Missing tenantId" }, { status: 400 });
  }

  if (tenantId === auth.tenantId) {
    return NextResponse.json(
      { error: "Switch to another client before deleting this one." },
      { status: 400 }
    );
  }

  const membership = await prisma.user.findFirst({
    where: {
      tenantId,
      email: auth.email.toLowerCase().trim()
    },
    select: {
      role: true,
      tenant: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  if (!membership) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  if (membership.role !== "admin") {
    return NextResponse.json({ error: "Only admins can delete a client." }, { status: 403 });
  }

  await prisma.tenant.delete({
    where: { id: tenantId }
  });

  return NextResponse.json({
    ok: true,
    client: membership.tenant
  });
}
