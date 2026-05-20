import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { softDeleteOverride } from "@/lib/pricing/manual-override";
import { prisma } from "@/lib/prisma";

/**
 * DELETE /api/pricing/overrides/:id
 *
 * Soft-deletes the override. Audit trail preserved (removedAt, removedBy).
 * The cell reverts to the dynamic recommendation on next render.
 */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const removed = await softDeleteOverride({
    tenantId: auth.tenantId,
    id,
    removedBy: auth.userId,
    prisma
  });
  if (!removed) {
    return NextResponse.json({ error: "Override not found or already removed" }, { status: 404 });
  }
  return NextResponse.json({ removed });
}
