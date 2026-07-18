import { NextResponse } from "next/server";

import { approveSuggestion, type ActionResult } from "@/lib/recs/actions";
import { getInternalRecsAuth } from "@/lib/recs/auth";

export const dynamic = "force-dynamic";

/** Engine pushes are rate-limited — approvals run one at a time, capped. */
const MAX_BULK_IDS = 50;

/**
 * POST /api/recs/bulk-approve — approve a set of nights SEQUENTIALLY.
 * Internal-only. Each id gets its own outcome; one failure never aborts the rest.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const tenantId = typeof raw.tenantId === "string" ? raw.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
  const ids = Array.isArray(raw.suggestionIds)
    ? raw.suggestionIds.filter((id): id is string => typeof id === "string" && id.trim() !== "")
    : null;
  if (!ids || ids.length === 0) {
    return NextResponse.json({ error: "suggestionIds must be a non-empty array of ids" }, { status: 400 });
  }
  if (ids.length > MAX_BULK_IDS) {
    return NextResponse.json({ error: `At most ${MAX_BULK_IDS} suggestions per request` }, { status: 400 });
  }

  const results: Array<{ suggestionId: string } & ActionResult> = [];
  for (const suggestionId of ids) {
    try {
      const result = await approveSuggestion({ tenantId, suggestionId, actorEmail: auth.email });
      results.push({ suggestionId, ...result });
    } catch (error) {
      results.push({
        suggestionId,
        ok: false,
        status: "error",
        error: error instanceof Error ? error.message : "Approve failed"
      });
    }
  }
  return NextResponse.json({ results });
}
