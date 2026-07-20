import { NextResponse } from "next/server";

import { getInternalRecsAuth } from "@/lib/recs/auth";
import { loadRecsCalendar } from "@/lib/recs/calendar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/recs/calendar — internal-only calendar payload: every client's
 * 14-day recommendation nights/runs plus 30 days of booked/min-stay/live
 * context per listing. Non-internal callers get a 404 (the route does not
 * exist for them).
 */
export async function GET(): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  try {
    return NextResponse.json(await loadRecsCalendar());
  } catch {
    return NextResponse.json({ error: "Failed to load recommendations calendar" }, { status: 500 });
  }
}
