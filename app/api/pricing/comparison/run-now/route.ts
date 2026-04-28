import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { runDailyTrialPipeline } from "@/lib/agents/pricing-comparison/pipeline";

/**
 * POST /api/pricing/comparison/run-now
 *
 * Admin-only. Triggers an ad-hoc daily trial pipeline run for the current date
 * (or for `?snapshotDate=YYYY-MM-DD`). Useful for verifying the pipeline outside
 * the 06:00 schedule.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let snapshotDate: string | undefined;
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("snapshotDate");
    if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) snapshotDate = q;
  } catch {
    // ignore — snapshotDate stays undefined
  }

  const result = await runDailyTrialPipeline({ snapshotDate, reason: `manual:${auth.tenantId}` });
  return NextResponse.json(result);
}
