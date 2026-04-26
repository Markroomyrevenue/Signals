/**
 * Admin-only team management API.
 *
 * GET  /api/team/users                  – list users across every client the current admin can manage.
 * POST /api/team/users                  – create or extend a user across selected clients.
 * PATCH /api/team/users                 – update role / display name / password across managed clients.
 * DELETE /api/team/users?email=...      – remove a user's access from all managed clients.
 *
 * Every route requires an authenticated admin. Viewers get 403.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { listManageableClientsForUserEmail, listTeamUsersForManagerEmail } from "@/lib/team/team-access";

const roleSchema = z.enum(["admin", "viewer"]);
const emailSchema = z.string().email().transform((value) => value.toLowerCase().trim());
const clientIdsSchema = z.array(z.string().trim().min(1)).min(1);

const createSchema = z.object({
  email: emailSchema,
  password: z.string().min(8),
  role: roleSchema.default("viewer"),
  displayName: z.string().trim().max(120).optional(),
  clientIds: clientIdsSchema
});

const patchSchema = z.object({
  email: emailSchema,
  role: roleSchema.optional(),
  displayName: z.string().trim().max(120).nullable().optional(),
  password: z.string().min(8).optional()
});

async function requireAdmin() {
  const auth = await getAuthContext();
  if (!auth) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  }
  if (auth.role !== "admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  }
  return { auth } as const;
}

function normalizeClientIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function loadManageableClients(authEmail: string) {
  const clients = await listManageableClientsForUserEmail(authEmail);
  return {
    clients,
    clientIds: new Set(clients.map((client) => client.id))
  };
}

async function ensureOtherAdminsRemain(params: {
  tenantIds: string[];
  targetEmail: string;
}) {
  const uniqueTenantIds = [...new Set(params.tenantIds)];
  for (const tenantId of uniqueTenantIds) {
    const otherAdmins = await prisma.user.count({
      where: {
        tenantId,
        role: "admin",
        NOT: { email: params.targetEmail }
      }
    });
    if (otherAdmins === 0) {
      throw new Error("Add another admin before removing this account from one of its portfolios.");
    }
  }
}

async function buildResponse(authEmail: string, currentTenantId: string) {
  const [clients, users] = await Promise.all([
    listManageableClientsForUserEmail(authEmail),
    listTeamUsersForManagerEmail(authEmail)
  ]);

  return {
    clients,
    users,
    currentUserEmail: authEmail.toLowerCase().trim(),
    currentTenantId
  };
}

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  return NextResponse.json(await buildResponse(guard.auth.email, guard.auth.tenantId));
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  let payload: z.infer<typeof createSchema>;
  try {
    payload = createSchema.parse(await req.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { clients: manageableClients, clientIds: manageableClientIds } = await loadManageableClients(guard.auth.email);
  const requestedClientIds = normalizeClientIds(payload.clientIds);

  if (manageableClients.length === 0) {
    return NextResponse.json({ error: "No manageable portfolios found for this account." }, { status: 400 });
  }

  if (requestedClientIds.some((clientId) => !manageableClientIds.has(clientId))) {
    return NextResponse.json({ error: "You can only grant access to portfolios you manage." }, { status: 400 });
  }

  const passwordHash = await hashPassword(payload.password);

  await prisma.$transaction(
    requestedClientIds.map((tenantId) =>
      prisma.user.upsert({
        where: { tenantId_email: { tenantId, email: payload.email } },
        update: {
          passwordHash,
          role: payload.role,
          displayName: payload.displayName?.trim() || null
        },
        create: {
          tenantId,
          email: payload.email,
          passwordHash,
          role: payload.role,
          displayName: payload.displayName?.trim() || null
        }
      })
    )
  );

  return NextResponse.json(await buildResponse(guard.auth.email, guard.auth.tenantId), { status: 201 });
}

export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  let payload: z.infer<typeof patchSchema>;
  try {
    payload = patchSchema.parse(await req.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (
    payload.email === guard.auth.email.toLowerCase().trim() &&
    payload.role &&
    payload.role !== "admin"
  ) {
    return NextResponse.json({ error: "You can't demote your own account." }, { status: 400 });
  }

  const { clientIds: manageableClientIds } = await loadManageableClients(guard.auth.email);
  const targetMemberships = await prisma.user.findMany({
    where: {
      email: payload.email,
      tenantId: { in: [...manageableClientIds] }
    },
    select: {
      tenantId: true,
      role: true
    }
  });

  if (targetMemberships.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (payload.role && payload.role !== "admin") {
    try {
      await ensureOtherAdminsRemain({
        tenantIds: targetMemberships
          .filter((membership) => membership.role === "admin")
          .map((membership) => membership.tenantId),
        targetEmail: payload.email
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not update role." },
        { status: 400 }
      );
    }
  }

  const data: Record<string, unknown> = {};
  if (payload.role) data.role = payload.role;
  if (payload.displayName !== undefined) {
    data.displayName = payload.displayName === null ? null : payload.displayName.trim() || null;
  }
  if (payload.password) data.passwordHash = await hashPassword(payload.password);

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No changes submitted." }, { status: 400 });
  }

  await prisma.user.updateMany({
    where: {
      email: payload.email,
      tenantId: { in: [...manageableClientIds] }
    },
    data
  });

  return NextResponse.json(await buildResponse(guard.auth.email, guard.auth.tenantId));
}

export async function DELETE(req: Request) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const url = new URL(req.url);
  const email = emailSchema.safeParse(url.searchParams.get("email"));
  if (!email.success) {
    return NextResponse.json({ error: "Missing or invalid email" }, { status: 400 });
  }

  if (email.data === guard.auth.email.toLowerCase().trim()) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }

  const { clientIds: manageableClientIds } = await loadManageableClients(guard.auth.email);
  const targetMemberships = await prisma.user.findMany({
    where: {
      email: email.data,
      tenantId: { in: [...manageableClientIds] }
    },
    select: {
      tenantId: true,
      role: true
    }
  });

  if (targetMemberships.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  try {
    await ensureOtherAdminsRemain({
      tenantIds: targetMemberships
        .filter((membership) => membership.role === "admin")
        .map((membership) => membership.tenantId),
      targetEmail: email.data
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove user." },
      { status: 400 }
    );
  }

  await prisma.user.deleteMany({
    where: {
      email: email.data,
      tenantId: { in: [...manageableClientIds] }
    }
  });

  return NextResponse.json(await buildResponse(guard.auth.email, guard.auth.tenantId));
}
