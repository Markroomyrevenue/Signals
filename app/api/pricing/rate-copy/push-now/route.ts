import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/lib/auth";
import { executeRateCopyPush, executeRateCopyPushForTenant } from "@/lib/pricing/rate-copy-push-service";

const bodySchema = z.union([
  z.object({ listingId: z.string().min(1) }),
  z.object({ all: z.literal(true) })
]);

/**
 * POST /api/pricing/rate-copy/push-now
 *
 * Body: `{ listingId }` for a single listing or `{ all: true }` for every
 * fully-configured rate-copy listing in the tenant. Admin-only.
 *
 * Returns: synchronous summary of the push (success/failed/skipped per
 * listing). The same code path as the daily 06:30 worker.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.flatten() }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if ("all" in body) {
    const summaries = await executeRateCopyPushForTenant({
      tenantId: auth.tenantId,
      pushedBy: auth.userId,
      triggerSource: "manual"
    });
    return NextResponse.json({ summaries });
  }

  const summary = await executeRateCopyPush({
    tenantId: auth.tenantId,
    listingId: body.listingId,
    pushedBy: auth.userId,
    triggerSource: "manual"
  });
  return NextResponse.json({ summary });
}
