/**
 * Admin-only team management API.
 *
 * GET  /api/team/users               – list every user in the current tenant.
 * POST /api/team/users               – create a staff login (role defaults to "viewer").
 * PATCH /api/team/users              – update role / displayName / password for a user.
 * DELETE /api/team/users?id=...      – remove a user (cannot delete yourself or the last admin).
 *
 * Every route requires an authenticated admin. Viewers get 403.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

const roleSchema = z.enum(["admin", "viewer"]);

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: roleSchema.default("viewer"),
  displayName: z.string().trim().max(120).optional()
});

const patchSchema = z.object({
  userId: z.string().min(1),
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

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const users = await prisma.user.findMany({
    where: { tenantId: guard.auth.tenantId },
    orderBy: [{ role: "asc" }, { email: "asc" }],
    select: {
      id: true,
      email: true,
      role: true,
      displayName: true,
      lastLoginAt: true,
      createdAt: true
    }
  });

  return NextResponse.json({ users });
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

  const email = payload.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({
    where: { tenantId_email: { tenantId: guard.auth.tenantId, email } }
  });
  if (existing) {
    return NextResponse.json({ error: "A user with that email already exists." }, { status: 409 });
  }

  const passwordHash = await hashPassword(payload.password);
  const user = await prisma.user.create({
    data: {
      tenantId: guard.auth.tenantId,
      email,
      passwordHash,
      role: payload.role,
      displayName: payload.displayName?.trim() || null
    },
    select: { id: true, email: true, role: true, displayName: true, createdAt: true }
  });

  return NextResponse.json({ user }, { status: 201 });
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

  const target = await prisma.user.findFirst({
    where: { id: payload.userId, tenantId: guard.auth.tenantId }
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Prevent demoting the only remaining admin — you'd lock yourself out of
  // Calendar/pricing and the team management page.
  if (payload.role && payload.role !== "admin" && target.role === "admin") {
    const otherAdmins = await prisma.user.count({
      where: {
        tenantId: guard.auth.tenantId,
        role: "admin",
        NOT: { id: target.id }
      }
    });
    if (otherAdmins === 0) {
      return NextResponse.json(
        { error: "Add another admin before demoting this account." },
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

  const updated = await prisma.user.update({
    where: { id: target.id },
    data,
    select: { id: true, email: true, role: true, displayName: true }
  });

  return NextResponse.json({ user: updated });
}

export async function DELETE(req: Request) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const url = new URL(req.url);
  const userId = url.searchParams.get("id")?.trim();
  if (!userId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  if (userId === guard.auth.userId) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }

  const target = await prisma.user.findFirst({
    where: { id: userId, tenantId: guard.auth.tenantId }
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (target.role === "admin") {
    const otherAdmins = await prisma.user.count({
      where: { tenantId: guard.auth.tenantId, role: "admin", NOT: { id: target.id } }
    });
    if (otherAdmins === 0) {
      return NextResponse.json(
        { error: "Add another admin before removing this account." },
        { status: 400 }
      );
    }
  }

  await prisma.user.delete({ where: { id: target.id } });
  return NextResponse.json({ ok: true });
}
