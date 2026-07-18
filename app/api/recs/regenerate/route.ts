import { NextResponse } from "next/server";

import { getInternalRecsAuth } from "@/lib/recs/auth";
import { generateRecsForClient } from "@/lib/recs/generate";

export const dynamic = "force-dynamic";

/**
 * POST /api/recs/regenerate — re-run recommendation generation for one client.
 * Internal-only; mirrors the 05:30 observe run for a single tenant.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const tenantId = raw && typeof raw.tenantId === "string" ? raw.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });

  try {
    const result = await generateRecsForClient({ tenantId });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Regeneration failed" },
      { status: 500 }
    );
  }
}
