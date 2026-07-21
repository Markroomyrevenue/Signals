import { NextResponse } from "next/server";

import { getInternalRecsAuth } from "@/lib/recs/auth";
import { loadEngineOverrides } from "@/lib/recs/overrides-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/recs/overrides?tenantId=... — internal-only. Returns the nights that
 * already carry an ENGINE override (Wheelhouse custom_rate / PriceLabs override)
 * so the calendar UI can mark them. Read-only and rate-limit-safe (the loader
 * walks the tenant's listings sequentially). Non-internal callers get a 404 (the
 * route does not exist for them), same as every other /api/recs route.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  const tenantId = new URL(request.url).searchParams.get("tenantId")?.trim();
  if (!tenantId) {
    return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  }

  try {
    return NextResponse.json(await loadEngineOverrides(tenantId));
  } catch {
    return NextResponse.json({ error: "Failed to load engine overrides" }, { status: 500 });
  }
}
