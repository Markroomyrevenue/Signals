import { NextResponse } from "next/server";

import { getInternalRecsAuth } from "@/lib/recs/auth";
import { loadRecsClientView } from "@/lib/recs/data";

export const dynamic = "force-dynamic";

/**
 * GET /api/recs/client/:tenantId — one client's day-by-day recommendation view.
 * Internal-only; unknown tenant → 404.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ tenantId: string }> }): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  const { tenantId } = await ctx.params;
  if (!tenantId || typeof tenantId !== "string") {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }

  try {
    const view = await loadRecsClientView(tenantId);
    if (!view) return NextResponse.json({ error: "Unknown tenant" }, { status: 404 });
    return NextResponse.json(view);
  } catch {
    return NextResponse.json({ error: "Failed to load client recommendations" }, { status: 500 });
  }
}
