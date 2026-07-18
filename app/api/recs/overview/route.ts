import { NextResponse } from "next/server";

import { getInternalRecsAuth } from "@/lib/recs/auth";
import { loadRecsOverview } from "@/lib/recs/data";

export const dynamic = "force-dynamic";

/**
 * GET /api/recs/overview — internal-only cross-client recommendation summary.
 * Non-internal callers get a 404 (the route does not exist for them).
 */
export async function GET(): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  try {
    const clients = await loadRecsOverview();
    return NextResponse.json({ clients });
  } catch {
    return NextResponse.json({ error: "Failed to load recommendations overview" }, { status: 500 });
  }
}
