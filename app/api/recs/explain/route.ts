import { NextResponse } from "next/server";

import { explainSuggestion } from "@/lib/recs/actions";
import { getInternalRecsAuth } from "@/lib/recs/auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/recs/explain — narrative explanation for a single night.
 * Internal-only.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const tenantId = raw && typeof raw.tenantId === "string" ? raw.tenantId.trim() : "";
  const suggestionId = raw && typeof raw.suggestionId === "string" ? raw.suggestionId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  if (!suggestionId) return NextResponse.json({ error: "suggestionId is required" }, { status: 400 });

  try {
    const result = await explainSuggestion({ tenantId, suggestionId });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Explain failed" }, { status: 500 });
  }
}
