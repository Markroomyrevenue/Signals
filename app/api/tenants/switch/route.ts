import { NextResponse } from "next/server";
import { z } from "zod";

import { clearSessionFromRequest, createSession, getAuthContext, setSessionCookie } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const switchTenantSchema = z.object({
  tenantId: z.string().min(1)
});

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = switchTenantSchema.parse(await request.json());

    const targetUser = await prisma.user.findFirst({
      where: {
        email: auth.email.toLowerCase().trim(),
        tenantId: body.tenantId
      },
      select: {
        id: true,
        tenantId: true,
        tenant: {
          select: {
            name: true
          }
        }
      }
    });

    if (!targetUser) {
      return NextResponse.json({ error: "Tenant access denied" }, { status: 403 });
    }

    await clearSessionFromRequest();
    const nextSessionToken = await createSession(targetUser.id, targetUser.tenantId);
    const response = NextResponse.json({
      success: true,
      tenant: {
        id: targetUser.tenantId,
        name: targetUser.tenant.name
      }
    });
    setSessionCookie(response, nextSessionToken);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    return NextResponse.json({ error: "Failed to switch tenant" }, { status: 500 });
  }
}
